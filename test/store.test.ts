// The two store readers on small hand-made stores in temp directories: what they accept, skip, retry and refuse.
// (fixtures.test.ts reads real pi-durable stores; zero-write.test.ts proves nothing is written.)
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, it } from "node:test";
import { readStore } from "../src/open.ts";
import { isJsonlStore, readJsonl } from "../src/store/jsonl.ts";
import { readSqlite, snapshotSqlite } from "../src/store/sqlite.ts";
import type { DecodeSite, JsonObject } from "../src/store/types.ts";

let directory: string;
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "durable-lens-store-test-"));
});
afterEach(() => {
	rmSync(directory, { recursive: true, force: true });
});

const lines = (...records: unknown[]) => records.map((record) => `${JSON.stringify(record)}\n`).join("");
const commit = (seq: number, ...writes: unknown[]) => ({ format: 1, type: "commit", seq, writes });
const put = (name: string, content: string) => writeFileSync(join(directory, name), content);

describe("isJsonlStore", () => {
	it("is true only for a directory with a main.jsonl file", () => {
		assert.equal(isJsonlStore(directory), false);
		put("main.jsonl", "");
		assert.equal(isJsonlStore(directory), true);
		assert.equal(isJsonlStore(join(directory, "main.jsonl")), false, "a file is not a store");
		assert.equal(isJsonlStore(join(directory, "missing")), false);
		mkdirSync(join(directory, "dir", "main.jsonl"), { recursive: true });
		assert.equal(isJsonlStore(join(directory, "dir")), false, "main.jsonl must be a file");
	});
});

