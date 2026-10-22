/**
 * /skill:<name> input expander (ui track, DESIGN.md §3b, §7).
 *
 * Mirrors `AgentSession._expandSkillCommand` (core/agent-session.ts): at submit time,
 * `/skill:<name> [args]` is replaced with the skill's body wrapped in a `<skill>` block.
 * Skills are loaded directly from pi's `loadSkills` (DESIGN.md decision D10) using the
 * dispatch context's cwd and the live settings' skill paths — no host access needed.
 * The demo re-runs `expandInput` on both submit and followUp, so the single registration
 * here covers both paths.
 */
import { readFileSync } from "node:fs";
import { getAgentDir } from "../../config.ts";
import { loadSkills } from "../../core/skills.ts";
import { stripFrontmatter } from "../../utils/frontmatter.ts";
import { type DurableCommandContext, registerInputExpander } from "./command-registry.ts";

export function expandSkillCommand(text: string, ctx: DurableCommandContext): string {
	if (!text.startsWith("/skill:")) return text;

	const spaceIndex = text.indexOf(" ");
	const skillName = spaceIndex === -1 ? text.slice(7) : text.slice(7, spaceIndex);
	const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim();

	if (!ctx.settings.getEnableSkillCommands()) {
		ctx.notice("warning", `Skill commands are disabled; /skill:${skillName} was not expanded`);
		return text;
	}

	// Unknown skill: pass through; the TUI's dispatch then reports "Unknown command".
	if (!skillName) return text;

	const skills = loadSkills({
		cwd: ctx.cwd,
		agentDir: getAgentDir(),
		skillPaths: ctx.settings.getSkillPaths(),
		includeDefaults: true,
	}).skills;

	const skill = skills.find((entry) => entry.name === skillName);
	if (!skill) {
		ctx.notice("error", `Unknown skill: ${skillName}`);
		return text;
	}

	try {
		const content = readFileSync(skill.filePath, "utf-8");
		const body = stripFrontmatter(content).trim();
		const skillBlock = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
		return args ? `${skillBlock}\n\n${args}` : skillBlock;
	} catch (err) {
		ctx.notice(
			"error",
			`Skill ${skillName} could not be read (${skill.filePath}): ${err instanceof Error ? err.message : String(err)}`,
		);
		return text;
	}
}

registerInputExpander(expandSkillCommand);
