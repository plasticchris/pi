/**
 * Maps the durable conversation's live watch into pi extension events (S3 of the
 * extension-host plan).
 *
 * pi-durable 1.4.0 has no event stream: `conversation.watch(context)` yields a
 * `ConversationView` (a committed transcript window plus built-in documents), and the
 * live projection is `docs["pi.live"]`. This bridge therefore keeps per-conversation
 * state and diffs each delivered view into the pi events an extension host expects:
 *
 * - an assistant partial appearing in `live.generation` opens a turn (`turn_start` +
 *   `message_start`); each later change is a `message_update`. 1.4.0 throttles the
 *   partial, so token-level fidelity is lost by design (DESIGN.md §2.5).
 * - a committed `pi.assistant` entry settling the partial is `message_end`; its tool
 *   calls carry the canonical start args for the round.
 * - `live.tools` / `live.nestedTools` slots drive `tool_execution_start` / `_update` /
 *   `_end`; a `done` slot's `entry` pointer finds its committed result.
 * - once every call of a turn has a committed `pi.tool-result`, the turn ends
 *   (`turn_end`). A turn cut off mid-round (abort, close) is flushed `aborted`.
 * - a committed `pi.compaction` entry is `session_compact`; a `live.compactionFailure`
 *   whose task leaves `live.compactions` is `session_compact_failed`.
 */
import type { Context } from "@earendil-works/chord";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
	AssistantMessage,
	AssistantMessageEvent,
	TextContent,
	ToolCall,
	ToolResultMessage,
} from "@earendil-works/pi-ai";
import type {
	CompactionReason,
	Conversation,
	ConversationView,
	EntryRecord,
	LiveState,
	NestedToolSlot,
	ToolSlot,
} from "@earendil-works/pi-durable";
import type { AgentActivityOutcome, ExtensionEvent, SessionCompactEvent } from "../../core/extensions/types.ts";
import type { CompactionEntry, SessionEntry } from "../../core/session-manager.ts";

/** The wrapped form durable writes for every summary entry, pi's own included. */
const SUMMARY_PREFIX =
	"The conversation history before this point was compacted into the following summary:\n\n<summary>\n";
const SUMMARY_SUFFIX = "\n</summary>";

/** The summary text of a durable compaction entry's wrapped user message. */
export function unwrapSummary(entry: EntryRecord): string {
	const message = entry.model?.[0];
	if (message?.role !== "user") return "";
	const text =
		typeof message.content === "string"
			? message.content
			: message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
	let summary = text;
	if (summary.startsWith(SUMMARY_PREFIX)) summary = summary.slice(SUMMARY_PREFIX.length);
	if (summary.endsWith(SUMMARY_SUFFIX)) summary = summary.slice(0, -SUMMARY_SUFFIX.length);
	return summary;
}

/** A durable entry as a pi session entry, best effort (DESIGN §2.5). */
export function toSessionEntry(entry: EntryRecord): SessionEntry {
	const message = entry.model?.[0];
	if (message !== undefined) {
		const timestamp = "timestamp" in message ? message.timestamp : Date.now();
		return {
			type: "message",
			id: String(entry.id),
			parentId: null,
			timestamp: new Date(timestamp).toISOString(),
			message: message as AgentMessage,
		};
	}
	if (entry.kind === "pi.compaction") {
		return {
			type: "compaction",
			id: String(entry.id),
			parentId: null,
			timestamp: new Date(Date.now()).toISOString(),
			summary: unwrapSummary(entry),
			firstKeptEntryId: entry.head === undefined ? "0" : String(entry.head),
			tokensBefore: 0,
		};
	}
	return {
		type: "custom",
		id: String(entry.id),
		parentId: null,
		timestamp: new Date(Date.now()).toISOString(),
		customType: entry.kind,
		...(entry.data === undefined ? {} : { data: entry.data }),
	};
}

