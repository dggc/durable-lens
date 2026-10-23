// Regressions for what a pre-release review found: hostile content, large stores, races, and interrupted reads.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { buildLens } from "../src/model.ts";
import { openLens } from "../src/open.ts";
import { serve } from "../src/server.ts";
import { readJsonl } from "../src/store/jsonl.ts";
import { applyOps, OpError } from "../src/store/ops.ts";
import type { JsonObject, RawStore } from "../src/store/types.ts";
import { copyFixture, fixture, ROOT } from "./support.ts";

/** Just enough DOM for the page's renderer: elements with children, attributes and text. */
type FakeNode = { tag: string; text?: string; attributes: Record<string, string>; children: FakeNode[] };
function installFakeDocument(): void {
	const element = (tag: string): FakeNode & Record<string, unknown> => {
		const node: FakeNode & Record<string, unknown> = {
			tag,
			attributes: {},
			children: [],
			setAttribute(name: string, value: string) {
				node.attributes[name] = value;
			},
			addEventListener() {},
			appendChild(child: FakeNode) {
				node.children.push(child);
				return child;
			},
			append(...children: FakeNode[]) {
				node.children.push(...children);
			},
		};
		return node;
	};
	(globalThis as Record<string, unknown>).document = {
		createElement: element,
		createTextNode: (text: string) => ({ tag: "#text", text, attributes: {}, children: [] }),
	};
}

function walk(node: FakeNode, visit: (node: FakeNode) => void): void {
	visit(node);
	for (const child of node.children) walk(child, visit);
}

function rawStore(parts: Partial<RawStore>): RawStore {
	return { kind: "sqlite", path: "test", files: [], conversations: [{ id: 1 }], entries: [], tasks: [], submissions: [], documents: [], attempts: 1, warnings: [], ...parts };
}

