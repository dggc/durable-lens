// JSONL stores (format 1, unchanged from pi-durable 1.0 through main), read into memory without writing.
//
// A store is a directory: `main.jsonl` holds one commit marker per line, and `task-<id>.jsonl` and `doc-<id>.jsonl`
// sidecars hold live task records and document revisions that markers confirm by (seq, ordinal). The owner appends
// sidecars first and the marker last, so a marker's records exist before it does. pi-durable's own open truncates torn
// tails and rewrites sidecars; this reader only skips a torn last line, and reads everything again when a sidecar a
// marker confirms is missing (the owner reclaimed it after the main file was read).

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { DecodeSite, FileInfo, Json, JsonObject, RawDocument, RawRevision, RawStore, ReadOptions } from "./types.ts";

const MAIN = "main.jsonl";
const SIDECAR = /^(doc|task)-(0|[1-9]\d*)\.jsonl$/;
const MAX_ATTEMPTS = 6;

class RetryRead extends Error {}

type Line = { readonly value: JsonObject; readonly number: number };

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
		try {
			result.push({ value: JSON.parse(line) as JsonObject, number });
		} catch {
			throw new Error(`${name} line ${number} is not JSON`);
		}
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
			if (!(error instanceof RetryRead) || attempt >= MAX_ATTEMPTS) throw error;
			await delay(25 * attempt);
		}
	}
}

async function readOnce(directory: string, options: ReadOptions): Promise<Omit<RawStore, "attempts">> {
	const warnings: string[] = [];
	const decode = async (value: Json, site: Omit<DecodeSite, "store">): Promise<Json> =>
		options.decode === undefined ? value : options.decode(value, { store: "jsonl", ...site });

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

	const conversations = new Map<number, JsonObject>();
	const entries = new Map<number, { record: JsonObject; seq: number }>();
	const tasks = new Map<number, JsonObject>();
	const submissions = new Map<number, JsonObject>();
	const documents = new Map<number, { record: JsonObject; revisions: RawRevision[] }>();

	// Which tasks end terminal, and which documents keep only their current value (their sidecars lose old records).
	const terminal = new Set<number>();
	const currentOnly = new Set<number>();
	for (const { value: marker } of mainLines) {
		for (const write of (marker.writes as JsonObject[] | undefined) ?? []) {
			if (write.type === "task") terminal.add(Number((write.value as JsonObject).id));
			if (write.type === "task.sidecar") terminal.delete(Number(write.id));
			if (write.type === "document.create") {
				const record = write.record as JsonObject;
				const scope = record.scope as JsonObject;
				if (scope.kind !== "conversation" || record.history === "latest") currentOnly.add(Number(record.id));
			}
		}
	}

	let previous = 0;
	for (const { value: marker, number } of mainLines) {
		if (marker.format !== 1 || marker.type !== "commit") throw new Error(`${MAIN} line ${number}: unknown marker format ${String(marker.format)}`);
		const seq = Number(marker.seq);
		if (!(seq > previous)) throw new Error(`${MAIN} line ${number}: commit sequence does not increase`);
		previous = seq;
		for (const write of (marker.writes as JsonObject[] | undefined) ?? []) {
			const sidecar = (file: string, ordinal: Json | undefined): JsonObject | undefined => sidecars.get(file)?.get(`${seq}:${String(ordinal)}`);
			switch (write.type) {
				case "conversation": {
					const value = (await decode(write.value as Json, { table: "conversation", column: "value" })) as JsonObject;
					conversations.set(Number(value.id), value);
					break;
				}
				case "entry": {
					const value = (await decode(write.value as Json, { table: "entry", column: "value" })) as JsonObject;
					entries.set(Number(value.id), { record: value, seq });
					break;
				}
				case "submission": {
					const value = (await decode(write.value as Json, { table: "submission", column: "value" })) as JsonObject;
					submissions.set(Number(value.id), value);
					break;
				}
				case "task": {
					const value = (await decode(write.value as Json, { table: "task", column: "value" })) as JsonObject;
					tasks.set(Number(value.id), value);
					break;
				}
				case "task.sidecar": {
					const id = Number(write.id);
					const record = sidecar(`task-${id}.jsonl`, write.ordinal);
					if (record === undefined) {
						// A task that ends terminal has its sidecar removed; only its final record matters.
						if (terminal.has(id)) break;
						throw new RetryRead(`task-${id}.jsonl lacks the record of commit ${seq}`);
					}
					const payload = record.payload as JsonObject;
					tasks.set(id, (await decode(payload.value as Json, { table: "task", column: "value" })) as JsonObject);
					break;
				}
				case "document.create":
				case "document.change": {
					const created = write.type === "document.create";
					const id = Number(created ? (write.record as JsonObject).id : write.id);
					if (created) {
						const record = (await decode(write.record as Json, { table: "document", column: "record" })) as JsonObject;
						documents.set(id, { record: { ...record, createdAt: seq }, revisions: [] });
					}
					const document = documents.get(id);
					if (document === undefined) throw new Error(`${MAIN} line ${number}: change of unknown document ${id}`);
					const record = sidecar(`doc-${id}.jsonl`, write.ordinal);
					if (record === undefined) {
						// Current-only documents drop records before their newest base; retired ones lose their file.
						if (currentOnly.has(id)) break;
						throw new RetryRead(`doc-${id}.jsonl lacks the record of commit ${seq}`);
					}
					const content = (await decode((record.payload as JsonObject).content as Json, { table: "document", column: "content" })) as JsonObject;
					document.revisions.push({
						seq,
						kind: content.kind === "base" ? "base" : "delta",
						version: Number(content.version),
						content: (content.kind === "base" ? content.value : content.ops) as Json,
					});
					break;
				}
				case "document.retire": {
					const document = documents.get(Number(write.id));
					if (document !== undefined) document.record = { ...document.record, retiredAt: seq };
					break;
				}
				default:
					warnings.push(`${MAIN} line ${number}: skipped unknown write type ${String(write.type)}`);
			}
		}
	}

	// Current-only documents may have lost the records before their newest base; replay from it.
	for (const [id, document] of documents) {
		if (!currentOnly.has(id)) continue;
		const lastBase = document.revisions.findLastIndex((revision) => revision.kind === "base");
		if (lastBase > 0) document.revisions = document.revisions.slice(lastBase);
		// The owner rewrote the sidecar from a base this read of the main file does not reach yet.
		if (document.record.retiredAt === undefined && lastBase === -1) throw new RetryRead(`doc-${id}.jsonl was rewritten meanwhile`);
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
