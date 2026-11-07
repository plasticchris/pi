/**
 * Presentation for the score tool.
 *
 * Renderers live apart from the implementation so a process that only displays tool output does not
 * load the execution path or its typebox parameter schema. `score.ts` spreads these into its
 * definition, so the tool's public shape is unchanged.
 */

import { Text } from "@earendil-works/pi-tui";
import type { Theme } from "../../../modes/interactive/theme/theme.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../../extensions/types.ts";
import { getTextOutput } from "../render-utils.ts";
import type { ScoreToolDetails } from "../score.ts";

function formatScoreCall(args: { command?: string } | undefined, theme: Theme): string {
	const cmd = args?.command ?? "";
	return `${theme.fg("toolTitle", theme.bold("score"))} ${cmd}`;
}

function formatScoreResult(
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: ScoreToolDetails;
	},
	options: ToolRenderResultOptions,
	theme: Theme,
	showImages: boolean,
): string {
	const score = result.details?.score;
	const exitCode = result.details?.exitCode;
	const headline =
		score !== undefined
			? `${theme.fg("toolTitle", theme.bold("score"))} ${theme.fg("success", String(score))}`
			: `${theme.fg("toolTitle", theme.bold("score"))} ${theme.fg("warning", "no numeric score")}`;
	const status = exitCode !== undefined && exitCode !== 0 ? theme.fg("warning", ` (exit ${exitCode})`) : "";

	const output = getTextOutput(result, showImages).trim();
	let text = headline + status;
	if (output) {
		const lines = output.split("\n");
		const maxLines = options.expanded ? lines.length : 20;
		const displayLines = lines.slice(0, maxLines);
		const remaining = lines.length - maxLines;
		text += `\n${displayLines.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
		if (remaining > 0) {
			text += `\n${theme.fg("muted", `... (${remaining} more lines)`)}`;
		}
	}
	return text;
}

export const scoreRenderers: Pick<ToolDefinition<any, any>, "renderCall" | "renderResult"> = {
	renderCall(args, theme, context) {
		const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
		text.setText(formatScoreCall(args as any, theme));
		return text;
	},
	renderResult(result, options, theme, context) {
		const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
		text.setText(formatScoreResult(result as any, options, theme, context.showImages));
		return text;
	},
};
