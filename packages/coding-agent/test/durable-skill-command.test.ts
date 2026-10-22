/**
 * U1: /skill:<name> input expander (durable-skill-command).
 * Covers: known-skill expansion (frontmatter strip, block shape, args), unknown-skill
 * passthrough + notice, enableSkillCommands: false passthrough + notice, non-command
 * passthrough, and explicit skill paths from settings.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DurableCommandContext, NoticeLevel } from "../src/experimental/durable/command-registry.ts";
import { expandSkillCommand } from "../src/experimental/durable/skill-command.ts";

let workDir: string;
let notices: { level: NoticeLevel; message: string }[];
let settings: {
	enableSkillCommands: boolean;
	skillPaths: string[];
	settings: DurableCommandContext["settings"];
};

beforeEach(() => {
	workDir = mkdtempSync(join(tmpdir(), "durable-skill-u1-"));
	process.env.PI_CODING_AGENT_DIR = join(workDir, "agent");
	notices = [];
	settings = {
		enableSkillCommands: true,
		skillPaths: [],
		settings: {
			getEnableSkillCommands: () => settings.enableSkillCommands,
			getSkillPaths: () => settings.skillPaths,
		} as DurableCommandContext["settings"],
	};
});

afterEach(() => {
	delete process.env.PI_CODING_AGENT_DIR;
	rmSync(workDir, { recursive: true, force: true });
});

function ctx(overrides: { args?: string; cwd?: string } = {}): DurableCommandContext {
	return {
		name: "skill:x",
		args: overrides.args ?? "",
		view: {} as DurableCommandContext["view"],
		cwd: overrides.cwd ?? workDir,
		settings: settings.settings,
		controller: {} as DurableCommandContext["controller"],
		notice: (level, message) => notices.push({ level, message }),
		restoreEditor: () => {},
	};
}

function writeProjectSkill(name: string, body: string): string {
	const dir = join(workDir, ".pi", "skills", name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: test skill\n---\n${body}`);
	return dir;
}

describe("expandSkillCommand", () => {
	it("expands a known project skill, stripping frontmatter, with the pi block shape", () => {
		writeProjectSkill("greet", "Do the thing well.");
		const expanded = expandSkillCommand("/skill:greet", ctx());
		expect(expanded).toBe(
			`<skill name="greet" location="${join(workDir, ".pi", "skills", "greet", "SKILL.md")}">` +
				"\nReferences are relative to " +
				join(workDir, ".pi", "skills", "greet") +
				"." +
				"\n\nDo the thing well.\n</skill>",
		);
		expect(notices).toEqual([]);
	});

	it("appends args after the skill block", () => {
		writeProjectSkill("greet", "Body.");
		const expanded = expandSkillCommand("/skill:greet do it now", ctx());
		expect(expanded.endsWith("</skill>\n\ndo it now")).toBe(true);
	});

	it("loads a skill from an explicit settings skill path", () => {
		const extraDir = join(workDir, "extra");
		mkdirSync(extraDir, { recursive: true });
		const file = join(extraDir, "extra-skill.md");
		writeFileSync(file, "---\nname: extra-skill\ndescription: from a path\n---\nPath body.");
		settings.skillPaths = [file];
		const expanded = expandSkillCommand("/skill:extra-skill", ctx());
		expect(expanded).toContain(`<skill name="extra-skill"`);
		expect(expanded).toContain("Path body.");
	});

	it("passes unknown skills through and notices 'unknown skill'", () => {
		const text = "/skill:nope args";
		expect(expandSkillCommand(text, ctx())).toBe(text);
		expect(notices).toEqual([{ level: "error", message: "Unknown skill: nope" }]);
	});

	it("does not expand when enableSkillCommands is false", () => {
		writeProjectSkill("greet", "Body.");
		settings.enableSkillCommands = false;
		const text = "/skill:greet";
		expect(expandSkillCommand(text, ctx())).toBe(text);
		expect(notices).toEqual([
			{ level: "warning", message: "Skill commands are disabled; /skill:greet was not expanded" },
		]);
	});

	it("returns non-skill text untouched", () => {
		expect(expandSkillCommand("hello world", ctx())).toBe("hello world");
		expect(expandSkillCommand("/help", ctx())).toBe("/help");
		expect(notices).toEqual([]);
	});
});