/** One in-progress turn: the assistant message ended, its top-level results pending. */
export interface BridgeTurn {
	/** The turn's index, as fired in its `turn_start`. */
	readonly index: number;
	readonly message: AssistantMessage;
	readonly entryId: number;
	/** Top-level call IDs in call order; nested calls never appear. */
	readonly calls: readonly string[];
	/** Start args per call ID, echoed by the tool update/end events. */
	readonly args: ReadonlyMap<string, unknown>;
	/** Collected results by call ID, in arrival order. */
	readonly results: ReadonlyMap<string, { readonly entryId: number; readonly message: ToolResultMessage }>;
}

/** Everything the diff remembers for the current conversation. */
export interface BridgeState {
	/** Index of the next assistant message's turn, from 0 for the first turn after attach. */
	turnIndex: number;
	/** The in-flight assistant partial, from `live.generation`. */
	partial?: AssistantMessage;
	/** The current turn awaiting its tool results, if any. */
	turn?: BridgeTurn;
	/** Committed assistant entry IDs already mapped. */
	seenAssistant: Set<number>;
	/** Committed tool-result entry IDs already mapped. */
	seenResults: Set<number>;
	/** Tool slots (call ID, and nested call ID) already started. */
	seenSlots: Set<string>;
	/** The retained output window per call ID, for `tool_execution_update` results. */
	outputs: Map<string, string>;
	/** Committed `pi.compaction` entry IDs already fired. */
	seenCompactions: Set<number>;
	/** `compactionFailure` (taskId, error) pairs already fired. */
	seenCompactionFailures: Map<number, string>;
}

function initialBridgeState(): BridgeState {
	return {
		turnIndex: 0,
		partial: undefined,
		turn: undefined,
		seenAssistant: new Set<number>(),
		seenResults: new Set<number>(),
		seenSlots: new Set<string>(),
		outputs: new Map<string, string>(),
		seenCompactions: new Set<number>(),
		seenCompactionFailures: new Map<number, string>(),
	};
}

export interface EventBridgeOptions {
	/** The demo's background context; each watch lives until `stop()`. */
	readonly context: Context;
	/** Fire a mapped pi event through every extension handler (host #fire). */
	dispatch(event: ExtensionEvent): Promise<void>;
	notice(level: "info" | "warning" | "error", message: string): void;
}

/**
 * Subscribes `conversation.watch` for the current conversation and diffs each view into
 * pi events. Re-subscribes on `switchTo`; an in-flight delivery from a superseded watch
 * is dropped by epoch.
 */
export class EventBridge {
	readonly #options: EventBridgeOptions;
	#watch: { readonly stop: () => Promise<unknown> } | undefined;
	#state: BridgeState = initialBridgeState();
	#conversationId: number | undefined;
	#epoch = 0;
	#sequence = Promise.resolve();
	#closed = false;
	/** Compaction tasks whose summary a `session_before_compact` handler supplied. */
	#fromExtension = new Map<number, true>();

	constructor(options: EventBridgeOptions) {
		this.#options = options;
	}

