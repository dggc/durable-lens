// Every view of the page, built in Node against a fake DOM from each committed fixture. This is not a browser test (npm
// run check:ui is that); it checks that no route throws on real stores, that nothing but inert elements comes out of
// store content, and that the facts the views exist to show are on the page.
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { openLens } from "../src/open.ts";
import { documentsView } from "../src/web/documents.ts";
import { jsonTree } from "../src/web/json.ts";
import type { Lens } from "../src/web/lens.ts";
import { buildIndex, type Context, type Route, routeHash } from "../src/web/state.ts";
import { statusText, tasksView, taskTone } from "../src/web/tasks.ts";
import { timelineView } from "../src/web/timeline.ts";
import { usageView } from "../src/web/usage.ts";
import { asFake, findAll, installFakeDocument, tagsIn, walk } from "./fake-dom.ts";
import { fixture, VARIANTS, VERSIONS } from "./support.ts";

const VIEWS = { timeline: timelineView, tasks: tasksView, documents: documentsView, usage: usageView };

const ALLOWED_TAGS = new Set([
	"a",
	"article",
	"aside",
	"b",
	"blockquote",
	"button",
	"code",
	"details",
	"div",
	"em",
	"h2",
	"h3",
	"h4",
	"header",
	"input",
	"li",
	"main",
	"nav",
	"ol",
	"p",
	"pre",
	"section",
	"span",
	"strong",
	"summary",
	"table",
	"tbody",
	"td",
	"th",
	"thead",
	"tr",
	"ul",
]);

function context(lens: Lens, route: Route): Context {
	const link = (patch: Partial<Route>) => routeHash({ ...route, ...patch });
	return { lens, index: buildIndex(lens), route, link, go: () => {} };
}

/** The routes the browser check visits: each conversation, each fork's comparison, tasks, documents and usage. */
function routesOf(lens: Lens): Route[] {
	return [
		...lens.conversations.map((conversation): Route => ({ view: "timeline", conversation: conversation.id })),
		...lens.conversations
			.filter((conversation) => conversation.parent)
			.map((conversation): Route => ({ view: "timeline", conversation: conversation.id, compare: true })),
		...lens.entries.slice(0, 5).map((entry): Route => ({ view: "timeline", conversation: entry.conversationId, entry: entry.id })),
		{ view: "tasks", conversation: 1 },
		{ view: "tasks", conversation: 1, builtins: true },
		...lens.tasks.map((task): Route => ({ view: "tasks", conversation: 1, task: task.id, builtins: true })),
		{ view: "documents", conversation: 1 },
		...lens.documents.map((document): Route => ({ view: "documents", conversation: 1, document: document.id })),
		{ view: "usage", conversation: 1 },
		{ view: "timeline", conversation: 999 },
		{ view: "tasks", conversation: 1, task: 999 },
		{ view: "documents", conversation: 1, document: 999 },
	];
}

