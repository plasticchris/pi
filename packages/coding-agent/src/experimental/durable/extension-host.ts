/**
 * Loads pi extensions for the durable demo and bridges them onto the durable Harness (DESIGN.md §1-2).
 *
 * Mechanism (decision D1): factories run against pi's real `createExtensionAPI` inside
 * `DefaultResourceLoader`, so pi's registration validation and conflict diagnostics apply unchanged.
 * This host replaces the runner's `bindCore` role: the `ExtensionAPI` objects the factories captured
 * delegate every action to the shared `ExtensionRuntime`, which the host patches with durable-backed
 * implementations, and events are fired by calling each extension's stored handlers.
 */

import type { Context, JsonValue } from "@earendil-works/chord";
import type {
	AgentMessage,
	AgentTool,
	AgentToolCallOutcome,
	AgentToolResult,
	AgentToolUpdateCallback,
	ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import {
	clampThinkingLevel,
	type ImageContent,
	type Model,
	type ModelThinkingLevel,
	type TextContent,
} from "@earendil-works/pi-ai";
import {
	type AgentChange,
	type CompactionHooks,
	CompactionTask,
	type Conversation,
	type ConversationId,
	type Extension as DurableExtension,
	defineExtension,
	type EntryDraft,
	type Harness,
	type HookApi,
	hook,
	type InboxState,
	type JsonObject,
	type LiveState,
	type NestedToolExecutionResult,
	type Registry,
	type ToolExecutionApi,
	type ToolExecutionResult,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import { extractFileOpsFromMessage, type FileOperations } from "../../core/compaction/utils.ts";
import { createEventBus, type EventBus } from "../../core/event-bus.ts";
import type {
	CompactOptions,
	ContextUsage,
	Extension,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionToolContext,
	ExtensionUIContext,
	InputEvent,
	InputEventResult,
	LoadExtensionsResult,
	SessionBeforeCompactEvent,
	SessionBeforeCompactResult,
	ToolDefinition,
	ToolExposure,
	ToolInfo,
} from "../../core/extensions/types.ts";
import type { CustomMessage } from "../../core/messages.ts";
import type { ModelRuntime } from "../../core/model-runtime.ts";
import { DefaultResourceLoader } from "../../core/resource-loader.ts";
import type { SettingsManager } from "../../core/settings-manager.ts";
import type { Skill } from "../../core/skills.ts";
import type { SlashCommandInfo } from "../../core/slash-commands.ts";
import type { SourceInfo } from "../../core/source-info.ts";
import { commands, type DurableCommandContext, expandInput, type NoticeLevel } from "./command-registry.ts";
import { EventBridge, toSessionEntry, unwrapSummary } from "./event-bridge.ts";
import { agentOf, type DurableController, type DurableView, type DurableViewSource } from "./runtime.ts";
import { contextTokens } from "./tui.ts";

export interface ExtensionHostOptions {
	readonly cwd: string;
	readonly agentDir: string;
	readonly settings: SettingsManager;
	readonly modelRuntime: ModelRuntime;
	readonly additionalExtensionPaths: string[]; // from PI_DURABLE_EXTENSION_PATHS
	/** Shared bus for extension `pi.events`; a fresh one when absent. */
	readonly eventBus?: EventBus;
	notice(level: NoticeLevel, message: string): void;
}

export interface PiPromptResources {
	readonly skills: readonly Skill[];
	readonly agentsFiles: readonly { readonly path: string; readonly content: string }[];
	readonly systemPrompt?: string;
	readonly appendSystemPrompt: readonly string[];
}

/** The host's view of the live demo session, bound by attach() before any ctx use. */
export interface ExtensionHostBinding {
	readonly view: DurableViewSource;
	readonly conversation: Conversation;
	readonly context: Context;
	/** The wrapped demo controller (submit, compact, abort, setModel, ...). */
	readonly controller: DurableController;
	/** Resolve a conversation by ID; used to track switches. */
	readonly getConversation: (id: ConversationId) => Promise<Conversation | undefined>;
	/** The durable harness, for the S3 event stream (watchEvents) and compaction receipts. */
	readonly harness: Harness;
}

export interface ExtensionHost {
	/** Durable extension with all bridged tools; install name "pi-bridge". */
	bridge(): DurableExtension;
	/** Loader output for the session cwd (prompt.ts). */
	resources(): PiPromptResources;
	/** promptSnippet/promptGuidelines of bridged tools, by tool name (prompt.ts). */
	toolPrompts(): ReadonlyMap<string, { readonly snippet?: string; readonly guidelines?: readonly string[] }>;
	/** Bind the durable registry so late `registerTool` calls re-publish the bridge (harness-setup.ts). */
	bindRegistry(registry: Registry): void;
	/** Wraps the demo controller: tracks the current conversation; S3 fires model/thinking events. */
	wrapController(controller: DurableController): DurableController;
	attach(binding: ExtensionHostBinding): void;
	fireSessionStart(reason: "startup" | "resume"): Promise<void>;
	fireSessionShutdown(): Promise<void>;
	/** Fire a mapped pi event through every extension handler (S3 stream bridge, controller wrapper). */
	fire(event: string, payload: unknown): Promise<void>;
	/** Run the `input` handlers; a transform chains, the first `handled` wins (DESIGN §2.5). */
	fireInput(event: InputEvent): Promise<InputEventResult | undefined>;
	createContext(): ExtensionContext;
	createCommandContext(): ExtensionCommandContext;
	/** Build the tool execution context for a bridged tool call. */
	createToolContext(api: ToolExecutionApi, context: Context): ExtensionToolContext;
	/** tui.ts sets this to the TUI's exit path. */
	setShutdownHandler(handler: () => void): void;
	/** Fires session_shutdown; S3 also stops the event stream here. */
	close(): Promise<void>;
}

/** Loader output captured once at host creation: the load result plus the prompt resources. */
interface LoadedResources {
	readonly result: LoadExtensionsResult;
	readonly skills: readonly Skill[];
	readonly agentsFiles: readonly { readonly path: string; readonly content: string }[];
	readonly systemPrompt?: string;
	readonly appendSystemPrompt: readonly string[];
}

type BridgedTool = { readonly definition: ToolDefinition; readonly sourceInfo: SourceInfo; readonly path: string };

export async function createExtensionHost(options: ExtensionHostOptions): Promise<ExtensionHost> {
	const eventBus = options.eventBus ?? createEventBus();
	const loader = new DefaultResourceLoader({
		cwd: options.cwd,
		agentDir: options.agentDir,
		settingsManager: options.settings,
		eventBus,
		additionalExtensionPaths: options.additionalExtensionPaths,
		disabledBuiltinExtensions: ["mcp"],
	});
	await loader.reload();
	const systemPrompt = loader.getSystemPrompt();
	const host = new ExtensionHostImpl(options, {
		result: loader.getExtensions(),
		skills: loader.getSkills().skills,
		agentsFiles: loader.getAgentsFiles().agentsFiles,
		...(systemPrompt === undefined ? {} : { systemPrompt }),
		appendSystemPrompt: loader.getAppendSystemPrompt(),
	});
	host.bind();
	return host;
}

class ExtensionHostImpl implements ExtensionHost {
	readonly #options: ExtensionHostOptions;
	readonly #loaded: LoadedResources;
	readonly #resources: PiPromptResources;
	readonly #extensions: Extension[];
	#registry: Registry | undefined;
	#bridgeExtension: DurableExtension | undefined;
	#tools: Map<string, BridgedTool> = new Map();
	#binding: ExtensionHostBinding | undefined;
	#conversation: Conversation | undefined;
	#shutdownHandler: (() => void) | undefined;
	#bridge: EventBridge | undefined;
	#closed = false;

	constructor(options: ExtensionHostOptions, loaded: LoadedResources) {
		this.#options = options;
		this.#loaded = loaded;
		this.#extensions = loaded.result.extensions;
		this.#resources = {
			skills: loaded.skills,
			agentsFiles: loaded.agentsFiles,
			...(loaded.systemPrompt === undefined ? {} : { systemPrompt: loaded.systemPrompt }),
			appendSystemPrompt: loaded.appendSystemPrompt,
		};
	}

	/** Report load diagnostics, warn for unsupported registrations, and bind the shared runtime. */
	bind(): void {
		const { notice } = this.#options;
		const runtime = this.#loaded.result.runtime;
		for (const error of this.#loaded.result.errors) notice("error", `${error.path}: ${error.error}`);
		for (const warning of this.#loaded.result.warnings ?? [])
			notice("warning", `${warning.path}: ${warning.warning}`);

		// Registrations the demo cannot honor: one warning each, then left inert (decision D12).
		for (const extension of this.#extensions) {
			for (const shortcut of extension.shortcuts.values())
				notice(
					"warning",
					`${extension.path}: shortcut "${shortcut.shortcut}" is not supported in the durable demo; ignored`,
				);
			for (const flag of extension.flags.values())
				notice("warning", `${extension.path}: flag "--${flag.name}" is not supported in the durable demo; ignored`);
			if (extension.messageRenderers.size > 0)
				notice(
					"warning",
					`${extension.path}: custom entry rendering is not supported in the durable demo; entries will not be shown`,
				);
			if (extension.entryRenderers !== undefined && extension.entryRenderers.size > 0)
				notice(
					"warning",
					`${extension.path}: custom entry rendering is not supported in the durable demo; entries will not be shown`,
				);
			if (extension.markdownTransformer !== undefined)
				notice(
					"warning",
					`${extension.path}: custom rendering is not supported in the durable demo; default rendering is used`,
				);
			if (extension.toolRenderers !== undefined && extension.toolRenderers.length > 0)
				notice(
					"warning",
					`${extension.path}: custom rendering is not supported in the durable demo; default rendering is used`,
				);
		}
		for (const pending of runtime.pendingProviderRegistrations)
			notice(
				"warning",
				`${pending.extensionPath}: provider "${pending.name}" registration is not supported in the durable demo; ignored`,
			);
		for (const pending of runtime.pendingNativeProviderRegistrations)
			notice(
				"warning",
				`${pending.extensionPath}: provider "${pending.provider.id}" registration is not supported in the durable demo; ignored`,
			);
		for (const pending of runtime.pendingVirtualModelRegistrations)
			notice(
				"warning",
				`${pending.extensionPath}: virtual model "${pending.definition.provider}/${pending.definition.id}" registration is not supported in the durable demo; ignored`,
			);
		for (const server of runtime.mcpServers.list())
			notice(
				"warning",
				`${server.extensionPath}: MCP is not supported in the durable demo; server "${server.name}" ignored`,
			);
		// Leave them queued/registered so they never apply, and make later calls fail loudly.
		runtime.pendingProviderRegistrations.length = 0;
		runtime.pendingNativeProviderRegistrations.length = 0;
		runtime.pendingVirtualModelRegistrations.length = 0;
		const unsupported = (member: string) => {
			throw new Error(`durable demo: ${member} is not supported`);
		};
		runtime.registerProvider = () => unsupported("provider registration");
		runtime.registerNativeProvider = () => unsupported("provider registration");
		runtime.unregisterProvider = () => unsupported("provider registration");
		runtime.registerVirtualModel = () => unsupported("virtual model registration");
		runtime.unregisterVirtualModel = () => unsupported("virtual model registration");
		runtime.mcpServers.register = () => unsupported("MCP");
		runtime.mcpServers.unregister = () => {};
		runtime.mcpServers.list = () => [];

		// Action methods: the runner's bindCore role, durable-backed.
		runtime.sendMessage = (message, options) => this.#sendMessage(message, options);
		runtime.sendUserMessage = (content, options) => this.#sendUserMessage(content, options);
		runtime.appendEntry = (customType, data) => this.#appendEntry(customType, data);
		runtime.setSessionName = () => {
			throw new Error("durable demo: session names/labels are not supported");
		};
		runtime.getSessionName = () => undefined;
		runtime.setLabel = () => {
			throw new Error("durable demo: session names/labels are not supported");
		};
		runtime.getActiveTools = () => this.#getActiveTools();
		runtime.getAllTools = () => this.#getAllTools();
		runtime.getSettings = () => this.#options.settings.getSettings();
		runtime.setActiveTools = (names) => this.#setActiveTools(names);
		runtime.refreshTools = () => this.#publishBridge();
		runtime.getCommands = () => this.#getCommands();
		runtime.setModel = (model) => this.#setModel(model);
		runtime.getThinkingLevel = () => this.#getThinkingLevel();
		runtime.setThinkingLevel = (level) => this.#setThinkingLevel(level);
		runtime.createContext = () => this.createContext();

		// Extension commands join the demo command registry (first registration wins, so sibling
		// module-load registrations take precedence over pi extensions).
		for (const extension of this.#extensions) {
			for (const command of extension.commands.values()) {
				commands.register({
					name: command.name,
					...(command.description === undefined ? {} : { description: command.description }),
					execute: (ctx) => command.handler(ctx.args, this.createCommandContext()),
				});
			}
		}

		this.#publishBridge();
	}

	// --- Tool bridge (DESIGN §2.3) -------------------------------------------------

	bindRegistry(registry: Registry): void {
		this.#registry = registry;
		this.#publishBridge();
	}

	bridge(): DurableExtension {
		if (this.#bridgeExtension === undefined) this.#bridgeExtension = this.#buildBridge();
		return this.#bridgeExtension;
	}

	/** Rebuild the pi-bridge tool set from every loaded extension and re-publish it. */
	#publishBridge(): void {
		const tools = new Map<string, BridgedTool>();
		for (const extension of this.#extensions) {
			for (const registered of extension.tools.values()) {
				const name = registered.definition.name;
				tools.set(name, {
					definition: registered.definition,
					sourceInfo: registered.sourceInfo,
					path: extension.path,
				});
				for (const field of [
					"constrainedSampling",
					"reachesTools",
					"prepareLoadout",
					"defaultActive",
					"renderCall",
					"renderResult",
				] as const) {
					if (registered.definition[field] !== undefined)
						this.#notice(
							"warning",
							`${extension.path}: tool "${name}": ${field} is not supported in the durable demo; ignored`,
						);
				}
			}
		}
		this.#tools = tools;
		this.#bridgeExtension = this.#buildBridge();
		this.#registry?.install(this.#bridgeExtension);
	}

	#buildBridge(): DurableExtension {
		const tools: ToolRegistration[] = [...this.#tools.values()].map((tool) => this.#mapTool(tool));
		// The pi-bridge extension also carries the S3 event hooks: the durable compaction task's
		// beforeCompact maps to pi's `session_before_compact` (DESIGN §2.5).
		const hooks = hook(CompactionTask, {
			beforeCompact: (compaction, api, context) => this.#beforeCompact(compaction, api, context),
		});
		return defineExtension({ name: "pi-bridge", tools, hooks: [hooks] });
	}

	#mapTool(bridged: BridgedTool): ToolRegistration {
		const definition = bridged.definition;
		const exposure = definition.exposure ?? "direct";
		return {
			name: definition.name,
			description: definition.description,
			parameters: definition.parameters,
			...(definition.prepareArguments === undefined
				? {}
				: { prepareArguments: (args: unknown) => definition.prepareArguments!(args) }),
			...(definition.executionMode === undefined ? {} : { executionMode: definition.executionMode }),
			...(exposure === "direct"
				? {}
				: {
						callers:
							exposure === "model-only"
								? (["model"] as const)
								: exposure === "codemode" || exposure === "deferred"
									? (["tools"] as const)
									: ([] as const),
					}),
			...(exposure === "deferred" ? { deferred: true } : {}),
			...(definition.outputSchema === undefined ? {} : { structuredOutputSchema: definition.outputSchema }),
			// pi's execute(id, params, signal, onUpdate, ctx) → durable execute(args, api, context).
			execute: (args, api, context) => this.#executeBridgedTool(definition, args, api, context),
		};
	}

	async #executeBridgedTool(
		definition: ToolDefinition,
		args: unknown,
		api: ToolExecutionApi,
		context: Context,
	): Promise<ToolExecutionResult> {
		const ctx = this.createToolContext(api, context);
		const onUpdate: AgentToolUpdateCallback = (partial) => {
			for (const block of partial.content ?? []) if (block.type === "text") api.output(block.text);
			if (partial.details !== undefined) void api.details(partial.details as JsonValue, context);
		};
		try {
			const result = await (
				definition.execute as (
					toolCallId: string,
					params: unknown,
					signal: AbortSignal | undefined,
					onUpdate: AgentToolUpdateCallback | undefined,
					ctx: ExtensionToolContext,
				) => Promise<AgentToolResult>
			)(api.callId, args, context.abortSignal, onUpdate, ctx);
			return {
				...(result.content === undefined ? {} : { output: result.content }),
				...(result.details === undefined ? {} : { details: result.details as JsonValue }),
				...(result.isError === undefined ? {} : { isError: result.isError }),
				...(result.usage === undefined ? {} : { usage: result.usage }),
				...(result.structuredContent === undefined
					? {}
					: { structuredOutput: result.structuredContent as JsonValue }),
				...(result.terminate === true ? { control: { terminate: true } } : {}),
			};
		} catch (error) {
			return {
				output: [{ type: "text", text: `Tool failed: ${error instanceof Error ? error.message : String(error)}` }],
				isError: true,
			};
		}
	}

	/** promptSnippet/promptGuidelines of the bridged tools, by tool name. */
	toolPrompts(): ReadonlyMap<string, { readonly snippet?: string; readonly guidelines?: readonly string[] }> {
		const map = new Map<string, { readonly snippet?: string; readonly guidelines?: readonly string[] }>();
		for (const { definition } of this.#tools.values()) {
			const snippet = definition.promptSnippet;
			const guidelines = definition.promptGuidelines === undefined ? undefined : [...definition.promptGuidelines];
			if (snippet !== undefined || guidelines !== undefined) map.set(definition.name, { snippet, guidelines });
		}
		return map;
	}

	// --- pi action implementations (DESIGN §2.1) -----------------------------------

	#sendMessage(
		message: Pick<CustomMessage, "customType" | "content" | "display" | "details">,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): void {
		const text = textOfContent(message.content);
		if (options?.triggerTurn === true) {
			void this.#controller().submit(text, this.#live().run !== undefined ? "followUp" : "steer");
		} else {
			this.#writeEntry({ kind: "pi.user", model: [{ role: "user", content: text, timestamp: Date.now() }] });
		}
	}

	#sendUserMessage(
		content: string | (TextContent | ImageContent)[],
		options?: { deliverAs?: "steer" | "followUp"; expandPromptTemplates?: boolean },
	): void {
		const text = textOfContent(content);
		const expanded =
			options?.expandPromptTemplates === false ? text : expandInput(text, this.#commandContextFor(text));
		void this.#controller().submit(expanded, options?.deliverAs ?? "steer");
	}

	#appendEntry(customType: string, data?: unknown): void {
		if (customType.startsWith("pi.")) throw new Error('durable demo: custom entry kinds must not start with "pi."');
		this.#writeEntry({ kind: customType, ...(data === undefined ? {} : { data: data as JsonValue }) });
	}

	#writeEntry(entry: EntryDraft): void {
		const conversation = this.#currentConversation();
		void conversation
			.submit({ type: "write", entry }, this.#context())
			.then(() => {})
			.catch((error) => this.#notice("error", error instanceof Error ? error.message : String(error)));
	}

	#setActiveTools(names: string[]): void {
		const registry = this.#registry;
		if (registry === undefined) throw new Error("durable demo: the tool registry is not bound yet");
		const byName = new Map(
			registry
				.snapshot()
				.tools()
				.map(({ tool }) => [tool.name, tool]),
		);
		// Unknown names are ignored, as in pi; hidden and deferred tools stay out of the enabled set.
		const resolved = names
			.map((name) => byName.get(name))
			.filter(
				(tool): tool is ToolRegistration =>
					tool !== undefined && tool.deferred !== true && (tool.callers ?? ["model"]).length > 0,
			);
		this.#configureCurrent({ tools: resolved });
	}

	async #setModel(model: Model<any>): Promise<boolean> {
		await this.#controller().setModel({ provider: model.provider, modelId: model.id });
		return true;
	}

	#getThinkingLevel(): ThinkingLevel {
		return (agentOf(this.#view().conversation).thinkingLevel ?? "off") as ThinkingLevel;
	}

	#setThinkingLevel(level: ThinkingLevel): void {
		const model = this.#currentModel();
		if (model === undefined) throw new Error("No model selected");
		const next = clampThinkingLevel(model, level as ModelThinkingLevel);
		this.#configureCurrent({ thinkingLevel: next });
	}

	#configureCurrent(change: AgentChange): void {
		void this.#currentConversation()
			.configure(change, this.#context())
			.catch((error) => this.#notice("error", error instanceof Error ? error.message : String(error)));
	}

	#getActiveTools(): string[] {
		const state = agentOf(this.#view().conversation);
		if (Array.isArray(state.tools)) return [...state.tools];
		const registry = this.#registry;
		if (registry === undefined) return [];
		const names: string[] = [];
		for (const { tool } of registry.snapshot().tools()) {
			if (tool.deferred === true) continue;
			if (state.tools !== undefined && !Array.isArray(state.tools) && state.tools.remove.includes(tool.name))
				continue;
			names.push(tool.name);
		}
		return names;
	}

	#getAllTools(): ToolInfo[] {
		const registry = this.#registry;
		if (registry === undefined) return [];
		return registry
			.snapshot()
			.tools()
			.map(({ extension, tool }) => ({
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters,
				exposure: this.#exposureOf(tool),
				sourceInfo:
					this.#tools.get(tool.name)?.sourceInfo ??
					({
						path: `durable:${extension.name}`,
						source: "builtin",
						scope: "project",
						origin: "top-level",
					} as SourceInfo),
			}));
	}

	#exposureOf(tool: ToolRegistration): ToolExposure {
		if (tool.deferred === true) return "deferred";
		const callers = tool.callers;
		if (callers === undefined) return "direct";
		if (callers.length === 0) return "hidden";
		if (!callers.includes("model")) return "codemode";
		return callers.length === 1 ? "model-only" : "direct";
	}

	#getCommands(): SlashCommandInfo[] {
		return commands.list().map((command) => ({
			name: command.name,
			...(command.description === undefined ? {} : { description: command.description }),
			source: "extension" as const,
			sourceInfo: { path: "durable-demo", source: "local", scope: "project", origin: "top-level" } as SourceInfo,
		}));
	}

	// --- Contexts (DESIGN §2.2, §2.4) ---------------------------------------------

	createContext(): ExtensionContext {
		return this.#createBaseContext(undefined);
	}

	createCommandContext(): ExtensionCommandContext {
		const base = this.createContext();
		const navigation = (): never => {
			throw new Error("durable demo: session navigation is not supported; use /agents to switch conversations");
		};
		return {
			...base,
			getSystemPromptOptions: () => {
				throw new Error("durable demo: system prompt access is not available");
			},
			waitForIdle: () => this.#currentConversation().waitForIdle(this.#context()),
			newSession: navigation,
			fork: navigation,
			navigateTree: navigation,
			switchSession: navigation,
			reload: () => {
				throw new Error("durable demo: reloading is not supported; restart the demo");
			},
		};
	}

	createToolContext(api: ToolExecutionApi, context: Context): ExtensionToolContext {
		const base = this.#createBaseContext(context.abortSignal);
		return {
			...base,
			tools: this.#callableTools(api, context),
			executeTool: async (name, args) => {
				const result = await api.executeTool(name, args as unknown as JsonObject, context);
				return outcomeFor(name, args, result, `${api.callId}/${result.taskId}`);
			},
		};
	}

	/** The pi tools a bridged tool can call: every registered tool through the call's executeTool. */
	#callableTools(api: ToolExecutionApi, context: Context): AgentTool[] {
		const registry = this.#registry;
		if (registry === undefined) return [];
		const tools: AgentTool[] = [];
		for (const { tool } of registry.snapshot().tools()) {
			tools.push({
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters,
				label: tool.name,
				execute: async (_toolCallId, params, _signal, _onUpdate) => {
					const result = await api.executeTool(tool.name, params as unknown as JsonObject, context);
					return {
						content: contentOf(result.structuredOutput),
						details: result.details,
						...(result.isError ? { isError: true } : {}),
						...(result.usage === undefined ? {} : { usage: result.usage }),
					};
				},
			});
		}
		return tools;
	}

	#createBaseContext(signal: AbortSignal | undefined): ExtensionContext {
		const view = this.#view();
		const agentState = agentOf(view.conversation);
		const model = this.#currentModel();
		// ui.notify maps to the demo notices; every other ui.* throws (DESIGN §2.2).
		const ui: ExtensionUIContext = new Proxy({} as ExtensionUIContext, {
			get: (_target, property) => {
				if (property === "notify")
					return (message: string, type?: "info" | "warning" | "error") => this.#notice(type ?? "info", message);
				throw new Error(`durable demo: ui.${String(property)} is not available`);
			},
		});
		const unavailable = (field: string): never => {
			throw new Error(`durable demo: ${field} is not available`);
		};
		// Any property access throws, as the DESIGN's proxy fields require.
		const throwing = (field: string): unknown =>
			new Proxy(
				{},
				{
					get: () => unavailable(field),
					has: () => false,
				},
			);
		return {
			ui,
			mode: "tui",
			hasUI: true,
			cwd: agentState.cwd ?? view.session.cwd,
			sessionManager: throwing("sessionManager") as ExtensionContext["sessionManager"],
			modelRegistry: throwing("modelRegistry") as ExtensionContext["modelRegistry"],
			model,
			scopedModels: [],
			...(agentState.thinkingLevel === undefined
				? {}
				: { thinkingLevel: agentState.thinkingLevel as ThinkingLevel }),
			isIdle: () => this.#live().run === undefined,
			isProjectTrusted: () => this.#options.settings.isProjectTrusted(),
			signal,
			abort: () => {
				void this.#controller().abort();
			},
			hasPendingMessages: () => this.#inboxItems().length > 0,
			shutdown: () => this.#shutdownHandler?.(),
			getContextUsage: () => this.#contextUsage(),
			compact: (options?: CompactOptions) => this.#compact(options),
			getSystemPrompt: () => unavailable("system prompt access"),
		};
	}

	#compact(options?: CompactOptions): void {
		void this.#controller()
			.compact(options?.customInstructions)
			.then(
				// Durable has no CompactionResult payload; the callback gets a best-effort one (DESIGN §2.2).
				() => options?.onComplete?.({ summary: "", firstKeptEntryId: "", tokensBefore: 0 }),
				(error) => options?.onError?.(error instanceof Error ? error : new Error(String(error))),
			);
	}

	#contextUsage(): ContextUsage | undefined {
		const view = this.#view();
		const ref = agentOf(view.conversation).model;
		const model = ref === undefined ? undefined : this.#options.modelRuntime.getModel(ref.provider, ref.modelId);
		const contextWindow = model?.contextWindow ?? 0;
		if (contextWindow <= 0) return undefined;
		const tokens = contextTokens(view.conversation.entries) ?? null;
		return {
			tokens,
			contextWindow,
			percent: tokens === null ? null : (tokens / contextWindow) * 100,
		};
	}

	#commandContextFor(text: string): DurableCommandContext {
		const { name, args } = parseCommand(text);
		const view = this.#view();
		return {
			name,
			args,
			view,
			cwd: agentOf(view.conversation).cwd ?? view.session.cwd,
			settings: this.#options.settings,
			controller: this.#controller(),
			notice: (level, message) => this.#notice(level, message),
			restoreEditor: () => {},
		};
	}

	// --- Events (S2: session lifecycle; S3: the stream bridge in event-bridge.ts) ----------

	async #fire(event: string, payload: unknown): Promise<void> {
		const ctx = this.createContext();
		for (const extension of this.#extensions) {
			const handlers = extension.handlers.get(event);
			if (handlers === undefined) continue;
			for (const handler of [...handlers]) {
				try {
					await handler(payload, ctx);
				} catch (error) {
					this.#notice(
						"error",
						`Extension ${extension.path} event ${event} failed: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			}
		}
	}

	/** Fire a mapped pi event through every extension handler. */
	async fire(event: string, payload: unknown): Promise<void> {
		await this.#fire(event, payload);
	}

	/**
	 * Run the `input` handlers, as pi's emitInput does: a `transform` chains (later handlers see
	 * the transformed text), the first `handled` wins, handler errors become notices.
	 */
	async fireInput(event: InputEvent): Promise<InputEventResult | undefined> {
		const ctx = this.createContext();
		let current: InputEvent = event;
		for (const extension of this.#extensions) {
			const handlers = extension.handlers.get("input");
			if (handlers === undefined) continue;
			for (const handler of [...handlers]) {
				let result: InputEventResult | undefined;
				try {
					result = (await handler(current, ctx)) as InputEventResult | undefined;
				} catch (error) {
					this.#notice(
						"error",
						`Extension ${extension.path} event input failed: ${error instanceof Error ? error.message : String(error)}`,
					);
					continue;
				}
				if (result?.action === "handled") return result;
				if (result?.action === "transform") {
					current = {
						...current,
						text: result.text,
						...(result.images === undefined ? {} : { images: result.images }),
					};
				}
			}
		}
		return undefined;
	}

	async fireSessionStart(reason: "startup" | "resume"): Promise<void> {
		await this.#fire("session_start", { type: "session_start", reason });
	}

	async fireSessionShutdown(): Promise<void> {
		await this.#fire("session_shutdown", { type: "session_shutdown", reason: "quit" });
	}

	/**
	 * The durable compaction task's beforeCompact, mapped to pi's `session_before_compact`
	 * (DESIGN §2.5). The first `cancel` declines; otherwise the last supplied summary wins and
	 * replaces the model-generated one.
	 */
	async #beforeCompact(
		compaction: Parameters<CompactionHooks["beforeCompact"]>[0],
		runtime: HookApi,
		context: Context,
	): Promise<{ readonly decline: true } | { readonly summary: string } | undefined> {
		const view = this.#view();
		const agentState = agentOf(view.conversation);
		const modelRef = agentState.model;
		const model =
			modelRef === undefined ? undefined : this.#options.modelRuntime.getModel(modelRef.provider, modelRef.modelId);
		const settings = this.#options.settings.getCompactionSettings(
			model === undefined ? undefined : { provider: model.provider, id: model.id },
		);
		const messages = [...compaction.messages] as AgentMessage[];
		const fileOps: FileOperations = { read: new Set(), written: new Set(), edited: new Set() };
		for (const message of messages) extractFileOpsFromMessage(message, fileOps);
		// The hook's entries are head-marker first: a leading compaction entry is the previous summary.
		const head = compaction.entries[0];
		const previousSummary = head !== undefined && head.kind === "pi.compaction" ? unwrapSummary(head) : undefined;
		const event: SessionBeforeCompactEvent = {
			type: "session_before_compact",
			preparation: {
				firstKeptEntryId: String(compaction.firstKept),
				messagesToSummarize: messages,
				turnPrefixMessages: [],
				isSplitTurn: false,
				tokensBefore: totalAssistantTokens(messages),
				...(previousSummary === undefined ? {} : { previousSummary }),
				fileOps,
				settings,
			},
			branchEntries: compaction.entries.map(toSessionEntry),
			...(compaction.instructions === undefined ? {} : { customInstructions: compaction.instructions }),
			reason: compaction.reason,
			willRetry: compaction.reason === "overflow",
			signal: context.abortSignal ?? new AbortController().signal,
		};
		let summary: string | undefined;
		for (const extension of this.#extensions) {
			const handlers = extension.handlers.get("session_before_compact");
			if (handlers === undefined) continue;
			for (const handler of [...handlers]) {
				let result: SessionBeforeCompactResult | undefined;
				try {
					result = (await handler(event, this.createContext())) as SessionBeforeCompactResult | undefined;
				} catch (error) {
					this.#notice(
						"error",
						`Extension ${extension.path} event session_before_compact failed: ${error instanceof Error ? error.message : String(error)}`,
					);
					continue;
				}
				if (result?.cancel === true) return { decline: true };
				if (result?.compaction !== undefined) summary = result.compaction.summary;
			}
		}
		if (summary === undefined) return undefined;
		this.#bridge?.markFromExtension(runtime.taskId);
		return { summary };
	}

	// --- Controller wrapper and lifecycle ------------------------------------------

	wrapController(controller: DurableController): DurableController {
		return {
			submit: (text, whenBusy) => controller.submit(text, whenBusy),
			compact: (instructions) => controller.compact(instructions),
			abort: () => controller.abort(),
			// DESIGN §2.5: model_select / thinking_level_select fire around the wrapped calls.
			cycleThinking: () => {
				const previousLevel = this.#getThinkingLevel();
				return controller.cycleThinking().then(() => {
					void this.#fire("thinking_level_select", {
						type: "thinking_level_select",
						level: this.#getThinkingLevel(),
						previousLevel,
					});
				});
			},
			setModel: (ref) => {
				const previousModel = this.#currentModel();
				return controller.setModel(ref).then(() => {
					const model = this.#options.modelRuntime.getModel(ref.provider, ref.modelId);
					if (model !== undefined)
						void this.#fire("model_select", {
							type: "model_select",
							model,
							previousModel,
							source: "set" as const,
						});
				});
			},
			toggleTasks: () => controller.toggleTasks(),
			// Track the shown conversation after the inner switch commits; re-subscribe the event stream.
			switchConversation: (id) =>
				controller.switchConversation(id).then(() =>
					this.#binding
						?.getConversation(id)
						.then((conversation) => {
							if (conversation === undefined) return;
							this.#conversation = conversation;
							void this.#bridge?.switchTo(conversation).catch(() => {});
						})
						.catch(() => {}),
				),
		};
	}

	attach(binding: ExtensionHostBinding): void {
		this.#binding = binding;
		this.#conversation = binding.conversation;
		// S3 event bridge: map the current conversation's watch stream to pi events.
		this.#bridge = new EventBridge({
			context: binding.context,
			dispatch: (event) => this.#fire(event.type, event),
			notice: (level, message) => this.#notice(level, message),
		});
		void this.#bridge
			.start(binding.conversation)
			.catch((error) => this.#notice("warning", error instanceof Error ? error.message : String(error)));
	}

	setShutdownHandler(handler: () => void): void {
		this.#shutdownHandler = handler;
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		// The event stream is a harness attachment: stop it before the harness closes.
		await this.#bridge?.stop().catch(() => {});
		this.#bridge = undefined;
		await this.fireSessionShutdown();
	}

	resources(): PiPromptResources {
		return this.#resources;
	}

	// --- Session accessors -----------------------------------------------------------

	#view(): DurableView {
		return this.#requireBinding().view.current();
	}

	#controller(): DurableController {
		return this.#requireBinding().controller;
	}

	#context(): Context {
		return this.#requireBinding().context;
	}

	#currentConversation(): Conversation {
		if (this.#conversation === undefined) throw new Error("durable demo: the session is not attached yet");
		return this.#conversation;
	}

	#requireBinding(): ExtensionHostBinding {
		if (this.#binding === undefined) throw new Error("durable demo: the session is not attached yet");
		return this.#binding;
	}

	#live(): LiveState {
		return (this.#view().conversation.docs["pi.live"] ?? {}) as LiveState;
	}

	#inboxItems(): unknown[] {
		return ((this.#view().conversation.docs["pi.inbox"] ?? { items: [] }) as InboxState).items;
	}

	#currentModel(): Model<any> | undefined {
		const ref = agentOf(this.#view().conversation).model;
		if (ref === undefined) return undefined;
		return this.#options.modelRuntime.getModel(ref.provider, ref.modelId);
	}

	#notice(level: NoticeLevel, message: string): void {
		this.#options.notice(level, message);
	}
}

/** pi `content` (string or text/image blocks) as plain text; images are not supported. */
function textOfContent(content: string | (TextContent | ImageContent)[]): string {
	if (typeof content === "string") return content;
	let text = "";
	for (const block of content) {
		if (block.type === "image") throw new Error("durable demo: image messages are not supported");
		text += block.text;
	}
	return text;
}

/** Context-token approximation for `session_before_compact.preparation.tokensBefore`: the
 * summed usage of the assistant messages about to be summarized. */
function totalAssistantTokens(messages: readonly AgentMessage[]): number {
	let total = 0;
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		const usage = message.usage;
		total += usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	}
	return total;
}

/** First word of a `/command args` text, for name/args parsing. */
function parseCommand(text: string): { name: string; args: string } {
	const trimmed = text.trim();
	if (!trimmed.startsWith("/")) return { name: "", args: "" };
	const space = trimmed.indexOf(" ");
	if (space === -1) return { name: trimmed.slice(1), args: "" };
	return { name: trimmed.slice(1, space), args: trimmed.slice(space + 1).trim() };
}

/** A nested call's structuredOutput as model-facing content. */
function contentOf(structuredOutput: JsonValue | undefined): (TextContent | ImageContent)[] {
	if (structuredOutput === undefined) return [];
	if (typeof structuredOutput === "string") return [{ type: "text", text: structuredOutput }];
	if (Array.isArray(structuredOutput)) return structuredOutput as unknown as (TextContent | ImageContent)[];
	return [{ type: "text", text: JSON.stringify(structuredOutput) }];
}

/** NestedToolExecutionResult → pi AgentToolCallOutcome, best effort (DESIGN §2.4). */
function outcomeFor(
	name: string,
	args: unknown,
	result: NestedToolExecutionResult,
	callId: string,
): AgentToolCallOutcome {
	return {
		toolCall: { type: "toolCall", id: callId, name, arguments: (args ?? {}) as JsonObject },
		result: {
			content: contentOf(result.structuredOutput),
			details: result.details,
			...(result.isError ? { isError: true } : {}),
			...(result.usage === undefined ? {} : { usage: result.usage }),
		},
		isError: result.isError,
		...(result.durationMs === undefined ? {} : { durationMs: result.durationMs }),
	};
}