describe("JSONL reader", () => {
	it("reads an empty store", async () => {
		put("main.jsonl", "");
		const raw = await readJsonl(directory);
		assert.deepEqual([raw.entries, raw.tasks, raw.conversations, raw.documents, raw.nextSeq, raw.attempts, raw.warnings], [[], [], [], [], 1, 1, []]);
	});

	it("reads records of every kind, keeping the latest write of each id in id order", async () => {
		put(
			"main.jsonl",
			lines(
				commit(
					1,
					{ type: "conversation", value: { id: 2 } },
					{ type: "conversation", value: { id: 1 } },
					{ type: "entry", value: { id: 1, conversationId: 1, kind: "pi.user" } },
				),
				commit(
					2,
					{ type: "entry", value: { id: 1, conversationId: 1, kind: "pi.user", edited: true } },
					{ type: "submission", value: { id: 4 } },
					{ type: "task", value: { id: 3 } },
				),
				commit(5, { type: "task", value: { id: 3, again: true } }),
			),
		);
		const raw = await readJsonl(directory);
		assert.deepEqual(
			raw.conversations.map((c) => c.id),
			[1, 2],
		);
		assert.deepEqual([raw.entries.length, raw.entries[0]?.seq, raw.entries[0]?.record.edited], [1, 2, true]);
		assert.deepEqual(raw.tasks, [{ id: 3, again: true }]);
		assert.deepEqual(raw.submissions, [{ id: 4 }]);
		assert.equal(raw.nextSeq, 6);
		assert.deepEqual(
			raw.files.map((file) => file.name),
			["main.jsonl"],
		);
	});

	it("skips a last line still being appended, and says so", async () => {
		put("main.jsonl", `${lines(commit(1, { type: "conversation", value: { id: 1 } }))}{"format":1,"type":"comm`);
		const raw = await readJsonl(directory);
		assert.equal(raw.conversations.length, 1);
		assert.deepEqual(raw.warnings, ["main.jsonl: skipped an incomplete last line (an owner may be writing it)"]);
	});

	it("reads a main file that is only a torn line as empty", async () => {
		put("main.jsonl", '{"format":1');
		assert.equal((await readJsonl(directory)).nextSeq, 1);
	});

	it("ignores blank lines", async () => {
		put("main.jsonl", `\n${lines(commit(1))}\n\n`);
		assert.equal((await readJsonl(directory)).nextSeq, 2);
	});

	it("applies the decoder to every payload, naming where it came from", async () => {
		put(
			"main.jsonl",
			lines(
				commit(
					1,
					{ type: "conversation", value: "enc:1" },
					{ type: "task.sidecar", id: 6, ordinal: 0 },
					{ type: "document.create", record: "enc:doc", ordinal: 0 },
				),
			),
		);
		put("task-6.jsonl", lines({ seq: 1, ordinal: 0, payload: { value: "enc:6" } }));
		put("doc-8.jsonl", lines({ seq: 1, ordinal: 0, payload: { content: "enc:content" } }));
		const sites: DecodeSite[] = [];
		const raw = await readJsonl(directory, {
			decode: (value, site) => {
				sites.push(site);
				return String(value).startsWith("enc:")
					? { id: Number(String(value).slice(4)) || 8, scope: { kind: "session" }, kind: "base", version: 1, value: 1 }
					: value;
			},
		});
		assert.deepEqual(sites.map((site) => `${site.store}:${site.table}.${site.column}`).sort(), [
			"jsonl:conversation.value",
			"jsonl:document.content",
			"jsonl:document.record",
			"jsonl:task.value",
		]);
		assert.equal(raw.conversations[0]?.id, 1);
		assert.equal(raw.tasks[0]?.id, 6);
		assert.equal(raw.documents[0]?.revisions[0]?.kind, "base");
	});

	it("tells the user to pass a decoder when a record has no id", async () => {
		put("main.jsonl", lines(commit(1, { type: "conversation", value: "ciphertext" })));
		await assert.rejects(readJsonl(directory), /a conversation without an id; pass --decoder if the store is encrypted/);
	});

	it("refuses markers it does not understand", async () => {
		const refused = async (content: string, message: RegExp) => {
			put("main.jsonl", content);
			await assert.rejects(readJsonl(directory), message, content);
		};
		await refused(lines({ format: 2, type: "commit", seq: 1, writes: [] }), /main.jsonl line 1: unknown marker format 2/);
		await refused(lines({ format: 1, type: "other", seq: 1, writes: [] }), /unknown marker format 1/);
		await refused(lines(commit(2), commit(2)), /line 2: commit sequence does not increase/);
		await refused(lines(commit(3), commit(1)), /line 2: commit sequence does not increase/);
		await refused(lines(commit(0)), /commit sequence does not increase/);
		await refused(lines({ format: 1, type: "commit", seq: 1 }), /no writes/);
		await refused(lines(commit(1, "text")), /a write is not an object/);
		await refused(lines(commit(1, { type: "task.sidecar", id: -1, ordinal: 0 })), /malformed task.sidecar write/);
		await refused(lines(commit(1, { type: "document.change", id: 1, ordinal: "x" })), /malformed document.change write/);
		await refused(lines(commit(1, { type: "document.create", record: { id: 1 }, ordinal: 0 })), /malformed document.create write/);
		await refused(lines(commit(1, { type: "document.retire", id: 1.5 })), /malformed document.retire write/);
		await refused("[1,2]\n", /line 1 is not a JSON object|is not a JSON object/);
	});

	it("skips write types it does not know, with a warning", async () => {
		put("main.jsonl", lines(commit(1, { type: "future-thing" }, { type: "conversation", value: { id: 1 } })));
		const raw = await readJsonl(directory);
		assert.equal(raw.conversations.length, 1);
		assert.deepEqual(raw.warnings, ["main.jsonl line 1: skipped unknown write type future-thing"]);
	});

	it("rejects a change to a document that was never created", async () => {
		put("main.jsonl", lines(commit(1, { type: "document.change", id: 9, ordinal: 0 })));
		put("doc-9.jsonl", lines({ seq: 1, ordinal: 0, payload: { content: { kind: "base", version: 1, value: 1 } } }));
		await assert.rejects(readJsonl(directory), /change of unknown document 9/);
	});

	it("retries a line that is not JSON, then gives up", async () => {
		put("main.jsonl", `${lines(commit(1))}not json\n`);
		await assert.rejects(readJsonl(directory), /main.jsonl line 2 is not JSON, still after 6 reads/);
	});

	it("retries a missing task sidecar but not for a task that ends terminal", async () => {
		put("main.jsonl", lines(commit(1, { type: "task.sidecar", id: 4, ordinal: 0 })));
		await assert.rejects(readJsonl(directory), /task-4.jsonl lacks the record of commit 1/);
		put("main.jsonl", lines(commit(1, { type: "task.sidecar", id: 4, ordinal: 0 }), commit(2, { type: "task", value: { id: 4, final: true } })));
		const raw = await readJsonl(directory);
		assert.deepEqual(raw.tasks, [{ id: 4, final: true }]);
	});

	it("reads task and document sidecars, and follows a document's life", async () => {
		const record = { id: 5, kind: "app.notes", scope: { kind: "conversation", conversationId: 1 }, history: "rewindable" };
		put(
			"main.jsonl",
			lines(
				commit(1, { type: "task.sidecar", id: 2, ordinal: 0 }, { type: "document.create", record, ordinal: 0 }),
				commit(2, { type: "document.change", id: 5, ordinal: 0 }, { type: "task.sidecar", id: 2, ordinal: 1 }),
				commit(3, { type: "document.retire", id: 5 }, { type: "document.retire", id: 77 }),
			),
		);
		put(
			"task-2.jsonl",
			lines({ seq: 1, ordinal: 0, payload: { value: { id: 2, state: "first" } } }, { seq: 2, ordinal: 1, payload: { value: { id: 2, state: "second" } } }),
		);
		put(
			"doc-5.jsonl",
			lines(
				{ seq: 1, ordinal: 0, payload: { content: { kind: "base", version: 1, value: { n: 0 } } } },
				{ seq: 2, ordinal: 0, payload: { content: { kind: "delta", version: 2, ops: [["s", ["n"], 1]] } } },
			),
		);
		put("notes.txt", "not a sidecar");
		put("task-01.jsonl", "ignored: leading zero");
		const raw = await readJsonl(directory);
		assert.deepEqual(raw.tasks, [{ id: 2, state: "second" }]);
		const [doc] = raw.documents;
		assert.deepEqual([doc?.record.createdAt, doc?.record.retiredAt], [1, 3]);
		assert.deepEqual(
			doc?.revisions.map((r) => [r.seq, r.kind, r.version, r.content]),
			[
				[1, "base", 1, { n: 0 }],
				[2, "delta", 2, [["s", ["n"], 1]]],
			],
		);
		assert.deepEqual(raw.files.map((file) => file.name).sort(), ["doc-5.jsonl", "main.jsonl", "task-2.jsonl"]);
	});

	it("tolerates reclaimed sidecar records of a document that keeps only its current value", async () => {
		// Session-scoped documents keep their newest base on: the older records may be gone, but a record the marker needs is not.
		const record = { id: 5, kind: "app.cfg", scope: { kind: "session" } };
		put(
			"main.jsonl",
			lines(
				commit(1, { type: "document.create", record, ordinal: 0 }),
				commit(2, { type: "document.change", id: 5, ordinal: 0 }),
				commit(3, { type: "document.change", id: 5, ordinal: 0 }),
			),
		);
		put(
			"doc-5.jsonl",
			lines(
				{ seq: 2, ordinal: 0, payload: { content: { kind: "base", version: 2, value: { n: 2 } } } },
				{ seq: 3, ordinal: 0, payload: { content: { kind: "delta", version: 3, ops: [["s", ["n"], 3]] } } },
			),
		);
		const raw = await readJsonl(directory);
		assert.deepEqual(
			raw.documents[0]?.revisions.map((r) => r.seq),
			[2, 3],
			"commit 1's record was reclaimed",
		);
		// The same hole in a rewindable conversation document is damage, and is not papered over.
		put(
			"main.jsonl",
			lines(
				commit(1, { type: "document.create", record: { ...record, scope: { kind: "conversation" }, history: "rewindable" }, ordinal: 0 }),
				commit(2, { type: "document.change", id: 5, ordinal: 0 }),
			),
		);
		await assert.rejects(readJsonl(directory), /doc-5.jsonl lacks the record of commit 1/);
	});

	it("refuses a malformed document sidecar record", async () => {
		put("main.jsonl", lines(commit(1, { type: "document.create", record: { id: 1, scope: { kind: "session" } }, ordinal: 0 })));
		put("doc-1.jsonl", lines({ seq: 1, ordinal: 0, payload: { content: { kind: "other" } } }));
		await assert.rejects(readJsonl(directory), /doc-1.jsonl: malformed record of commit 1/);
	});

	it("does not read a directory without main.jsonl", async () => {
		await assert.rejects(readJsonl(directory), /ENOENT/);
		await assert.rejects(readStore(directory), /without main.jsonl, so not a pi-durable JSONL store/);
	});
});

