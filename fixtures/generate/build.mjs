// Regenerate fixtures/stores/<version>/{sqlite,jsonl}{,-crashed}/ from every installed v<version>/ generator.
// Usage: node fixtures/generate/build.mjs [version...]
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const stores = join(here, "..", "stores");
const wanted = process.argv.slice(2);
const versions = readdirSync(here)
	.filter((name) => /^v/.test(name) && existsSync(join(here, name, "node_modules")))
	.map((name) => name.slice(1))
	.filter((version) => wanted.length === 0 || wanted.includes(version));

function run(version, args) {
	// vmain links the Earendil packages to an unbuilt checkout; Node runs their TypeScript sources.
	const linked = lstatSync(join(here, `v${version}`, "node_modules", "@earendil-works", "pi-durable")).isSymbolicLink();
	const flags = linked ? ["--conditions=source"] : [];
	const result = spawnSync(process.execPath, [...flags, join(here, `v${version}`, "run.mjs"), ...args], { stdio: "inherit" });
	if (result.status !== 0) throw new Error(`v${version} ${args.join(" ")} exited ${result.status}`);
}

for (const version of versions) {
	for (const kind of ["sqlite", "jsonl"]) {
		const scratch = mkdtempSync(join(tmpdir(), "durable-lens-gen-"));
		const store = kind === "sqlite" ? join(scratch, "session.sqlite") : join(scratch, "session");
		run(version, ["generate", kind, store, "4"]);
		// Right after the last crash: SQLite still has its -wal and -shm, JSONL whatever the dead owner left.
		const crashed = join(stores, version, `${kind}-crashed`);
		rmSync(crashed, { recursive: true, force: true });
		mkdirSync(crashed, { recursive: true });
		cpSync(scratch, crashed, { recursive: true });
		run(version, ["settle", kind, store]);
		const idle = join(stores, version, kind);
		rmSync(idle, { recursive: true, force: true });
		mkdirSync(idle, { recursive: true });
		cpSync(scratch, idle, { recursive: true });
		rmSync(scratch, { recursive: true, force: true });
		console.log(`fixtures: ${version} ${kind}`);
	}
	// Unreleased code has no version number; keep the commit it came from.
	const source = join(here, `v${version}`, "SOURCE");
	if (existsSync(source)) writeFileSync(join(stores, version, "SOURCE"), readFileSync(source));
}
