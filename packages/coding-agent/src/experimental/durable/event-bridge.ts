/**
 * Maps the durable `watchEvents` stream to pi extension events (DESIGN.md §2.5).
 *
 * The stream is durable's per-conversation agent event. Pi's per-LLM-round turn
 * (`turn_start`/`turn_end` per assistant message and its tool results) is reconstructed
 * from the stream's message/tool events: an assistant `message_start` opens a turn, the
 * committed assistant entry closes it — once every top-level tool result of the message
 * has ended, or immediately when it has no calls — and a turn cut off mid-round (abort,
 * close) is flushed at the stream's run-level `turn_end`. The stream's own `turn_start`
 * is run-level and not used for pi turns.
 *
 * Compaction events need the harness for receipts, so `EventBridge` handles them:
 * `compaction_end` → the task's receipt → `session_compact` (a summary entry was placed,
 * read from the stream or the entry store) or `session_compact_failed`. A summary placed
 * through a write submission (busy conversation) is resolved when its summary entry
 * reaches the stream.
 *
 * Approximations (noted here per DESIGN §2.5): `turn_end`'s BoundaryState carries empty
 * entries/messages (the demo has no session-file projection); `tool_execution_end`
 * duration comes from the result entry when present; a faulted or orphaned call has no
 * result entry and gets a synthetic error result; compaction `tokensBefore`/`usage` are
 * unknown to the demo and omitted.
 */

import type { Context } from "@earendil-works/chord";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, AssistantMessageEvent, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import type {
	AgentEvent,
	AgentEventStream,
	CompactionReason,
	CompactionResult,
	ConversationId,
	EntryRecord,
	Harness,
	MessageChange,
	SubmissionId,
	TaskId,
} from "@earendil-works/pi-durable";
import { watchEvents } from "@earendil-works/pi-durable";
import type {
	ExtensionEvent,
	SessionCompactEvent,
	SessionCompactFailedEvent,
	TurnEndEvent,
} from "../../core/extensions/types.ts";
import type { CompactionEntry, SessionEntry } from "../../core/session-manager.ts";

/** One in-progress turn: the assistant message ended, its top-level results pending. */
export interface BridgeTurn {
	/** The turn's index, as fired in its `turn_start`. */
	readonly index: number;
	readonly message: AssistantMessage;
	readonly entryId: number;
	/** Top-level call IDs in call order; nested calls never appear. */
	readonly calls: readonly string[];
	/** Collected results by call ID, as their `tool_execution_end` events arrived. */
	readonly results: ReadonlyMap<string, { readonly entryId: number; readonly message: ToolResultMessage }>;
}

/** Everything the stream mapping remembers for the current conversation. */
export interface BridgeState {
	/** Index of the next assistant message's turn, from 0 for the first turn after attach. */
	turnIndex: number;
	/** The in-flight assistant partial, from `message_start`/`message_update`. */
	partial?: AssistantMessage;
	/** The current turn awaiting its tool results, if any. */
	turn?: BridgeTurn;
	/** The retained output window per call ID, for `tool_execution_update` results. */
	outputs: Map<string, string>;
	/** The start args per call ID, echoed by the update/end events. */
	toolArgs: Map<string, unknown>;
}

export function initialBridgeState(): BridgeState {
	return { turnIndex: 0, outputs: new Map(), toolArgs: new Map() };
}

/** One stream event's effect: the new state and the pi events to fire, in order. */
export type StreamMapping = { readonly state: BridgeState; readonly events: readonly ExtensionEvent[] };

export function mapStreamEvent(state: BridgeState, event: AgentEvent): StreamMapping {
	switch (event.type) {
		case "turn_end":
			// Run-level end: flush a turn that did not collect all its results (abort, close).
			return state.turn === undefined ? { state, events: [] } : endTurn(state, state.turn);
		case "message_start":
			return onMessageStart(state, event.message);
		case "message_update":
			return onMessageUpdate(state, event.changes);
		case "message_end":
			return onMessageEnd(state, event.entry);
		case "tool_execution_start":
			return onToolStart(state, event);
		case "tool_execution_update":
			return onToolUpdate(state, event);
		case "tool_execution_end":
			return onToolEnd(state, event);
		default:
			// snapshot, run_*, inbox_update, submission, auto_retry_*, deferred_poll,
			// entry_appended, agent_changed, usage_changed, task_failed, compaction_*:
			// no pi event (DESIGN §2.5); compaction_end is handled by EventBridge.
			return { state, events: [] };
	}
}

