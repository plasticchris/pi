import { describe, expect, it } from "vitest";
import { createScoreTool, parseScore } from "../src/core/tools/index.ts";

describe("parseScore", () => {
	it("parses the last non-empty stdout line as a number", () => {
		expect(parseScore("all tests passed\n85.3")).toBe(85.3);
		expect(parseScore("7")).toBe(7);
	});

	it("strips a score: / score = prefix", () => {
		expect(parseScore("score: 0.7")).toBe(0.7);
		expect(parseScore("score = 42")).toBe(42);
	});

	it("falls back to the last finite number token", () => {
		expect(parseScore("passed 3 of 4 cases")).toBe(4);
		expect(parseScore("accuracy=0.91 n=100")).toBe(100);
	});

	it("returns undefined when no number is present", () => {
		expect(parseScore("no numbers here")).toBeUndefined();
		expect(parseScore("")).toBeUndefined();
	});

	it("ignores non-numeric trailing lines", () => {
		expect(parseScore("done\nexit 0\n12")).toBe(12);
	});
});

describe("score tool", () => {
	it("runs a scorer and reports score + structured content", async () => {
		const tool = createScoreTool(process.cwd());
		const result = await tool.execute("call-1", { command: "printf 'running tests...\\n91.5\\n'" });

		expect(result.isError).toBe(false);
		const details = result.details as { score?: number; exitCode: number };
		expect(details.score).toBe(91.5);
		expect(details.exitCode).toBe(0);
		const structured = (result as { structuredContent?: { score: number | null; exit_code: number } })
			.structuredContent;
		expect(structured?.score).toBe(91.5);
		expect(structured?.exit_code).toBe(0);
	});

	it("treats a non-zero exit with a parseable score as a low score, not a crash", async () => {
		const tool = createScoreTool(process.cwd());
		const result = await tool.execute("call-2", { command: "printf '3 of 5 passed\\n60\\n'; exit 1" });

		expect(result.isError).toBe(true);
		const details = result.details as { score?: number; exitCode: number };
		expect(details.score).toBe(60);
		expect(details.exitCode).toBe(1);
	});
});
