# Design: durable demo extension bridge (S1)

Goal: the demo loads pi's resources (extensions, skills, prompt templates, settings) and behaves
like regular pi for everything that maps onto the durable Harness. This document is the contract
for the three campaign tracks; section 6 (Integration Seams) is binding and verbatim for the
`sibling` tracks (durable-parity-ui, durable-parity-templates).

**No pi-durable changes are needed** (verified): `conversation.watch(context)`
(`packages/durable/src/harness/view.ts`, exported from `@earendil-works/pi-durable`) delivers the
throttled `ConversationView` — the committed transcript window plus built-in documents, the live
projection at `docs["pi.live"]` — from which the bridge derives the per-turn lifecycle (`turn_*`,
`message_*`, `tool_execution_*`, compaction events), and durable extensions can hook built-in tasks
(`CompactionHooks.beforeCompact` on `pi.compaction`, `ToolHooks` on `pi.tool`, `GenerationHooks` on
`pi.generation`). All bridge code lives in the demo directory.

## 0. Port to pi-durable 1.4.0 (old → new API mapping)

The 1.4.0 release removed the dedicated event-stream surface this demo was written against. The
mapping actually implemented (see `event-bridge.ts`, `runtime.ts`, `tui.ts`):

| 1.3.0 API (removed) | 1.4.0 replacement used by the demo |
|---|---|
| `watchEvents(harness, conversationId, context)` → `AgentEvent` stream | `conversation.watch(context)` → `ConversationWatch`; the bridge diffs consecutive `ConversationView`s (committed entries + `docs["pi.live"]`) into pi events |
| `Conversation.viewState` | seed from `watch.value`; no standalone state read |
| `Harness.taskGraph` | `harness.watchTaskGraph(context)` → `TaskGraphWatch` (task panel) |
| `Harness.subscribeCommits` | `harness.observeCommits(observer: CommitObserver)` (conversation labels/titles only) |
| `CompactionStatus.reason` / `CompactionFailure.reason` | `.trigger` (`CompactionReason`) |
| `EntryRecord.timestamp` (removed from the type) | synthesized: committed messages keep the pi message's own timestamp; compaction/custom entries get `Date.now()`; `CompactionEntry.timestamp` is the epoch placeholder `1970-01-01` (no wall clock survives to the demo) |

Simplifications the 1.4.0 surface forces (capabilities cut or coarsened, each noted where used):

- **Token-level streaming is gone.** 1.4.0 only exposes the *committed, throttled* partial in
  `LiveState.generation.message`. `message_update` is therefore a coarse `text_delta` with an empty
  `delta` whose `partial` carries the current text; the first partial appearance is `message_start`.
- **`turn_end` boundary state is empty.** The demo has no session-file projection, so
  `TurnEndEvent.entries`/`context` are `[]`/empty previews and `continue` is always `false`;
  `outcome` is derived from the assistant `stopReason` / run failure. `messageEntryId`/`toolResultEntryIds`
  are `String(entryId)` of the durable entries (or `"0"` when the turn opened from a partial the
  bridge never saw commit).
- **Tool args are reconstructed.** 1.4.0 `ToolSlot` carries no arguments: top-level start/update/end
  events echo the args parsed from the turn's committed `pi.assistant` `ToolCall` blocks (`null`
  when absent); nested calls use `NestedToolSlot.arguments` directly, with `parentCallId`/`parentTaskId`
  mapping to `parentToolCallId`.
- **Tool results prefer the committed entry.** A `done` slot's `entry` pointer finds its
  `pi.tool-result` entry (real `isError`/`durationMs`); without one the bridge synthesizes a text
  result from the slot's retained output. Nested ends use `NestedToolSlot.summary`.