// --- Message events -------------------------------------------------------------

function onMessageStart(state: BridgeState, message: AgentMessage): StreamMapping {
	if (message.role !== "assistant") return { state, events: [{ type: "message_start", message }] };
	// A new turn supersedes one still missing results.
	const base = state.turn === undefined ? state : endTurn(state, state.turn).state;
	const events: ExtensionEvent[] = [
		{ type: "turn_start", turnIndex: base.turnIndex, timestamp: Date.now() },
		{ type: "message_start", message },
	];
	return {
		state: {
			...base,
			turnIndex: base.turnIndex + 1,
			partial: cloneMessage(base.partial === undefined ? message : base.partial),
		},
		events,
	};
}

function onMessageUpdate(state: BridgeState, changes: readonly MessageChange[]): StreamMapping {
	if (state.partial === undefined) return { state, events: [] };
	let partial = state.partial;
	const events: ExtensionEvent[] = [];
	for (const change of changes) {
		partial = applyChange(partial, change);
		const synthesized = synthesizeAssistantEvent(change, partial);
		if (synthesized !== undefined)
			events.push({ type: "message_update", message: partial, assistantMessageEvent: synthesized });
	}
	return { state: { ...state, partial }, events };
}

function onMessageEnd(state: BridgeState, entry: EntryRecord): StreamMapping {
	const message = entry.model?.[0];
	if (message === undefined) return { state, events: [] };
	const events: ExtensionEvent[] = [{ type: "message_end", message }];
	const next = { ...state, partial: undefined };
	if (message.role === "assistant") {
		const assistant = message as AssistantMessage;
		const calls =
			assistant.stopReason === "toolUse"
				? assistant.content.filter((block): block is ToolCall => block.type === "toolCall").map((block) => block.id)
				: [];
		const turn: BridgeTurn = {
			index: next.turnIndex - 1,
			message: assistant,
			entryId: entry.id,
			calls,
			results: new Map(),
		};
		if (calls.length === 0) {
			const ended = endTurn(next, turn);
			return { state: ended.state, events: [...events, ...ended.events] };
		}
		return { state: { ...next, turn }, events };
	}
	if (message.role === "toolResult") {
		const result = message as ToolResultMessage;
		const turn = next.turn;
		if (turn?.calls.includes(result.toolCallId) && !turn.results.has(result.toolCallId)) {
			const results = new Map(turn.results);
			results.set(result.toolCallId, { entryId: entry.id, message: result });
			const completed = { ...turn, results };
			if (completed.calls.every((id) => completed.results.has(id))) {
				const ended = endTurn(next, completed);
				return { state: ended.state, events: [...events, ...ended.events] };
			}
			return { state: { ...next, turn: completed }, events };
		}
	}
	return { state: next, events };
}

function endTurn(state: BridgeState, turn: BridgeTurn): StreamMapping {
	const results = turn.calls.flatMap((id) => {
		const collected = turn.results.get(id);
		return collected === undefined ? [] : [collected];
	});
	const event: TurnEndEvent = {
		type: "turn_end",
		turnIndex: turn.index,
		message: turn.message,
		toolResults: results.map((result) => result.message),
		messageEntryId: String(turn.entryId),
		toolResultEntryIds: results.map((result) => String(result.entryId)),
		// BoundaryState approximation: the demo has no session-file projection (DESIGN §2.5).
		entries: [],
		continue: false,
		context: { contextEntries: [], contextMessages: [], llmMessages: [], pendingMessages: [], canContinue: false },
		outcome:
			turn.message.stopReason === "aborted"
				? "aborted"
				: turn.message.stopReason === "error"
					? "error"
					: "completed",
	};
	return { state: { ...state, turn: undefined }, events: [event] };
}

