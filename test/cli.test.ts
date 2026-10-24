// The command line, run as a user runs it: the built dist/cli.js in a child process.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fixture, ROOT } from "./support.ts";

const CLI = join(ROOT, "dist", "cli.js");
const STORE = fixture("1.4.0", "sqlite");
const built = existsSync(CLI) || "run npm run build first";

type Result = { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string };

let scratch: string;
/** Every child a test started: a failed assertion must not leave a server running past its test. */
const children = new Set<ReturnType<typeof spawn>>();
beforeEach(() => {
	scratch = mkdtempSync(join(tmpdir(), "durable-lens-cli-test-"));
});
afterEach(() => {
	for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	children.clear();
	rmSync(scratch, { recursive: true, force: true });
});

/** Start the CLI with a private TMPDIR, so its snapshots can be inspected and nothing else's are touched. */
function start(args: string[], env: Record<string, string> = {}) {
	const tmp = join(scratch, "tmp");
	mkdirSync(tmp, { recursive: true });
	const child = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, TMPDIR: tmp, ...env }, stdio: ["ignore", "pipe", "pipe"] });
	children.add(child);
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk: Buffer) => (stdout += chunk));
	child.stderr.on("data", (chunk: Buffer) => (stderr += chunk));
	const done = new Promise<Result>((resolve) => child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr })));
	return { child, done, tmp, output: () => stdout };
}

/** A port nothing listens on right now. */
function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const probe = createServer();
		probe.once("error", reject);
		probe.listen(0, "127.0.0.1", () => {
			const { port } = probe.address() as { port: number };
			probe.close(() => resolve(port));
		});
	});
}

const run = (args: string[], env?: Record<string, string>) => start(args, env).done;

/** Wait until the child has printed its URL line. */
async function listening(started: ReturnType<typeof start>): Promise<string> {
	for (let waited = 0; waited < 20_000; waited += 20) {
		const match = /^ {2}(http:\/\/127\.0\.0\.1:\d+\/\S+\/)$/m.exec(started.output());
		if (match?.[1] !== undefined) return match[1];
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`the server did not start: ${started.output()}`);
}

