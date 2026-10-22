/**
 * Prompt template (/name) expansion for the durable demo — templates track (DESIGN.md §3 (b), D10).
 *
 * Mirrors pi's /name behavior (core/prompt-templates.ts, re-verified post-merge):
 * - A template's name is its .md file's basename without ".md" (frontmatter `name` is not
 *   consulted); matching is exact and case-sensitive on the first word of the submitted text.
 * - Everything after `/name` is parsed bash-style (parseCommandArgs) and substituted into the
 *   template body ($1..$N, $@/$ARGUMENTS, ${N:-default}, ${@:N}, ${@:N:L}).
 * - Expansion happens at submit time: the expander returns the expanded text and the TUI submits
 *   it (steer / followUp), the same shape as pi, which submits the expanded prompt.
 * - Text matching no template is returned unchanged. The TUI dispatch (DESIGN.md §6.2) then
 *   rejects a still-`/`-prefixed line with an "Unknown command" notice instead of submitting it
 *   as literal text — a documented deviation from pi (pi sends an unmatched /x through as text;
 *   the S2 dispatch contract chose the notice behavior for all unknown slash commands).
 *
 * This module registers its expander at module load through the core seam
 * (registerInputExpander); S4 imports it from main.ts (DESIGN.md D11) so registration runs
 * before the TUI starts. Templates are loaded with the core loader directly (no host accessor —
 * D10), cached per cwd + agentDir like prompt.ts caches skills.
 */
import { getAgentDir } from "../../config.ts";
import { expandPromptTemplate, loadPromptTemplates, type PromptTemplate } from "../../core/prompt-templates.ts";
import type { SettingsManager } from "../../core/settings-manager.ts";
import { registerInputExpander } from "./command-registry.ts";

const templatesByCwd = new Map<string, readonly PromptTemplate[]>();

/**
 * Load prompt templates for `cwd` (agentDir/prompts, cwd/.pi/prompts, plus the settings'
 * configured prompt paths) and cache them per cwd + agentDir.
 */
export function loadTemplatesForCwd(
	cwd: string,
	settings: SettingsManager,
	agentDir: string = getAgentDir(),
): readonly PromptTemplate[] {
	const key = `${agentDir}\0${cwd}`;
	let found = templatesByCwd.get(key);
	if (found === undefined) {
		const { templates } = loadPromptTemplates({
			cwd,
			agentDir,
			promptPaths: settings.getPromptTemplatePaths(),
			includeDefaults: true,
		});
		found = templates;
		templatesByCwd.set(key, found);
	}
	return found;
}

/**
 * Expand a leading `/name [args]` into the template's body with pi's argument substitution.
 * Returns the text unchanged when it is not a template (the TUI then handles it as an unknown
 * command or normal text, per DESIGN.md §6.2).
 */
export function expandTemplateCommand(
	text: string,
	cwd: string,
	settings: SettingsManager,
	agentDir: string = getAgentDir(),
): string {
	return expandPromptTemplate(text, [...loadTemplatesForCwd(cwd, settings, agentDir)]);
}

/** The seam registration: /name expansion at submit time, per conversation cwd (D10/§6.1). */
registerInputExpander((text, ctx) => expandTemplateCommand(text, ctx.cwd, ctx.settings));