/** Apply one stream change to the partial; returns the (possibly new) partial. */
function applyChange(partial: AssistantMessage, change: MessageChange): AssistantMessage {
	switch (change.type) {
		case "text_start":
		case "thinking_start":
		case "toolcall_start":
		case "block": {
			const content = [...partial.content];
			content[change.contentIndex] = cloneMessageBlock(change.block);
			return { ...partial, content };
		}
		case "text_delta": {
			const block = partial.content[change.contentIndex];
			if (block?.type !== "text") return partial;
			const content = [...partial.content];
			content[change.contentIndex] = { ...block, text: block.text + change.delta };
			return { ...partial, content };
		}
		case "thinking_delta": {
			const block = partial.content[change.contentIndex];
			if (block?.type !== "thinking") return partial;
			const content = [...partial.content];
			content[change.contentIndex] = { ...block, thinking: block.thinking + change.delta };
			return { ...partial, content };
		}
		case "toolcall_delta": {
			const block = partial.content[change.contentIndex];
			if (block?.type !== "toolCall") return partial;
			const content = [...partial.content];
			content[change.contentIndex] = {
				...block,
				arguments: appendAtPath(block.arguments, change.path, change.delta) as ToolCall["arguments"],
			};
			return { ...partial, content };
		}
		case "message":
			// The whole partial was replaced (a new attempt): start over with it.
			return cloneMessage(change.message);
	}
}

/** String append at a JSON path inside the tool-call arguments; non-strings are left alone. */
function appendAtPath(args: unknown, path: readonly (string | number)[], delta: string): unknown {
	if (path.length === 0) return args;
	let node: unknown = args;
	for (const segment of path.slice(0, -1)) {
		if (typeof node !== "object" || node === null) return args;
		node = (node as Record<string, unknown>)[String(segment)];
	}
	const last = path[path.length - 1]!;
	if (typeof node !== "object" || node === null) return args;
	const container = node as Record<string, unknown>;
	const value = container[String(last)];
	if (typeof value !== "string") return args;
	return { ...container, [String(last)]: value + delta };
}

/** The pi-ai stream event a stream change corresponds to, for `message_update.assistantMessageEvent`. */
function synthesizeAssistantEvent(change: MessageChange, partial: AssistantMessage): AssistantMessageEvent | undefined {
	switch (change.type) {
		case "text_start":
			return { type: "text_start", contentIndex: change.contentIndex, partial };
		case "thinking_start":
			return { type: "thinking_start", contentIndex: change.contentIndex, partial };
		case "toolcall_start":
			return { type: "toolcall_start", contentIndex: change.contentIndex, partial };
		case "text_delta":
			return { type: "text_delta", contentIndex: change.contentIndex, delta: change.delta, partial };
		case "thinking_delta":
			return { type: "thinking_delta", contentIndex: change.contentIndex, delta: change.delta, partial };
		case "toolcall_delta":
			return { type: "toolcall_delta", contentIndex: change.contentIndex, delta: change.delta, partial };
		case "block":
			if (change.block.type === "text")
				return { type: "text_end", contentIndex: change.contentIndex, content: change.block.text, partial };
			if (change.block.type === "thinking")
				return { type: "thinking_end", contentIndex: change.contentIndex, content: change.block.thinking, partial };
			return { type: "toolcall_end", contentIndex: change.contentIndex, toolCall: change.block, partial };
		case "message":
			// Approximation: a whole-partial replacement has no single pi-ai event; `start` is closest.
			return { type: "start", partial };
	}
}

// --- Tool events ----------------------------------------------------------------

function onToolStart(state: BridgeState, event: Extract<AgentEvent, { type: "tool_execution_start" }>): StreamMapping {
	const toolArgs = new Map(state.toolArgs);
	toolArgs.set(event.toolCallId, event.args);
	return {
		state: { ...state, toolArgs },
		events: [
			{
				type: "tool_execution_start",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
				...(event.parentToolCallId === undefined ? {} : { parentToolCallId: event.parentToolCallId }),
			},
		],
	};
}

