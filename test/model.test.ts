// buildLens on hand-written records: version detection, task state, usage totals, documents and the odd shapes a
// newer or damaged store can hold. The fixtures (fixtures.test.ts) cover real stores; these pin the rules.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildLens, DEFAULT_RESTART_LIMIT, emptyUsage } from "../src/model.ts";
import type { Json, JsonObject, RawDocument, RawStore } from "../src/store/types.ts";
import { rawStore } from "./support.ts";

const usage = (input: number, output: number, cost: number): JsonObject => ({
	input,
	output,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: input + output,
	cost: { total: cost },
});
const assistant = (extra: JsonObject = {}): JsonObject => ({ role: "assistant", provider: "faux", model: "m1", stopReason: "stop", content: [], ...extra });
const entry = (id: number, extra: JsonObject = {}, conversationId = 1): { record: JsonObject; seq: number } => ({
	record: { id, conversationId, kind: "pi.assistant", model: [], ...extra },
	seq: id,
});
const task = (id: number, extra: JsonObject = {}): JsonObject => ({ id, kind: "k", conversationId: 1, state: { status: "pending" }, ...extra });
const document = (id: number, record: JsonObject, revisions: RawDocument["revisions"]): RawDocument => ({
	record: { id, kind: "app.doc", scope: { kind: "session" }, ...record },
	revisions,
});
const base = (seq: number, value: Json, version = seq) => ({ seq, kind: "base" as const, version, content: value });
const delta = (seq: number, ops: Json, version = seq) => ({ seq, kind: "delta" as const, version, content: ops });

describe("version detection", () => {
	const version = (parts: Partial<RawStore>) => buildLens(rawStore(parts)).format.version;

	it("reads SQLite schema v1 as 1.3 or earlier and v2 as 1.4.0 or later", () => {
		assert.equal(version({ schemaVersion: 1 }), "pi-durable 1.0–1.3");
		assert.equal(version({ schemaVersion: 2 }), "pi-durable 1.4 or later");
	});

	it("says so when the schema is newer than it knows", () => {
		const lens = buildLens(rawStore({ schemaVersion: 9 }));
		assert.equal(lens.format.version, "pi-durable 1.0 or later");
		assert.match(lens.format.hints.join("\n"), /schema v9: newer than this durable-lens knows/);
	});

	it("reads a table prefix as 1.3.0 or later, and combines it with schema v1", () => {
		assert.equal(version({ schemaVersion: 1, prefix: "app_" }), "pi-durable 1.3");
		assert.equal(version({ schemaVersion: 2, prefix: "app_" }), "pi-durable 1.4 or later");
	});

	it("keeps JSONL at format 1 and raises the floor from what the records hold", () => {
		const lens = buildLens(rawStore({ kind: "jsonl" }));
		assert.equal(lens.format.version, "pi-durable 1.0 or later");
		assert.match(lens.format.hints[0] ?? "", /JSONL format 1/);
	});

	it("raises the floor from task shapes", () => {
		const jsonl = (tasks: JsonObject[]) => version({ kind: "jsonl", tasks });
		assert.equal(jsonl([task(1, { startedAt: 5 })]), "pi-durable 1.1 or later");
		assert.equal(jsonl([task(1, { kind: "pi.tool", version: 2 })]), "pi-durable 1.2 or later");
		assert.equal(jsonl([task(1, { restarts: 0 })]), "pi-durable 1.4 or later");
		assert.equal(jsonl([task(1, { state: { status: "sleeping", until: 5 } })]), "pi-durable 1.4 or later");
	});

	it("raises the floor from tool result durations", () => {
		const entries = [entry(1, { kind: "pi.tool-result", model: [{ role: "toolResult", durationMs: 12 }] })];
		assert.equal(version({ kind: "jsonl", entries }), "pi-durable 1.1 or later");
	});

	it("reports an exact release when the floor meets the ceiling", () => {
		assert.equal(version({ schemaVersion: 1, prefix: "p_", tasks: [task(1, { kind: "pi.tool", version: 2 })] }), "pi-durable 1.3");
		// A v1 database cannot hold 1.4.0 task shapes: the range collapses to what both agree on.
		assert.equal(version({ schemaVersion: 1, tasks: [task(1, { startedAt: 5 })] }), "pi-durable 1.1–1.3");
	});
});

