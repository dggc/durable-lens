import { statSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildLens } from "./model.ts";
import { isJsonlStore, readJsonl } from "./store/jsonl.ts";
import { readSqlite } from "./store/sqlite.ts";
import type { Decode, RawStore, ReadOptions } from "./store/types.ts";
import type { Lens } from "./web/lens.ts";

export type OpenOptions = ReadOptions & {
	readonly restartLimit?: number;
	readonly decoderName?: string;
	/** Path shown in the page; defaults to the path as given, so a shared screenshot need not reveal where it lives. */
	readonly displayPath?: string;
};

/** Read a SQLite file or a JSONL directory, never writing to it. */
export async function readStore(path: string, options: ReadOptions = {}): Promise<RawStore> {
	const absolute = resolve(path);
	const stat = statSync(absolute);
	if (stat.isDirectory()) {
		if (isJsonlStore(absolute)) return readJsonl(absolute, options);
		throw new Error(`${absolute} is a directory without main.jsonl, so not a pi-durable JSONL store`);
	}
	return readSqlite(absolute, options);
}

export async function openLens(path: string, options: OpenOptions = {}): Promise<Lens> {
	const started = performance.now();
	const raw = await readStore(path, options);
	return buildLens(raw, {
		...(options.restartLimit === undefined ? {} : { restartLimit: options.restartLimit }),
		...(options.decoderName === undefined ? {} : { decoder: options.decoderName }),
		displayPath: options.displayPath ?? path,
		readMs: Math.round(performance.now() - started),
	});
}

/**
 * Load a decoder module: its default export or a named `decode` export is a function `(value, site) => value`.
 * The module runs in this process with your permissions, and reads any keys it needs itself.
 */
export async function loadDecoder(path: string): Promise<Decode> {
	const module = (await import(pathToFileURL(resolve(path)).href)) as { default?: unknown; decode?: unknown };
	const decode = typeof module.default === "function" ? module.default : module.decode;
	if (typeof decode !== "function") throw new Error(`${path} exports no decode function (default export or "decode")`);
	return decode as Decode;
}