function onToolUpdate(
	state: BridgeState,
	event: Extract<AgentEvent, { type: "tool_execution_update" }>,
): StreamMapping {
	const outputs = new Map(state.outputs);
	const previous = outputs.get(event.toolCallId) ?? "";
	if (event.output !== undefined) {
		if ("set" in event.output) outputs.set(event.toolCallId, event.output.set);
		else outputs.set(event.toolCallId, previous.slice(event.output.trimStart ?? 0) + (event.output.append ?? ""));
	}
	const args = state.toolArgs.get(event.toolCallId);
	const details = event.details ?? null;
	return {
		state: { ...state, outputs },
		events: [
			{
				type: "tool_execution_update",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args,
				partialResult: { content: [{ type: "text", text: outputs.get(event.toolCallId) ?? "" }], details },
				...(event.parentToolCallId === undefined ? {} : { parentToolCallId: event.parentToolCallId }),
			},
		],
	};
}

function onToolEnd(state: BridgeState, event: Extract<AgentEvent, { type: "tool_execution_end" }>): StreamMapping {
	const _args = state.toolArgs.get(event.toolCallId);
	let result: unknown;
	let isError: boolean;
	if (event.entry !== undefined) {
		const message = event.entry.model?.[0] as ToolResultMessage | undefined;
		if (message !== undefined) {
			result = message;
			isError = message.isError;
		} else {
			result = { content: [{ type: "text", text: "No result: the tool call was interrupted." }] };
			isError = true;
		}
	} else if (event.result !== undefined) {
		// A nested call: its result lives on the caller's record, not in the transcript.
		const structured = event.result.structuredOutput;
		result = {
			content: typeof structured === "string" ? [{ type: "text", text: structured }] : [],
			...(event.result.details === undefined ? {} : { details: event.result.details }),
			...(event.result.usage === undefined ? {} : { usage: event.result.usage }),
		};
		isError = event.result.isError ?? false;
	} else {
		// Faulted, orphaned, or the run ended before the slot settled: no result entry.
		result = { content: [{ type: "text", text: "No result: the tool call was interrupted." }] };
		isError = true;
	}
	const entry = event.entry?.model?.[0] as ToolResultMessage | undefined;
	const events: ExtensionEvent[] = [
		{
			type: "tool_execution_end",
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			result,
			isError,
			...(entry?.durationMs === undefined ? {} : { durationMs: entry.durationMs }),
			...(event.parentToolCallId === undefined ? {} : { parentToolCallId: event.parentToolCallId }),
		},
	];
	// A completed turn waits for its results through the result entries, not the end events:
	// collect here too, so a turn ends in the same batch its last result lands.
	const turn = state.turn;
	if (turn?.calls.includes(event.toolCallId) && event.entry !== undefined) {
		const message = event.entry.model?.[0] as ToolResultMessage | undefined;
		if (message !== undefined && !turn.results.has(event.toolCallId)) {
			const results = new Map(turn.results);
			results.set(event.toolCallId, { entryId: event.entry.id, message });
			const completed = { ...turn, results };
			if (completed.calls.every((id) => completed.results.has(id))) {
				const ended = endTurn({ ...state, turn: completed }, completed);
				return { state: { ...ended.state, toolArgs: state.toolArgs }, events: [...events, ...ended.events] };
			}
			return { state: { ...state, turn: completed }, events };
		}
	}
	return { state, events };
}

// --- Compaction -----------------------------------------------------------------

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

/** What a settled compaction means for pi, given the receipt the bridge read. */
export type CompactionDecisionInput = {
	readonly reason: CompactionReason;
	/** Error text from the stream's `compaction_end`; set when the task faulted or was orphaned. */
	readonly streamError?: string;
	readonly outcome:
		| { readonly status: "completed"; readonly result: { readonly entryId?: number; readonly submissionId?: number } }
		| { readonly status: "aborted" }
		| { readonly status: "failed" | "faulted" | "orphaned"; readonly message?: string };
	/** True when a `session_before_compact` handler supplied the summary. */
	readonly fromExtension: boolean;
	/** The placed summary entry, when its text is known (blocking compaction). */
	readonly summaryEntry?: {
		readonly id: number;
		readonly head?: number;
		readonly summary: string;
		readonly timestamp?: number;
	};
};