describe("tasks", () => {
	const build = (tasks: JsonObject[], restartLimit?: number) => buildLens(rawStore({ tasks }), restartLimit === undefined ? {} : { restartLimit }).tasks;

	it("parks a pending or running task that crashed restartLimit times in a row", () => {
		const [pending, running, short, terminal, aborted, none] = build([
			task(1, { restarts: 5 }),
			task(2, { restarts: 7, state: { status: "running" } }),
			task(3, { restarts: 4 }),
			task(4, { restarts: 9, state: { status: "terminal", outcome: { status: "failed" } } }),
			task(5, { restarts: 9, abortRequested: true }),
			task(6),
		]);
		assert.deepEqual(
			[pending, running, short, terminal, aborted, none].map((t) => t?.parked),
			[true, true, false, false, false, false],
		);
	});

	it("takes the restart limit from the options, defaulting to pi-durable's", () => {
		assert.equal(DEFAULT_RESTART_LIMIT, 5);
		assert.equal(build([task(1, { restarts: 2 })], 2)[0]?.parked, true);
		assert.equal(build([task(1, { restarts: 2 })])[0]?.parked, false);
		assert.equal(buildLens(rawStore({})).restartLimit, 5);
	});

	it("reads waiting, sleeping and finished state", () => {
		const [waiting, sleeping, done] = build([
			task(1, { state: { status: "waiting", on: [2, "3"], policy: "all" } }),
			task(2, { state: { status: "sleeping", until: 1234 } }),
			task(3, {
				state: {
					status: "terminal",
					outcome: { status: "failed", error: { message: "x" }, reason: "why", result: { entryId: 8 } },
					checkpoint: { phase: "p1" },
				},
			}),
		]);
		assert.deepEqual([waiting?.on, waiting?.policy], [[2, 3], "all"]);
		assert.equal(sleeping?.until, 1234);
		assert.deepEqual(done?.outcome, { status: "failed", error: { message: "x" }, reason: "why", result: { entryId: 8 } });
		assert.equal(done?.entryId, 8);
		assert.equal(done?.phase, "p1");
	});

	it("falls back to placeholders for a record with a missing or odd state", () => {
		const [odd, strings] = build([
			{ id: 1, conversationId: 1 },
			{ id: 2, conversationId: 1, kind: 5, state: "gone", restarts: "many", startedAt: "now" },
		]);
		assert.deepEqual([odd?.kind, odd?.status, odd?.parked], ["?", "?", false]);
		assert.deepEqual([strings?.kind, strings?.status, strings?.restarts, strings?.startedAt], ["?", "?", undefined, undefined]);
	});

	it("links children to owners, and names tool tasks from their call", () => {
		const entries = [entry(10, { model: [assistant({ content: [{ type: "toolCall", id: "c1", name: "grep" }] })] })];
		const tasks = [
			task(1),
			task(2, { owner: 1 }),
			task(3, { kind: "pi.tool", owner: 1, input: { assistant: 10, callId: "c1" } }),
			task(4, { kind: "pi.tool", input: { assistant: 10, callId: "c1", name: "named" } }),
		];
		const lens = buildLens(rawStore({ entries, tasks }));
		assert.deepEqual(lens.tasks[0]?.children, [2, 3]);
		assert.equal(lens.tasks[2]?.label, "grep", "from the toolCall part of the issuing entry");
		assert.equal(lens.tasks[3]?.label, "named", "from the input when it has one");
		assert.deepEqual([lens.tasks[2]?.callEntryId, lens.tasks[2]?.callId], [10, "c1"]);
	});

	it("labels a generation with the model of the entry it produced", () => {
		const entries = [entry(5, { model: [assistant({ provider: "p", model: "big" })] })];
		const tasks = [task(1, { kind: "pi.generation", state: { status: "terminal", outcome: { status: "completed", result: { entryId: 5 } } } })];
		assert.equal(buildLens(rawStore({ entries, tasks })).tasks[0]?.label, "p/big");
	});
});

