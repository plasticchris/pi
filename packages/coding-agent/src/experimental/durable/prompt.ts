import { defineExtension, type PromptInput, section } from "@earendil-works/pi-durable";
import { getAgentDir } from "../../config.ts";
import { loadProjectContextFiles } from "../../core/resource-loader.ts";
import type { SettingsManager } from "../../core/settings-manager.ts";
import { loadSkills, type Skill } from "../../core/skills.ts";
import { buildSystemPromptSections } from "../../core/system-prompt.ts";
import { bashToolSystemPromptContribution } from "../../core/tools/bash.ts";
import { editToolSystemPromptContribution } from "../../core/tools/edit.ts";
import { readToolSystemPromptContribution } from "../../core/tools/read.ts";
import { writeToolSystemPromptContribution } from "../../core/tools/write.ts";
import type { ExtensionHost } from "./extension-host.ts";

const CONTRIBUTIONS = {
	read: readToolSystemPromptContribution,
	bash: bashToolSystemPromptContribution,
	edit: editToolSystemPromptContribution,
	write: writeToolSystemPromptContribution,
};

/**
 * pi's section order, with `addendum` where pi places the append system prompt;
 * `buildSystemPromptSections()` omits the ones without content.
 */
const KEYS = ["preamble", "tools", "rules", "docs", "addendum", "project_context", "skills", "cwd"] as const;

/**
 * pi's system prompt as one extension: the sections of `buildSystemPromptSections()` for the request's tools and the
 * conversation's directory. For the session directory the resources come from the extension host's ResourceLoader
 * (skills, context files, discovered system-prompt overrides); other directories keep the direct per-cwd load.
 */
export function createPiPrompt(settings: SettingsManager, fallbackCwd: string, host: ExtensionHost) {
	const resources = new Map<string, { contextFiles: { path: string; content: string }[]; skills: Skill[] }>();
	const load = (cwd: string) => {
		if (cwd === fallbackCwd) {
			const loaderResources = host.resources();
			return { contextFiles: [...loaderResources.agentsFiles], skills: [...loaderResources.skills] };
		}
		let found = resources.get(cwd);
		if (found === undefined) {
			const agentDir = getAgentDir();
			found = {
				contextFiles: loadProjectContextFiles({ cwd, agentDir }),
				skills: loadSkills({ cwd, agentDir, skillPaths: settings.getSkillPaths(), includeDefaults: true }).skills,
			};
			resources.set(cwd, found);
		}
		return found;
	};
	// The sections of one request render from one build.
	const built = new WeakMap<PromptInput, Record<string, string>>();
	const build = (input: PromptInput): Record<string, string> => {
		let sections = built.get(input);
		if (sections === undefined) {
			sections = buildSections(input);
			built.set(input, sections);
		}
		return sections;
	};
	const buildSections = (input: PromptInput): Record<string, string> => {
		const cwd = input.env?.cwd ?? input.agent.cwd ?? fallbackCwd;
		const selectedTools = input.agent.tools.map((tool) => tool.name);
		const snippets: Record<string, string> = {};
		const guidelines: Record<string, string[]> = {};
		for (const name of selectedTools) {
			const contribution = CONTRIBUTIONS[name as keyof typeof CONTRIBUTIONS];
			if (contribution !== undefined) {
				snippets[name] = contribution.snippet;
				guidelines[name] = [...contribution.guidelines];
			}
			// Bridged extension tools contribute their prompt fields, like pi's custom tools.
			const bridged = host.toolPrompts().get(name);
			if (bridged?.snippet !== undefined) snippets[name] = bridged.snippet;
			if (bridged?.guidelines !== undefined) guidelines[name] = [...(guidelines[name] ?? []), ...bridged.guidelines];
		}
		const hostResources = host.resources();
		const appendSystemPrompt = hostResources.appendSystemPrompt.join("\n\n");
		return buildSystemPromptSections({
			cwd,
			selectedTools,
			toolSnippets: snippets,
			toolGuidelines: guidelines,
			// pi semantics: a discovered SYSTEM.md replaces the preamble and tools/rules/docs sections;
			// project context, skills, and cwd still render (DESIGN §4, decision D13).
			...(hostResources.systemPrompt === undefined ? {} : { customPrompt: hostResources.systemPrompt }),
			...(appendSystemPrompt === "" ? {} : { appendSystemPrompt }),
			...load(cwd),
		});
	};
	return defineExtension({
		name: "pi-prompt",
		// The built sections carry their own tags.
		sections: KEYS.map((key) => section(key, (input) => build(input)[key], { tag: false })),
	});
}
