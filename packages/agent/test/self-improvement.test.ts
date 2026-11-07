import { describe, expect, it } from "vitest";
import { SelfImprovementTracker } from "../src/self-improvement.ts";

function scoreResult(score: number, id: string) {
	return { toolName: "score", toolCallId: id, details: { score, exitCode: 0 } };
}

describe("SelfImprovementTracker", () => {
	it("ignores non-score tool results", () => {
		const t = new SelfImprovementTracker();
		expect(t.observe({ toolName: "bash", toolCallId: "1", details: {} })).toBeUndefined();
		expect(t.summary().rounds).toBe(0);
	});

	it("ignores score results without a finite numeric score", () => {
		const t = new SelfImprovementTracker();
		expect(t.observe({ toolName: "score", toolCallId: "1", details: { score: null } })).toBeUndefined();
		expect(t.observe({ toolName: "score", toolCallId: "2", details: {} })).toBeUndefined();
		expect(t.observe({ toolName: "score", toolCallId: "3", details: { score: NaN } })).toBeUndefined();
		expect(t.summary().rounds).toBe(0);
	});

	it("tracks the best-so-far curve and T*", () => {
		const t = new SelfImprovementTracker();
		t.observe(scoreResult(10, "1"));
		t.observe(scoreResult(20, "2"));
		t.observe(scoreResult(15, "3")); // regression, not productive
		t.observe(scoreResult(25, "4"));
		t.observe(scoreResult(25, "5")); // plateau, not strict improvement

		const s = t.summary();
		expect(s.rounds).toBe(5);
		expect(s.best).toBe(25);
		expect(s.productiveRounds).toBe(3); // rounds 1,2,4
		expect(s.observations.map((o) => o.improved)).toEqual([true, true, false, true, false]);
		expect(s.observations.map((o) => o.best)).toEqual([10, 20, 20, 25, 25]);
	});

	it("marks the first observation as productive regardless of value", () => {
		const t = new SelfImprovementTracker();
		t.observe(scoreResult(-5, "1"));
		expect(t.summary().observations[0].improved).toBe(true);
		expect(t.summary().best).toBe(-5);
	});

	it("resets per task", () => {
		const t = new SelfImprovementTracker();
		t.observe(scoreResult(10, "1"));
		t.reset();
		expect(t.summary().rounds).toBe(0);
		expect(t.summary().best).toBeNull();
		t.observe(scoreResult(5, "2"));
		expect(t.summary().observations[0].round).toBe(0);
		expect(t.summary().best).toBe(5);
	});
});