describe("entries", () => {
	it("takes time, duration, usage, model and stop reason from the messages", () => {
		const entries = [
			entry(1, {
				model: [
					assistant({ timestamp: 1000, durationMs: 40, usage: usage(10, 5, 0.25), stopReason: "length", errorMessage: "cut" }),
					assistant({ timestamp: 2000, durationMs: 2, usage: usage(1, 1, 0.5) }),
				],
			}),
		];
		const [result] = buildLens(rawStore({ entries })).entries;
		assert.equal(result?.at, 1000);
		assert.equal(result?.durationMs, 42);
		assert.deepEqual(result?.usage, { input: 11, output: 6, cacheRead: 0, cacheWrite: 0, totalTokens: 17, cost: 0.75 });
		assert.equal(result?.model, "faux/m1");
		assert.equal(result?.stopReason, "stop", "the last message's");
		assert.equal(result?.errorMessage, "cut");
	});

	it("estimates a missing time from the task, then from the entry before", () => {
		const entries = [
			entry(1, { model: [assistant({ timestamp: 100 })] }),
			entry(2, { byTaskId: 7 }),
			entry(3, { byTaskId: 8 }),
			entry(4),
			{ record: { id: 5, conversationId: 1, kind: "x", model: [] }, seq: 5 },
		];
		const tasks = [task(7, { startedAt: 200, endedAt: 300 }), task(8, { startedAt: 400 })];
		const result = buildLens(rawStore({ entries, tasks })).entries;
		assert.deepEqual(
			result.map((e) => [e.at, e.atEstimated]),
			[
				[100, undefined],
				[300, true],
				[400, true],
				[400, true],
				[400, true],
			],
		);
	});

	it("leaves a time unset when nothing can estimate it", () => {
		const [result] = buildLens(rawStore({ entries: [entry(1)] })).entries;
		assert.equal(result?.at, undefined);
	});

	it("passes odd messages and unknown fields through", () => {
		const record = {
			id: 1,
			conversationId: 1,
			kind: 7,
			model: ["text", null, { role: "assistant", usage: "none" }],
			data: { a: 1 },
			head: 3,
			edits: [1],
			future: true,
		};
		const [result] = buildLens(rawStore({ entries: [{ record, seq: undefined }] })).entries;
		assert.equal(result?.kind, "?");
		assert.equal(result?.messages.length, 3);
		assert.deepEqual([result?.data, result?.head, result?.edits, result?.seq], [{ a: 1 }, 3, [1], undefined]);
		assert.equal(result?.usage, undefined);
	});

	it("reads a record whose model is not a list as having no messages", () => {
		assert.deepEqual(buildLens(rawStore({ entries: [{ record: { id: 1, conversationId: 1, kind: "k", model: "text" }, seq: 1 }] })).entries[0]?.messages, []);
	});
});

