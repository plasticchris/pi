import { type Static, Type } from "typebox";
import { defineTool } from "../harness/define.ts";
import type { ToolExecutionResult, ToolRegistration } from "../harness/types.ts";
import { DEFAULT_MAX_BYTES } from "../truncate.ts";
import { requireEnv } from "./env.ts";

const MAX_TIMEOUT_SECONDS = 2_147_483_647 / 1000;

const scoreSchema = Type.Object({
	command: Type.String({
		description:
			"Scorer command to run (tests, typecheck, benchmark). Its last stdout line should be a numeric score.",
	}),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional)" })),
});

export type ScoreToolInput = Static<typeof scoreSchema>;

const scoreStructuredOutputSchema = Type.Object({
	score: Type.Union([Type.Number(), Type.Null()], {
		description: "Parsed score, or null when no number was found",
	}),
	exitCode: Type.Number(),
	output: Type.String({ description: "Combined stdout and stderr, retained tail" }),
});

export type ScoreStructuredOutput = Static<typeof scoreStructuredOutputSchema>;

/** Stored on the tool-result message so harnesses can read the curve without parsing text. */
export type ScoreToolDetails = {
	score: number | null;
	exitCode: number;
};

/**
 * Parse a score from scorer output. Last non-empty line first (a `score:`/`score =`
 * prefix is stripped), then the last finite number token anywhere in the output.
 */
export function parseScore(stdout: string): number | undefined {
	const lines = stdout.split(/\r?\n/);
	for (let i = lines.length - 1; i >= 0; i--) {
		const raw = lines[i].trim();
		if (!raw) continue;
		const stripped = raw.replace(/^score\s*[:=]\s*/i, "").trim();
		if (stripped === "") continue;
		const n = Number(stripped);
		if (Number.isFinite(n)) return n;
	}
	const tokens = stdout.match(/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g);
	if (tokens) {
		const n = Number(tokens[tokens.length - 1]);
		if (Number.isFinite(n)) return n;
	}
	return undefined;
}

/**
 * The `score` tool: the harness side of test-time self-improvement. It runs a
 * verifiable scorer and reports a numeric result as a first-class, machine-readable
 * signal (structuredOutput.score) rather than opaque stderr. The model's trained
 * reflection drives keep/revert; the harness just measures. A non-zero exit with a
 * parseable number is still a valid low score (a red suite with partial credit is a
 * legitimate observation), flagged isError.
 */
export function createScoreTool(): ToolRegistration<typeof scoreSchema, ScoreToolDetails> {
	return defineTool<typeof scoreSchema, ScoreToolDetails>({
		name: "score",
		description:
			"Run a verifiable scorer (tests, typecheck, benchmark) and report its numeric result as a first-class score signal. " +
			"Use it at round boundaries of an iterative task: do work, then submit to the scorer to see a score before deciding what to keep or revert. " +
			"The scorer's last stdout line should be a single number.",
		parameters: scoreSchema,
		structuredOutputSchema: scoreStructuredOutputSchema,
		outputLimits: { retain: "tail" },
		async execute(args, api, context): Promise<ToolExecutionResult<ScoreToolDetails>> {
			if (args.timeout !== undefined) {
				if (!Number.isFinite(args.timeout) || args.timeout <= 0) {
					throw new Error("Invalid timeout: must be a finite number of seconds");
				}
				if (args.timeout > MAX_TIMEOUT_SECONDS) {
					throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`);
				}
			}
			const env = requireEnv(api);
			let buffer = "";
			const result = await env.exec(
				args.command,
				{
					cwd: env.cwd,
					timeout: args.timeout,
					onOutput: (text) => {
						buffer += text;
						if (buffer.length > DEFAULT_MAX_BYTES) {
							buffer = buffer.slice(-DEFAULT_MAX_BYTES);
						}
					},
				},
				context,
			);

			let exitCode: number;
			if (result.ok) {
				exitCode = result.value.exitCode;
			} else {
				if (result.error.code === "aborted" && context.abortSignal?.aborted) throw result.error;
				if (result.error.code === "timeout") throw new Error(`Command timed out after ${args.timeout} seconds`);
				if (result.error.code === "aborted") throw new Error("Command aborted");
				throw result.error;
			}

			const score = parseScore(buffer);
			const report = [
				`$ ${args.command}`,
				buffer || "(no output)",
				``,
				`exit code: ${exitCode}`,
				score !== undefined ? `score: ${score}` : "no numeric score found in output",
			].join("\n");

			return {
				output: [{ type: "text", text: report }],
				structuredOutput: { score: score ?? null, exitCode, output: buffer },
				details: { score: score ?? null, exitCode },
				isError: exitCode !== 0,
			};
		},
	});
}
