// Reproduce the measurements in docs/reading-pi-durable-storage.md: for each way of opening a store, hash every file
// of a private copy before and after a read. With fixtures/generate/vmain set up, also measure pi-durable's own
// storage opened under HarnessOptions.readOnly.
// Usage: npm run build && node scripts/measure-open-modes.mjs
import { createHash } from "node:crypto";
import { appendFileSync, cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { openLens } from "../dist/index.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const stores = join(root, "fixtures", "stores");
const walk = (dir) =>
	readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? walk(join(dir, name)).map((sub) => join(name, sub)) : [name]));
const hash = (dir) =>
	Object.fromEntries(
		walk(dir)
			.sort()
			.map((name) => [
				name,
				createHash("sha256")
					.update(readFileSync(join(dir, name)))
					.digest("hex")
					.slice(0, 12),
			]),
	);
const changes = (before, after) =>
	[...new Set([...Object.keys(before), ...Object.keys(after)])]
		.filter((name) => before[name] !== after[name])
		.map((name) => `${name} ${before[name] ?? "(none)"} → ${after[name] ?? "(gone)"}`);

async function measure(label, version, variant, read, prepare = () => {}) {
	const dir = mkdtempSync(join(tmpdir(), "durable-lens-measure-"));
	try {
		cpSync(join(stores, version, variant), dir, { recursive: true });
		prepare(dir);
		const before = hash(dir);
		let result;
		try {
			result = await read(dir);
		} catch (error) {
			result = `error: ${error.message.slice(0, 80)}`;
		}
		const changed = changes(before, hash(dir));
		console.log(
			`${label.padEnd(44)} ${`${version} ${variant}`.padEnd(22)} ${String(result).padEnd(26)} ${changed.length === 0 ? "unchanged" : `CHANGED: ${changed.join("; ")}`}`,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

const sqliteRead = (open) => (dir) => {
	const db = open(join(dir, "session.sqlite"));
	try {
		return `next_seq ${db.prepare("SELECT next_seq FROM durable_metadata").get().next_seq}`;
	} finally {
		db.close();
	}
};
const uri = (path, key, value) => {
	const url = pathToFileURL(path);
	url.searchParams.set(key, value);
	return url;
};

for (const variant of ["sqlite", "sqlite-crashed"]) {
	await measure(
		"node:sqlite { readOnly: true }",
		"1.4.0",
		variant,
		sqliteRead((path) => new DatabaseSync(path, { readOnly: true })),
	);
	await measure(
		"node:sqlite file: URI mode=ro",
		"1.4.0",
		variant,
		sqliteRead((path) => new DatabaseSync(uri(path, "mode", "ro"), { readOnly: true })),
	);
	await measure(
		"node:sqlite file: URI immutable=1",
		"1.4.0",
		variant,
		sqliteRead((path) => new DatabaseSync(uri(path, "immutable", "1"), { readOnly: true })),
	);
	await measure("durable-lens", "1.4.0", variant, async (dir) => `next_seq ${(await openLens(join(dir, "session.sqlite"))).format.nextSeq}`);
}

const vmain = join(root, "fixtures", "generate", "vmain", "node_modules", "@earendil-works");
if (existsSync(join(vmain, "pi-durable"))) {
	const load = (path) => import(pathToFileURL(join(vmain, path)).href);
	const { BACKGROUND_CONTEXT: context } = await load("chord/dist/context/index.js");
	const { createModels } = await load("pi-ai/dist/models.js");
	const { createRegistry, Harness } = await load("pi-durable/dist/index.js");
	const { openNodeSqliteStorage } = await load("pi-durable/dist/storage/sqlite/node.js");
	const { openNodeJsonlStorage } = await load("pi-durable/dist/storage/jsonl/node.js");
	const viewer = async (storage) => {
		const harness = await Harness.open(storage, { models: createModels(), registry: createRegistry(), readOnly: true }, context);
		await harness.close(context);
	};
	const schema = (dir) => {
		const db = new DatabaseSync(join(dir, "session.sqlite"), { readOnly: true });
		try {
			return db.prepare("SELECT version FROM durable_schema").get().version;
		} finally {
			db.close();
		}
	};
	for (const [version, variant] of [
		["1.2.0", "sqlite"],
		["1.2.0", "sqlite-crashed"],
		["1.4.0", "sqlite-crashed"],
	]) {
		await measure("pi-durable main storage + readOnly Harness", version, variant, async (dir) => {
			const before = schema(dir);
			await viewer(await openNodeSqliteStorage(join(dir, "session.sqlite")));
			return `schema v${before} → v${schema(dir)}`;
		});
	}
	// A last line the owner is still appending, as a viewer of a live session can find it.
	const tear = (dir) => appendFileSync(join(dir, "session", "main.jsonl"), '{"format":1,"type":"commit","seq":9999,"wri');
	await measure(
		"pi-durable main JSONL + readOnly, torn tail",
		"1.4.0",
		"jsonl",
		async (dir) => {
			const main = join(dir, "session", "main.jsonl");
			const size = statSync(main).size;
			await viewer(await openNodeJsonlStorage(join(dir, "session"), context));
			return `main.jsonl ${size} → ${statSync(main).size} B`;
		},
		tear,
	);
	await measure("durable-lens, torn tail", "1.4.0", "jsonl", async (dir) => `${(await openLens(join(dir, "session"))).entries.length} entries`, tear);
} else {
	console.log("(skipping pi-durable readOnly: run fixtures/generate/link-main.mjs first)");
}
