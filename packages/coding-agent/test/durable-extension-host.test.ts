import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type Conversation, createRegistry, type Registry, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createEventBus, type EventBus } from "../src/core/event-bus.ts";
import type { ModelRuntime } from "../src/core/model-runtime.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { commands, type DurableCommandContext } from "../src/experimental/durable/command-registry.ts";
import {
	createExtensionHost,
	type ExtensionHost,
	type ExtensionHostBinding,
} from "../src/experimental/durable/extension-host.ts";
import type { DurableController, DurableView, DurableViewSource } from "../src/experimental/durable/runtime.ts";

const extensionCode = `
import { Type } from "typebox";

export default function (pi) {
	pi.on("session_start", (event) => {
		pi.events.emit("test-session-start", { reason: event.reason });
	});
	pi.registerCommand("dtest-hello", {
		description: "Say hello",
		handler: async (args, ctx) => {
			pi.events.emit("test-hello", { args, cwd: ctx.cwd, mode: ctx.mode, hasUi: ctx.hasUI });
		},
	});
	pi.registerCommand("dtest-late", {
		handler: async () => {
			pi.registerTool({
				name: "dtest-late-tool",
				label: "Late",
				description: "Registered late",
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: "late" }] }),
			});
		},
	});
	pi.registerCommand("dtest-passive", {
		handler: async (args) => {
			pi.sendMessage({ customType: "dtest-msg", content: \`passive:\${args}\`, display: true });
		},
	});
	pi.registerCommand("dtest-turn", {
		handler: async (args) => {
			pi.sendMessage({ customType: "dtest-msg", content: \`turn:\${args}\`, display: true }, { triggerTurn: true });
		},
	});
	pi.registerCommand("dtest-entry", {
		handler: async (args) => {
			pi.appendEntry("dtest-kind", { args });
		},
	});
	pi.registerCommand("dtest-model", {
		handler: async (args) => {
			const [provider, id] = args.split("/");
			const model = {
				provider,
				id,
				name: "m",
				api: "openai-completions",
				baseUrl: "http://x",
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				reasoning: false,
				contextWindow: 1000,
				maxTokens: 100,
			};
			pi.events.emit("test-model", { ok: await pi.setModel(model) });
		},
	});
	pi.registerTool({
		name: "dtest-echo",
		label: "Echo",
		description: "Echo the input",
		parameters: Type.Object({ text: Type.String() }),
		prepareArguments: (args) => ({ text: String(args.text) }),
		execute: async (id, params, signal, onUpdate) => {
			onUpdate?.({ content: [{ type: "text", text: "progress" }], details: { id, updating: true } });
			return {
				content: [{ type: "text", text: \`echo:\${params.text}\` }],
				details: { id },
			};
		},
	});
	pi.registerTool({
		name: "dtest-boomerang",
		label: "Boomerang",
		description: "Echo and terminate",
		parameters: Type.Object({ text: Type.String() }),
		exposure: "model-only",
		execute: async (_id, params) => ({
			content: [{ type: "text", text: \`boomerang:\${params.text}\` }],
			terminate: true,
		}),
	});
	pi.registerTool({
		name: "dtest-boom",
		label: "Boom",
		description: "Always fails",
		parameters: Type.Object({}),
		execute: async () => {
			throw new Error("boom");
		},
	});
	pi.registerTool({
		name: "dtest-rendered",
		label: "Rendered",
		description: "Has an unsupported renderer",
		parameters: Type.Object({}),
		renderCall: () => null,
		execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
	});
}
`;

