import { describe, expect, it } from "vitest";
import {
	commands,
	createCommandRegistry,
	createPanelRegistry,
	type DurableCommandContext,
	expandInput,
	panels,
	registerCommand,
	registerInputExpander,
	registerPanel,
} from "../src/experimental/durable/command-registry.ts";

const noopCtx: DurableCommandContext = {
	name: "",
	args: "",
	view: {} as DurableCommandContext["view"],
	cwd: "/tmp",
	settings: {} as DurableCommandContext["settings"],
	controller: {} as DurableCommandContext["controller"],
	notice: () => {},
	restoreEditor: () => {},
};

describe("command registry (factories)", () => {
	it("registers, gets, and lists commands", () => {
		const registry = createCommandRegistry();
		registry.register({ name: "alpha", description: "first", execute: () => {} });
		registry.register({ name: "beta", execute: () => {} });
		expect(registry.get("alpha")?.description).toBe("first");
		expect(registry.get("nope")).toBeUndefined();
		expect(registry.list().map((command) => command.name)).toEqual(["alpha", "beta"]);
	});

	it("first registration wins on name clash", async () => {
		const registry = createCommandRegistry();
		const calls: string[] = [];
		registry.register({
			name: "dup",
			execute: () => {
				calls.push("first");
			},
		});
		registry.register({
			name: "dup",
			execute: () => {
				calls.push("second");
			},
		});
		expect(registry.list().length).toBe(1);
		await registry.get("dup")!.execute(noopCtx);
		expect(calls).toEqual(["first"]);
	});
});

describe("panel registry (factory)", () => {
	it("registers and looks up panels; first wins", () => {
		const registry = createPanelRegistry();
		registry.register({ command: "settings", build: () => ({}) as never });
		registry.register({ command: "settings", build: () => ({}) as never });
		expect(registry.get("settings")).toBeDefined();
		expect(registry.get("other")).toBeUndefined();
	});
});

describe("demo-wide singletons", () => {
	it("registerCommand lands in the TUI-dispatched registry", async () => {
		let ran: DurableCommandContext | undefined;
		registerCommand({
			name: "test-singleton-command",
			description: "test",
			execute: (ctx) => {
				ran = ctx;
			},
		});
		const command = commands.get("test-singleton-command");
		expect(command).toBeDefined();
		await command!.execute({ ...noopCtx, name: "test-singleton-command", args: " x" });
		expect(ran?.args).toBe(" x");
	});

	it("registerPanel lands in the TUI-dispatched registry", () => {
		let built: unknown;
		registerPanel({
			command: "test-singleton-panel",
			build: () => {
				built = { ok: true };
				return built as never;
			},
		});
		const panel = panels.get("test-singleton-panel");
		expect(panel).toBeDefined();
		const component = panel!.build(noopCtx);
		expect(built).toEqual({ ok: true });
		expect(component).toBe(built);
	});

	it("expandInput runs expanders in registration order", () => {
		// Unique markers: other tests in this file never register expanders.
		registerInputExpander((text) => `${text}+a`);
		registerInputExpander((text) => `${text}+b`);
		expect(expandInput("base", noopCtx)).toBe("base+a+b");
	});
});