describe("durable-lens command", { skip: built !== true && built }, () => {
	it("prints usage and exits 0 for --help and -h", async () => {
		for (const flag of ["--help", "-h"]) {
			const result = await run([flag]);
			assert.equal(result.code, 0);
			assert.match(result.stdout, /^durable-lens: a read-only inspector for pi-durable storage/);
			assert.match(result.stdout, /Usage: durable-lens <store> \[options\]/);
			assert.match(result.stdout, /--restart-limit/);
			assert.equal(result.stderr, "");
		}
	});

	it("prints the package version for --version and -v", async () => {
		const { version } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string };
		for (const flag of ["--version", "-v"]) {
			const result = await run([flag]);
			assert.equal(result.code, 0);
			assert.equal(result.stdout.trim(), version);
		}
	});

	it("exits 2 with the usage on stderr when there is no store, or more than one", async () => {
		for (const args of [[], ["a.sqlite", "b.sqlite"], ["--no-watch"]]) {
			const result = await run(args);
			assert.equal(result.code, 2, args.join(" "));
			assert.match(result.stderr, /Usage: durable-lens <store>/);
			assert.equal(result.stdout, "");
		}
	});

	it("exits 1 and names the option for one it does not know", async () => {
		const result = await run(["--bogus", STORE]);
		assert.equal(result.code, 1);
		assert.match(result.stderr, /^durable-lens: Unknown option '--bogus'/);
	});

	it("exits 1 for a store that does not exist, and for one that is not a store", async () => {
		const missing = await run([join(scratch, "nope.sqlite"), "--json"]);
		assert.equal(missing.code, 1);
		assert.match(missing.stderr, /^durable-lens: \S*nope\.sqlite does not exist; give a SQLite file or a JSONL storage directory$/m);
		writeFileSync(join(scratch, "text.sqlite"), "just text");
		const notSqlite = await run([join(scratch, "text.sqlite"), "--json"]);
		assert.equal(notSqlite.code, 1);
		assert.match(notSqlite.stderr, /is not a SQLite database/);
		mkdirSync(join(scratch, "empty"));
		const notJsonl = await run([join(scratch, "empty"), "--json"]);
		assert.equal(notJsonl.code, 1);
		assert.match(notJsonl.stderr, /without main.jsonl/);
	});

	it("exits 1 for a restart limit that is not a positive number", async () => {
		for (const value of ["0", "-3", "abc", ""]) {
			const result = await run([STORE, "--json", `--restart-limit=${value}`]);
			assert.equal(result.code, 1, JSON.stringify(value));
			assert.match(result.stderr, /--restart-limit must be a positive number/);
		}
	});

	it("exits 1 when the decoder cannot be loaded or exports nothing usable", async () => {
		const missing = await run([STORE, "--json", "--decoder", join(scratch, "none.mjs")]);
		assert.equal(missing.code, 1);
		assert.match(missing.stderr, /Cannot find module/);
		writeFileSync(join(scratch, "empty.mjs"), "export const other = 1;\n");
		const empty = await run([STORE, "--json", "--decoder", join(scratch, "empty.mjs")]);
		assert.equal(empty.code, 1);
		assert.match(empty.stderr, /exports no decode function/);
	});

	it("prints the store as JSON with --json, without starting a server", async () => {
		const result = await run([STORE, "--json"]);
		assert.equal(result.code, 0);
		const lens = JSON.parse(result.stdout);
		assert.equal(lens.source.kind, "sqlite");
		assert.equal(lens.source.path, STORE, "the path as given");
		assert.equal(lens.entries.length, 27);
		assert.equal(lens.restartLimit, 5);
		assert.match(lens.format.version, /^pi-durable 1\.4/);
	});

	it("passes --restart-limit, --prefix and --decoder through to the read", async () => {
		const limited = JSON.parse((await run([STORE, "--json", "--restart-limit", "2"])).stdout);
		assert.equal(limited.restartLimit, 2);
		const wrongPrefix = await run([STORE, "--json", "--prefix", "nothing_"]);
		assert.equal(wrongPrefix.code, 1, "a prefix with no tables is an error, not an empty store");
		writeFileSync(join(scratch, "decoder.mjs"), "export default (value) => value;\n");
		const decoded = JSON.parse((await run([STORE, "--json", "--decoder", join(scratch, "decoder.mjs")])).stdout);
		assert.equal(decoded.source.decoder, join(scratch, "decoder.mjs"));
	});

	it("reads a JSONL directory as well", async () => {
		const result = await run([fixture("1.4.0", "jsonl"), "--json"]);
		assert.equal(result.code, 0);
		assert.equal(JSON.parse(result.stdout).source.kind, "jsonl");
	});

	// The snapshot of a finished read is already gone; a signal during a read is tested in hardening.test.ts.
	it("serves the page on loopback, exits 143 on SIGTERM, and leaves no snapshot", async () => {
		const server = start([STORE, "--no-watch"]);
		const url = await listening(server);
		assert.match(server.output(), /^durable-lens: pi-durable 1\.4.*, \d+ conversations, \d+ tasks/);
		assert.match(server.output(), /read-only; Ctrl-C to stop/);
		const page = await fetch(url);
		assert.equal(page.status, 200);
		assert.match(await page.text(), /<title>/);
		server.child.kill("SIGTERM");
		const result = await server.done;
		assert.equal(result.code, 143);
		assert.deepEqual(readdirSync(server.tmp), [], "no snapshot left behind");
	});

	it("exits 130 on SIGINT", async () => {
		const server = start([STORE, "--no-watch"]);
		await listening(server);
		server.child.kill("SIGINT");
		assert.equal((await server.done).code, 130);
	});

	it("listens on the port it is given", async () => {
		const port = await freePort();
		const server = start([STORE, "--no-watch", "--port", String(port)]);
		const url = await listening(server);
		assert.ok(url.startsWith(`http://127.0.0.1:${port}/`), url);
		server.child.kill("SIGTERM");
		await server.done;
	});

	it("with --open hands the browser a link that works once", { skip: process.platform !== "linux" && "uses xdg-open" }, async () => {
		const bin = join(scratch, "bin");
		mkdirSync(bin);
		const record = join(scratch, "opened.txt");
		writeFileSync(join(bin, "xdg-open"), `#!/bin/sh\necho "$1" > "${record}"\n`);
		chmodSync(join(bin, "xdg-open"), 0o755);
		const server = start([STORE, "--no-watch", "--open"], { PATH: `${bin}:${process.env.PATH}` });
		const url = await listening(server);
		for (let waited = 0; !existsSync(record) && waited < 10_000; waited += 20) await new Promise((resolve) => setTimeout(resolve, 20));
		const link = readFileSync(record, "utf8").trim();
		assert.match(link, /^http:\/\/127\.0\.0\.1:\d+\/open\/[\w-]+$/);
		assert.ok(!link.includes(new URL(url).pathname.split("/")[1] as string), "the link does not carry the token");
		const first = await fetch(link, { redirect: "manual" });
		assert.equal(first.status, 302);
		assert.equal(first.headers.get("location"), new URL(url).pathname);
		assert.equal((await fetch(link, { redirect: "manual" })).status, 404, "used up");
		server.child.kill("SIGTERM");
		await server.done;
	});
});