export type CompactionDecision =
	| { readonly kind: "compact"; readonly event: SessionCompactEvent }
	| {
			readonly kind: "failed";
			readonly event: SessionCompactFailedEvent;
	  } /** Summary queued as a write submission; resolve it when its entry reaches the stream. */
	| ({ readonly kind: "pending"; readonly submissionId: number } & Pick<
			CompactionDecisionInput,
			"reason" | "fromExtension"
	  >)
	| { readonly kind: "none" };

export function decideCompaction(input: CompactionDecisionInput): CompactionDecision {
	const { reason, fromExtension } = input;
	const willRetry = reason === "overflow";
	const failed = (errorMessage?: string): CompactionDecision => ({
		kind: "failed",
		event: {
			type: "session_compact_failed",
			reason,
			...(errorMessage === undefined ? {} : { errorMessage }),
			aborted: false,
			willRetry,
			fromExtension,
		},
	});
	switch (input.outcome.status) {
		case "aborted":
			return {
				kind: "failed",
				event: { type: "session_compact_failed", reason, aborted: true, willRetry, fromExtension },
			};
		case "failed":
		case "faulted":
		case "orphaned":
			return failed(input.streamError ?? input.outcome.message);
		case "completed": {
			const { result } = input.outcome;
			if (result.entryId !== undefined && input.summaryEntry !== undefined) {
				return {
					kind: "compact",
					event: {
						type: "session_compact",
						compactionEntry: toCompactionEntry(input.summaryEntry, fromExtension),
						fromExtension,
						reason,
						willRetry,
					},
				};
			}
			if (result.submissionId !== undefined)
				return { kind: "pending", submissionId: result.submissionId, reason, fromExtension };
			// Nothing was compacted (or the entry is unreadable): pi fires session_compact only
			// when a summary entry exists.
			return { kind: "none" };
		}
	}
}