- **Compaction bookkeeping is best-effort.** Success: the committed `pi.compaction` entry is
  authoritative — `reason` from `entry.data.reason` (default `manual`), `firstKeptEntryId` from
  `entry.head` (else `"0"`), `tokensBefore: 0` (unknown to the demo), `usage` omitted. Failure:
  `live.compactionFailure` fires `session_compact_failed` once its task leaves `live.compactions`;
  `reason` from `failure.trigger`, `errorMessage` from `failure.error`. `fromExtension` correlates
  via `markFromExtension(taskId)` (the `session_before_compact` handler's task) and the entry's
  `byTaskId`; tasks with neither marker default to `false`. `session_compact` sets
  `willRetry: reason === "overflow"`.
- **Cut entirely (no clean 1.4.0 equivalent):** `AgentEvent` `submission`, `auto_retry_start/end`,
  `agent_changed`, `compaction_start` (no distinct start event; the live `CompactionStatus` list is
  observed but only used to scope the failure dedupe), `inbox_update` (inbox is harness-internal),
  fine-grained commit-list events (only conversation metadata flows through `observeCommits`).
- **The watch listener never throws** (a throw ends the watch); delivery failures surface as
  warning notices, and a superseded watch is epoch-guarded so stale views drop on `switchTo`/`stop`.

## 1. Architecture

```
main.ts  ── args + PI_DURABLE_EXTENSION_PATHS ──▶ openDurable() (runtime.ts)
                                                   │
                                                   ├─ selectSession()            (unchanged)
                                                   ├─ ModelRuntime.create()      (unchanged)
                                                   ├─ SettingsManager.create()   (unchanged)
                                                   ├─ createExtensionHost()      (S2, extension-host.ts)
                                                   │    ├─ DefaultResourceLoader.reload()   ← pi discovery, factory run,
                                                   │    │    (tools/commands/handlers collected per Extension)
                                                   │    ├─ bind runtime actions (bindCore role, §2.1)
                                                   │    ├─ register pi extension commands → `commands` singleton (§6.1)
                                                   │    └─ build bridge durable extension "pi-bridge" (tools, §2.3)
                                                   ├─ createHarnessSettings()    (unchanged)
                                                   ├─ registry.install: CodingTools, pi-prompt (prompt.ts, host-aware),
                                                   │                    Subagent, host.bridge()
                                                   ├─ Harness.open() / root()    (unchanged)
                                                   ├─ host.attach({view, controller: host.wrapController(controller),
                                                   │                conversation: root, context})
                                                   ├─ host.fireSessionStart(location.created ? "startup" : "resume")
                                                   └─ return {view, controller, settings, notice, close()}
main.ts ──▶ runDurableTui(view, controller, settings, notice) (tui.ts, S2 dispatch per §6.2)
```

Key mechanism: pi extension **factories run against pi's real `createExtensionAPI`** (inside
`DefaultResourceLoader` → `loadExtensionFromFactory`, so all of pi's registration validation,
`omitReplacedExtensions`, and conflict diagnostics apply unchanged). What the demo replaces is the
*runner*: pi's `ExtensionRunner.bindCore()` is never used. Instead the host takes over that role —
the `ExtensionAPI` objects the factories captured delegate every action method to the shared
`ExtensionRuntime` (see `core/extensions/loader.ts`, `createExtensionAPI`), so the host binds real
durable-backed implementations by replacing the runtime's throwing stubs, and fires events by
calling into each `Extension.handlers` map.

`openDurable` S2 sequence (replaces the current lines in `runtime.ts`):

1. `selectSession`, `ModelRuntime.create`, `SettingsManager.create`, `configureHarnessHttp` (as today).
2. `host = await createExtensionHost({ cwd: location.cwd, agentDir: getAgentDir(), settings: settingsManager,
   additionalExtensionPaths, notice })` — inside: `new DefaultResourceLoader({ cwd, agentDir, settingsManager,
   additionalExtensionPaths, disabledBuiltinExtensions: ["mcp"] })`; `await loader.reload()`; report
   `result.errors` as level `error` notices and `result.warnings` as level `warning` notices
   (one per entry: `<path>: <message>`); bind runtime actions; register extension commands into the
   `commands` singleton (first registration wins, §6.1); warn (level `warning`) for every
   unsupported registration found in the loaded extensions (§2.2, §2.5); build the bridge tools (§2.3).
3. `settings = createHarnessSettings(settingsManager)`; `registry = createCodingRegistry(settingsManager, location.cwd, host)`.
4. `registry.install(Subagent)`; `registry.install(host.bridge())`.
5. `Harness.open`, `harness.root(...)` as today.
6. Build the raw controller (as today); `const controller = host.wrapController(rawController)`;
   `host.attach({ view: viewSource, conversation: root, context })`.
7. `await host.fireSessionStart(location.created ? "startup" : "resume")`; model notices; `toggleTasks`;
   `harness.resume()` (as today).
8. `close()` runs `await host.close()` (fires `session_shutdown`, stops the S3 event stream) **before**
   `harness.close()`.

`OpenDurableOptions` gains `additionalExtensionPaths?: string[]`; `main.ts` sets it from
`process.env.PI_DURABLE_EXTENSION_PATHS` (colon-separated paths; empty/absent = none).
`OpenDurableResult` gains `notice: (level: "info" | "warning" | "error", message: string) => void`
(the existing internal `notice` closure).

## 2. (a) ExtensionAPI mapping

### 2.1 Implemented members (shim → durable/TUI target)

The host binds these on the shared `ExtensionRuntime` (and uses the per-`Extension` registration maps
where noted). "ctx" below means the host-built `ExtensionContext`/`ExtensionCommandContext` (§2.4).