	/** Start (or restart) the watch for the given conversation. */
	async start(conversation: Conversation): Promise<void> {
		if (this.#closed || this.#conversationId === conversation.id) return;
		this.#conversationId = conversation.id;
		await this.#resubscribe(conversation);
	}

	/** Stop the watch and never restart it. */
	async stop(): Promise<void> {
		this.#closed = true;
		await this.#flushTurn("aborted");
		const watch = this.#watch;
		this.#watch = undefined;
		this.#conversationId = undefined;
		if (watch !== undefined) await watch.stop().catch(() => {});
		// Wait for in-flight work, so a late event cannot fire after shutdown.
		await this.#sequence;
	}

	/** Re-subscribe for a conversation switch; earlier deliveries are dropped. */
	switchTo(conversation: Conversation): Promise<void> {
		if (this.#closed || this.#conversationId === conversation.id) return Promise.resolve();
		this.#conversationId = conversation.id;
		return this.#resubscribe(conversation);
	}

	/** A `session_before_compact` handler supplied the summary of this compaction task. */
	markFromExtension(taskId: number): void {
		this.#fromExtension.set(taskId, true);
	}

	isFromExtension(taskId: number): boolean {
		const result = this.#fromExtension.has(taskId);
		if (result) this.#fromExtension.delete(taskId);
		return result;
	}

	async #resubscribe(conversation: Conversation): Promise<void> {
		this.#epoch += 1;
		const previous = this.#watch;
		this.#watch = undefined;
		if (previous !== undefined) await previous.stop().catch(() => {});
		this.#state = initialBridgeState();
		this.#conversationId = conversation.id;
		try {
			const watch = await conversation.watch(this.#options.context);
			if (this.#closed || this.#conversationId !== conversation.id) {
				// Superseded or closed while the watch was opening: drop it.
				await watch.stop().catch(() => {});
				return;
			}
			this.#watch = { stop: () => watch.stop() };
			const epoch = this.#epoch;
			watch.start(async (call) => {
				// A throwing listener ends the watch; never throw one.
				try {
					if (this.#epoch !== epoch || this.#closed) return;
					if (call.kind === "value") {
						const view = call.value;
						this.#sequence = this.#sequence
							.then(() => this.#dispatchView(view))
							.catch((error) =>
								this.#options.notice(
									"error",
									`durable demo: event stream failed: ${error instanceof Error ? error.message : String(error)}`,
								),
							);
						await this.#sequence;
					} else {
						// `failed` is a delivery the source may still recover from; keep watching.
						this.#options.notice(
							"warning",
							`durable demo: watch delivery failed: ${call.error instanceof Error ? call.error.message : String(call.error)}`,
						);
					}
				} catch (error) {
					this.#options.notice(
						"error",
						`durable demo: event stream failed: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			});
		} catch (error) {
			// The conversation object has no `watch` (test fakes) or the harness is
			// closing: there is nothing to map; the TUI still renders committed state.
			this.#options.notice(
				"warning",
				`durable demo: event stream not started: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	async #dispatchView(view: ConversationView): Promise<void> {
		const events = mapConversationView(this.#state, view, this.#fromExtension);
		for (const event of events) await this.#dispatch(event);
	}

	async #dispatch(event: ExtensionEvent): Promise<void> {
		try {
			await this.#options.dispatch(event);
		} catch (error) {
			this.#options.notice(
				"error",
				`durable demo: event ${event.type} failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	async #flushTurn(outcome: AgentActivityOutcome): Promise<void> {
		const turn = this.#state.turn;
		if (turn === undefined) return;
		this.#state.turn = undefined;
		await this.#dispatch(endTurnEvent(turn, outcome));
	}
}

// --- The state diff -------------------------------------------------------------

function mapConversationView(
	state: BridgeState,
	view: ConversationView,
	fromExtension: ReadonlyMap<number, true>,
): ExtensionEvent[] {
	const events: ExtensionEvent[] = [];
	const live: LiveState = (view.docs["pi.live"] ?? {}) as LiveState;
	const seenAssistant = new Set(state.seenAssistant);
	const seenResults = new Set(state.seenResults);
	const seenSlots = new Set(state.seenSlots);
	const outputs = new Map(state.outputs);
	const seenCompactions = new Set(state.seenCompactions);
	const seenFailures = new Map(state.seenCompactionFailures);

	// 1. Committed entries, in order: assistant turns, tool results, compaction summaries.
	for (const entry of view.entries) {
		if (entry.kind === "pi.assistant") onAssistantEntry(state, events, seenAssistant, entry);
		else if (entry.kind === "pi.tool-result") onToolResultEntry(state, events, seenResults, entry);
		else if (entry.kind === "pi.compaction") onCompactionEntry(events, seenCompactions, fromExtension, entry);
	}

	// 2. The live projection: the partial, the tool round, compaction.
	applyGeneration(state, events, live);
	applyTools(state, events, view, seenSlots, outputs, live.tools ?? []);
	applyNestedTools(events, seenSlots, outputs, live.nestedTools ?? []);
	applyCompactions(events, live, fromExtension, seenFailures);

	// A turn whose run died mid-round (no partial, no run, results missing) ends now.
	if (
		state.turn !== undefined &&
		state.partial === undefined &&
		live.generation === undefined &&
		live.run === undefined
	) {
		endOpenTurn(state, events, outcomeOfTurn(state.turn.message));
	}

	state.seenAssistant = seenAssistant;
	state.seenResults = seenResults;
	state.seenSlots = seenSlots;
	state.outputs = outputs;
	state.seenCompactions = seenCompactions;
	state.seenCompactionFailures = seenFailures;
	return events;
}

function onAssistantEntry(state: BridgeState, events: ExtensionEvent[], seen: Set<number>, entry: EntryRecord): void {
	if (seen.has(entry.id)) return;
	seen.add(entry.id);
	const message = entry.model?.[0];
	if (message?.role !== "assistant") return;
	const assistant = message as AssistantMessage;
	const toolCalls = assistant.content.filter((block): block is ToolCall => block.type === "toolCall");
	const calls = toolCalls.map((call) => call.id);
	// The partial this committed entry settled: message_end for it.
	const partial = state.partial;
	state.partial = undefined;
	if (partial !== undefined) events.push({ type: "message_end", message: assistant });
	const turn = state.turn;
	if (turn !== undefined && turn.entryId === entry.id) {
		// This entry opened the turn (via a partial we saw); settle it.
		state.turn = { ...turn, message: assistant, calls, args: new Map(toolCalls.map((c) => [c.id, c.arguments])) };
	} else if (turn === undefined || turn.entryId !== -1) {
		// The partial was never seen (attach mid-turn) or a different round was open:
		// settle the open round, then open this entry's turn.
		if (turn !== undefined) endOpenTurn(state, events, outcomeOfTurn(turn.message));
		state.turnIndex += 1;
		state.turn = {
			index: state.turnIndex,
			entryId: entry.id,
			message: assistant,
			calls,
			args: new Map(toolCalls.map((c) => [c.id, c.arguments])),
			results: new Map(),
		};
		if (calls.length > 0) events.push({ type: "turn_start", turnIndex: state.turn.index, timestamp: Date.now() });
	}
	// A text-only answer closes a turn it opened.
	if (calls.length === 0 && state.turn !== undefined && state.turn.entryId === entry.id) {
		endOpenTurn(state, events, outcomeOfTurn(state.turn.message));
	}
}

function onToolResultEntry(state: BridgeState, events: ExtensionEvent[], seen: Set<number>, entry: EntryRecord): void {
	if (seen.has(entry.id)) return;
	seen.add(entry.id);
	const message = entry.model?.[0];
	if (message?.role !== "toolResult") return;
	const result = message as ToolResultMessage;
	// The round that started this call (usually the open turn; may be a superseded one).
	const turn = state.turn;
	if (turn === undefined || !turn.calls.includes(result.toolCallId)) return;
	const results = new Map(turn.results);
	results.set(result.toolCallId, { entryId: entry.id, message: result });
	const completed = { ...turn, results };
	if (completed.calls.every((id) => completed.results.has(id))) {
		endOpenTurn({ ...state, turn: completed }, events, outcomeOfTurn(completed.message));
	} else {
		state.turn = completed;
	}
}

function onCompactionEntry(
	events: ExtensionEvent[],
	seen: Set<number>,
	fromExtension: ReadonlyMap<number, true>,
	entry: EntryRecord,
): void {
	if (seen.has(entry.id)) return;
	seen.add(entry.id);
	const data = entry.data as { reason?: string } | undefined;
	const reason =
		data?.reason === "manual" || data?.reason === "threshold" || data?.reason === "overflow" ? data.reason : "manual";
	const taskId = entry.byTaskId ?? -1;
	events.push(makeCompactionEvent(entry, reason, fromExtension.has(taskId) === true));
}

function makeCompactionEvent(
	entry: EntryRecord,
	reason: CompactionReason,
	fromExtension: boolean,
): SessionCompactEvent {
	return {
		type: "session_compact",
		compactionEntry: toCompactionEntry(entry, fromExtension),
		fromExtension,
		reason,
		willRetry: reason === "overflow",
	};
}

function toCompactionEntry(entry: EntryRecord, fromExtension: boolean): CompactionEntry {
	return {
		type: "compaction",
		id: String(entry.id),
		parentId: null,
		timestamp: new Date(0).toISOString(),
		summary: unwrapSummary(entry),
		firstKeptEntryId: entry.head === undefined ? "0" : String(entry.head),
		tokensBefore: 0, // Unknown to the demo; pi estimates it from its projection.
		...(fromExtension ? { fromHook: true } : {}),
	};
}

function applyGeneration(state: BridgeState, events: ExtensionEvent[], live: LiveState): void {
	const generation = live.generation;
	if (generation === undefined || generation.message === undefined) {
		// The partial left: the committed entry (step 1) already fired message_end.
		return;
	}
	const partial = generation.message as AssistantMessage;
	if (state.partial === undefined) {
		state.partial = partial;
		if (state.turn === undefined) {
			state.turnIndex += 1;
			state.turn = {
				index: state.turnIndex,
				entryId: -1,
				message: partial,
				calls: [],
				args: new Map(),
				results: new Map(),
			};
			events.push({ type: "turn_start", turnIndex: state.turn.index, timestamp: Date.now() });
		}
		events.push({ type: "message_start", message: partial });
		return;
	}
	if (state.partial === partial) return;
	state.partial = partial;
	events.push({ type: "message_update", message: partial, assistantMessageEvent: partialUpdate(partial) });
}

function partialUpdate(partial: AssistantMessage): AssistantMessageEvent {
	// The throttled partial is not a token delta: report it as a (possibly empty) delta
	// whose `partial` carries the current text. See DESIGN.md §2.5.
	const text = partial.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("");
	return {
		type: "text_delta",
		contentIndex: 0,
		delta: "",
		partial: { ...partial, content: [{ type: "text", text }] },
	};
}

function applyTools(
	state: BridgeState,
	events: ExtensionEvent[],
	view: ConversationView,
	seen: Set<string>,
	outputs: Map<string, string>,
	slots: readonly ToolSlot[],
): void {
	const entriesById = new Map<number, EntryRecord>(view.entries.map((entry) => [entry.id, entry]));
	for (const slot of slots) {
		const key = slot.callId;
		if (!seen.has(key)) {
			seen.add(key);
			outputs.set(key, slot.output ?? "");
			const args = state.turn?.args.get(key) ?? null;
			events.push({ type: "tool_execution_start", toolCallId: key, toolName: slot.name, args });
			continue;
		}
		const previous = outputs.get(key) ?? "";
		if (slot.status === "done") {
			if (previous === (slot.output ?? "")) continue;
			outputs.set(key, slot.output ?? "");
			const entry = slot.entry !== undefined ? entriesById.get(slot.entry) : undefined;
			const message = entry?.model?.[0];
			const committed = message?.role === "toolResult" ? (message as ToolResultMessage) : undefined;
			const result = committed ?? fallbackResult(slot);
			events.push({
				type: "tool_execution_end",
				toolCallId: key,
				toolName: slot.name,
				result,
				isError: committed?.isError ?? false,
				...(committed?.durationMs === undefined ? {} : { durationMs: committed.durationMs }),
			});
			continue;
		}
		if (previous !== (slot.output ?? "")) {
			outputs.set(key, slot.output ?? "");
			events.push({
				type: "tool_execution_update",
				toolCallId: key,
				toolName: slot.name,
				args: state.turn?.args.get(key) ?? null,
				partialResult: {
					content: [{ type: "text", text: slot.output ?? "" } satisfies TextContent],
					details: slot.details ?? null,
				},
			});
		}
	}
}

function applyNestedTools(
	events: ExtensionEvent[],
	seen: Set<string>,
	outputs: Map<string, string>,
	slots: readonly NestedToolSlot[],
): void {
	for (const slot of slots) {
		const key = slot.callId;
		if (!seen.has(key)) {
			seen.add(key);
			outputs.set(key, slot.output ?? "");
			events.push({
				type: "tool_execution_start",
				toolCallId: key,
				toolName: slot.name,
				args: slot.arguments ?? null,
				parentToolCallId: slot.parentCallId,
			});
			continue;
		}
		const previous = outputs.get(key) ?? "";
		if (slot.status === "done") {
			if (previous === (slot.output ?? "")) continue;
			outputs.set(key, slot.output ?? "");
			const summary = slot.summary;
			events.push({
				type: "tool_execution_end",
				toolCallId: key,
				toolName: slot.name,
				result: {
					content: [{ type: "text", text: slot.output ?? "" } satisfies TextContent],
					details: slot.details ?? null,
				},
				isError: summary?.isError ?? false,
				...(summary?.durationMs === undefined ? {} : { durationMs: summary.durationMs }),
				parentToolCallId: slot.parentCallId,
			});
			continue;
		}
		if (previous !== (slot.output ?? "")) {
			outputs.set(key, slot.output ?? "");
			events.push({
				type: "tool_execution_update",
				toolCallId: key,
				toolName: slot.name,
				args: slot.arguments ?? null,
				partialResult: {
					content: [{ type: "text", text: slot.output ?? "" } satisfies TextContent],
					details: slot.details ?? null,
				},
				parentToolCallId: slot.parentCallId,
			});
		}
	}
}

function fallbackResult(slot: ToolSlot): unknown {
	return {
		role: "toolResult",
		toolCallId: slot.callId,
		toolName: slot.name,
		content: [{ type: "text", text: slot.output ?? "No result" } satisfies TextContent],
		isError: false,
	};
}

function applyCompactions(
	events: ExtensionEvent[],
	live: LiveState,
	fromExtension: ReadonlyMap<number, true>,
	seenFailures: Map<number, string>,
): void {
	const liveTasks = new Set<number>((live.compactions ?? []).map((item) => item.taskId));
	const failure = live.compactionFailure;
	if (failure === undefined) return;
	// Fire only once the task has left `live.compactions` (it is settled as a failure).
	if (liveTasks.has(failure.taskId)) return;
	const key = failure.error;
	if (seenFailures.get(failure.taskId) === key) return;
	seenFailures.set(failure.taskId, key);
	events.push({
		type: "session_compact_failed",
		reason: failure.trigger,
		errorMessage: failure.error,
		aborted: false,
		willRetry: failure.trigger === "overflow",
		fromExtension: fromExtension.has(failure.taskId) === true,
	});
}

function endOpenTurn(state: BridgeState, events: ExtensionEvent[], outcome: AgentActivityOutcome): void {
	const turn = state.turn;
	if (turn === undefined) return;
	state.turn = undefined;
	events.push(endTurnEvent(turn, outcome));
}

function endTurnEvent(turn: BridgeTurn, outcome: AgentActivityOutcome): Extract<ExtensionEvent, { type: "turn_end" }> {
	const toolResults: ToolResultMessage[] = [];
	const toolResultEntryIds: string[] = [];
	for (const callId of turn.calls) {
		const result = turn.results.get(callId);
		if (result !== undefined) {
			toolResults.push(result.message);
			toolResultEntryIds.push(String(result.entryId));
		}
	}
	return {
		type: "turn_end",
		turnIndex: turn.index,
		message: turn.message,
		toolResults,
		// Approximation (DESIGN §2.5): the demo has no session-file projection, so the
		// boundary state is carried empty.
		entries: [],
		continue: false,
		context: { contextEntries: [], contextMessages: [], llmMessages: [], pendingMessages: [], canContinue: false },
		outcome,
		messageEntryId: turn.entryId >= 0 ? String(turn.entryId) : "0",
		toolResultEntryIds,
	};
}

function outcomeOfTurn(message: AssistantMessage): AgentActivityOutcome {
	return message.stopReason === "aborted" ? "aborted" : message.stopReason === "error" ? "error" : "completed";
}
