import {
	type Api,
	type AssistantMessage,
	createAssistantMessageEventStream,
	type JsonObject,
	type Model,
	type SimpleStreamOptions,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAgentLoop } from "../src/agent-loop.ts";
import type { AgentLoopConfig, AgentMessage, AgentTool, StreamFn } from "../src/types.ts";

const SLOW_TOOL_MS = 5000;

function createUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createModel(): Model<"openai-responses"> {
	return {
		id: "mock",
		name: "mock",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	};
}

function assistantMessage(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"],
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: createUsage(),
		stopReason,
		timestamp: Date.now(),
	};
}

function toolCallMessage(toolName: string, args: JsonObject): AssistantMessage {
	return assistantMessage([{ type: "toolCall", id: "tc-1", name: toolName, arguments: args }], "toolUse");
}

function stopMessage(): AssistantMessage {
	return assistantMessage([{ type: "text", text: "done" }], "stop");
}

/**
 * Stream function: call 1 → one tool call for `toolName`; call 2+ → a plain stop message
 * (honors an already-aborted signal the way real providers do).
 */
function makeStreamFn(toolName: string): StreamFn {
	let providerCalls = 0;
	return (_model: Model<Api>, _ctx: TranscriptContext, opts?: SimpleStreamOptions) => {
		providerCalls++;
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			if (providerCalls > 1) {
				if (opts?.signal?.aborted) {
					stream.push({
						type: "error",
						reason: "aborted",
						error: { ...stopMessage(), stopReason: "aborted", errorMessage: "aborted" },
					});
				} else {
					stream.push({ type: "done", reason: "stop", message: stopMessage() });
				}
			} else {
				stream.push({ type: "done", reason: "toolUse", message: toolCallMessage(toolName, {}) });
			}
		});
		return stream;
	};
}

const emptySchema = Type.Object({});

type AnyAgentTool = AgentTool<typeof emptySchema, undefined>;

function slowTool(name: string, opts: { ignoreSignal?: boolean; rejectMs?: number }): AnyAgentTool {
	return {
		name,
		label: name,
		description: `${name} test tool`,
		parameters: emptySchema,
		async execute(_id: string, _args: unknown, signal: AbortSignal | undefined) {
			const delay = new Promise<never>((_resolve, reject) => {
				const t = setTimeout(() => reject(new Error(`${name}: unexpected early completion`)), SLOW_TOOL_MS + 1500);
				if (opts.ignoreSignal !== true && signal) {
					signal.addEventListener(
						"abort",
						() => {
							clearTimeout(t);
							// Resolving is the common case; the loop must treat a signal-abort as an abort.
							reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
						},
						{ once: true },
					);
				}
			});
			if (opts.rejectMs !== undefined) {
				const rejecter = new Promise<never>((_resolve, reject) =>
					setTimeout(() => reject(new Error(`${name} blew up`)), opts.rejectMs),
				);
				return Promise.race([delay, rejecter]);
			}
			return delay;
		},
	};
}

function okTool(name: string): AnyAgentTool {
	return {
		name,
		label: name,
		description: `${name} test tool`,
		parameters: emptySchema,
		async execute() {
			return { content: [{ type: "text", text: "ok" }], details: undefined };
		},
	};
}

function baseConfig(
	_tools: AgentTool<any, any>[],
	opts: { convertToLlm?: (m: AgentMessage[]) => unknown[] } = {},
): AgentLoopConfig {
	return {
		model: createModel(),
		convertToLlm: (opts.convertToLlm ?? ((messages) => messages)) as AgentLoopConfig["convertToLlm"],
	};
}