| pi `ExtensionAPI` member | Durable / TUI target |
| --- | --- |
| `on(event, handler)` | stored in `Extension.handlers` by pi's loader; fired by the host per §2.5 |
| `registerTool(tool)` | tool bridge → durable `defineTool` in the `pi-bridge` extension (§2.3); a late `registerTool` re-publishes `pi-bridge` via `registry.install()` |
| `registerCommand(name, options)` | registered into the `commands` singleton (§6.1) at host creation; dispatch builds a pi `ExtensionCommandContext` via `host.createCommandContext()` and calls `handler(args, ctx)`; handler errors → `error` notice `Command /<name> failed: <message>` |
| `exec(command, args, options)` | `execCommand(command, args, options?.cwd ?? cwd, options)` from `core/exec.ts` (same call pi's loader makes) |
| `getSettings()` | `settingsManager.getSettings()` (identical `Settings` type) |
| `getActiveTools()` | approximation of the offered tools: `agent.tools` names when the agent state narrows them, else all installed non-deferred tool names (coding + bridge) |
| `getAllTools()` | `ToolInfo[]` built by the host from the registry snapshot (name, description, parameters, promptGuidelines, exposure, sourceInfo) |
| `setActiveTools(names)` | `current.configure({ tools: names }, context)` on the current conversation |
| `getCommands()` | `SlashCommandInfo[]` from the `commands` singleton (name, description) + builtins |
| `setModel(model)` | `controller.setModel({ provider, modelId })`; resolves `true` (auth is checked at startup by `findInitialAgentModel`; unknown model → throw) |
| `getThinkingLevel()` | `agentOf(view).thinkingLevel ?? "off"` |
| `setThinkingLevel(level)` | clamp to the model's levels, `current.configure({ thinkingLevel }, context)` (mirrors `controller.cycleThinking`) |
| `sendMessage(message, options)` | text content only. `triggerTurn: true` (or busy): `controller.submit(text, "followUp")` when the conversation is busy else `submit(text, "steer")`; `triggerTurn` false/absent: passive write `submit({ type: "write", entry: { kind: "pi.user", model: [userMessage] } }, context)` (queued in `pi.inbox` while busy, appended at a boundary; no turn starts). Image content → throw §2.2 |
| `sendUserMessage(content, options)` | `controller.submit(expandInput(text, ctx), options?.deliverAs ?? "steer")` — always triggers a turn; `expandPromptTemplates: true` (default) runs the registered input expanders |
| `appendEntry(customType, data)` | passive write `submit({ type: "write", entry: { kind: customType, data } }, context)` (`customType` must not start with `pi.`); entries render only if the TUI knows the kind |
| `events` (EventBus) | a real `createEventBus()`; the host passes it to the loader so `api.events` is shared across extensions as in pi |

### 2.2 UNSUPPORTED (member → why → behavior)

Load-time registrations that the demo cannot honor produce one **`warning` notice each**
(`<extension path>: <message>`) and are otherwise ignored; runtime calls throw. Error messages are
literal below.

| pi member | Why unsupported in the demo | Behavior |
| --- | --- | --- |
| `registerShortcut` | the demo TUI wires pi's fixed keybindings only | warning `shortcut "<id>" is not supported in the durable demo; ignored` |
| `registerFlag` / `getFlag` | `main.ts` parses a fixed arg list; no CLI flag plumbing | `registerFlag` throws `Error("durable demo: CLI flags are not supported")`; `getFlag` returns `undefined` |
| `registerMessageRenderer`, `registerEntryRenderer` | the TUI renders only `pi.*` entry kinds | warning `custom entry rendering is not supported in the durable demo; entries will not be shown` |
| `registerMarkdownTransformer`, `registerToolRenderer` | the TUI uses pi's default markdown and the generic `ToolExecutionComponent` | warning `custom rendering is not supported in the durable demo; default rendering is used` |
| `setSessionName`, `setLabel` | the demo session store has no names or entry labels | throw `Error("durable demo: session names/labels are not supported")` |
| `getSessionName` | — | returns `undefined` |
| `registerProvider`, `unregisterProvider` | model catalog is fixed at startup (`ModelRuntime.create`, `HarnessOptions.models`) | load: pending registrations never apply + warning `provider "<name>" registration is not supported in the durable demo; ignored`; runtime call: throw `Error("durable demo: provider registration is not supported")` |
| `registerMcpServer`, `unregisterMcpServer`, `getMcpServers` | the `mcp` builtin extension is disabled (it is AgentSession-shaped) | load: warning `MCP is not supported in the durable demo; server "<name>" ignored`; runtime: throw `Error("durable demo: MCP is not supported")`; `getMcpServers` returns `[]` |
| `registerVirtualModel`, `unregisterVirtualModel` | model catalog is fixed | same pattern as providers |
| `ctx.sessionManager` (field) | no pi session files | proxy field: **any** property access throws `Error("durable demo: sessionManager is not available")` |
| `ctx.modelRegistry` (field) | the demo uses `ModelRuntime`, not pi's `ModelRegistry` | proxy field: any access throws `Error("durable demo: modelRegistry is not available")` |
| `ctx.ui.*` except `ui.notify` | the demo TUI has no general dialog surface (no `select`/`input`/`custom` mounting from tool context in S2) | `ui.notify(message, type)` → `notice(type ?? "info", message)`; every other `ui.*` throws `Error("durable demo: ui.<name> is not available")` |
| `ctx.getSystemPrompt()`, `ctx.getSystemPromptOptions()` | the prompt is rendered per request inside the harness; no exposed construction options | throw `Error("durable demo: system prompt access is not available")` |
| `ctx.newSession`, `ctx.fork`, `ctx.navigateTree`, `ctx.switchSession` | no session files or trees | throw `Error("durable demo: session navigation is not supported; use /agents to switch conversations")` |
| `ctx.reload()` | resources are loaded once at open | throw `Error("durable demo: reloading is not supported; restart the demo")` |
| `ctx.compact(options.onComplete/onError)` | supported (see §2.4); durable has no `CompactionResult` payload | callbacks receive a best-effort `{}` result |
| tool `execute` `options.onUpdate` on `ctx.executeTool` | nested-call progress lives in `pi.live.nestedTools` only | silently ignored |
| `sendMessage` with image blocks | images are "not here" (README) | throw `Error("durable demo: image messages are not supported")` |

### 2.3 Tool bridge (pi `ToolDefinition` → durable `ToolRegistration`)

One durable extension, name **`pi-bridge`**, carries every bridged tool. Installed after `Subagent`,
so it is selected by the default (all-installed) extension selection in every conversation, and its
tools are offered to the model unless the conversation's agent filters them.

| pi `ToolDefinition` field | durable `ToolRegistration` field |
| --- | --- |
| `name`, `description`, `parameters` (same `TSchema`) | same |
| `prepareArguments` | same (pure, re-validated) |
| `executionMode` (`"sequential" \| "parallel"`) | same |
| `exposure: "direct"` (default) | default `callers` (model + tools) |
| `exposure: "model-only"` | `callers: ["model"]` |
| `exposure: "codemode"` | `callers: ["tools"]` |
| `exposure: "deferred"` | `deferred: true`, `callers: ["tools"]` |
| `exposure: "hidden"` | `callers: []` |
| `outputSchema` | `structuredOutputSchema` |
| `promptSnippet`, `promptGuidelines` | collected by the host in `toolPrompts()`; `prompt.ts` merges them into the system-prompt `tools` section (§4) |
| `execute(id, params, signal, onUpdate, ctx)` | `execute(args, api, context)`: `signal = context.abortSignal`; `onUpdate(partial)` → `api.output(text blocks)` + `api.details(partial.details, context)`; `ctx = host.createToolContext(api, context)`; result map: `content` → `output`, `details`, `isError`, `usage`, `terminate: true` → `control: { terminate: true }`. A thrown pi `execute` becomes `{ output: [{ type: "text", text: "Tool failed: <message>" }], isError: true }` |
| `label` | ignored (the card shows `name`) |
| `constrainedSampling`, `reachesTools`, `prepareLoadout`, `defaultActive: false`, `renderShell`, `renderCall`, `renderResult` | ignored + one load-time `warning` notice each: `tool "<name>": <field> is not supported in the durable demo; ignored`. `renderCall`/`renderResult`: the generic `ToolExecutionComponent` renders the call (S2 smoke accepts this) |
| `namespace`, `annotations` | ignored silently (metadata only; no codemode/MCP to consume them) |

### 2.4 Tool execution context (durable `ToolExecutionApi` → pi `ExtensionToolContext`)

| pi ctx field | Source in the demo |
| --- | --- |
| `ui.notify` | the host's `notice` |
| `ui.*` (other) | throw, §2.2 |
| `mode`, `hasUI` | `"tui"`, `true` |
| `cwd` | `api.env?.cwd ?? agent.cwd` |
| `sessionManager`, `modelRegistry` | throwing proxy, §2.2 |
| `model`, `thinkingLevel` | from `api.agent(context)` via `modelRuntime` |
| `scopedModels` | `[]` (no scoping) |
| `isIdle()` | current view's `pi.live.run === undefined` |
| `isProjectTrusted()` | `settingsManager.isProjectTrusted()` |
| `signal` | `context.abortSignal` |
| `abort()` | `controller.abort()` |
| `hasPendingMessages()` | `pi.inbox` items length `> 0` |
| `shutdown()` | host shutdown handler (set by `tui.ts` to the same path as Ctrl+D/`app.clear` exit) |
| `getContextUsage()` | tokens from the current view's entries (same computation the TUI footer uses — `tui.ts` exports the helper, the host imports it) + the model's `contextWindow` |
| `compact(options?)` | `controller.compact(options?.customInstructions)`, fire-and-forget; `onComplete`/`onError` best-effort |
| `getSystemPrompt()` | throw, §2.2 |
| `tools` | the callable `AgentTool` set (coding tools + bridge tools) |
| `executeTool(name, args, options?)` | `api.executeTool(name, args, context, { key: options?.key })`; `NestedToolExecutionResult` → `AgentToolCallOutcome` best-effort (`content` from `structuredOutput`/bounded output, `details`, `isError`, `durationMs`) |

`ExtensionCommandContext` (pi extension commands) adds: `waitForIdle()` → `conversation.waitForIdle(context)`;
`getSystemPromptOptions()`/`newSession`/`fork`/`navigateTree`/`switchSession`/`reload` → throw, §2.2.

### 2.5 Event mapping (`on(event)` → fire point)

Fired events use pi's payload shapes from `core/extensions/types.ts` as faithfully as the demo has
data; fields the demo cannot know are omitted or approximated (noted).

| pi event | Demo fire point | Notes |
| --- | --- | --- |
| `session_start` | `host.fireSessionStart()` after open (S2) | `reason`: `"startup"` (new session) / `"resume"` (`--continue`) |
| `session_shutdown` | `host.close()` in `durable.close()`, before `harness.close()` (S2) | `reason: "quit"` |
| `input` | TUI submit path, before command/panel/expander dispatch (S3) | result `continue`/`transform`/`handled` honored as in pi |
| `turn_start`, `turn_end` | `conversation.watch` view diff (S3) | `turnIndex` = per-conversation counter from 0; `timestamp = Date.now()`; `turn_end.message`/`toolResults`/entry ids from the turn's entries (ids as `String(entryId)`); boundary state empty — see §0 |
| `message_start`, `message_update`, `message_end` | `conversation.watch` view diff (S3) | `message_update.message` = the live partial (`pi.live.generation.message`); 1.4.0 only exposes the throttled partial, so `message_update` is a coarse `text_delta` — see §0 |
| `tool_execution_start`, `tool_execution_update`, `tool_execution_end` | `conversation.watch` view diff (S3) | `toolCallId`/`toolName`/`parentToolCallId` faithful; args reconstructed (1.4.0 slots carry none); `end.result` from the committed `pi.tool-result` entry or the slot's retained output — see §0 |
| `model_select`, `thinking_level_select` | `host.wrapController` around `setModel`/`cycleThinking` (S3) | `source: "set"` |
| `session_before_compact` | bridge durable extension hook `CompactionHooks.beforeCompact` on task `pi.compaction` (S3) | **honored**: handler `decline`/`summary` results map to the hook's `{ decline: true }` / `{ summary }`; payload `preparation`/`branchEntries` are best-effort from the hook's `compaction` argument (`reason`, `entries` → `branchEntries`-shaped) |
| `session_compact`, `session_compact_failed` | committed `pi.compaction` entry / `pi.live.compactionFailure` (S3) | `reason` from `entry.data.reason` / `failure.trigger` (1.4.0 `trigger`, was `reason`); `fromExtension` via `markFromExtension(taskId)` + entry `byTaskId`; `tokensBefore: 0`, `usage` omitted — see §0 |
| `auto_retry_start` / `auto_retry_end` (durable) | **not mapped** — pi has no retry event | the TUI status line already shows retries; noted here per the S3 spec |
| UNSUPPORTED — load-time `warning` notice each, never fired: | `project_trust`, `resources_discover`, `session_info_changed`, `session_before_switch`, `session_before_fork`, `session_before_tree`, `session_tree`, `mcp_servers_change`, `context`, `context_with_system`, `cache_warming_decision`, `before_provider_request`, `before_provider_headers`, `after_provider_response`, `provider_stream_event`, `before_agent_start`, `agent_start`, `agent_end`, `agent_before_settle`, `agent_settled`, `ui_prompt_start`, `ui_prompt_end`, `tool_call`, `tool_result`, `user_bash` | reasons: session files/trees and the project-trust prompt don't exist in the demo; the harness does not expose the provider request pipeline (a `context` mapping via `GenerationHooks.beforeRequest` is a possible follow-up); `tool_call`/`tool_result` would map to durable `ToolHooks` (follow-up); no `!`/`!!` user-bash prefix in the demo TUI |

The S3 event bridge lives in a new core file `event-bridge.ts` (created in S3): it subscribes
`conversation.watch(context)` for the current conversation (re-subscribes on `switchConversation` via
the controller wrapper; a missing/failed `watch` degrades to a `warning` notice) and maps the view
diff → pi events, calling the stored handlers with a host-built `ExtensionContext`. Handler throws
become `error` notices `Extension <path> event <event> failed: <message>`.

## 3. (b) File layout (all three tracks)

```
packages/coding-agent/src/experimental/durable/
  main.ts             core — S2: env → additionalExtensionPaths; S4: import sibling modules
  runtime.ts          core — S2: host creation, OpenDurableResult.notice, wrapController
  harness-setup.ts    core — S2: createCodingRegistry(settingsManager, cwd, host)
  prompt.ts           core — S2: loader resources + host.toolPrompts() (§4)
  tui.ts              core — S2: §6.2 dispatch, notice param, shutdown handler, exported context-token helper
  sessions.ts         core — read-only (contract)
  subagent.ts         core — unchanged
  DESIGN.md           core — this file
  README.md           core — S4: new commands, unsupported list, MCP off, /name, /skill
  command-registry.ts core, NEW (S2) — the Integration Seams, §6.1 (verbatim)
  extension-host.ts   core, NEW (S2) — §5 surface
  event-bridge.ts     core, NEW (S3) — §2.5 stream mapping

  commands.ts         ui track — /help and the cheap parity commands (registerCommand at module load)
  skill-command.ts    ui track — /skill:name input expander (registerInputExpander at module load)
  settings.ts         ui track — /settings panel (registerPanel at module load)
  settings-panel.ts   ui track — SettingsSelectorComponent wiring (SettingsConfig/Callbacks from
                      SettingsManager + DurableCommandContext; onCancel → ctx.restoreEditor())

  prompt-templates.ts templates track — /name input expander (registerInputExpander at module load)

packages/coding-agent/test/
  durable-command-registry.test.ts   core (S2)
  durable-extension-host.test.ts     core (S2)
  durable-event-bridge.test.ts       core (S3)
  durable-skill-command.test.ts      ui (U1)
  durable-settings.test.ts           ui (U2)
  durable-prompt-templates.test.ts   templates (T1)
```

Notes:

- **S4 integration edit in `main.ts`** (core-owned): after the other imports,
  `import "./commands.ts"; import "./skill-command.ts"; import "./settings.ts"; import "./prompt-templates.ts";`
  so the sibling modules' module-load registrations run before the TUI starts. Until S4, the demo
  dispatches builtins + pi extension commands only.
- Sibling tracks may **import** core files (`command-registry.ts`, `core/*`) but never edit them.
  They load their own resources directly (ui: `loadSkills({ cwd, agentDir,
  skillPaths: settings.getSkillPaths(), includeDefaults: true })`, honoring
  `settings.getEnableSkillCommands()`; templates: `loadPromptTemplates({ cwd, agentDir,
  promptPaths: settings.getPromptTemplatePaths(), includeDefaults: true })`) — no host access needed.
- `settings.ts` mounts the **real** `SettingsSelectorComponent` (`modes/interactive/components/
  settings-selector.ts`): its constructor is `(config: SettingsConfig, callbacks: SettingsCallbacks)` —
  plain data, no `AgentSession` dependency (verified). Unavailable options (session share, telemetry,
  changelog) map to no-ops with their current values; the panel's `onCancel` restores the editor.

## 4. (c) `createPiPrompt` inputs → ResourceLoader output

`prompt.ts` changes in S2; section keys and order stay `["preamble", "tools", "rules", "docs",
"project_context", "skills", "cwd"]` plus a final `"appended"` key:

| Input | Before | After |
| --- | --- | --- |
| context files | `loadProjectContextFiles({ cwd, agentDir })` per cwd | `host.resources().agentsFiles` (loader `getAgentsFiles()`, same loader call for `location.cwd`) |
| skills | `loadSkills({ cwd, agentDir, skillPaths: settings.getSkillPaths(), includeDefaults: true })` per cwd | `host.resources().skills` (loader `getSkills()`; the package manager resolves the same default dirs plus settings skill paths) |
| tool snippets | fixed `CONTRIBUTIONS` (read/bash/edit/write) | `CONTRIBUTIONS` ∪ `host.toolPrompts()` (bridged extension tools contribute `promptSnippet`/`promptGuidelines` when selected) |
| system prompt override | none | `host.resources().systemPrompt` (discovered `SYSTEM.md`, trust-aware): when set, the `"preamble"` section renders it and all other sections render `undefined` (the sections array is fixed at install; the renderers branch on the value) |
| append system prompt | none | `host.resources().appendSystemPrompt` rendered by the new `"appended"` section (pi appends it after the prompt) |
| themes | `InteractiveThemeController` from `SettingsManager` | **unchanged** — the theme system reads theme dirs directly (`getAvailableThemes()`); the loader's `getThemes()` is not needed; the ui track uses `getAvailableThemes()` for `/settings` |
| per-cwd cache | `Map<cwd, {contextFiles, skills}>` | kept: the loader resources apply for the session cwd; a conversation agent with a *different* `cwd` (not reachable in the demo today) falls back to the existing direct `loadProjectContextFiles`/`loadSkills` load |

Project-trust caveat: `DefaultResourceLoader.reload()` uses the `SettingsManager` trust state; the
demo does not prompt for trust (no `resolveProjectTrust`), so untrusted projects behave as untrusted
(no project `SYSTEM.md`), same as pi before trust is granted.

## 5. Extension host surface (core internal; S2 may refine signatures, not the seam file)

```ts
// extension-host.ts
export interface ExtensionHostOptions {
	readonly cwd: string;
	readonly agentDir: string;
	readonly settings: SettingsManager;
	readonly additionalExtensionPaths: string[]; // from PI_DURABLE_EXTENSION_PATHS
	notice(level: "info" | "warning" | "error", message: string): void;
}

export interface PiPromptResources {
	readonly skills: readonly Skill[];
	readonly agentsFiles: readonly { readonly path: string; readonly content: string }[];
	readonly systemPrompt?: string;
	readonly appendSystemPrompt: readonly string[];
}

export interface ExtensionHost {
	/** Durable extension with all bridged tools; install name "pi-bridge". */
	bridge(): Extension<ToolRegistration>;
	/** Loader output for the session cwd (prompt.ts). */
	resources(): PiPromptResources;
	/** promptSnippet/promptGuidelines of bridged tools, by tool name (prompt.ts). */
	toolPrompts(): ReadonlyMap<string, { readonly snippet?: string; readonly guidelines?: readonly string[] }>;
	/** Wraps the demo controller: tracks the current conversation; S3 fires model/thinking events. */
	wrapController(controller: DurableController): DurableController;
	/** Binds the live view and current conversation (runtime.ts, before any ctx use). */
	attach(options: {
		readonly view: DurableViewSource;
		readonly conversation: Conversation;
		readonly context: Context;
	}): void;
	fireSessionStart(reason: "startup" | "resume"): Promise<void>; // S2
	fireSessionShutdown(): Promise<void>;                          // S2
	fire(event: string, payload: unknown): Promise<unknown>;       // S3 (event-bridge.ts)
	createContext(): ExtensionContext;                             // S2 (tool/event ctx), S3 extends
	createCommandContext(): ExtensionCommandContext;               // S2
	setShutdownHandler(handler: () => void): void;                 // S2, called by tui.ts
	close(): Promise<void>;                                        // fires session_shutdown, stops S3 stream
}

export async function createExtensionHost(options: ExtensionHostOptions): Promise<ExtensionHost>;
```

## 6. (e) Integration Seams — binding, verbatim

### 6.1 `packages/coding-agent/src/experimental/durable/command-registry.ts` (core creates in S2)

Exports, exactly:

```ts
import type { Component } from "@earendil-works/pi-tui";
import type { SettingsManager } from "../../core/settings-manager.ts";
import type { DurableController, DurableView } from "./runtime.ts";

export type NoticeLevel = "info" | "warning" | "error";

/** Context for demo commands, panels, and input expanders. Built by tui.ts at dispatch. */
export interface DurableCommandContext {
	/** Command name without the leading slash; "" for non-command text. */
	readonly name: string;
	/** Raw text after the command name, trimmed; "" without arguments. */
	readonly args: string;
	/** Snapshot of the session and shown conversation at dispatch. */
	readonly view: DurableView;
	/** Shown conversation's agent cwd, falling back to the session cwd. */
	readonly cwd: string;
	/** pi's settings, live. */
	readonly settings: SettingsManager;
	/** The demo controller: submit, compact, abort, setModel, ... */
	readonly controller: DurableController;
	/** Add a TUI notice. */
	notice(level: NoticeLevel, message: string): void;
	/** Re-focus the editor; panels call it when dismissed. */
	restoreEditor(): void;
}

export interface DurableCommand {
	/** Name without the leading slash, e.g. "settings". */
	readonly name: string;
	/** Shown by /help. */
	readonly description?: string;
	execute(ctx: DurableCommandContext): Promise<void> | void;
}

/** Panel command: the TUI mounts the returned component in place of the editor. */
export interface DurablePanel {
	/** Command name without the leading slash, e.g. "settings". */
	readonly command: string;
	/** Build the component to mount; call ctx.restoreEditor() when dismissed. */
	build(ctx: DurableCommandContext): Component;
}

/** Submit-time text transform, e.g. /skill:name and /name expansion. */
export type DurableInputExpander = (text: string, ctx: DurableCommandContext) => string;

export interface CommandRegistry {
	/** Later registration with the same name is ignored (first wins). */
	register(command: DurableCommand): void;
	get(name: string): DurableCommand | undefined;
	list(): readonly DurableCommand[];
}

export interface PanelRegistry {
	register(panel: DurablePanel): void;
	get(command: string): DurablePanel | undefined;
}

export function createCommandRegistry(): CommandRegistry;
export function createPanelRegistry(): PanelRegistry;

/** Demo-wide registries the TUI dispatch consults. */
export const commands: CommandRegistry;
export const panels: PanelRegistry;

/** Register a demo command (sibling tracks call at module load). */
export function registerCommand(command: DurableCommand): void;
/** Register a panel (ui track's /settings). */
export function registerPanel(panel: DurablePanel): void;
/** Register an input expander; expanders run in registration order, each over the previous output. */
export function registerInputExpander(expander: DurableInputExpander): void;
/** Run every registered expander over `text`; returns the final text. */
export function expandInput(text: string, ctx: DurableCommandContext): string;
```

Semantics: `commands`/`panels` are module singletons; pi extension commands are registered into
`commands` by `extension-host.ts` at host creation (after sibling module-load registrations, since
`main.ts` imports siblings before calling `openDurable` — a name clash resolves first-wins in
favor of the sibling). All `import type` only from `runtime.ts` (no runtime cycle).

### 6.2 TUI submit dispatch (core edits `tui.ts` in S2; siblings never touch it)

```
submit(text):
	trimmed = text.trim(); if (!trimmed) return
	// builtins first, exactly as today: /model, /tasks, /agents, /compact [args]
	if (trimmed is a builtin) { handle; return }
	name = command name of trimmed (first word, minus "/"); args = the rest, trimmed
	ctx = { name, args, view: source.current(), cwd: agentOf(view).cwd ?? view.session.cwd,
	        settings, controller, notice, restoreEditor: () => view.restoreEditor() }
	if ((cmd = commands.get(name)) !== undefined) { void cmd.execute(ctx).catch(error notice); return }
	if ((panel = panels.get(name)) !== undefined) { view.mount(panel.build(ctx)); return }
	expanded = expandInput(trimmed, ctx)
	if (expanded.startsWith("/")) { ctx.notice("error", `Unknown command: /${name}`); return }
	void controller.submit(expanded, "steer")

followUp(text):  // follow-up key
	trimmed = text.trim(); if (!trimmed) return
	if (trimmed.startsWith("/")) { notice("error", "Commands cannot be queued as follow-ups"); return }
	void controller.submit(expandInput(trimmed, ctxFor(trimmed)), "followUp")
```

Precedence: builtins > registered commands > panels > expanders > unknown-command notice.
A registered command shadows a prompt template of the same name (documented in README).

### 6.3 What sibling tracks import (the whole contract they need)

```ts
// ui track / templates track files (module-load registrations):
import { registerCommand, registerPanel, registerInputExpander } from "./command-registry.ts";
import type { DurableCommandContext } from "./command-registry.ts";
```

That is all. Everything else (view shape, controller methods, settings getters) comes from the
existing `runtime.ts` / `core/settings-manager.ts` exports that the files above type against.

## 7. (d) Test strategy per step

Unit tests (vitest, `packages/coding-agent/test/`, run from the package root with
`node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run <file>`):

| Step | Test | Covers |
| --- | --- | --- |
| S2 | `durable-command-registry.test.ts` | registration, first-wins, panel lookup, expander ordering, `expandInput` |
| S2 | `durable-extension-host.test.ts` | temp extension under `os.tmpdir()` with `registerTool`/`registerCommand`/`on(session_start)`/`sendMessage`: bridge tool field mapping (exposure, prepareArguments, executionMode), command lands in `commands`, load errors/warnings → notices, unsupported members throw with the §2.2 messages; bridged `execute` arg mapping + result mapping (`terminate` → `control`, thrown error → `isError`) against a fake `ToolExecutionApi` |
| S3 | `durable-event-bridge.test.ts` | stream-event → pi-event mapping as pure functions (turn index counting, tool event call ids, compaction outcomes) |
| U1 | `durable-skill-command.test.ts` | `/skill:name args` expansion (frontmatter strip, block shape, unknown skill passthrough, `enableSkillCommands: false`) |
| U2 | `durable-settings.test.ts` | `SettingsConfig` built from a real `SettingsManager` fixture; callback → settings write round-trip |
| T1 | `durable-prompt-templates.test.ts` | `/name args` expansion (arg substitution, unknown template passthrough, precedence vs commands) |

Manual smokes:

- **S2**: demo boots to the editor; a **temporary** extension written under `/tmp` (passed via
  `PI_DURABLE_EXTENSION_PATHS` — the chosen mechanism, §6.4) registers a `hello` command (prints a
  notice with its args), an `echo` tool (the model calls it; generic `ToolExecutionComponent` card
  renders), and logs `session_start`; remove the temp extension before committing. `npm run check`
  green.
- **S3**: test extension overrides `session_before_compact` instructions and logs turn/tool events;
  confirm the override changes the compaction (notice text or transcript). `npm run check` green.
- **S4**: full smoke — fresh start and `--continue`, `/settings` round-trip, extension tool call,
  `/skill:name`, `/name` template, `kill -9` mid-turn then `--continue` recovers. `npm run check`
  full output.

## 8. Decisions log (S1)

- **D1** — Reuse `DefaultResourceLoader` for discovery + factory execution; the host replaces the
  runner's `bindCore` by patching the shared `ExtensionRuntime` actions. No factory re-runs, no
  hand-rolled factory shim. (Answers the "shim ExtensionAPI" wording in the S2 spec: the shim is
  the binding layer, the API objects are pi's own.)
- **D2** — Extra extension paths via env `PI_DURABLE_EXTENSION_PATHS` (colon-separated) →
  `OpenDurableOptions.additionalExtensionPaths` → loader `additionalExtensionPaths`. Chosen over a
  CLI flag (keeps `main.ts` parsing minimal; S2 smoke uses it).
- **D3** — One loader per process at `location.cwd`; `additionalSkillPaths` not needed (the package
  manager already resolves default skill dirs and settings skill paths); per-cwd fallback in
  `prompt.ts` kept for non-session cwds.
- **D4** — `disabledBuiltinExtensions: ["mcp"]` (scope decision; the `mcp` builtin is
  AgentSession-shaped). Other builtins load as-is; replacements/conflicts use pi's own
  `omitReplacedExtensions` + conflict diagnostics, surfaced as notices.
- **D5** — Bridge extension name `pi-bridge`; selected by the default all-installed selection (no
  `HarnessSettings.extensions` change) in every conversation, subagents included (matches pi, where
  subagents inherit the session's extension tools).
- **D6** — `sendMessage`: text only; `triggerTurn` maps to input submit (steer idle / followUp
  busy); passive = durable `write` submission of a `pi.user` entry. Images/custom types throw.
- **D7** — Dialog-style `ui.*` and provider/virtual-model/MCP registration are S2-unavailable with
  literal §2.2 messages; they stay out rather than half-working.
- **D8** — `context`/provider/request-level events are unsupported (harness keeps the provider
  pipeline internal); `tool_call`/`tool_result` noted as `ToolHooks` follow-up. Retry state stays
  in the TUI status line (no pi event exists).
- **D9** — S3 bridge file `event-bridge.ts` (new) rather than growing `extension-host.ts`.
- **D10** — Sibling tracks load skills/templates directly from `core/skills.ts` /
  `core/prompt-templates.ts` (no host accessor seam needed); ui mounts the real
  `SettingsSelectorComponent` (constructor verified dependency-free of `AgentSession`).
- **D11** — S4 (core) adds the four sibling module imports to `main.ts`; until then the demo has
  builtins + pi extension commands only.
