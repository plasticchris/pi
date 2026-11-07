import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import { createLocalBashOperations } from "./bash.ts";
import { scoreRenderers } from "./renderers/score.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { DEFAULT_MAX_BYTES, truncateHead } from "./truncate.ts";

/**
 * The `score` tool is the harness side of test-time self-improvement: it runs a
 * verifiable scorer (tests, typecheck, a benchmark) and reports a numeric
 * result as a first-class, machine-readable signal — not opaque stderr. The
 * model's trained reflection (AREX-2-style) drives keep/revert; the harness
 * just measures. `SelfImprovementTracker` folds these results into the
 * best-so-far curve and T* (productive rounds).
 *
 * Scorer contract: the command's LAST non-empty stdout line should be the score
 * as a single number (e.g. `85.3`, `0.7`, `7`). A `score:`/`score =` prefix is
 * stripped. If no line parses, the last finite number token in stdout is used.
 * A non-zero exit code is still a valid (failing) score when a number parses —
 * a red test suite with a partial score is a legitimate low observation.
 */

const scoreSchema = Type.Object({
	command: Type.String({
		description:
			"Scorer command to run (tests, typecheck, benchmark). Its last stdout line should be a numeric score.",
	}),
	cwd: Type.Optional(Type.String({ description: "Working directory (default: current directory)" })),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional)" })),
});

export type ScoreToolInput = Static<typeof scoreSchema>;

const scoreOutputSchema = Type.Object({
	score: Type.Union([Type.Number(), Type.Null()], { description: "Parsed score, or null when no number was found" }),
	exit_code: Type.Number(),
	output: Type.String({ description: "Combined stdout/stderr, possibly truncated" }),
});

export type ScoreToolOutput = Static<typeof scoreOutputSchema>;

export interface ScoreToolOptions {
	shellPath?: string;
}

export interface ScoreToolDetails {
	score?: number;
	exitCode: number;
	output: string;
	truncated: boolean;
}

const SCORE_OUTPUT_MAX_BYTES = 256 * 1024;

/** Parse a score from scorer output. Last non-empty line first, then last number token. */
export function parseScore(stdout: string): number | undefined {
	const lines = stdout.split(/\r?\n/);
	for (let i = lines.length - 1; i >= 0; i--) {
		const raw = lines[i].trim();
		if (!raw) continue;
		const stripped = raw.replace(/^score\s*[:=]\s*/i, "").trim();
		const n = Number(stripped);
		if (stripped !== "" && Number.isFinite(n)) return n;
	}
	// Fallback: last finite number token anywhere in the output.
	const tokens = stdout.match(/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g);
	if (tokens) {
		const n = Number(tokens[tokens.length - 1]);
		if (Number.isFinite(n)) return n;
	}
	return undefined;
}

export function createScoreToolDefinition(cwd: string, options?: ScoreToolOptions): ToolDefinition {
	const ops = createLocalBashOperations({ shellPath: options?.shellPath });
	return {
		name: "score",
		label: "Score",
		description:
			"Run a verifiable scorer (tests, typecheck, benchmark) and report its numeric result as a first-class score signal. " +
			"Use it at round boundaries of an iterative task: do work, then submit to the scorer to see a score before deciding what to keep or revert. " +
			"The scorer's last stdout line should be a single number.",
		parameters: scoreSchema,
		outputSchema: scoreOutputSchema,
		async execute(
			_toolCallId,
			{ command, cwd: runCwd, timeout }: ScoreToolInput,
			signal?: AbortSignal,
			_onUpdate?,
			ctx?: ExtensionContext,
		) {
			const workDir = runCwd || ctx?.cwd || cwd;
			let buffer = "";
			let truncated = false;
			const onData = (data: Buffer) => {
				buffer += data.toString("utf8");
				if (buffer.length > SCORE_OUTPUT_MAX_BYTES) {
					buffer = buffer.slice(0, SCORE_OUTPUT_MAX_BYTES);
					truncated = true;
				}
			};
			let exitCode: number | null;
			try {
				const result = await ops.exec(command, workDir, { onData, signal, timeout });
				exitCode = result.exitCode;
			} catch (err) {
				if (err instanceof Error && err.message === "aborted") throw new Error("Scorer aborted");
				throw err;
			}
			if (exitCode === null) exitCode = 1;

			const score = parseScore(buffer);
			const { content: modelOutput } = truncateHead(buffer, { maxBytes: DEFAULT_MAX_BYTES });
			const report = [
				`$ ${command}`,
				modelOutput || "(no output)",
				``,
				`exit code: ${exitCode}`,
				score !== undefined ? `score: ${score}` : "no numeric score found in output",
			].join("\n");

			const details: ScoreToolDetails = {
				...(score !== undefined ? { score } : {}),
				exitCode,
				output: modelOutput,
				truncated,
			};
			const structuredContent: ScoreToolOutput = {
				score: score ?? null,
				exit_code: exitCode,
				output: modelOutput,
			};
			return {
				content: [{ type: "text", text: report }],
				details,
				structuredContent,
				isError: exitCode !== 0,
			};
		},
		...scoreRenderers,
	};
}

export function createScoreTool(cwd: string, options?: ScoreToolOptions): AgentTool<typeof scoreSchema> {
	return wrapToolDefinition(createScoreToolDefinition(cwd, options));
}