/** A SQLite store with the tables the reader selects from, with an optional table prefix. */
function sqliteStore(name: string, prefix = "", rows: { conversations?: JsonObject[]; entries?: [number, JsonObject][]; schema?: number | null } = {}): string {
	const path = join(directory, name);
	const db = new DatabaseSync(path);
	const t = (table: string) => `"${`${prefix}${table}`.replaceAll('"', '""')}"`;
	db.exec(`
		CREATE TABLE ${t("durable_schema")} (version INTEGER);
		CREATE TABLE ${t("durable_metadata")} (next_id INTEGER, next_seq INTEGER);
		CREATE TABLE ${t("conversations")} (id INTEGER PRIMARY KEY, record TEXT);
		CREATE TABLE ${t("entries")} (id INTEGER PRIMARY KEY, record TEXT, commit_seq INTEGER);
		CREATE TABLE ${t("tasks")} (id INTEGER PRIMARY KEY, record TEXT);
		CREATE TABLE ${t("submissions")} (id INTEGER PRIMARY KEY, record TEXT);
		CREATE TABLE ${t("documents")} (id INTEGER PRIMARY KEY, record TEXT);
		CREATE TABLE ${t("document_revisions")} (document_id INTEGER, seq INTEGER, kind TEXT, version INTEGER, content TEXT);
	`);
	if (rows.schema !== null) db.prepare(`INSERT INTO ${t("durable_schema")} VALUES (?)`).run(rows.schema ?? 2);
	db.prepare(`INSERT INTO ${t("durable_metadata")} VALUES (10, 20)`).run();
	for (const record of rows.conversations ?? []) db.prepare(`INSERT INTO ${t("conversations")} VALUES (?, ?)`).run(Number(record.id), JSON.stringify(record));
	for (const [seq, record] of rows.entries ?? [])
		db.prepare(`INSERT INTO ${t("entries")} VALUES (?, ?, ?)`).run(Number(record.id), JSON.stringify(record), seq);
	db.exec("PRAGMA journal_mode = DELETE");
	db.close();
	return path;
}

