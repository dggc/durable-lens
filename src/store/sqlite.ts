// SQLite stores, read from a private copy so the owner's files are never opened for writing.
//
// Opening the original read-only is not enough: SQLite still creates -wal and -shm beside an idle WAL database and
// writes read marks into the -shm of a live one, and `immutable=1` skips the WAL and returns stale data. So the
// database and its WAL are copied (a reflink where the filesystem supports one), and the copy is opened.
//
// The copy is consistent when no WAL reset happened while it was taken: in WAL mode the database file only changes by
// checkpointing frames that stay in the WAL until a reset, and a reset changes the WAL header's salts. Opening the copy
// replays every committed frame over the database pages. A change of the WAL header, or of the database file's size or
// mtime, during the copy starts it over.

import { closeSync, constants, copyFileSync, existsSync, mkdtempSync, openSync, readSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import type { DecodeSite, FileInfo, Json, JsonObject, RawDocument, RawStore, ReadOptions } from "./types.ts";

const SIDE_FILES = ["-wal", "-journal"] as const;
const MAX_ATTEMPTS = 8;

/** The first bytes of a file, opened read-only; `undefined` when it does not exist. */
function head(path: string, bytes: number): Buffer | undefined {
	let fd: number;
	try {
		fd = openSync(path, "r");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	try {
		const buffer = Buffer.alloc(bytes);
		const read = readSync(fd, buffer, 0, bytes, 0);
		return buffer.subarray(0, read);
	} finally {
		closeSync(fd);
	}
}

function fingerprint(path: string): string {
	const wal = head(`${path}-wal`, 32);
	const stat = statSync(path);
	return `${stat.size}:${stat.mtimeMs}:${wal === undefined ? "-" : wal.toString("hex")}`;
}

export type Snapshot = {
	readonly path: string;
	readonly files: FileInfo[];
	readonly attempts: number;
	readonly dispose: () => void;
};

/** Copy a SQLite database and its WAL or rollback journal into a new private directory. */
export async function snapshotSqlite(source: string): Promise<Snapshot> {
	if (head(source, 16)?.toString("latin1") !== "SQLite format 3\0") throw new Error(`${source} is not a SQLite database`);
	const directory = mkdtempSync(join(tmpdir(), "durable-lens-"));
	const target = join(directory, basename(source));
	const dispose = () => rmSync(directory, { recursive: true, force: true });
	try {
		for (let attempt = 1; ; attempt++) {
			const before = fingerprint(source);
			copyFileSync(source, target, constants.COPYFILE_FICLONE);
			for (const suffix of SIDE_FILES) {
				rmSync(target + suffix, { force: true });
				if (existsSync(source + suffix)) copyFileSync(source + suffix, target + suffix, constants.COPYFILE_FICLONE);
			}
			const copied = head(`${target}-wal`, 32);
			const after = fingerprint(source);
			const walOfAfter = after.slice(after.lastIndexOf(":") + 1);
			if (before === after && walOfAfter === (copied === undefined ? "-" : copied.toString("hex"))) {
				const files = ["", ...SIDE_FILES, "-shm"]
					.filter((suffix) => existsSync(source + suffix))
					.map((suffix) => {
						const stat = statSync(source + suffix);
						return { name: basename(source) + suffix, size: stat.size, mtimeMs: stat.mtimeMs };
					});
				return { path: target, files, attempts: attempt, dispose };
			}
			if (attempt >= MAX_ATTEMPTS) throw new Error(`${source} kept changing while it was copied`);
			await delay(25 * attempt);
		}
	} catch (error) {
		dispose();
		throw error;
	}
}

type Row = Record<string, unknown>;

/** Read every pi-durable table of a SQLite store. */
export async function readSqlite(source: string, options: ReadOptions = {}): Promise<RawStore> {
	const snapshot = await snapshotSqlite(source);
	let db: DatabaseSync | undefined;
	try {
		db = new DatabaseSync(snapshot.path);
		const warnings: string[] = [];
		const prefix = options.prefix ?? detectPrefix(db, warnings);
		const table = (name: string) => `"${prefix}${name}"`;
		const all = (sql: string): Row[] => db!.prepare(sql).all() as Row[];
		const decode = async (text: unknown, site: Omit<DecodeSite, "store">): Promise<Json> => {
			const value = JSON.parse(String(text)) as Json;
			return options.decode === undefined ? value : options.decode(value, { store: "sqlite", ...site });
		};
		const records = async (name: string, extra = ""): Promise<{ row: Row; record: JsonObject }[]> => {
			const rows = all(`SELECT * FROM ${table(name)} ${extra}`);
			return Promise.all(
				rows.map(async (row) => ({ row, record: (await decode(row.record, { table: name, column: "record" })) as JsonObject })),
			);
		};

		const schema = all(`SELECT version FROM ${table("durable_schema")}`)[0];
		const metadata = all(`SELECT next_id, next_seq FROM ${table("durable_metadata")}`)[0];
		const conversations = (await records("conversations", "ORDER BY id")).map(({ record }) => record);
		const entries = (await records("entries", "ORDER BY id")).map(({ row, record }) => ({
			record,
			seq: Number(row.commit_seq),
		}));
		const tasks = (await records("tasks", "ORDER BY id")).map(({ record }) => record);
		const submissions = (await records("submissions", "ORDER BY id")).map(({ record }) => record);

		const revisionRows = all(`SELECT document_id, seq, kind, version, content FROM ${table("document_revisions")} ORDER BY document_id, seq`);
		const revisions = new Map<number, RawDocument["revisions"]>();
		for (const row of revisionRows) {
			const id = Number(row.document_id);
			const list = revisions.get(id) ?? [];
			list.push({
				seq: Number(row.seq),
				kind: row.kind === "base" ? "base" : "delta",
				version: Number(row.version),
				content: await decode(row.content, { table: "document_revisions", column: "content" }),
			});
			revisions.set(id, list);
		}
		const documents = (await records("documents", "ORDER BY id")).map(({ record }) => ({
			record,
			revisions: revisions.get(Number(record.id)) ?? [],
		}));

		return {
			kind: "sqlite",
			path: source,
			files: snapshot.files,
			conversations,
			entries,
			tasks,
			submissions,
			documents,
			schemaVersion: schema === undefined ? undefined : Number(schema.version),
			...(prefix === "" ? {} : { prefix }),
			nextSeq: metadata === undefined ? undefined : Number(metadata.next_seq),
			nextId: metadata === undefined ? undefined : Number(metadata.next_id),
			attempts: snapshot.attempts,
			warnings,
		};
	} finally {
		db?.close();
		snapshot.dispose();
	}
}

function detectPrefix(db: DatabaseSync, warnings: string[]): string {
	const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Row[]).map((row) => String(row.name));
	const prefixes = names.filter((name) => name.endsWith("durable_schema")).map((name) => name.slice(0, -"durable_schema".length));
	if (prefixes.length === 0) throw new Error("no pi-durable tables in this database (no durable_schema table)");
	if (prefixes.length > 1) {
		const shown = prefixes.map((p) => (p === "" ? "(none)" : p)).join(", ");
		warnings.push(`several pi-durable storages share this database (prefixes ${shown}); showing "${prefixes[0] || "(none)"}", pick one with --prefix`);
	}
	return prefixes[0] as string;
}
