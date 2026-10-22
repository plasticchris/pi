import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";
import {
	commands,
	createCommandRegistry,
	type DurableCommandContext,
	expandInput,
} from "../src/experimental/durable/command-registry.ts";
import { expandTemplateCommand, loadTemplatesForCwd } from "../src/experimental/durable/prompt-templates.ts";

// Importing the module registers the /name expander on the demo-wide seam (module-load
// registration per DESIGN.md §3 (b)); the singleton tests below exercise it end-to-end.

let tempDir: string;
let cwd: string;
let agentDir: string;
let settings: SettingsManager;

beforeAll(() => {
	tempDir = mkdtempSync(join(tmpdir(), "durable-templates-test-"));
	cwd = join(tempDir, "project");
	agentDir = join(tempDir, "agent");
	const projectPrompts = join(cwd, ".pi", "prompts");
	const globalPrompts = join(agentDir, "prompts");
	mkdirSync(projectPrompts, { recursive: true });
	mkdirSync(globalPrompts, { recursive: true });
	writeFileSync(
		join(projectPrompts, "demo.md"),
		`---\ndescription: Demo template\nargument-hint: <name> <other>\n---\nHello $1. All: $@. Second: \${2:-nobody}\n`,
	);
	writeFileSync(join(globalPrompts, "global.md"), "From global $1\n");
	settings = SettingsManager.create(cwd, agentDir);
});

afterAll(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

const ctxFor = (name: string, args: string): DurableCommandContext => ({
	name,
	args,
	view: {} as DurableCommandContext["view"],
	cwd,
	settings,
	controller: {} as DurableCommandContext["controller"],
	notice: () => {},
	restoreEditor: () => {},
});

describe("loadTemplatesForCwd", () => {
	it("loads project .pi/prompts and agent global prompts", () => {
		const templates = loadTemplatesForCwd(cwd, settings, agentDir);
		const names = templates.map((t) => t.name).sort();
		expect(names).toEqual(["demo", "global"]);
		const demo = templates.find((t) => t.name === "demo")!;
		expect(demo.description).toBe("Demo template");
		expect(demo.argumentHint).toBe("<name> <other>");
		expect(demo.content).toBe(`Hello $1. All: $@. Second: \${2:-nobody}`);
	});

	it("caches per cwd + agentDir", () => {
		expect(loadTemplatesForCwd(cwd, settings, agentDir)).toBe(loadTemplatesForCwd(cwd, settings, agentDir));
	});
});

describe("expandTemplateCommand (pi's /name rule)", () => {
	it(`expands /name with arg substitution ($1, $@, \${2:-default})`, () => {
		expect(expandTemplateCommand("/demo world", cwd, settings, agentDir)).toBe(
			"Hello world. All: world. Second: nobody",
		);
		expect(expandTemplateCommand("/demo world again", cwd, settings, agentDir)).toBe(
			"Hello world. All: world again. Second: again",
		);
	});

	it("parses quoted arguments bash-style", () => {
		expect(expandTemplateCommand('/demo "two words" x', cwd, settings, agentDir)).toBe(
			"Hello two words. All: two words x. Second: x",
		);
	});

	it("matches names exactly and case-sensitively; no prefix match", () => {
		expect(expandTemplateCommand("/Demo world", cwd, settings, agentDir)).toBe("/Demo world");
		expect(expandTemplateCommand("/demox", cwd, settings, agentDir)).toBe("/demox");
	});

	it("passes through unknown templates and non-command text unchanged", () => {
		expect(expandTemplateCommand("/nope x", cwd, settings, agentDir)).toBe("/nope x");
		expect(expandTemplateCommand("hello /demo world", cwd, settings, agentDir)).toBe("hello /demo world");
	});
});

describe("seam registration (module load)", () => {
	it("the registered expander expands /name through expandInput", () => {
		expect(expandInput("/demo world", ctxFor("demo", "world"))).toBe("Hello world. All: world. Second: nobody");
		expect(expandInput("/nope x", ctxFor("nope", "x"))).toBe("/nope x");
	});

	it("a registered command shadows a template of the same name (DESIGN.md §6.2)", () => {
		// The demo-wide registry holds no command named "demo" (pi extension commands could),
		// so dispatch falls through to the expander.
		expect(commands.get("demo")).toBeUndefined();
		// Simulating the S2 dispatch order (commands before expanders): a registry that does
		// have "demo" short-circuits and never reaches the expander.
		const registry = createCommandRegistry();
		let executed = false;
		registry.register({
			name: "demo",
			execute() {
				executed = true;
			},
		});
		const dispatched = registry.get("demo");
		expect(dispatched).toBeDefined();
		void dispatched!.execute(ctxFor("demo", "world"));
		expect(executed).toBe(true);
	});
});
