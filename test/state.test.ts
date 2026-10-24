// Hash routing and the lookup index the views share.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { openLens } from "../src/open.ts";
import { buildIndex, parseRoute, type Route, routeHash } from "../src/web/state.ts";
import { fixture } from "./support.ts";

describe("parseRoute", () => {
	it("defaults to the root conversation's timeline", () => {
		assert.deepEqual(parseRoute(""), { view: "timeline", conversation: 1 });
		assert.deepEqual(parseRoute("#"), { view: "timeline", conversation: 1 });
	});

	it("reads every field", () => {
		assert.deepEqual(parseRoute("#v=tasks&c=3&t=7&d=2&e=9&cmp=1&all=1"), {
			view: "tasks",
			conversation: 3,
			task: 7,
			document: 2,
			entry: 9,
			compare: true,
			builtins: true,
		});
	});

	it("works with or without the leading hash", () => {
		assert.deepEqual(parseRoute("v=usage&c=2"), parseRoute("#v=usage&c=2"));
	});

	it("falls back to the timeline for an unknown view", () => {
		for (const view of ["", "nope", "TASKS", "constructor", "__proto__"]) assert.equal(parseRoute(`#v=${view}`).view, "timeline", view);
	});

	it("ignores numbers that are not plain non-negative integers", () => {
		for (const value of ["", "-1", "1.5", "1e3", "0x10", "abc", " 1", "1 ", "+2"]) {
			const route = parseRoute(`#c=${encodeURIComponent(value)}&t=${encodeURIComponent(value)}`);
			assert.equal(route.conversation, 1, `c=${JSON.stringify(value)}`);
			assert.equal(route.task, undefined, `t=${JSON.stringify(value)}`);
		}
	});

	it("only switches the flags on for exactly 1", () => {
		assert.equal(parseRoute("#cmp=0&all=true").compare, undefined);
		assert.equal(parseRoute("#cmp=0&all=true").builtins, undefined);
	});

	it("accepts a route that never was a hash this program wrote", () => {
		assert.deepEqual(parseRoute("#%E2%9C%93=1&v=documents&v=tasks"), { view: "documents", conversation: 1 });
	});
});

describe("routeHash", () => {
	it("round trips every route", () => {
		const routes: Route[] = [
			{ view: "timeline", conversation: 1 },
			{ view: "tasks", conversation: 2, task: 5, builtins: true },
			{ view: "documents", conversation: 1, document: 0 },
			{ view: "timeline", conversation: 4, entry: 12, compare: true },
			{ view: "usage", conversation: 9 },
			{ view: "tasks", conversation: 1, task: 3, document: 4, entry: 5, compare: true, builtins: true },
		];
		for (const route of routes) assert.deepEqual(parseRoute(routeHash(route)), route, routeHash(route));
	});

	it("starts with a hash and puts the view and conversation first", () => {
		assert.equal(routeHash({ view: "usage", conversation: 2 }), "#v=usage&c=2");
	});

	it("keeps id 0 and leaves unset and false fields out", () => {
		assert.equal(routeHash({ view: "tasks", conversation: 1, task: 0, compare: false, builtins: false }), "#v=tasks&c=1&t=0");
	});
});

describe("buildIndex", () => {
	it("indexes a real store by id, call, fork point and owner", async () => {
		const lens = await openLens(fixture("1.4.0", "sqlite"));
		const index = buildIndex(lens);
		assert.equal(index.entries.size, lens.entries.length);
		assert.equal(index.tasks.size, lens.tasks.length);
		assert.equal(index.conversations.size, lens.conversations.length);
		assert.equal(index.documents.size, lens.documents.length);
		assert.ok(index.results.size > 0, "tool results are found by conversation and call id");
		for (const [key, entry] of index.results) assert.ok(key.startsWith(`${entry.conversationId}:`));
		assert.ok(index.toolTasks.size > 0, "tool tasks are found by issuing entry and call id");
		for (const fork of lens.conversations.filter((conversation) => conversation.parent)) {
			assert.ok(index.forksAt.get(fork.parent?.at as number)?.includes(fork));
		}
		for (const sub of lens.conversations.filter((conversation) => conversation.owner)) {
			assert.ok(index.ownedBy.get(sub.owner?.taskId as number)?.includes(sub));
		}
	});
});