describe("usage", () => {
	it("fills the total from its parts when the total is missing, and reads a plain number as the cost", () => {
		const doc = document(1, { kind: "pi.usage", scope: { kind: "conversation", conversationId: 1 } }, [
			base(1, { models: { a: { input: 3, output: 4, cost: 0.5 }, b: { totalTokens: 100, cost: { total: 1 } } }, tools: { t: { input: 1, cost: Number.NaN } } }),
		]);
		const lens = buildLens(rawStore({ documents: [doc] }));
		assert.equal(lens.usage.byModel.a?.totalTokens, 7);
		assert.equal(lens.usage.byModel.a?.cost, 0.5);
		assert.equal(lens.usage.byModel.b?.totalTokens, 100);
		assert.equal(lens.usage.byTool.t?.cost, 0);
		assert.equal(lens.usage.total.cost, 1.5);
		assert.equal(lens.conversations[0]?.usage.cost, 1.5);
	});

	it("sums per-entry usage for a conversation without a usage document", () => {
		const entries = [
			entry(1, { model: [assistant({ usage: usage(10, 0, 1) })] }),
			entry(2, { model: [assistant({ usage: usage(5, 0, 2) })] }),
			entry(3, { model: [assistant({ usage: usage(7, 0, 4) })] }, 2),
		];
		const lens = buildLens(rawStore({ conversations: [{ id: 1 }, { id: 2 }], entries }));
		assert.deepEqual(
			lens.conversations.map((c) => c.usage.cost),
			[3, 4],
		);
		assert.equal(lens.usage.total.cost, 0, "the page's total comes only from usage documents");
	});

	it("ignores retired and malformed usage documents", () => {
		const scope = { kind: "conversation", conversationId: 1 };
		const documents = [
			document(1, { kind: "pi.usage", scope, retiredAt: 4 }, [base(1, { models: { a: usage(1, 1, 9) } })]),
			document(2, { kind: "pi.usage", scope }, [base(1, "not an object")]),
			document(3, { kind: "pi.usage", scope }, [base(1, { models: "x", tools: [] })]),
		];
		assert.equal(buildLens(rawStore({ documents })).usage.total.cost, 0);
	});

	it("exports an empty usage with zero counters", () => {
		assert.deepEqual(emptyUsage(), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 });
	});
});

describe("documents", () => {
	it("materializes the newest base plus the deltas after it", () => {
		const doc = document(1, {}, [base(1, { n: 1 }), delta(2, [["s", ["n"], 2]]), base(3, { n: 10 }), delta(4, [["s", ["m"], 1]])]);
		const [result] = buildLens(rawStore({ documents: [doc] })).documents;
		assert.deepEqual(result?.value, { n: 10, m: 1 });
		assert.equal(result?.version, 4);
		assert.equal(result?.error, undefined);
	});

	it("skips deltas that come before the first base the store kept", () => {
		const doc = document(1, {}, [delta(1, [["s", ["n"], 2]]), base(2, { n: 5 })]);
		assert.deepEqual(buildLens(rawStore({ documents: [doc] })).documents[0]?.value, { n: 5 });
	});

	it("reports a document with deltas only", () => {
		const lens = buildLens(rawStore({ documents: [document(1, {}, [delta(1, [["s", ["n"], 2]])])] }));
		assert.equal(lens.documents[0]?.error, "no base revision");
		assert.equal(lens.documents[0]?.value, null);
		assert.match(lens.warnings.join("\n"), /document 1 \(app.doc\): no base revision/);
	});

	it("keeps the last good value and says why when a delta cannot apply", () => {
		const doc = document(1, {}, [base(1, { n: 1 }), delta(2, [["s", ["a", "b"], 1]]), delta(3, [["s", ["n"], 3]])]);
		const [result] = buildLens(rawStore({ documents: [doc] })).documents;
		assert.deepEqual(result?.value, { n: 1 });
		assert.match(result?.error ?? "", /could not apply revision: path \["a"\] does not exist/);
	});

	it("keeps the state after each revision of a rewindable document, and none for others", () => {
		const revisions = [base(1, { n: 0 }), delta(2, [["s", ["n"], 1]]), delta(3, [["s", ["n"], 2]])];
		const [rewindable, latest, unmarked] = buildLens(
			rawStore({ documents: [document(1, { history: "rewindable" }, revisions), document(2, { history: "latest" }, revisions), document(3, {}, revisions)] }),
		).documents;
		assert.deepEqual(
			rewindable?.states?.map((s) => [s.seq, s.value]),
			[
				[1, { n: 0 }],
				[2, { n: 1 }],
				[3, { n: 2 }],
			],
		);
		assert.equal(latest?.states, undefined);
		assert.equal(unmarked?.states, undefined);
	});

	it("caps the states a long history sends to the page", () => {
		const revisions = [base(1, { items: [] as Json[] })];
		for (let seq = 2; seq <= 250; seq++) revisions.push(delta(seq, [["p", ["items"], seq, 0, [seq]]]) as never);
		const [result] = buildLens(rawStore({ documents: [document(1, { history: "rewindable" }, revisions)] })).documents;
		assert.equal(result?.states?.length, 100);
		assert.equal(result?.states?.at(0)?.seq, 151);
		assert.equal(result?.states?.at(-1)?.seq, 250);
		assert.equal((result?.value as { items: unknown[] } | undefined)?.items.length, 249);
	});

	it("reads scope, key and lifecycle fields, tolerating a missing scope", () => {
		const doc = document(1, { key: "k", createdAt: 3, retiredAt: 9, fork: "inherit", scope: { kind: "task", taskId: 4, conversationId: 2 } }, [base(1, 1)]);
		const [result, bare] = buildLens(rawStore({ documents: [doc, { record: { id: 2 }, revisions: [] }] })).documents;
		assert.deepEqual(result?.scope, { kind: "task", taskId: 4, conversationId: 2 });
		assert.deepEqual([result?.key, result?.createdAt, result?.retiredAt, result?.fork], ["k", 3, 9, "inherit"]);
		assert.deepEqual([bare?.kind, bare?.scope.kind, bare?.value, bare?.error], ["?", "?", null, undefined]);
	});
});