beforeEach(() => {
	vi.useRealTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

describe("aborting a run while a tool is executing", () => {
	it("releases the loop immediately when a signal-ignoring tool is in flight (no 5s park)", async () => {
		const tool = slowTool("blind-slow", { ignoreSignal: true });
		const controller = new AbortController();
		const toolEnds: { isError: boolean; text: string }[] = [];
		const started = Date.now();

		const abortTimer = setTimeout(() => controller.abort(), 300);
		try {
			await runAgentLoop(
				[{ role: "user", content: "go", timestamp: Date.now() }],
				{ messages: [], tools: [tool] },
				baseConfig([tool]),
				(event) => {
					if (event.type === "tool_execution_end") {
						const text = (event.result.content as { text?: string }[]).map((c) => c.text ?? "").join(" ");
						toolEnds.push({ isError: event.isError, text });
					}
				},
				controller.signal,
				makeStreamFn("blind-slow"),
			);
		} finally {
			clearTimeout(abortTimer);
		}

		const elapsed = Date.now() - started;
		expect(elapsed).toBeLessThan(2500); // released by the abort, not by the tool's 5s completion
		expect(toolEnds).toHaveLength(1);
		expect(toolEnds[0].isError).toBe(true);
		expect(toolEnds[0].text).toContain("Operation aborted (interrupted tool call)");
	});

	it("emits a tool result for a signal-respecting tool and releases on abort", async () => {
		// A tool that rejects with AbortError on signal (the common well-behaved case): the
		// loop must treat this as an abort too, and never wait out the 5s.
		const tool = slowTool("polite-slow", { ignoreSignal: false });
		const controller = new AbortController();
		const toolEnds: { isError: boolean; text: string }[] = [];
		const started = Date.now();
		const abortTimer = setTimeout(() => controller.abort(), 300);
		try {
			await runAgentLoop(
				[{ role: "user", content: "go", timestamp: Date.now() }],
				{ messages: [], tools: [tool] },
				baseConfig([tool]),
				(event) => {
					if (event.type === "tool_execution_end") {
						const text = (event.result.content as { text?: string }[]).map((c) => c.text ?? "").join(" ");
						toolEnds.push({ isError: event.isError, text });
					}
				},
				controller.signal,
				makeStreamFn("polite-slow"),
			);
		} finally {
			clearTimeout(abortTimer);
		}
		const elapsed = Date.now() - started;
		expect(elapsed).toBeLessThan(2500);
		expect(toolEnds).toHaveLength(1);
		expect(toolEnds[0].isError).toBe(true);
		expect(toolEnds[0].text).toMatch(/abort/i);
	});

	it("does not leave an unhandled rejection when a signal-ignoring tool rejects after the abort", async () => {
		const onUnhandledRejection = vi.fn();
		process.on("unhandledRejection", onUnhandledRejection);
		try {
			const tool = slowTool("late-reject", { ignoreSignal: true, rejectMs: 250 });
			const controller = new AbortController();
			const abortTimer = setTimeout(() => controller.abort(), 100);
			try {
				await runAgentLoop(
					[{ role: "user", content: "go", timestamp: Date.now() }],
					{ messages: [], tools: [tool] },
					baseConfig([tool]),
					() => {},
					controller.signal,
					makeStreamFn("late-reject"),
				);
			} finally {
				clearTimeout(abortTimer);
			}
			await new Promise((r) => setTimeout(r, 120)); // give a stray rejection time to surface
			expect(onUnhandledRejection).not.toHaveBeenCalled();
		} finally {
			process.off("unhandledRejection", onUnhandledRejection);
		}
	});

	it("keeps normal completion intact: a fast tool without abort resolves as before", async () => {
		const tool = okTool("fast");
		const toolEnds: { isError: boolean; text: string }[] = [];
		let toolResults = 0;
		await runAgentLoop(
			[{ role: "user", content: "go", timestamp: Date.now() }],
			{ messages: [], tools: [tool] },
			baseConfig([tool]),
			(event) => {
				if (event.type === "message_end" && event.message.role === "toolResult") toolResults++;
				if (event.type === "tool_execution_end") {
					const text = (event.result.content as { text?: string }[]).map((c) => c.text ?? "").join(" ");
					toolEnds.push({ isError: event.isError, text });
				}
			},
			undefined,
			makeStreamFn("fast"),
		);
		expect(toolResults).toBe(1);
		expect(toolEnds).toHaveLength(1);
		expect(toolEnds[0].isError).toBe(false);
		expect(toolEnds[0].text).toBe("ok");
	});

	it("waits for the full duration when there is no signal at all (the race must not fire spuriously)", async () => {
		// Control: with no signal, a signal-ignoring tool parks the loop until it settles.
		// Here the tool resolves at ~800ms so the test stays fast.
		const tool: AnyAgentTool = {
			name: "no-signal-slow",
			label: "no-signal-slow",
			description: "tool",
			parameters: emptySchema,
			async execute() {
				await new Promise((r) => setTimeout(r, 800));
				return { content: [{ type: "text", text: "finished" }], details: undefined };
			},
		};
		const started = Date.now();
		const messages = await runAgentLoop(
			[{ role: "user", content: "go", timestamp: Date.now() }],
			{ messages: [], tools: [tool] },
			baseConfig([tool]),
			() => {},
			undefined,
			makeStreamFn("no-signal-slow"),
		);
		const elapsed = Date.now() - started;
		expect(elapsed).toBeGreaterThanOrEqual(780);
		const last = messages[messages.length - 1];
		expect(last.role).toBe("assistant");
		expect((last as AssistantMessage).stopReason).toBe("stop");
	});
});
