// JSONL stores (format 1, unchanged from pi-durable 1.0 through main), read into memory without writing.
//
// A store is a directory: `main.jsonl` holds one commit marker per line, and `task-<id>.jsonl` and `doc-<id>.jsonl`
// sidecars hold live task records and document revisions that markers confirm by (seq, ordinal). The owner appends
// sidecars first and the marker last, so a marker's records exist before it does. pi-durable's own open truncates torn
// tails and rewrites sidecars; this reader only skips a torn last line, and reads everything again when a sidecar a
// marker confirms is missing (the owner reclaimed it after the main file was read). Which records may legitimately be
// missing follows pi-durable's `JsonlStorage.recover()`.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { DecodeSite, FileInfo, Json, JsonObject, RawDocument, RawRevision, RawStore, ReadOptions } from "./types.ts";

const MAIN = "main.jsonl";
const SIDECAR = /^(doc|task)-(0|[1-9]\d*)\.jsonl$/;
const MAX_ATTEMPTS = 6;

/** A read that saw the owner mid-change; reading again from the start resolves it. */
class RetryRead extends Error {}

type Line = { readonly value: JsonObject; readonly number: number };

const isObject = (value: unknown): value is JsonObject => value !== null && typeof value === "object" && !Array.isArray(value);
const isId = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

/** Complete lines of a file; a last line without its newline is an append in progress and is left out. */
function lines(bytes: Buffer, name: string, warnings: string[]): Line[] {
	let end = bytes.length;
	if (end > 0 && bytes[end - 1] !== 0x0a) {
		end = bytes.lastIndexOf(0x0a) + 1;
		warnings.push(`${name}: skipped an incomplete last line (an owner may be writing it)`);
	}
	const text = bytes.subarray(0, end).toString("utf8");
	const result: Line[] = [];
	let number = 0;
	for (const line of text.split("\n")) {
		number++;
		if (line === "") continue;
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			// A restarting owner truncates a torn tail and appends again; a second read sees whole lines.
			throw new RetryRead(`${name} line ${number} is not JSON`);
		}
		if (!isObject(value)) throw new Error(`${name} line ${number} is not a JSON object`);
		result.push({ value, number });
	}
	return result;
}

export function isJsonlStore(path: string): boolean {
	try {
		return statSync(path).isDirectory() && statSync(join(path, MAIN)).isFile();
	} catch {
		return false;
	}
}

export async function readJsonl(directory: string, options: ReadOptions = {}): Promise<RawStore> {
	for (let attempt = 1; ; attempt++) {
		try {
			return { ...(await readOnce(directory, options)), attempts: attempt };
		} catch (error) {
			if (!(error instanceof RetryRead)) throw error;
			if (attempt >= MAX_ATTEMPTS) {
				throw new Error(`${directory}: ${error.message}, still after ${MAX_ATTEMPTS} reads; an owner may be writing very fast, or the store is damaged`);
			}
			await delay(25 * attempt);
		}
	}
}

/** One write of a commit marker, with its payloads decoded. */
type Write =
	| { readonly type: "conversation" | "entry" | "submission" | "task"; readonly value: JsonObject }
	| { readonly type: "task.sidecar"; readonly id: number; readonly ordinal: number }
	| { readonly type: "document.create"; readonly record: JsonObject; readonly id: number; readonly ordinal: number }
	| { readonly type: "document.change"; readonly id: number; readonly ordinal: number }
	| { readonly type: "document.retire"; readonly id: number };

type Commit = { readonly seq: number; readonly number: number; readonly writes: Write[] };