describe("conversations", () => {
	it("tells roots, forks, subagents and others apart, and links children to parents", () => {
		const conversations: JsonObject[] = [
			{ id: 1 },
			{ id: 2, parent: { conversationId: 1, at: 7 } },
			{ id: 3, owner: { conversationId: 1, taskId: 9 } },
			{ id: 4 },
		];
		const lens = buildLens(rawStore({ conversations }));
		assert.deepEqual(
			lens.conversations.map((c) => [c.role, c.label]),
			[
				["root", "Root"],
				["fork", "Fork of #1 at entry 7"],
				["subagent", "Subagent of task 9"],
				["conversation", "Conversation #4"],
			],
		);
		assert.deepEqual(lens.conversations[0]?.children, [2, 3]);
	});

	it("titles a conversation from its first user text, shortened to 120 characters", () => {
		const user = (id: number, content: Json, conversationId = 1) => entry(id, { kind: "pi.user", model: [{ role: "user", content }] }, conversationId);
		const entries = [user(1, "x".repeat(300)), user(2, [{ type: "image" }, { type: "text", text: "short" }], 2), user(3, [], 3)];
		const lens = buildLens(rawStore({ conversations: [{ id: 1 }, { id: 2 }, { id: 3 }], entries }));
		assert.equal(lens.conversations[0]?.title, `${"x".repeat(117)}…`);
		assert.equal(lens.conversations[1]?.title, "short");
		assert.equal(lens.conversations[2]?.title, undefined);
	});

	it("reads the model from the pi.agent document, and first and last times from the entries", () => {
		const agent = document(1, { kind: "pi.agent", scope: { kind: "conversation", conversationId: 1 } }, [base(1, { model: { provider: "p", modelId: "m" } })]);
		const legacy = document(2, { kind: "pi.agent", scope: { kind: "conversation", conversationId: 2 } }, [base(1, { model: { provider: "p", id: "old" } })]);
		const partial = document(3, { kind: "pi.agent", scope: { kind: "conversation", conversationId: 3 } }, [base(1, { model: { provider: "p" } })]);
		const entries = [
			entry(1, { model: [assistant({ timestamp: 30 })] }),
			entry(2, { model: [assistant({ timestamp: 10 })] }),
			entry(3, { model: [assistant({ timestamp: 20 })] }),
		];
		const lens = buildLens(rawStore({ conversations: [{ id: 1 }, { id: 2 }, { id: 3 }], documents: [agent, legacy, partial], entries }));
		assert.deepEqual(
			lens.conversations.map((c) => c.model),
			["p/m", "p/old", undefined],
		);
		assert.deepEqual([lens.conversations[0]?.firstAt, lens.conversations[0]?.lastAt], [10, 30]);
	});
});

