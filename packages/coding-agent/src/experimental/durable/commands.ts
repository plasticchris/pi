/**
 * Demo builtin-layer commands (ui track, DESIGN.md §3b). Registered at module load through
 * the core registry; core's S4 adds `import "./commands.ts"` to main.ts, which runs this
 * before the TUI starts, so /help is live from the first submit.
 */
import { commands, registerCommand } from "./command-registry.ts";

/** The TUI builtins handled before any registry dispatch (tui.ts, DESIGN.md §6.2). */
const BUILTINS: readonly (readonly [name: string, description: string])[] = [
	["/model", "select the model"],
	["/tasks", "toggle the task view"],
	["/agents", "switch conversations (subagents)"],
	["/compact [instructions]", "compact the conversation"],
];

export function helpText(): string {
	const registered = commands
		.list()
		.filter((command) => command.name !== "help")
		.map((command) => (command.description ? `/${command.name} — ${command.description}` : `/${command.name}`));
	const parts: string[] = [];
	parts.push(`Builtins: ${BUILTINS.map(([name, description]) => `${name} — ${description}`).join("; ")}`);
	parts.push(
		registered.length > 0
			? `Commands: /help — show this list; ${registered.join("; ")}`
			: "Commands: /help — show this list",
	);
	parts.push("/skill:<name> [args] — expand a loaded skill into the message (unknown skill: <name> if not found)");
	return parts.join(" · ");
}

registerCommand({
	name: "help",
	description: "list builtins, commands, and /skill usage",
	execute(ctx) {
		ctx.notice("info", helpText());
	},
});
