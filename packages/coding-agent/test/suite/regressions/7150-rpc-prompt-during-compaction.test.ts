import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { PromptDisposition } from "../../../src/core/agent-session.ts";
import { createHarness, getMessageText, getUserTexts, type Harness } from "../harness.ts";

// issue #7150: an RPC prompt arriving while manual compaction is in progress must not
// surface as a raw runtime error and must not be lost. Upstream fixed this by rejecting
// the prompt ("Cannot submit a prompt while compaction is in progress"); this fork
// supersedes that with deferral (18af7d95d): the prompt resolves, waits out the
// compaction, and is re-submitted before compact() resolves — so the RPC response
// reports "started" and the message is delivered exactly once.
describe("issue #7150: RPC prompt during manual compaction", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("defers an RPC prompt while manual compaction is in progress and delivers it after", async () => {
		let markCompactionStarted = () => {};
		const compactionStarted = new Promise<void>((resolve) => {
			markCompactionStarted = resolve;
		});
		let releaseCompaction = () => {};
		const compactionReleased = new Promise<void>((resolve) => {
			releaseCompaction = resolve;
		});

		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						markCompactionStarted();
						await compactionReleased;
						return {
							compaction: {
								summary: "manual compacted",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
								details: {},
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);

		const timestamp = Date.now();
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "old user message" }],
			timestamp: timestamp - 1000,
		});
		harness.sessionManager.appendMessage(
			fauxAssistantMessage("old assistant response", { timestamp: timestamp - 500 }),
		);
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		harness.setResponses([fauxAssistantMessage("probe response")]);

		const compactPromise = harness.session.compact();
		await compactionStarted;

		let preflightResult: PromptDisposition | undefined;
		let promptError: unknown;
		try {
			// No throw: the prompt is deferred while compaction is in progress.
			await harness.session.prompt("PROBE-7150", {
				source: "rpc",
				preflightResult: (result) => {
					preflightResult = result;
				},
			});
		} catch (error) {
			promptError = error;
		} finally {
			releaseCompaction();
			await compactPromise;
		}

		expect(promptError).toBeUndefined();
		// Delivered after compaction: the deferred re-submission ran inside compact().
		expect(preflightResult).toBe("started");

		const persistedUserTexts = harness.sessionManager
			.getEntries()
			.flatMap((entry) =>
				entry.type === "message" && entry.message.role === "user" ? [getMessageText(entry.message)] : [],
			);

		// The message was not lost, and it did not run concurrently with the compaction.
		expect(getUserTexts(harness)).toContain("PROBE-7150");
		expect(persistedUserTexts).toContain("PROBE-7150");
		expect(harness.eventsOfType("agent_start")).toHaveLength(1);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
	});
});