function toCompactionEntry(
	entry: NonNullable<CompactionDecisionInput["summaryEntry"]>,
	fromExtension: boolean,
): CompactionEntry {
	return {
		type: "compaction",
		id: String(entry.id),
		parentId: null,
		timestamp: entry.timestamp === undefined ? new Date(0).toISOString() : new Date(entry.timestamp).toISOString(),
		summary: entry.summary,
		firstKeptEntryId: entry.head === undefined ? "0" : String(entry.head),
		tokensBefore: 0, // Unknown to the demo; pi estimates it from its projection.
		...(fromExtension ? { fromHook: true } : {}),
	};
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

function cloneMessage(message: AssistantMessage): AssistantMessage {
	return structuredClone(message);
}

function cloneMessageBlock(block: AssistantMessage["content"][number]): AssistantMessage["content"][number] {
	return structuredClone(block);
}

// --- Stream management ----------------------------------------------------------

export interface EventBridgeOptions {
	readonly harness: Harness;
	/** The demo's background context; the stream lives until stop(). */
	readonly context: Context;
	/** Fire a mapped pi event through every extension handler (host #fire). */
	dispatch(event: ExtensionEvent): Promise<void>;
	notice(level: "info" | "warning" | "error", message: string): void;
}

/**
 * Subscribes `watchEvents` for the current conversation and maps the stream to pi events.
 * Re-subscribes on `switchTo`; an in-flight delivery from a superseded stream is dropped
 * by epoch.
 */
export class EventBridge {
	readonly #options: EventBridgeOptions;
	#stream: AgentEventStream | undefined;
	#state: BridgeState = initialBridgeState();
	#conversationId: ConversationId | undefined;
	#epoch = 0;
	#sequence = Promise.resolve();
	#closed = false;
	#pendingCompaction:
		| {
				readonly reason: CompactionReason;
				readonly fromExtension: boolean;
				readonly submissionId: number;
				readonly epoch: number;
		  }
		| undefined;
	/** Compaction tasks whose summary a `session_before_compact` handler supplied. */
	#fromExtension = new Set<number>();
	/** The newest summary entry seen in the stream; consumed by the compaction it belongs to. */
	#lastCompactionEntry: EntryRecord | undefined;

	constructor(options: EventBridgeOptions) {
		this.#options = options;
	}

	get state(): BridgeState {
		return this.#state;
	}

	async start(conversationId: ConversationId): Promise<void> {
		await this.#resubscribe(conversationId);
	}

	/** Stop the stream and never restart it. */
	async stop(): Promise<void> {
		this.#closed = true;
		const stream = this.#stream;
		this.#stream = undefined;
		this.#conversationId = undefined;
		if (stream !== undefined) await stream.stop().catch(() => {});
		// Wait for in-flight work, so a late receipt cannot fire after shutdown.
		await this.#sequence;
	}

	/** Re-subscribe for a conversation switch; earlier deliveries are dropped. */
	switchTo(conversationId: ConversationId): Promise<void> {
		if (this.#closed || this.#conversationId === conversationId) return Promise.resolve();
		return this.#resubscribe(conversationId);
	}

	/** A `session_before_compact` handler supplied the summary of this compaction task. */
	markFromExtension(taskId: number): void {
		this.#fromExtension.add(taskId);
	}

	isFromExtension(taskId: number): boolean {
		const result = this.#fromExtension.has(taskId);
		if (result) this.#fromExtension.delete(taskId);
		return result;
	}

	async #resubscribe(conversationId: ConversationId): Promise<void> {
		this.#epoch += 1;
		const previous = this.#stream;
		this.#stream = undefined;
		if (previous !== undefined) await previous.stop().catch(() => {});
		this.#state = initialBridgeState();
		this.#lastCompactionEntry = undefined;
		this.#conversationId = conversationId;
		try {
			const stream = await watchEvents(this.#options.harness, conversationId, this.#options.context);
			if (this.#closed || this.#conversationId !== conversationId) {
				await stream.stop().catch(() => {});
				return;
			}
			this.#stream = stream;
			const epoch = this.#epoch;
			stream.start(async (events) => {
				// A throw ends the watch with a reported error; never do one.
				try {
					if (this.#epoch !== epoch || this.#closed) return;
					await this.#onBatch(events);
				} catch (error) {
					this.#options.notice(
						"error",
						`durable demo: event stream failed: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			});
		} catch (error) {
			// The harness is closing or the conversation is gone: nothing left to map.
			this.#options.notice(
				"warning",
				`durable demo: event stream not started: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	async #onBatch(events: readonly AgentEvent[]): Promise<void> {
		for (const event of events) {
			if (event.type === "compaction_end") {
				// Receipt reads need the harness; run them in order with switches.
				this.#sequence = this.#sequence.then(() => this.#onCompactionEnd(event)).catch(() => {});
				continue;
			}
			const { state, events: piEvents } = mapStreamEvent(this.#state, event);
			this.#state = state;
			for (const piEvent of piEvents) await this.#options.dispatch(piEvent);
			if (event.type === "message_end" && event.entry?.kind === "pi.compaction") {
				// Remember the newest summary entry: an idle conversation-owned compaction places
				// it in the same commit (and stream batch) as its own end, entry first.
				this.#lastCompactionEntry = event.entry;
				await this.#onCompactionSummaryEntry(event.entry);
			}
		}
	}

	async #onCompactionEnd(event: Extract<AgentEvent, { type: "compaction_end" }>): Promise<void> {
		const { harness, context } = this.#options;
		let outcome: CompactionDecisionInput["outcome"];
		let summaryEntry: CompactionDecisionInput["summaryEntry"];
		try {
			// The stream carries the unbranded `TaskId`; this is the harness compaction task.
			const receipt = await harness.waitForTask(event.taskId as TaskId<CompactionResult>, context);
			const settled = receipt.state.outcome;
			if (settled.status === "completed") {
				outcome = { status: "completed", result: settled.result };
				// A blocking compaction appended its summary in the same commit: read it from the store.
				// (Its message events already streamed; this only needs the text for the payload.)
				const entryId = settled.result.entryId;
				const conversationId = this.#conversationId;
				if (entryId !== undefined && conversationId !== undefined) {
					const conversation = await harness.conversation(conversationId, context);
					const view = conversation === undefined ? undefined : await conversation.context(context);
					const entry = view?.entries.find((candidate) => candidate.id === entryId);
					if (entry !== undefined) {
						// The entry already streamed as message_end; do not let a later compaction
						// consume it as its own.
						if (this.#lastCompactionEntry?.id === entry.id) this.#lastCompactionEntry = undefined;
						summaryEntry = {
							id: entry.id,
							...(entry.head === undefined ? {} : { head: entry.head }),
							summary: unwrapSummary(entry),
							...((entry.model?.[0] as { timestamp?: number } | undefined)?.timestamp === undefined
								? {}
								: { timestamp: (entry.model?.[0] as { timestamp: number }).timestamp }),
						};
					}
				}
			} else if (settled.status === "aborted") outcome = { status: "aborted" };
			else
				outcome = {
					status: settled.status,
					...(settled.status === "orphaned"
						? { message: settled.reason }
						: settled.error.message === undefined
							? {}
							: { message: settled.error.message }),
				};
		} catch {
			return; // The harness closed under us; the event is not worth a notice.
		}
		const decision = decideCompaction({
			reason: event.reason,
			...(event.error === undefined ? {} : { streamError: event.error }),
			outcome,
			fromExtension: this.isFromExtension(event.taskId),
			...(summaryEntry === undefined ? {} : { summaryEntry }),
		});
		if (decision.kind === "pending") {
			// The summary lands as a write submission at the next boundary: an idle one already
			// placed it (entry first in this batch, remembered above), a busy one streams it later.
			const placed = this.#lastCompactionEntry;
			if (placed !== undefined) {
				this.#lastCompactionEntry = undefined;
				await this.#fireCompaction(placed, decision.reason, decision.fromExtension);
				return;
			}
			this.#pendingCompaction = {
				reason: decision.reason,
				fromExtension: decision.fromExtension,
				submissionId: decision.submissionId,
				epoch: this.#epoch,
			};
			// A summary dropped as stale (the context changed under it) never lands: clear the wait.
			void this.#options.harness
				.submission(decision.submissionId as SubmissionId, this.#options.context)
				.then((submission) => (submission === undefined ? undefined : submission.status(this.#options.context)))
				.then((record) => {
					if (record?.status === "unanswered") {
						const pending = this.#pendingCompaction;
						if (pending?.submissionId === decision.submissionId && pending.epoch === this.#epoch)
							this.#pendingCompaction = undefined;
					}
				})
				.catch(() => {});
			return;
		}
		if (decision.kind !== "compact" && decision.kind !== "failed") return;
		await this.#dispatch(decision.event);
	}

	async #fireCompaction(entry: EntryRecord, reason: CompactionReason, fromExtension: boolean): Promise<void> {
		const decision = decideCompaction({
			reason,
			outcome: { status: "completed", result: {} },
			fromExtension,
			summaryEntry: {
				id: entry.id,
				...(entry.head === undefined ? {} : { head: entry.head }),
				summary: unwrapSummary(entry),
				...((entry.model?.[0] as { timestamp?: number } | undefined)?.timestamp === undefined
					? {}
					: { timestamp: (entry.model?.[0] as { timestamp: number }).timestamp }),
			},
		});
		if (decision.kind === "compact") await this.#dispatch(decision.event);
	}

	async #onCompactionSummaryEntry(entry: EntryRecord): Promise<void> {
		const pending = this.#pendingCompaction;
		if (pending === undefined || pending.epoch !== this.#epoch) return;
		this.#pendingCompaction = undefined;
		this.#lastCompactionEntry = undefined;
		await this.#fireCompaction(entry, pending.reason, pending.fromExtension);
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
}