describe("hostile transcript text", () => {
	installFakeDocument();

	it("renders long runs of backticks, brackets and table rules in linear time", async () => {
		const { markdown } = await import("../src/web/markdown.ts");
		for (const text of [`Here is the output: ${"`".repeat(20_000)}x`, "[".repeat(50_000), `|a|b|\n|---${" ".repeat(20_000)}x`, `${"*a".repeat(20_000)}`, `**${"x".repeat(50_000)}`]) {
			const started = performance.now();
			markdown(text);
			assert.ok(performance.now() - started < 500, `took ${Math.round(performance.now() - started)} ms`);
		}
	});

	it("keeps HTML, scripts and links as text", async () => {
		const { markdown } = await import("../src/web/markdown.ts");
		const root = markdown('<img src=x onerror="alert(1)"> <script>alert(2)</script> [docs](javascript:alert(3)) `<b>code</b>` **<i>bold</i>**') as unknown as FakeNode;
		const allowed = new Set(["#text", "div", "p", "code", "strong", "em", "span"]);
		walk(root, (node) => {
			assert.ok(allowed.has(node.tag), `unexpected element ${node.tag}`);
			assert.equal(node.attributes.href, undefined);
			assert.equal(node.attributes.src, undefined);
		});
		const text: string[] = [];
		walk(root, (node) => node.text !== undefined && text.push(node.text));
		assert.match(text.join(""), /<img src=x onerror="alert\(1\)">/);
		assert.match(text.join(""), /<script>alert\(2\)<\/script>/);
	});
});

describe("store content that collides with JavaScript", () => {
	it("keeps usage keys named __proto__ and toString as rows, without touching Object.prototype", () => {
		const usage = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { total: 0.5 } };
		const lens = buildLens(
			rawStore({
				documents: [
					{
						record: { id: 9, kind: "pi.usage", scope: { kind: "conversation", conversationId: 1 }, history: "latest" },
						revisions: [{ seq: 1, kind: "base", version: 1, content: JSON.parse(`{"models":{"__proto__":${JSON.stringify(usage)}},"tools":{"toString":${JSON.stringify(usage)}}}`) }],
					},
				],
			}),
		);
		assert.equal(({} as Record<string, unknown>).input, undefined, "Object.prototype untouched");
		assert.deepEqual(Object.keys(lens.usage.byModel), ["__proto__"]);
		assert.deepEqual(Object.keys(lens.usage.byTool), ["toString"]);
		assert.equal(lens.usage.total.cost, 1);
		assert.equal(JSON.parse(JSON.stringify(lens)).usage.byModel.__proto__.cost, 0.5);
	});

	it("rejects the ops Chord rejects", () => {
		for (const op of [["p", ["a"], -1, 0, [1]], ["t", ["s"], -1], ["t", ["s"], 1.5], ["m", ["a"], [0, 0]], ["s", ["a"]], ["d", []]]) {
			assert.throws(() => applyOps({ a: [1, 2], s: "text" }, [op]), OpError, JSON.stringify(op));
		}
	});
});

describe("large stores", () => {
	it("builds a conversation of 150,000 timestamped entries", () => {
		const entries = Array.from({ length: 150_000 }, (_, i) => ({ record: { id: i + 2, conversationId: 1, kind: "pi.user", model: [{ role: "user", content: "hi", timestamp: 1_000 + i }] } as JsonObject, seq: i + 1 }));
		const lens = buildLens(rawStore({ entries }));
		assert.equal(lens.conversations[0]?.firstAt, 1_000);
		assert.equal(lens.conversations[0]?.lastAt, 150_999);
	});

	it("splices 150,000 items as Chord does", () => {
		const items = Array.from({ length: 150_000 }, (_, i) => i);
		assert.equal((applyOps({ list: [] }, [["p", ["list"], 0, 0, items]]) as { list: number[] }).list.length, 150_000);
	});

	it("keeps a bounded number of rewind states", () => {
		const revisions = [{ seq: 1, kind: "base" as const, version: 1, content: { items: [] } }];
		for (let seq = 2; seq <= 3_000; seq++) revisions.push({ seq, kind: "delta" as never, version: 1, content: [["p", ["items"], 0, 0, [`note ${seq}`]]] as never });
		const lens = buildLens(rawStore({ documents: [{ record: { id: 9, kind: "app.notes", scope: { kind: "conversation", conversationId: 1 }, history: "rewindable" }, revisions }] }));
		const states = lens.documents[0]?.states ?? [];
		assert.equal(states.length, 100);
		assert.equal(states.at(-1)?.seq, 3_000);
		assert.equal((lens.documents[0]?.value as { items: unknown[] }).items.length, 2_999);
	});
});

describe("task status", () => {
	it("does not call an abort-marked task parked", () => {
		const task = (id: number, abortRequested: boolean) => ({ id, conversationId: 1, kind: "app.sync", background: true, abortRequested, restarts: 5, state: { status: "pending", checkpoint: {} } });
		const lens = buildLens(rawStore({ tasks: [task(2, false), task(3, true)] }));
		assert.deepEqual(lens.tasks.map((t) => t.parked), [true, false]);
	});
});

describe("JSONL records that may and may not be missing", () => {
	const store = (main: object[], sidecar: object[]) => {
		const directory = mkdtempSync(join(tmpdir(), "durable-lens-test-"));
		writeFileSync(join(directory, "main.jsonl"), main.map((line) => `${JSON.stringify(line)}\n`).join(""));
		writeFileSync(join(directory, "doc-1.jsonl"), sidecar.map((line) => `${JSON.stringify(line)}\n`).join(""));
		return directory;
	};
	const record = { id: 1, kind: "app.settings", scope: { kind: "session" } };
	const content = (seq: number, kind: "base" | "delta", body: unknown) => ({ format: 1, type: "record", seq, ordinal: 0, payload: { type: "document", id: 1, content: kind === "base" ? { version: 1, kind, value: body } : { version: 1, kind, ops: body } } });
	const main = [
		{ format: 1, type: "commit", seq: 1, writes: [{ type: "document.create", record, ordinal: 0 }] },
		{ format: 1, type: "commit", seq: 2, writes: [{ type: "document.change", id: 1, ordinal: 0 }] },
	];

	it("accepts records reclaimed before the newest base", async () => {
		const directory = store(main, [content(2, "base", { a: 2 })]);
		try {
			const raw = await readJsonl(directory);
			assert.deepEqual(raw.documents[0]?.revisions.map((revision) => [revision.seq, revision.kind]), [[2, "base"]]);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("refuses a missing record after the newest base, after rereading", async () => {
		const directory = store(main, [content(1, "base", { a: 1 })]);
		try {
			await assert.rejects(readJsonl(directory), /doc-1\.jsonl lacks the record of commit 2, still after 6 reads/);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});

describe("snapshots of SQLite stores", () => {
	it("reads a read-only database file twice", async () => {
		const copy = copyFixture("1.4.0", "sqlite-crashed");
		try {
			for (const suffix of ["", "-wal", "-shm"]) chmodSync(copy.store + suffix, 0o444);
			for (let i = 0; i < 2; i++) assert.equal((await openLens(copy.store)).entries.length, 27);
		} finally {
			for (const suffix of ["", "-wal", "-shm"]) chmodSync(copy.store + suffix, 0o644);
			copy.dispose();
		}
	});

	it("removes its copies on SIGINT mid-read, and stale ones of dead processes", async () => {
		// A pid that no process has, for a snapshot directory a killed durable-lens left behind.
		let dead = 4_194_000;
		while (dead > 1) {
			try {
				process.kill(dead, 0);
				dead--;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ESRCH") break;
				dead--;
			}
		}
		const stale = join(tmpdir(), `durable-lens-${dead}-Zz9Zz9`);
		mkdirSync(stale, { recursive: true });
		writeFileSync(join(stale, "session.sqlite"), "left behind");

		// A decoder that never returns (with a timer, so the process stays up) keeps the read and its snapshot in progress.
		const decoderDirectory = mkdtempSync(join(tmpdir(), "durable-lens-test-"));
		const decoder = join(decoderDirectory, "hang.mjs");
		writeFileSync(decoder, "export default () => new Promise(() => setInterval(() => {}, 1000));\n");
		try {
			const child = spawn(process.execPath, [join(ROOT, "dist", "cli.js"), fixture("1.4.0", "sqlite"), "--json", "--decoder", decoder], { stdio: "ignore" });
			const mine = () => readdirSync(tmpdir()).filter((name) => name.startsWith(`durable-lens-${child.pid}-`));
			const deadline = Date.now() + 10_000;
			while (mine().length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
			assert.equal(mine().length, 1, "the read is in progress with its snapshot");
			assert.ok(!existsSync(stale), "the stale snapshot of a dead process was swept");
			const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
			child.kill("SIGINT");
			assert.equal(await exited, 130);
			assert.deepEqual(mine(), [], "no snapshot left after SIGINT");
		} finally {
			rmSync(decoderDirectory, { recursive: true, force: true });
			rmSync(stale, { recursive: true, force: true });
		}
	});
});

describe("--open link", () => {
	it("works once", async () => {
		const running = await serve(fixture("1.4.0", "sqlite"), { watch: false });
		try {
			const link = new URL(running.openLink());
			const get = () =>
				new Promise<{ status: number; location?: string }>((resolve, reject) => {
					const req = request({ hostname: link.hostname, port: link.port, path: link.pathname }, (response) => {
						response.resume();
						resolve({ status: response.statusCode ?? 0, ...(response.headers.location === undefined ? {} : { location: response.headers.location }) });
					});
					req.on("error", reject);
					req.end();
				});
			const first = await get();
			assert.equal(first.status, 302);
			assert.equal(first.location, new URL(running.url).pathname);
			assert.equal((await get()).status, 404);
		} finally {
			await running.close();
		}
	});
});
