import { appendFile, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Context, JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterEach, describe, expect, it } from "vitest";
import type { FileError, Result } from "../src/env/index.ts";
import { NodeExecutionEnv } from "../src/env/node.ts";
import { JsonlStorage } from "../src/storage/jsonl/index.ts";
import type { DocumentCreate, DocumentId, EntryId, TaskId, TaskRecord } from "../src/types.ts";
import { ROOT_CONVERSATION_ID } from "../src/types.ts";

const context = BACKGROUND_CONTEXT;
type StoredTask = TaskRecord<JsonValue, JsonValue, JsonValue>;

const tempDirectories = new Set<string>();
const openStorages = new Set<JsonlStorage>();

afterEach(async () => {
	for (const storage of openStorages) await storage.close(context);
	openStorages.clear();
	for (const directory of tempDirectories) await rm(directory, { recursive: true, force: true });
	tempDirectories.clear();
});

async function tempDirectory(prefix = "pi-durable-jsonl-readonly-"): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), prefix));
	tempDirectories.add(directory);
	return directory;
}

/**
 * Records every mutating filesystem operation so a test can assert that a
 * read-only open performed *none* of them while still reading correctly.
 * All recorded operations still reach the real filesystem.
 */
class RecordingExecutionEnv extends NodeExecutionEnv {
	readonly operations: string[] = [];

	private record(operation: string, path: string): void {
		this.operations.push(`${operation}:${basename(path)}`);
	}

	override async writeFile(
		path: string,
		content: string | Uint8Array,
		writeContext: Context,
	): Promise<Result<void, FileError>> {
		this.record("write", path);
		return super.writeFile(path, content, writeContext);
	}

	override async appendFile(
		path: string,
		content: string | Uint8Array,
		appendContext: Context,
	): Promise<Result<void, FileError>> {
		this.record("append", path);
		return super.appendFile(path, content, appendContext);
	}

	override async truncateFile(path: string, size: number, truncateContext: Context): Promise<Result<void, FileError>> {
		this.record("truncate", path);
		return super.truncateFile(path, size, truncateContext);
	}

	override async flushFile(path: string, flushContext: Context): Promise<Result<void, FileError>> {
		this.record("flush", path);
		return super.flushFile(path, flushContext);
	}

	override async renameFile(
		sourcePath: string,
		destinationPath: string,
		renameContext: Context,
	): Promise<Result<void, FileError>> {
		this.record("rename", destinationPath);
		return super.renameFile(sourcePath, destinationPath, renameContext);
	}

	override async remove(
		path: string,
		options: { recursive?: boolean; force?: boolean } | undefined,
		removeContext: Context,
	): Promise<Result<void, FileError>> {
		this.record("remove", path);
		return super.remove(path, options, removeContext);
	}

	override async createDir(
		path: string,
		options: { recursive?: boolean } | undefined,
		createDirContext: Context,
	): Promise<Result<void, FileError>> {
		this.record("createDir", path);
		return super.createDir(path, options, createDirContext);
	}

	override async createTempDir(
		prefix: string | undefined,
		createTempDirContext: Context,
	): Promise<Result<string, FileError>> {
		this.record("createTempDir", prefix ?? "(temp)");
		return super.createTempDir(prefix, createTempDirContext);
	}

	override async createTempFile(
		options: { prefix?: string; suffix?: string } | undefined,
		createTempFileContext: Context,
	): Promise<Result<string, FileError>> {
		this.record("createTempFile", options?.prefix ?? "(temp)");
		return super.createTempFile(options, createTempFileContext);
	}
}

async function openWriter(directory: string): Promise<JsonlStorage> {
	const storage = await JsonlStorage.open(directory, new NodeExecutionEnv({ cwd: directory }), context);
	openStorages.add(storage);
	return storage;
}

async function openReader(directory: string): Promise<{ storage: JsonlStorage; env: RecordingExecutionEnv }> {
	const env = new RecordingExecutionEnv({ cwd: directory });
	const storage = await JsonlStorage.open(directory, env, context, { readOnly: true });
	openStorages.add(storage);
	return { storage, env };
}

function sessionDocument(id: DocumentId, kind = "test.document"): DocumentCreate {
	return { id, kind, scope: { kind: "session" } };
}