async function readOnce(directory: string, options: ReadOptions): Promise<Omit<RawStore, "attempts">> {
	const warnings: string[] = [];
	const decode = async (value: Json | undefined, site: Omit<DecodeSite, "store">): Promise<Json | undefined> =>
		options.decode === undefined || value === undefined ? value : options.decode(value, { store: "jsonl", ...site });
	const decodeObject = async (value: Json | undefined, site: Omit<DecodeSite, "store">, where: string): Promise<JsonObject> => {
		const decoded = await decode(value, site);
		if (!isObject(decoded) || !isId(decoded.id)) throw new Error(`${where}: a ${site.table} without an id; pass --decoder if the store is encrypted`);
		return decoded;
	};

	const files: FileInfo[] = [];
	const mainStat = statSync(join(directory, MAIN));
	// The main file first: every sidecar record a marker read here confirms was written before it.
	const mainLines = lines(readFileSync(join(directory, MAIN)), MAIN, warnings);
	files.push({ name: MAIN, size: mainStat.size, mtimeMs: mainStat.mtimeMs });

	const sidecars = new Map<string, Map<string, JsonObject>>();
	for (const name of readdirSync(directory).sort()) {
		if (!SIDECAR.test(name)) continue;
		let bytes: Buffer;
		try {
			bytes = readFileSync(join(directory, name));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; // reclaimed meanwhile
			throw error;
		}
		const stat = statSync(join(directory, name), { throwIfNoEntry: false });
		if (stat !== undefined) files.push({ name, size: stat.size, mtimeMs: stat.mtimeMs });
		const records = new Map<string, JsonObject>();
		for (const line of lines(bytes, name, warnings)) records.set(`${line.value.seq}:${line.value.ordinal}`, line.value);
		sidecars.set(name, records);
	}

	// Validate and decode every marker once.
	const commits: Commit[] = [];
	let previous = 0;
	for (const { value: marker, number } of mainLines) {
		const where = `${MAIN} line ${number}`;
		if (marker.format !== 1 || marker.type !== "commit") throw new Error(`${where}: unknown marker format ${String(marker.format)}`);
		const seq = marker.seq;
		if (!isId(seq) || !(seq > previous)) throw new Error(`${where}: commit sequence does not increase`);
		previous = seq;
		if (!Array.isArray(marker.writes)) throw new Error(`${where}: no writes`);
		const writes: Write[] = [];
		for (const write of marker.writes) {
			if (!isObject(write)) throw new Error(`${where}: a write is not an object`);
			switch (write.type) {
				case "conversation":
				case "entry":
				case "submission":
				case "task":
					writes.push({ type: write.type, value: await decodeObject(write.value, { table: write.type, column: "value" }, where) });
					break;
				case "task.sidecar":
				case "document.change":
					if (!isId(write.id) || !isId(write.ordinal)) throw new Error(`${where}: malformed ${write.type} write`);
					writes.push({ type: write.type, id: write.id, ordinal: write.ordinal });
					break;
				case "document.create": {
					const record = await decodeObject(write.record, { table: "document", column: "record" }, where);
					if (!isId(write.ordinal) || !isObject(record.scope)) throw new Error(`${where}: malformed document.create write`);
					writes.push({ type: "document.create", record, id: record.id as number, ordinal: write.ordinal });
					break;
				}
				case "document.retire":
					if (!isId(write.id)) throw new Error(`${where}: malformed document.retire write`);
					writes.push({ type: "document.retire", id: write.id });
					break;
				default:
					warnings.push(`${where}: skipped unknown write type ${String(write.type)}`);
			}
		}
		commits.push({ seq, number, writes });
	}

	// Which tasks end terminal, which documents keep only their current value, and which of those were retired.
	const terminal = new Set<number>();
	const currentOnly = new Set<number>();
	const retired = new Set<number>();
	for (const { writes } of commits) {
		for (const write of writes) {
			if (write.type === "task") terminal.add(Number(write.value.id));
			else if (write.type === "task.sidecar") terminal.delete(write.id);
			else if (write.type === "document.create") {
				const scope = write.record.scope as JsonObject;
				if (scope.kind !== "conversation" || write.record.history === "latest") currentOnly.add(write.id);
			} else if (write.type === "document.retire") retired.add(write.id);
		}
	}

	const contents = new Map<string, JsonObject>();
	const sidecarContent = async (id: number, seq: number, ordinal: number): Promise<JsonObject | undefined> => {
		const key = `${id}:${seq}:${ordinal}`;
		if (contents.has(key)) return contents.get(key);
		const record = sidecars.get(`doc-${id}.jsonl`)?.get(`${seq}:${ordinal}`);
		if (record === undefined) return undefined;
		const payload = record.payload;
		const content = await decode(isObject(payload) ? payload.content : undefined, { table: "document", column: "content" });
		if (!isObject(content) || (content.kind !== "base" && content.kind !== "delta")) throw new Error(`doc-${id}.jsonl: malformed record of commit ${seq}`);
		contents.set(key, content);
		return content;
	};

	// The newest base each current-only document's sidecar still holds; records before it were reclaimed.
	const latestBase = new Map<number, [number, number]>();
	for (const { seq, writes } of commits) {
		for (const write of writes) {
			if ((write.type !== "document.create" && write.type !== "document.change") || !currentOnly.has(write.id)) continue;
			if ((await sidecarContent(write.id, seq, write.ordinal))?.kind === "base") latestBase.set(write.id, [seq, write.ordinal]);
		}
	}
	const beforeLatestBase = (id: number, seq: number, ordinal: number): boolean => {
		const base = latestBase.get(id);
		return base !== undefined && (seq < base[0] || (seq === base[0] && ordinal < base[1]));
	};

	const conversations = new Map<number, JsonObject>();
	const entries = new Map<number, { record: JsonObject; seq: number }>();
	const tasks = new Map<number, JsonObject>();
	const submissions = new Map<number, JsonObject>();
	const documents = new Map<number, { record: JsonObject; revisions: RawRevision[] }>();

	for (const { seq, number, writes } of commits) {
		for (const write of writes) {
			switch (write.type) {
				case "conversation":
					conversations.set(Number(write.value.id), write.value);
					break;
				case "entry":
					entries.set(Number(write.value.id), { record: write.value, seq });
					break;
				case "submission":
					submissions.set(Number(write.value.id), write.value);
					break;
				case "task":
					tasks.set(Number(write.value.id), write.value);
					break;
				case "task.sidecar": {
					const record = sidecars.get(`task-${write.id}.jsonl`)?.get(`${seq}:${write.ordinal}`);
					if (record === undefined) {
						// A task that ends terminal has its sidecar removed; only its final record matters.
						if (terminal.has(write.id)) break;
						throw new RetryRead(`task-${write.id}.jsonl lacks the record of commit ${seq}`);
					}
					const payload = isObject(record.payload) ? record.payload.value : undefined;
					tasks.set(write.id, await decodeObject(payload, { table: "task", column: "value" }, `task-${write.id}.jsonl`));
					break;
				}
				case "document.create":
				case "document.change": {
					if (write.type === "document.create") documents.set(write.id, { record: { ...write.record, createdAt: seq }, revisions: [] });
					const document = documents.get(write.id);
					if (document === undefined) throw new Error(`${MAIN} line ${number}: change of unknown document ${write.id}`);
					const content = await sidecarContent(write.id, seq, write.ordinal);
					if (content === undefined) {
						// Reclaimed: a current-only document keeps records from its newest base on, and none once retired.
						if (currentOnly.has(write.id) && (retired.has(write.id) || beforeLatestBase(write.id, seq, write.ordinal))) break;
						throw new RetryRead(`doc-${write.id}.jsonl lacks the record of commit ${seq}`);
					}
					document.revisions.push({
						seq,
						kind: content.kind === "base" ? "base" : "delta",
						version: typeof content.version === "object" && content.version !== null ? Number.NaN : Number(content.version),
						content: (content.kind === "base" ? content.value : content.ops) as Json,
					});
					break;
				}
				case "document.retire": {
					const document = documents.get(write.id);
					if (document !== undefined) document.record = { ...document.record, retiredAt: seq };
					break;
				}
			}
		}
	}

	return {
		kind: "jsonl",
		path: directory,
		files,
		conversations: [...conversations.values()].sort(byId),
		entries: [...entries.values()].sort((a, b) => Number(a.record.id) - Number(b.record.id)),
		tasks: [...tasks.values()].sort(byId),
		submissions: [...submissions.values()].sort(byId),
		documents: [...documents.values()].sort((a, b) => Number(a.record.id) - Number(b.record.id)) as RawDocument[],
		jsonlFormat: 1,
		nextSeq: previous + 1,
		warnings,
	};
}

const byId = (a: JsonObject, b: JsonObject) => Number(a.id) - Number(b.id);