describe("views over the fixtures", () => {
	before(() => {
		installFakeDocument();
	});

	for (const version of VERSIONS) {
		for (const variant of VARIANTS) {
			it(`${version} ${variant}: every route renders inert elements only`, async () => {
				const lens = await openLens(fixture(version, variant));
				for (const route of routesOf(lens)) {
					const root = asFake(VIEWS[route.view](context(lens, route)));
					const where = routeHash(route);
					for (const tag of tagsIn(root)) assert.ok(ALLOWED_TAGS.has(tag), `${where}: unexpected <${tag}>`);
					walk(root, (node) => {
						for (const [name, value] of Object.entries(node.attributes)) {
							assert.ok(!name.startsWith("on"), `${where}: ${name} attribute`);
							assert.ok(!["src", "srcdoc", "style", "formaction"].includes(name), `${where}: ${name} attribute`);
							if (name === "href") assert.match(value, /^#/, `${where}: link leaves the page`);
						}
					});
					assert.ok(root.textContent.length > 0, `${where}: empty`);
				}
			});
		}
	}
});

describe("what the views show", () => {
	before(() => {
		installFakeDocument();
	});

	it("lists every task of a crashed 1.4.0 store, with the parked one marked", async () => {
		const lens = await openLens(fixture("1.4.0", "sqlite-crashed"), { restartLimit: 1 });
		const text = asFake(tasksView(context(lens, { view: "tasks", conversation: 1, builtins: true }))).textContent;
		assert.match(text, /parked|crashed \d+ times in a row/);
		for (const task of lens.tasks) assert.ok(text.includes(`#${task.id}`), `task #${task.id}`);
	});

	it("shows spend in the usage view and a row per conversation", async () => {
		const lens = await openLens(fixture("1.4.0", "sqlite"));
		const root = asFake(usageView(context(lens, { view: "usage", conversation: 1 })));
		const text = root.textContent;
		assert.match(text, /By model/);
		assert.match(text, /By conversation/);
		for (const conversation of lens.conversations) assert.ok(text.includes(`#${conversation.id} ${conversation.label}`));
		assert.equal(findAll(root, (node) => node.tag === "tr" && node.parent?.tag === "tbody").length >= lens.conversations.length, true);
	});

	it("steps a rewindable document back through its states with the slider", async () => {
		const lens = await openLens(fixture("1.4.0", "sqlite"));
		const document = lens.documents.find((candidate) => (candidate.states?.length ?? 0) > 1);
		assert.ok(document, "the fixture has a rewindable document with history");
		const root = asFake(documentsView(context(lens, { view: "documents", conversation: 1, document: document.id })));
		const [slider] = findAll(root, (node) => node.tag === "input" && node.attributes.type === "range");
		assert.ok(slider);
		const states = document.states ?? [];
		assert.match(root.textContent, new RegExp(`as of commit ${states.at(-1)?.seq} \\(${states.length} of ${states.length}\\)`));
		slider.value = "0";
		slider.dispatch("input");
		assert.match(root.textContent, new RegExp(`as of commit ${states[0]?.seq} \\(1 of ${states.length}\\)`));
	});

	it("tones and names task statuses", () => {
		const base = { id: 1, kind: "k", conversationId: 1, children: [], background: false, abortRequested: false, parked: false };
		assert.equal(taskTone({ ...base, status: "running" }), "accent");
		assert.equal(taskTone({ ...base, status: "waiting" }), "info");
		assert.equal(taskTone({ ...base, status: "sleeping" }), "sleep");
		assert.equal(taskTone({ ...base, status: "pending" }), "warn");
		assert.equal(taskTone({ ...base, status: "terminal", outcome: { status: "completed" } }), "ok");
		assert.equal(taskTone({ ...base, status: "terminal", outcome: { status: "orphaned" } }), "bad");
		assert.equal(taskTone({ ...base, status: "terminal", outcome: { status: "aborted" } }), "muted");
		assert.equal(taskTone({ ...base, status: "?" }), "muted");
		assert.equal(taskTone({ ...base, status: "pending", parked: true }), "bad");
		assert.equal(statusText({ ...base, status: "pending", parked: true }), "parked");
		assert.equal(statusText({ ...base, status: "terminal", outcome: { status: "failed" } }), "failed");
		assert.equal(statusText({ ...base, status: "terminal" }), "terminal");
		assert.equal(statusText({ ...base, status: "sleeping" }), "sleeping");
	});
});

describe("jsonTree", () => {
	before(() => {
		installFakeDocument();
	});

	const text = (value: Parameters<typeof jsonTree>[0], open?: number) => asFake(jsonTree(value, open)).textContent;

	it("shows scalars and empty containers inline", () => {
		assert.equal(text(null), "null");
		assert.equal(text(true), "true");
		assert.equal(text(12.5), "12.5");
		assert.equal(text("a\nb"), '"a\\nb"');
		assert.equal(text([]), "[]");
		assert.equal(text({}), "{}");
		assert.equal(text(undefined), "—");
	});

	it("counts the items of arrays and the keys of objects", () => {
		assert.match(text([1, 2]), /2 items/);
		assert.match(text([1]), /1 item\b/);
		assert.match(text({ a: 1 }), /1 key\b/);
		assert.match(text({ a: 1, b: 2 }), /2 keys/);
	});

	it("opens the first levels and leaves deeper ones closed", () => {
		const root = asFake(jsonTree({ a: { b: { c: 1 } } }, 2));
		const states = findAll(root, (node) => node.tag === "details").map((node) => node.open);
		assert.deepEqual(states, [true, true, false]);
	});

	it("truncates a long string and expands it on request", () => {
		const long = "x".repeat(1000);
		const root = asFake(jsonTree(long));
		assert.ok(root.textContent.length < 600);
		const [more] = findAll(root, (node) => node.tag === "button");
		assert.match(more?.textContent ?? "", /\+602 chars/);
		more?.dispatch("click");
		assert.equal(root.textContent, JSON.stringify(long));
	});

	it("renders keys that collide with JavaScript as ordinary keys", () => {
		const value = JSON.parse('{"__proto__": 1, "constructor": 2}');
		const root = asFake(jsonTree(value));
		assert.match(root.textContent, /"__proto__"/);
		assert.match(root.textContent, /"constructor"/);
	});

	it("keeps markup in strings as text", () => {
		const root = asFake(jsonTree({ html: "<img src=x onerror=alert(1)>" }));
		assert.equal(tagsIn(root).has("img"), false);
		assert.ok(root.textContent.includes("<img src=x onerror=alert(1)>"));
	});
});