/**
 * Build a realistic store with committed state that a normal open would want to
 * clean up: a live document that has accumulated superseded bases (reclaim
 * candidates) plus a task, so the writer's on-disk state has both a reclaimable
 * doc sidecar and a live task sidecar.
 */
async function buildStore(directory: string): Promise<{ documentId: DocumentId; taskId: TaskId<JsonValue> }> {
	const storage = await openWriter(directory);
	await storage.commit([{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }], context);
	const taskId = await storage.mintId<TaskId<JsonValue>>();
	const documentId = await storage.mintId<DocumentId>();
	const task: StoredTask = {
		id: taskId,
		conversationId: ROOT_CONVERSATION_ID,
		kind: "test.task",
		version: 1,
		input: null,
		state: { status: "pending", checkpoint: { phase: "ready" } },
		background: false,
		abortRequested: false,
	};
	await storage.commit([{ type: "task", value: task }], context);
	await storage.commit(
		[
			{
				type: "document.create",
				record: sessionDocument(documentId),
				content: { kind: "base", version: 1, value: { count: 0 } },
			},
		],
		context,
	);
	// Two more bases: the first two become reclaim candidates on a normal reopen.
	await storage.commit(
		[{ type: "document.change", id: documentId, content: { kind: "base", version: 1, value: { count: 1 } } }],
		context,
	);
	await storage.commit(
		[{ type: "document.change", id: documentId, content: { kind: "base", version: 1, value: { count: 2 } } }],
		context,
	);
	await storage.close(context);
	openStorages.delete(storage);
	return { documentId, taskId };
}