describe("SQLite reader", () => {
	it("reads the tables of a store and describes its schema", async () => {
		const path = sqliteStore("a.sqlite", "", { conversations: [{ id: 1 }], entries: [[4, { id: 7, conversationId: 1, kind: "pi.user" }]] });
		const raw = await readSqlite(path);
		assert.deepEqual([raw.kind, raw.path, raw.schemaVersion, raw.nextSeq, raw.nextId, raw.prefix], ["sqlite", path, 2, 20, 10, undefined]);
		assert.deepEqual(raw.conversations, [{ id: 1 }]);
		assert.deepEqual([raw.entries[0]?.seq, raw.entries[0]?.record.id], [4, 7]);
		assert.deepEqual(
			raw.files.map((file) => file.name),
			["a.sqlite"],
		);
		assert.equal(raw.attempts, 1);
	});

	it("detects a single table prefix, and reports it", async () => {
		const path = sqliteStore("p.sqlite", "app_", { conversations: [{ id: 1 }] });
		const raw = await readSqlite(path);
		assert.equal(raw.prefix, "app_");
		assert.equal(raw.conversations.length, 1);
		assert.equal((await readSqlite(path, { prefix: "app_" })).prefix, "app_");
	});

	it("treats a table prefix as a name, never as SQL", async () => {
		for (const prefix of ['x"; DROP TABLE canary; --', 'a" OR "1"="1', '"', "p'; DELETE FROM canary; --", "multi\nline_", "semi;colon_"]) {
			const path = sqliteStore("h.sqlite", prefix, { conversations: [{ id: 1, from: "hostile" }] });
			const db = new DatabaseSync(path);
			db.exec("CREATE TABLE canary (x INTEGER); INSERT INTO canary VALUES (42)");
			db.close();
			const detected = await readSqlite(path, {});
			assert.equal(detected.prefix, prefix, JSON.stringify(prefix));
			assert.equal(detected.conversations[0]?.from, "hostile");
			assert.equal((await readSqlite(path, { prefix })).conversations[0]?.from, "hostile");
			// A prefix with no tables behind it is an ordinary missing-table error.
			await assert.rejects(readSqlite(path, { prefix: `${prefix}missing` }), /no such table/);
			const after = new DatabaseSync(path, { readOnly: true });
			assert.deepEqual(
				after
					.prepare("SELECT x FROM canary")
					.all()
					.map((row) => row.x),
				[42],
				"nothing was dropped or changed",
			);
			after.close();
			rmSync(path);
		}
	});

	it("warns when several storages share a database, and reads the first or the one asked for", async () => {
		const path = sqliteStore("s.sqlite", "a_", { conversations: [{ id: 1 }] });
		const db = new DatabaseSync(path);
		db.exec(`CREATE TABLE "b_durable_schema" (version INTEGER); CREATE TABLE "b_durable_metadata" (next_id INTEGER, next_seq INTEGER);`);
		for (const table of ["conversations", "entries", "tasks", "submissions", "documents"])
			db.exec(`CREATE TABLE "b_${table}" (id INTEGER PRIMARY KEY, record TEXT, commit_seq INTEGER)`);
		db.exec(`CREATE TABLE "b_document_revisions" (document_id INTEGER, seq INTEGER, kind TEXT, version INTEGER, content TEXT)`);
		db.prepare(`INSERT INTO "b_conversations" VALUES (1, '{"id":1,"from":"b"}', NULL)`).run();
		db.close();
		const first = await readSqlite(path);
		assert.match(first.warnings.join("\n"), /several pi-durable storages share this database \(prefixes a_, b_\); showing "a_"/);
		assert.equal(first.conversations[0]?.from, undefined);
		const second = await readSqlite(path, { prefix: "b_" });
		assert.deepEqual(second.warnings, []);
		assert.equal(second.conversations[0]?.from, "b");
		assert.equal(second.schemaVersion, undefined, "b_ has no schema row");
		assert.equal(second.nextSeq, undefined, "nor a metadata row");
	});

	it("refuses a database without pi-durable tables", async () => {
		const path = join(directory, "other.sqlite");
		const db = new DatabaseSync(path);
		db.exec("CREATE TABLE unrelated (x INTEGER)");
		db.close();
		await assert.rejects(readSqlite(path), /no pi-durable tables in this database/);
	});

	it("refuses a file that is not SQLite, and one that does not exist", async () => {
		put("text.sqlite", "SELECT 1; this is not a database file");
		await assert.rejects(readSqlite(join(directory, "text.sqlite")), /is not a SQLite database/);
		await assert.rejects(readSqlite(join(directory, "missing.sqlite")), /not a SQLite database/);
		put("tiny.sqlite", "");
		await assert.rejects(readSqlite(join(directory, "tiny.sqlite")), /is not a SQLite database/);
	});

	it("applies the decoder to every JSON payload, and fails on a payload that is not JSON", async () => {
		const path = sqliteStore("d.sqlite", "", { conversations: [{ id: 1 }] });
		const sites: string[] = [];
		await readSqlite(path, {
			decode: (value, site) => {
				sites.push(`${site.store}:${site.table}.${site.column}`);
				return value;
			},
		});
		assert.deepEqual(sites, ["sqlite:conversations.record"]);
		const db = new DatabaseSync(path);
		db.exec(`INSERT INTO conversations VALUES (2, 'not json')`);
		db.close();
		await assert.rejects(readSqlite(path), /JSON/);
	});

	it("copies the database into a private directory and cleans up, also on failure", async () => {
		const tmp = join(directory, "tmp");
		mkdirSync(tmp);
		const before = process.env.TMPDIR;
		process.env.TMPDIR = tmp;
		try {
			const path = sqliteStore("c.sqlite");
			const snapshot = await snapshotSqlite(path);
			assert.ok(snapshot.path.startsWith(tmp), "inside the temp directory");
			assert.notEqual(snapshot.path, path);
			assert.equal(readdirSync(snapshot.path.replace(/\/[^/]+$/, "")).length, 1);
			snapshot.dispose();
			assert.deepEqual(readdirSync(tmp), []);
			await assert.rejects(readSqlite(join(directory, "text-missing.sqlite")), /not a SQLite database/);
			put("text.sqlite", "nope");
			await assert.rejects(readSqlite(join(directory, "text.sqlite")), /not a SQLite database/);
			assert.deepEqual(readdirSync(tmp), []);
			// Those fail before any copy; a real database without pi-durable tables fails after its snapshot.
			const plain = new DatabaseSync(join(directory, "plain.sqlite"));
			plain.exec("CREATE TABLE other (x)");
			plain.close();
			await assert.rejects(readSqlite(join(directory, "plain.sqlite")), /no pi-durable tables/);
			assert.deepEqual(readdirSync(tmp), [], "the snapshot of a read that failed is gone too");
		} finally {
			if (before === undefined) delete process.env.TMPDIR;
			else process.env.TMPDIR = before;
		}
	});

	it("leaves the original untouched", async () => {
		const path = sqliteStore("u.sqlite", "", { conversations: [{ id: 1 }] });
		chmodSync(path, 0o444);
		const before = readdirSync(directory).sort();
		await readSqlite(path);
		assert.deepEqual(readdirSync(directory).sort(), before, "no -wal, -shm or journal appeared");
	});
});