describe("odd stores", () => {
	it("warns when records have no id, which an encrypted store looks like", () => {
		const lens = buildLens(rawStore({ conversations: [{ id: 1 }, { ciphertext: "x" }], tasks: [{ blob: "y" }], entries: [{ record: { blob: "z" }, seq: 1 }] }));
		assert.match(lens.warnings.join("\n"), /3 records have no id: .* --decoder/);
		assert.equal(lens.conversations.length, 1);
		assert.equal(lens.entries.length, 0);
		assert.equal(lens.tasks.length, 0);
	});

	it("skips records that are not objects at all, such as null from a column or a decoder, with the same warning", () => {
		const odd = [null, 7, "ciphertext", [], true] as unknown as JsonObject[];
		const lens = buildLens(
			rawStore({
				conversations: [{ id: 1 }, ...odd],
				entries: odd.map((record) => ({ record, seq: 1 })),
				tasks: odd,
				submissions: odd,
				documents: odd.map((record) => ({ record, revisions: [] })),
			}),
		);
		assert.match(lens.warnings.join("\n"), /15 records have no id: .* --decoder/);
		assert.deepEqual([lens.conversations.length, lens.entries.length, lens.tasks.length, lens.documents.length], [1, 0, 0, 0]);
	});

	it("reads ids and links that are objects with a toString that is not a function, as numbers that are not numbers", () => {
		// Found by the fuzz tests: Number() of such a value throws, and one record took the whole lens down.
		const odd = { toString: false, valueOf: false };
		const lens = buildLens(
			rawStore({
				conversations: [{ id: 1, parent: { conversationId: odd, at: odd }, owner: { conversationId: odd, taskId: odd } }],
				entries: [entry(1, { conversationId: odd })],
				tasks: [task(1, { conversationId: odd, state: { status: "waiting", on: [odd, 2] } })],
				submissions: [{ id: 1, conversationId: odd }],
			}),
		);
		assert.ok(Number.isNaN(lens.entries[0]?.conversationId));
		assert.ok(Number.isNaN(lens.tasks[0]?.conversationId));
		assert.deepEqual(lens.tasks[0]?.on?.map(Number.isNaN), [true, false]);
		assert.ok(Number.isNaN(lens.submissions[0]?.conversationId));
		assert.ok(Number.isNaN(lens.conversations[0]?.parent?.conversationId));
		assert.ok(Number.isNaN(lens.conversations[0]?.owner?.taskId));
	});

	it("keeps the reader's warnings first", () => {
		assert.deepEqual(buildLens(rawStore({ warnings: ["from the reader"] })).warnings, ["from the reader"]);
	});

	it("carries submissions with their optional fields", () => {
		const lens = buildLens(
			rawStore({
				submissions: [
					{ id: 1, conversationId: 1, type: "answer", status: "done", entry: 4, answer: 5, reason: "r", requestId: "q" },
					{ id: 2, conversationId: 1 },
					{ type: "no id" },
				],
			}),
		);
		assert.deepEqual(lens.submissions[0], { id: 1, conversationId: 1, type: "answer", status: "done", entry: 4, answer: 5, reason: "r", requestId: "q" });
		assert.deepEqual([lens.submissions.length, lens.submissions[1]?.type, lens.submissions[1]?.status], [2, "?", "?"]);
	});

	it("describes the source, with the display path and decoder when given", () => {
		const lens = buildLens(rawStore({ path: "/real/path", nextSeq: 12, jsonlFormat: 1, schemaVersion: 2, prefix: "x_", attempts: 3 }), {
			displayPath: "shown",
			decoder: "my.mjs",
			readMs: 17,
		});
		assert.deepEqual(
			[
				lens.source.path,
				lens.source.decoder,
				lens.source.readMs,
				lens.source.attempts,
				lens.format.nextSeq,
				lens.format.schemaVersion,
				lens.format.prefix,
				lens.format.jsonlFormat,
			],
			["shown", "my.mjs", 17, 3, 12, 2, "x_", 1],
		);
		assert.equal(buildLens(rawStore({ path: "/real/path" })).source.path, "/real/path");
	});
});
