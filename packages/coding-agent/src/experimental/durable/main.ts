#!/usr/bin/env node

import { type OpenDurableOptions, openDurable } from "./runtime.ts";
import { runDurableTui } from "./tui.ts";

function parseArgs(argv: readonly string[]): OpenDurableOptions {
	let continueSession = false;
	for (const arg of argv) {
		if (arg === "--continue" || arg === "-c") continueSession = true;
		else throw new Error(`Unknown argument: ${arg}`);
	}
	// Extra extension paths, like pi's -e: colon-separated, e.g. /tmp/my-ext/index.ts:/tmp/other-ext.
	const additionalExtensionPaths = (process.env.PI_DURABLE_EXTENSION_PATHS ?? "")
		.split(":")
		.map((path) => path.trim())
		.filter((path) => path.length > 0);
	return { continueSession, ...(additionalExtensionPaths.length > 0 ? { additionalExtensionPaths } : {}) };
}

const durable = await openDurable(parseArgs(process.argv.slice(2)));
try {
	await runDurableTui(durable.view, durable.controller, durable.settings, durable.notice, durable.host);
} finally {
	await durable.close();
}