describe("durable extension host", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;
	let extensionPath: string;

	// The host (created once, below) captures these fakes in its binding, so they live for the
	// whole file; only the recorded output is cleared between tests.
	const notices: { level: string; message: string }[] = [];
	const eventBus: EventBus = createEventBus();
	const received = new Map<string, unknown[]>();
	const view0: DurableView = {
		session: { id: "s1", directory: "/tmp/s", cwd: "/tmp/project" },
		conversation: { conversation: { id: 1 }, entries: [], docs: {} },
		conversations: [],
		models: [],
		notices: [],
	} as unknown as DurableView;
	const viewSource: DurableViewSource = { current: () => view0, subscribe: () => () => {} };
	const submitDrafts: { type: string; entry: Record<string, unknown> }[] = [];
	const submitContexts: unknown[] = [];
	const submitMock = vi.fn(async (draft: { type: string; entry: Record<string, unknown> }, context: unknown) => {
		submitDrafts.push(draft);
		submitContexts.push(context);
		return {} as never;
	});
	const conversation = { id: 1, submit: submitMock } as unknown as Conversation;
	const controller: DurableController = {
		submit: vi.fn(async () => {}),
		compact: vi.fn(async () => {}),
		abort: vi.fn(async () => {}),
		cycleThinking: vi.fn(async () => {}),
		setModel: vi.fn(async () => {}),
		toggleTasks: vi.fn(async () => {}),
		switchConversation: vi.fn(async () => {}),
	};

	let host: ExtensionHost;
	let settings: SettingsManager;

	beforeAll(async () => {
		tempDir = mkdtempSync(join(tmpdir(), "durable-host-test-"));
		cwd = join(tempDir, "project");
		agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		extensionPath = join(tempDir, "ext.ts");
		writeFileSync(extensionPath, extensionCode);
		for (const channel of ["test-session-start", "test-hello", "test-model"]) {
			received.set(channel, []);
			eventBus.on(channel, (data) => received.get(channel)!.push(data));
		}
		settings = SettingsManager.create(cwd, agentDir);
		const created = await createExtensionHost({
			cwd,
			agentDir,
			settings,
			modelRuntime: { getModel: () => undefined } as unknown as ModelRuntime,
			additionalExtensionPaths: [extensionPath],
			eventBus,
			notice: (level, message) => notices.push({ level, message }),
		});
		created.attach({
			view: viewSource,
			conversation,
			context: BACKGROUND_CONTEXT,
			controller,
			getConversation: async () => conversation,
		} satisfies ExtensionHostBinding);
		host = created;
	});

	afterAll(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	beforeEach(() => {
		notices.length = 0;
		for (const items of received.values()) items.length = 0;
	});

	function commandCtx(name: string, args: string): DurableCommandContext {
		return {
			name,
			args,
			view: view0,
			cwd: "/tmp/project",
			settings,
			controller,
			notice: (level, message) => notices.push({ level, message }),
			restoreEditor: () => {},
		};
	}

	function fakeToolApi(): { api: ToolExecutionApi; output: string[]; details: unknown[] } {
		const output: string[] = [];
		const details: unknown[] = [];
		const api = {
			taskId: 42,
			conversationId: 1,
			callId: "call-1",
			output: (chunk: string) => {
				output.push(chunk);
			},
			details: async (value: unknown) => {
				details.push(value);
			},
			executeTool: vi.fn(),
			agent: async () => ({}),
			env: undefined,
		} as unknown as ToolExecutionApi;
		return { api, output, details };
	}

	it("loads the temp extension and fires session_start after attach", async () => {
		expect(notices).toEqual([]);
		await host.fireSessionStart("startup");
		expect(received.get("test-session-start")).toEqual([{ reason: "startup" }]);
	});

	it("bridges tool fields: exposure, prepareArguments, executionMode; unsupported fields warn", () => {
		const bridge = host.bridge();
		expect(bridge.name).toBe("pi-bridge");
		const echo = bridge.tools!.find((tool) => tool.name === "dtest-echo")!;
		expect(echo.parameters).toBeDefined();
		expect(typeof echo.prepareArguments).toBe("function");
		expect(echo.prepareArguments!({ text: 5 })).toEqual({ text: "5" });
		expect(echo.executionMode).toBeUndefined();
		expect(echo.callers).toBeUndefined();
		expect(echo.deferred).toBeUndefined();
		const boomerang = bridge.tools!.find((tool) => tool.name === "dtest-boomerang")!;
		expect(boomerang.callers).toEqual(["model"]);
		// The renderCall warning was recorded at host creation; it survives the per-test clear only
		// if it is re-asserted against the creation-time array — so re-check via a fresh publish.
		const registry: Registry = createRegistry();
		host.bindRegistry(registry);
		const warning = notices.find(
			(item) =>
				item.level === "warning" && item.message.includes('tool "dtest-rendered": renderCall is not supported'),
		);
		expect(warning).toBeDefined();
	});

	it("lands the extension command in the demo registry with a command context", async () => {
		const command = commands.get("dtest-hello");
		expect(command).toBeDefined();
		expect(command!.description).toBe("Say hello");
		await command!.execute(commandCtx("dtest-hello", " world"));
		expect(received.get("test-hello")).toEqual([{ args: " world", cwd: "/tmp/project", mode: "tui", hasUi: true }]);
	});

	it("bridged execute: args, onUpdate progress, and result mapping", async () => {
		const echo = host.bridge().tools!.find((tool) => tool.name === "dtest-echo")!;
		const { api, output, details } = fakeToolApi();
		const result = await echo.execute({ text: "hi" } as never, api, BACKGROUND_CONTEXT);
		expect(output).toEqual(["progress"]);
		expect(details).toEqual([{ id: "call-1", updating: true }]);
		expect(result.output).toEqual([{ type: "text", text: "echo:hi" }]);
		expect(result.details).toEqual({ id: "call-1" });
	});

	it("maps terminate to control and thrown errors to isError", async () => {
		const { api } = fakeToolApi();
		const boomerang = host.bridge().tools!.find((tool) => tool.name === "dtest-boomerang")!;
		const boomerangResult = await boomerang.execute({ text: "x" } as never, api, BACKGROUND_CONTEXT);
		expect(boomerangResult.control).toEqual({ terminate: true });
		const boom = host.bridge().tools!.find((tool) => tool.name === "dtest-boom")!;
		const errorResult = await boom.execute({} as never, api, BACKGROUND_CONTEXT);
		expect(errorResult.isError).toBe(true);
		expect(errorResult.output).toEqual([{ type: "text", text: "Tool failed: boom" }]);
	});

	it("a late registerTool re-publishes the bridge into the bound registry", async () => {
		const registry: Registry = createRegistry();
		host.bindRegistry(registry);
		expect(
			registry
				.snapshot()
				.extension("pi-bridge")!
				.tools!.some((tool) => tool.name === "dtest-late-tool"),
		).toBe(false);
		await commands.get("dtest-late")!.execute(commandCtx("dtest-late", ""));
		expect(
			registry
				.snapshot()
				.extension("pi-bridge")!
				.tools!.some((tool) => tool.name === "dtest-late-tool"),
		).toBe(true);
	});

	it("sendMessage: passive write, triggerTurn steer/followUp, appendEntry, setModel", async () => {
		await commands.get("dtest-passive")!.execute(commandCtx("dtest-passive", "x"));
		expect(submitMock).toHaveBeenCalledWith(expect.objectContaining({ type: "write" }), BACKGROUND_CONTEXT);
		expect(submitContexts.every((context) => context === BACKGROUND_CONTEXT)).toBe(true);
		const write = submitDrafts.at(-1)!;
		expect(write.entry).toEqual({
			kind: "pi.user",
			model: [{ role: "user", content: "passive:x", timestamp: expect.any(Number) }],
		});

		await commands.get("dtest-turn")!.execute(commandCtx("dtest-turn", "x"));
		expect(controller.submit).toHaveBeenCalledWith("turn:x", "steer");

		// A busy conversation queues the turn as a follow-up.
		(view0.conversation.docs as Record<string, unknown>)["pi.live"] = { run: { taskId: 1, inputs: [] } };
		await commands.get("dtest-turn")!.execute(commandCtx("dtest-turn", "y"));
		expect(controller.submit).toHaveBeenCalledWith("turn:y", "followUp");
		delete (view0.conversation.docs as Record<string, unknown>)["pi.live"];

		await commands.get("dtest-entry")!.execute(commandCtx("dtest-entry", "z"));
		const entryCall = submitDrafts.at(-1)!;
		expect(entryCall.entry).toEqual({ kind: "dtest-kind", data: { args: "z" } });

		await commands.get("dtest-model")!.execute(commandCtx("dtest-model", "acme/solo"));
		expect(controller.setModel).toHaveBeenCalledWith({ provider: "acme", modelId: "solo" });
		expect(received.get("test-model")).toEqual([{ ok: true }]);
	});

	it("unsupported ctx members throw with the design messages", () => {
		const ctx = host.createContext();
		expect(() => {
			void ctx.ui.select;
		}).toThrow("durable demo: ui.select is not available");
		ctx.ui.notify("hello", "warning");
		expect(notices.at(-1)).toEqual({ level: "warning", message: "hello" });
		expect(() => {
			void ctx.sessionManager.getCwd;
		}).toThrow("durable demo: sessionManager is not available");
		expect(() => {
			void ctx.modelRegistry.refresh;
		}).toThrow("durable demo: modelRegistry is not available");
		expect(() => ctx.getSystemPrompt()).toThrow("durable demo: system prompt access is not available");
		const commandContext = host.createCommandContext();
		expect(() => commandContext.newSession()).toThrow(
			"durable demo: session navigation is not supported; use /agents to switch conversations",
		);
		expect(() => commandContext.reload()).toThrow("durable demo: reloading is not supported; restart the demo");
	});

	it("reports load errors as error notices", async () => {
		const badPath = join(tempDir, "bad.ts");
		writeFileSync(badPath, "export default (pi) => { throw new Error('load failure'); };");
		const badNotices: { level: string; message: string }[] = [];
		await createExtensionHost({
			cwd,
			agentDir,
			settings: SettingsManager.create(cwd, agentDir),
			modelRuntime: { getModel: () => undefined } as unknown as ModelRuntime,
			additionalExtensionPaths: [badPath],
			notice: (level, message) => badNotices.push({ level, message }),
		});
		expect(badNotices.some((item) => item.level === "error" && item.message.includes("load failure"))).toBe(true);
	});
});
