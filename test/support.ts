import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RawStore } from "../src/store/types.ts";

export const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const STORES = join(ROOT, "fixtures", "stores");
export const GENERATE = join(ROOT, "fixtures", "generate");
export const VERSIONS = ["1.2.0", "1.3.0", "1.4.0", "main"] as const;
export const VARIANTS = ["sqlite", "sqlite-crashed", "jsonl", "jsonl-crashed"] as const;
export type Version = (typeof VERSIONS)[number];
export type Variant = (typeof VARIANTS)[number];

/** The store inside a fixture directory: the SQLite file, or the JSONL directory. */
export function storeIn(directory: string, variant: Variant): string {
	return variant.startsWith("sqlite") ? join(directory, "session.sqlite") : join(directory, "session");
}

export function fixture(version: Version, variant: Variant): string {
	return storeIn(join(STORES, version, variant), variant);
}

/** A private copy of a fixture directory, so tests that start owners never touch the committed files. */
export function copyFixture(version: Version, variant: Variant): { directory: string; store: string; dispose: () => void } {
	const directory = mkdtempSync(join(tmpdir(), "durable-lens-test-"));
	cpSync(join(STORES, version, variant), directory, { recursive: true });
	return { directory, store: storeIn(directory, variant), dispose: () => rmSync(directory, { recursive: true, force: true }) };
}

/** SHA-256 of every file under a directory, by relative path. */
export function hashTree(directory: string): Record<string, string> {
	const result: Record<string, string> = {};
	const walk = (dir: string, prefix: string) => {
		for (const name of readdirSync(dir).sort()) {
			const path = join(dir, name);
			if (statSync(path).isDirectory()) walk(path, `${prefix}${name}/`);
			else result[`${prefix}${name}`] = createHash("sha256").update(readFileSync(path)).digest("hex");
		}
	};
	walk(directory, "");
	return result;
}

/** Whether the pi-durable generator of a version is installed (npm ci in fixtures/generate/v<version>). */
export function generatorInstalled(version: Version): boolean {
	return existsSync(join(GENERATE, `v${version}`, "node_modules", "@earendil-works", "pi-durable"));
}

/** Start a pi-durable owner process on a store and wait until it reports ready. */
export async function startOwner(
	version: Version,
	mode: "hold" | "churn",
	kind: "sqlite" | "jsonl",
	store: string,
): Promise<{ child: ChildProcess; stop: () => Promise<void> }> {
	const script = join(GENERATE, `v${version}`, "run.mjs");
	const linked = lstatSync(join(GENERATE, `v${version}`, "node_modules", "@earendil-works", "pi-durable")).isSymbolicLink();
	const child = spawn(process.execPath, [...(linked ? ["--conditions=source"] : []), script, mode, kind, store], { stdio: ["pipe", "pipe", "inherit"] });
	await new Promise<void>((resolve, reject) => {
		let output = "";
		const timer = setTimeout(() => reject(new Error(`owner did not start: ${output}`)), 20_000);
		child.stdout?.on("data", (chunk: Buffer) => {
			output += chunk.toString();
			if (output.includes("ready")) {
				clearTimeout(timer);
				resolve();
			}
		});
		child.on("exit", (code) => {
			clearTimeout(timer);
			reject(new Error(`owner exited ${code}: ${output}`));
		});
	});
	return {
		child,
		stop: () =>
			new Promise<void>((resolve) => {
				child.removeAllListeners("exit");
				child.on("exit", () => resolve());
				child.stdin?.end();
			}),
	};
}

/** A minimal in-memory store for building a lens from hand-written records. */
export function rawStore(parts: Partial<RawStore>): RawStore {
	return {
		kind: "sqlite",
		path: "test",
		files: [],
		conversations: [{ id: 1 }],
		entries: [],
		tasks: [],
		submissions: [],
		documents: [],
		attempts: 1,
		warnings: [],
		...parts,
	};
}
