import type { Json } from "./ops.ts";

export type { Json } from "./ops.ts";
export type JsonObject = { [key: string]: Json };

/** Where a decoder hook is called: one JSON payload of the store, before durable-lens reads it. */
export type DecodeSite = {
	readonly store: "sqlite" | "jsonl";
	/** SQLite table (unprefixed) or JSONL write type, such as `entries` or `entry`. */
	readonly table: string;
	/** SQLite column or JSONL field holding the payload, such as `record` or `content`. */
	readonly column: string;
};

/** Turns a stored payload back into pi-durable's JSON, for adapters that encrypt or compress it at rest. */
export type Decode = (value: Json, site: DecodeSite) => Json | Promise<Json>;

export type FileInfo = { readonly name: string; readonly size: number; readonly mtimeMs: number };

export type RawRevision = {
	readonly seq: number;
	readonly kind: "base" | "delta";
	readonly version: number;
	/** Base: the value. Delta: the op list. */
	readonly content: Json;
};

export type RawDocument = { readonly record: JsonObject; readonly revisions: RawRevision[] };

/** The records of one store as pi-durable wrote them, read without any pi-durable code. */
export type RawStore = {
	readonly kind: "sqlite" | "jsonl";
	readonly path: string;
	readonly files: FileInfo[];
	readonly conversations: JsonObject[];
	readonly entries: { readonly record: JsonObject; readonly seq: number | undefined }[];
	readonly tasks: JsonObject[];
	readonly submissions: JsonObject[];
	readonly documents: RawDocument[];
	readonly schemaVersion?: number;
	readonly jsonlFormat?: number;
	readonly prefix?: string;
	readonly nextSeq?: number;
	readonly nextId?: number;
	/** Reads repeated because the owner changed the files while they were copied or read. */
	readonly attempts: number;
	readonly warnings: string[];
};

export type ReadOptions = {
	readonly decode?: Decode;
	/** SQLite table prefix (pi-durable 1.3.0+); detected when there is exactly one. */
	readonly prefix?: string;
};
