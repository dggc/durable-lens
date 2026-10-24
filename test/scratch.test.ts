// Private snapshot directories: created owner-only, removed on dispose, and swept when a killed process left one behind.
// The module sweeps once per process, so this file points TMPDIR at its own directory before it loads the module.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

const home = mkdtempSync(join(tmpdir(), "durable-lens-scratch-test-"));
process.env.TMPDIR = home;
const { disposeScratch, makeScratch } = await import("../src/store/scratch.ts");
after(() => rmSync(home, { recursive: true, force: true }));

/** The pid of a process that has exited, so no live process owns it. */
function deadPid(): number {
	const result = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
	return Number(result.stdout);
}

describe("scratch directories", () => {
	it("sweeps the directories of dead processes on first use, and leaves everything else", () => {
		const dead = join(home, `durable-lens-${deadPid()}-abc123`);
		const alive = join(home, `durable-lens-${process.ppid}-abc123`);
		const other = join(home, "durable-lens-notes");
		const strange = join(home, `durable-lens-${deadPid()}-toolongsuffix`);
		for (const path of [dead, alive, other, strange]) mkdirSync(path);
		writeFileSync(join(dead, "session.sqlite"), "copy of someone's transcripts");

		const scratch = makeScratch();

		assert.equal(existsSync(dead), false, "a dead process's snapshot is removed");
		assert.equal(existsSync(alive), true, "a live process's is not");
		assert.equal(existsSync(other), true);
		assert.equal(existsSync(strange), true, "names that do not match the pattern are not durable-lens's");
		scratch.dispose();
	});

	it("makes a directory only its owner can use, named for the process", () => {
		const scratch = makeScratch();
		assert.ok(scratch.path.startsWith(join(home, `durable-lens-${process.pid}-`)));
		assert.equal(statSync(scratch.path).mode & 0o777, 0o700);
		scratch.dispose();
		assert.equal(existsSync(scratch.path), false);
		scratch.dispose();
	});

	it("disposes of every live directory at once", () => {
		const paths = [makeScratch().path, makeScratch().path];
		assert.ok(paths.every(existsSync));
		disposeScratch();
		assert.ok(paths.every((path) => !existsSync(path)));
		assert.deepEqual(
			readdirSync(home).filter((name) => name.startsWith(`durable-lens-${process.pid}-`)),
			[],
		);
	});

	it("cleans up after a process that exits without disposing", () => {
		const script = `
			const { makeScratch } = await import(${JSON.stringify(new URL("../src/store/scratch.ts", import.meta.url).href)});
			process.stdout.write(makeScratch().path);
		`;
		const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", env: { ...process.env, TMPDIR: home } });
		assert.equal(result.status, 0, result.stderr);
		assert.ok(result.stdout.startsWith(home));
		assert.equal(existsSync(result.stdout), false, "removed by the exit handler");
	});
});