describe("Pico JsonlStorage read-only open", () => {
	it("reads committed state identical to a writer open, and performs zero filesystem writes", async () => {
		const directory = await tempDirectory();
		const { taskId } = await buildStore(directory);

		// Baseline: what a normal open sees.
		const baseline = await openWriter(directory);
		const baselineConvs = await baseline.scanConversations({}, 100, undefined, context);
		const baselineTasks = await baseline.scanTasks({}, 100, undefined, context);
		const baselineDocs = await baseline.scanDocuments(
			{ scope: { kind: "session" } as never, at: "current" as never, kind: "test.document" } as never,
			100,
			undefined,
			context,
		);
		await baseline.close(context);
		openStorages.delete(baseline);

		// The reader: same view, no writes.
		const { storage: reader, env } = await openReader(directory);
		expect(reader.isReadOnly).toBe(true);

		const convs = await reader.scanConversations({}, 100, undefined, context);
		const tasks = await reader.scanTasks({}, 100, undefined, context);
		const docs = await reader.scanDocuments(
			{ scope: { kind: "session" } as never, at: "current" as never, kind: "test.document" } as never,
			100,
			undefined,
			context,
		);
		expect(convs.items.map((r) => r.id)).toEqual(baselineConvs.items.map((r) => r.id));
		expect(tasks.items.map((r) => r.id)).toEqual(baselineTasks.items.map((r) => r.id));
		expect(docs.items.map((r) => r.id)).toEqual(baselineDocs.items.map((r) => r.id));
		expect(docs.items).toHaveLength(1);
		expect(tasks.items.map((r) => r.id)).toContain(taskId);

		// The whole point: the reader made no mutating filesystem call at all,
		// even though a normal open would reclaim the superseded doc bases.
		expect(env.operations).toEqual([]);

		// close is write-free too.
		const before = [...env.operations];
		await reader.close(context);
		openStorages.delete(reader);
		expect(env.operations).toEqual(before);
	});

	it("does not truncate a torn sidecar tail and leaves the on-disk bytes untouched", async () => {
		const directory = await tempDirectory();
		const { documentId } = await buildStore(directory);

		// Simulate a crash mid-commit: an incomplete, non-newline-terminated
		// line appended to a live doc sidecar. A normal open truncates it.
		const sidecarPath = join(directory, `doc-${documentId}.jsonl`);
		const torn = '{"format":1,"type":"record","seq":999,"ordinal":0,"payload":{"type":"document"';
		await appendFile(sidecarPath, torn); // no trailing newline
		const sizeBefore = (await stat(sidecarPath)).size;

		const { storage: reader, env } = await openReader(directory);
		// The torn tail is ignored in-memory; the committed value is intact.
		const docs = await reader.scanDocuments(
			{ scope: { kind: "session" } as never, at: "current" as never, kind: "test.document" } as never,
			100,
			undefined,
			context,
		);
		expect(docs.items).toHaveLength(1);

		// Zero writes, and the torn bytes are still on disk (a writer is still
		// allowed to finish that append later).
		expect(env.operations).toEqual([]);
		expect((await stat(sidecarPath)).size).toBe(sizeBefore);
		await reader.close(context);
		openStorages.delete(reader);
	});

	it("a normal open of the same torn store would have written (the flag changes behavior)", async () => {
		const directory = await tempDirectory();
		const { documentId } = await buildStore(directory);
		const sidecarPath = join(directory, `doc-${documentId}.jsonl`);
		await appendFile(sidecarPath, '{"format":1,"type":"record","seq":999,"ordinal":0,'); // torn

		const env = new RecordingExecutionEnv({ cwd: directory });
		const storage = await JsonlStorage.open(directory, env, context); // NOT read-only
		openStorages.add(storage);
		expect(env.operations.some((op) => op.startsWith("truncate:") || op.startsWith("remove:"))).toBe(true);
		await storage.close(context);
		openStorages.delete(storage);
	});

	it("rejects commit() on a read-only storage", async () => {
		const directory = await tempDirectory();
		const { storage: reader } = await openReader(directory);
		await expect(reader.commit([], context)).rejects.toThrow(/read-only/);
	});

	it("opens a missing directory as an empty store, creating nothing", async () => {
		const directory = await tempDirectory();
		await rm(directory, { recursive: true, force: true });
		const env = new RecordingExecutionEnv({ cwd: tmpdir() });
		const storage = await JsonlStorage.open(directory, env, context, { readOnly: true });
		openStorages.add(storage);
		expect(storage.isReadOnly).toBe(true);
		const convs = await storage.scanConversations({}, 100, undefined, context);
		expect(convs.items).toHaveLength(0);
		expect(env.operations).toEqual([]);
		expect(await stat(directory).catch(() => null)).toBeNull(); // directory was never created
		await storage.close(context);
		openStorages.delete(storage);
	});

	it("reads a torn main-marker tail without truncating it", async () => {
		const directory = await tempDirectory();
		await buildStore(directory);
		const mainPath = join(directory, "main.jsonl");
		await appendFile(mainPath, '{"format":1,"type":"commit","seq":999'); // torn, no newline
		const sizeBefore = (await stat(mainPath)).size;

		const { storage: reader, env } = await openReader(directory);
		const convs = await reader.scanConversations({}, 100, undefined, context);
		expect(convs.items).toHaveLength(1); // only the committed root
		expect(env.operations).toEqual([]);
		expect((await stat(mainPath)).size).toBe(sizeBefore);
		await reader.close(context);
		openStorages.delete(reader);
	});

	it("tracks entries and submissions read-only across a long history", async () => {
		const directory = await tempDirectory();
		const storage = await openWriter(directory);
		await storage.commit([{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }], context);
		const documentId = await storage.mintId<DocumentId>();
		await storage.commit(
			[
				{
					type: "document.create",
					record: sessionDocument(documentId),
					content: { kind: "base", version: 1, value: { n: 0 } },
				},
			],
			context,
		);
		const entryIds: EntryId[] = [];
		for (let i = 1; i <= 5; i++) {
			const id = await storage.mintId<EntryId>();
			entryIds.push(id);
			await storage.commit(
				[
					{
						type: "entry",
						value: { id, conversationId: ROOT_CONVERSATION_ID, kind: "user", data: { text: `msg ${i}` } },
					},
				],
				context,
			);
		}
		await storage.close(context);
		openStorages.delete(storage);

		const { storage: reader, env } = await openReader(directory);
		const entries = await reader.scanEntries({ conversationId: ROOT_CONVERSATION_ID }, 100, undefined, context);
		expect(entries.items.map((r) => r.id).sort((a, b) => a - b)).toEqual([...entryIds].sort((a, b) => a - b));
		expect(env.operations).toEqual([]);
		await reader.close(context);
		openStorages.delete(reader);
	});
});
