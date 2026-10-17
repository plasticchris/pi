import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { describe, expect, it } from "vitest";
import { processResponsesStream } from "../src/api/openai-responses-shared.ts";
import type { AssistantMessage, Model, ServerCompaction } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";

function createModel(): Model<"openai-responses"> {
	return {
		id: "qwen3.8-27b",
		name: "qwen3.8-27b",
		api: "openai-responses",
		provider: "qwen3.8-27b-mtp",
		baseUrl: "http://127.0.0.1:8045/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 262144,
		maxTokens: 81920,
	};
}

function createOutput(model: Model<"openai-responses">): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "pending",
		timestamp: Date.now(),
	};
}

const compactionItem = {
	type: "compaction",
	id: "cmpct_abc123",
	status: "completed",
	encrypted_content: "## Goal\nFix the bug in /a/b.py.\n## Next\nRun the test suite.",
	pi: { input_tokens: 1200, items_compacted: 5, items_retained: 3 },
};

const messageItem = {
	type: "message",
	id: "msg_pi_0",
	status: "completed",
	role: "assistant",
	content: [{ type: "output_text", text: "Done.", annotations: [] }],
};

/**
 * variant:
 *  - "full": compaction item in added/done events AND in the completed response
 *  - "completed-only": only in the completed response (Azure-style omission)
 *  - "none": no compaction anywhere
 */
async function* compactionEvents(variant: "full" | "completed-only" | "none"): AsyncIterable<ResponseStreamEvent> {
	let seq = 0;
	const withAdded = variant === "full";
	const inCompleted = variant !== "none";
	const output = inCompleted ? [compactionItem, messageItem] : [messageItem];
	const msgIndex = inCompleted ? 1 : 0;
	if (withAdded) {
		yield {
			type: "response.output_item.added",
			output_index: 0,
			sequence_number: seq++,
			item: compactionItem,
		} as ResponseStreamEvent;
		yield {
			type: "response.output_item.done",
			output_index: 0,
			sequence_number: seq++,
			item: compactionItem,
		} as ResponseStreamEvent;
	}
	yield {
		type: "response.output_item.added",
		output_index: msgIndex,
		sequence_number: seq++,
		item: { ...messageItem, status: "in_progress", content: [] },
	} as ResponseStreamEvent;
	yield {
		type: "response.output_text.delta",
		output_index: msgIndex,
		content_index: 0,
		item_id: messageItem.id,
		sequence_number: seq++,
		delta: "Done.",
	} as ResponseStreamEvent;
	yield {
		type: "response.output_item.done",
		output_index: msgIndex,
		sequence_number: seq++,
		item: messageItem,
	} as ResponseStreamEvent;
	yield {
		type: "response.completed",
		sequence_number: seq++,
		response: { id: "resp_test", status: "completed", output },
	} as unknown as ResponseStreamEvent;
}

async function run(variant: "full" | "completed-only" | "none", onServerCompaction?: (c: ServerCompaction) => void) {
	const model = createModel();
	const output = createOutput(model);
	const stream = new AssistantMessageEventStream();
	await processResponsesStream(compactionEvents(variant), output, stream, model, {
		requestItemCounts: [1, 1, 1, 1, 1, 1, 1],
		onServerCompaction: onServerCompaction as (c: ServerCompaction, m: Model<any>) => void,
	});
	return output;
}

describe("server-side compaction capture (openai-responses)", () => {
	it("captures the compaction item and forwards request item counts", async () => {
		let captured: ServerCompaction | undefined;
		const output = await run("full", (c) => {
			captured = c;
		});

		expect(captured?.id).toBe("cmpct_abc123");
		expect(captured?.summary).toContain("## Goal");
		expect(captured?.summary).toContain("/a/b.py");
		expect(captured?.inputTokens).toBe(1200);
		expect(captured?.itemsCompacted).toBe(5);
		expect(captured?.itemsRetained).toBe(3);
		expect(captured?.inputItemCounts).toEqual([1, 1, 1, 1, 1, 1, 1]);
		// The compaction item must not create a content slot; only the answer message does.
		expect(output.content.map((b) => b.type)).toEqual(["text"]);
		expect(output.stopReason).toBe("stop");
	});

	it("falls back to the terminal response output when added/done events omit it", async () => {
		let captured: ServerCompaction | undefined;
		await run("completed-only", (c) => {
			captured = c;
		});
		expect(captured?.id).toBe("cmpct_abc123");
		expect(captured?.summary).toContain("/a/b.py");
	});

	it("does not invoke the callback when the server did not compact", async () => {
		let calls = 0;
		const output = await run("none", () => calls++);
		expect(calls).toBe(0);
		expect(output.content.map((b) => b.type)).toEqual(["text"]);
	});
});
