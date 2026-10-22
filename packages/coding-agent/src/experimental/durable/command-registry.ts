/**
 * Demo command, panel, and input-expander registries — the Integration Seams (DESIGN.md §6.1).
 * This file is the binding contract: the ui and templates tracks import from it and register at
 * module load; only the core track may edit it.
 */
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

export function createCommandRegistry(): CommandRegistry {
	const byName = new Map<string, DurableCommand>();
	return {
		register(command) {
			if (!byName.has(command.name)) byName.set(command.name, command);
		},
		get(name) {
			return byName.get(name);
		},
		list() {
			return [...byName.values()];
		},
	};
}

export function createPanelRegistry(): PanelRegistry {
	const byCommand = new Map<string, DurablePanel>();
	return {
		register(panel) {
			if (!byCommand.has(panel.command)) byCommand.set(panel.command, panel);
		},
		get(command) {
			return byCommand.get(command);
		},
	};
}

/** Demo-wide registries the TUI dispatch consults. */
export const commands: CommandRegistry = createCommandRegistry();
export const panels: PanelRegistry = createPanelRegistry();

const expanders: DurableInputExpander[] = [];

/** Register a demo command (sibling tracks call at module load). */
export function registerCommand(command: DurableCommand): void {
	commands.register(command);
}
/** Register a panel (ui track's /settings). */
export function registerPanel(panel: DurablePanel): void {
	panels.register(panel);
}
/** Register an input expander; expanders run in registration order, each over the previous output. */
export function registerInputExpander(expander: DurableInputExpander): void {
	expanders.push(expander);
}
/** Run every registered expander over `text`; returns the final text. */
export function expandInput(text: string, ctx: DurableCommandContext): string {
	return expanders.reduce((current, expander) => expander(current, ctx), text);
}
