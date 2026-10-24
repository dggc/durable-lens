// Property-based tests (fast-check) over the code that handles untrusted store content: the Markdown renderer, the op
// applier, the JSONL reader and the model. A crafted store must not throw, hang, write, or reach the page as markup.
//
// FUZZ_RUNS overrides the number of runs of every property; FUZZ_SEED fixes the seed (otherwise it is random, and
// fast-check prints it with the counterexample when a property fails).
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, describe, it } from "node:test";
import fc from "fast-check";
import { buildLens } from "../src/model.ts";
import { readJsonl } from "../src/store/jsonl.ts";
import { applyOps, type Json, OpError } from "../src/store/ops.ts";
import type { JsonObject, RawDocument, RawStore } from "../src/store/types.ts";
import { markdown } from "../src/web/markdown.ts";
import { type FakeNode, installFakeDocument, walk } from "./fake-dom.ts";
import { hashTree, rawStore, STORES, VERSIONS } from "./support.ts";

function positive(name: string): number | undefined {
	const value = process.env[name];
	if (value === undefined || value === "") return undefined;
	const number = Number(value);
	if (!Number.isInteger(number) || number < 1) throw new Error(`${name} must be a positive integer, got ${value}`);
	return number;
}

/** Arbitrary JSON, typed as the reader's own Json. */
const jsonValue = (constraints?: fc.JsonSharedConstraints): fc.Arbitrary<Json> => fc.jsonValue(constraints) as fc.Arbitrary<Json>;
const RUNS = positive("FUZZ_RUNS");
const SEED = process.env.FUZZ_SEED === undefined || process.env.FUZZ_SEED === "" ? undefined : Number(process.env.FUZZ_SEED);
if (SEED !== undefined && !Number.isInteger(SEED)) throw new Error(`FUZZ_SEED must be an integer, got ${process.env.FUZZ_SEED}`);

/** Parameters of one property: its default number of runs unless FUZZ_RUNS says otherwise, and the seed if one is fixed. */
const params = (runs: number): fc.Parameters<unknown> => ({ numRuns: RUNS ?? runs, ...(SEED === undefined ? {} : { seed: SEED }) });

// ---------------------------------------------------------------------------------------------------------------
// Markdown

// Everything markdown() may create, and the attributes it may set. Anything else is an escape from "text only".
const ELEMENTS = new Set([
	"#text",
	"div",
	"p",
	"pre",
	"code",
	"strong",
	"em",
	"span",
	"table",
	"thead",
	"tbody",
	"tr",
	"th",
	"td",
	"ul",
	"ol",
	"li",
	"blockquote",
]);
const ATTRIBUTES = new Set(["class", "title", "data-lang"]);

const METACHARACTERS = [
	"`",
	"``",
	"```",
	"~~~",
	"*",
	"**",
	"_",
	"[",
	"]",
	"(",
	")",
	"|",
	"#",
	"> ",
	"-",
	"---",
	":",
	"<",
	"&",
	"\n",
	"\r\n",
	" ",
	"\t",
	"1. ",
	"- ",
];
const FRAGMENTS = [
	"javascript:alert(1)",
	"<script>x</script>",
	"<img src=x onerror=alert(1)>",
	"[a](javascript:x)",
	"![i](http://x/y.png)",
	"word",
	"é",
	"日本",
	"🙂",
	"a|b",
	"\n| a | b |\n|---|:---:|\n| 1 | `2` |\n",
	"```js\ncode\n```\n",
	"~~~\nx\n~~~",
	"> quote\n",
	"# head\n",
	"1. one\n2) two\n",
	"**bold** *it* `code` [l](t)",
];

/** Mostly markdown metacharacters in runs, with some words, and sometimes a long run of one of them. */
const markupSource = fc
	.array(
		fc.oneof(
			{ weight: 6, arbitrary: fc.constantFrom(...METACHARACTERS) },
			{ weight: 2, arbitrary: fc.constantFrom(...FRAGMENTS) },
			{ weight: 1, arbitrary: fc.tuple(fc.constantFrom(...METACHARACTERS), fc.integer({ min: 2, max: 400 })).map(([unit, count]) => unit.repeat(count)) },
			{ weight: 2, arbitrary: fc.string({ unit: "grapheme", maxLength: 8 }) },
		),
		{ maxLength: 40 },
	)
	.map((parts) => parts.join(""));

const anySource = fc.oneof(
	{ weight: 3, arbitrary: markupSource },
	{ weight: 2, arbitrary: fc.string({ unit: "binary", maxLength: 300 }) },
	{ weight: 1, arbitrary: fc.string({ unit: "grapheme", maxLength: 300 }) },
);

/** The letters of a string, counted (digits, spaces and punctuation are what the renderer may legitimately consume). */
function letters(text: string): Map<string, number> {
	const counts = new Map<string, number>();
	for (const character of text) if (/\p{L}/u.test(character)) counts.set(character, (counts.get(character) ?? 0) + 1);
	return counts;
}

describe("fuzz: markdown", () => {
	before(() => {
		installFakeDocument();
	});

	const seen = new Set<string>();

	it("never throws, and creates only its own elements and attributes, none of them a link, a source or a handler", () => {
		fc.assert(
			fc.property(anySource, (source) => {
				const root = markdown(source) as unknown as FakeNode;
				walk(root, (node) => {
					seen.add(node.tag);
					assert.ok(ELEMENTS.has(node.tag), `unexpected element ${node.tag}`);
					for (const [name, value] of Object.entries(node.attributes)) {
						assert.ok(ATTRIBUTES.has(name), `unexpected attribute ${name}`);
						assert.ok(!/^(href|src|srcset|action|formaction|xlink:href|style)$/i.test(name) && !/^on/i.test(name), `forbidden attribute ${name}`);
						assert.ok(!/^\s*javascript:/i.test(value), `attribute ${name} starts with javascript:`);
					}
					assert.equal(Object.keys(node.listeners).length, 0, "the renderer attached a listener");
				});
			}),
			params(10000),
		);
		// Not vacuous: the sources reach the structures, and the structures are all inside the allowlist.
		if ((RUNS ?? Number.POSITIVE_INFINITY) >= 1000) {
			for (const tag of ELEMENTS) assert.ok(seen.has(tag), `no source produced <${tag}>; saw ${[...seen].join(" ")}`);
		}
	});

	it("keeps the text: every letter of the input is in the text nodes, or in the code block's language", () => {
		fc.assert(
			fc.property(anySource, (source) => {
				const root = markdown(source) as unknown as FakeNode;
				let out = "";
				walk(root, (node) => {
					if (node.text !== undefined) out += node.text;
					else if (node.attributes["data-lang"] !== undefined) out += node.attributes["data-lang"];
				});
				const kept = letters(out);
				for (const [character, count] of letters(source)) {
					assert.ok((kept.get(character) ?? 0) >= count, `lost ${JSON.stringify(character)}: ${count} in the input, ${kept.get(character) ?? 0} in the output`);
				}
				// Nothing is invented either: a letter in the output was in the input.
				const known = letters(source);
				for (const character of kept.keys()) assert.ok(known.has(character), `invented ${JSON.stringify(character)}`);
			}),
			params(10000),
		);
	});

	it("renders large hostile input in bounded time", () => {
		const unit = fc.constantFrom(...METACHARACTERS, "a", "ab ", "x\n", "|---", "[a](", "**a", "`a");
		fc.assert(
			fc.property(fc.array(fc.tuple(unit, fc.integer({ min: 1, max: 30_000 })), { minLength: 1, maxLength: 4 }), (runs) => {
				const source = runs.map(([part, count]) => part.repeat(count)).join("");
				const started = performance.now();
				markdown(source);
				const took = performance.now() - started;
				assert.ok(took < 1000, `${source.length} characters took ${Math.round(took)} ms`);
			}),
			params(40),
		);
	});
});

// ---------------------------------------------------------------------------------------------------------------
// applyOps

const KEYS = ["a", "b", "c", "toString", "length", "0", "1"];
const RESERVED = ["__proto__", "constructor", "prototype"];

/** An object with exactly these own properties, whatever the keys (JSON.parse also makes an own "__proto__"). */
function own(entries: [string, Json][]): Json {
	const object: { [key: string]: Json } = {};
	for (const [key, value] of entries) Object.defineProperty(object, key, { value, writable: true, enumerable: true, configurable: true });
	return object;
}

/** A small JSON tree whose keys collide with the paths below, and whose own keys include the reserved names. */
const tree = fc.letrec<{ node: Json }>((tie) => ({
	node: fc.oneof(
		{ depthSize: "small", maxDepth: 3 },
		fc.constantFrom<Json>(null, true, 0, 1, "", "abc", "ünï🙂"),
		fc.string({ maxLength: 6 }),
		fc.array(tie("node"), { maxLength: 3 }),
		fc.array(fc.tuple(fc.constantFrom(...KEYS, ...RESERVED), tie("node")), { maxLength: 3 }).map(own),
	),
})).node;

const index = fc.oneof(fc.nat(4), fc.constantFrom(2 ** 32, 2 ** 53, 1e21));
const safeSegment = fc.oneof({ weight: 3, arbitrary: fc.constantFrom(...KEYS) }, { weight: 3, arbitrary: fc.nat(3) });
const anySegment = fc.oneof(
	{ weight: 4, arbitrary: safeSegment },
	{ weight: 3, arbitrary: fc.constantFrom(...RESERVED) },
	{ weight: 1, arbitrary: index },
	{
		weight: 1,
		arbitrary: fc.oneof(
			fc.integer({ min: -3, max: -1 }),
			fc.double({ noNaN: true, noDefaultInfinity: true }),
			fc.constant(null),
			fc.boolean(),
			jsonValue({ maxDepth: 1 }),
		),
	},
);
const path = fc.oneof({ weight: 5, arbitrary: fc.array(safeSegment, { maxLength: 3 }) }, { weight: 4, arbitrary: fc.array(anySegment, { maxLength: 4 }) });
const permutation = fc.oneof(
	fc.shuffledSubarray([0, 1, 2, 3], { minLength: 0, maxLength: 4 }),
	fc.array(fc.oneof(fc.nat(4), fc.constant(-1), fc.constant(1.5), fc.constant(null)), { maxLength: 4 }),
);

const op: fc.Arbitrary<unknown> = fc.oneof(
	{ weight: 1, arbitrary: tree.map((value) => ["r", value]) },
	{ weight: 4, arbitrary: fc.tuple(fc.constant("s"), path, tree) },
	{ weight: 3, arbitrary: fc.tuple(fc.constant("d"), path) },
	{ weight: 2, arbitrary: fc.tuple(fc.constant("a"), path, fc.oneof(fc.string({ maxLength: 4 }), jsonValue({ maxDepth: 1 }))) },
	{ weight: 2, arbitrary: fc.tuple(fc.constant("t"), path, fc.oneof(fc.nat(4), fc.integer({ min: -2, max: -1 }), fc.constant(0.5))) },
	{ weight: 3, arbitrary: fc.tuple(fc.constant("p"), path, index, index, fc.oneof(fc.array(tree, { maxLength: 3 }), tree)) },
	{ weight: 3, arbitrary: fc.tuple(fc.constant("m"), path, permutation) },
	// Wrong arity, unknown verbs, and plain JSON where a tuple should be.
	{
		weight: 2,
		arbitrary: fc
			.tuple(fc.constantFrom("r", "s", "d", "a", "t", "p", "m", "x", ""), jsonValue({ maxDepth: 1 }))
			.chain(([verb, first]) => fc.array(jsonValue({ maxDepth: 1 }), { maxLength: 5 }).map((rest) => [verb, first, ...rest])),
	},
	{ weight: 1, arbitrary: jsonValue({ maxDepth: 2 }) },
);
const ops = fc.oneof({ weight: 12, arbitrary: fc.array(op, { maxLength: 8 }) }, { weight: 1, arbitrary: jsonValue({ maxDepth: 2 }) });

/** The own properties of a prototype, with what they hold, to compare before and after. */
function snapshot(prototype: object): [string | symbol, PropertyDescriptor][] {
	return Reflect.ownKeys(prototype).map((key) => [key, Object.getOwnPropertyDescriptor(prototype, key) as PropertyDescriptor]);
}

/** Every object reachable from `value` is a plain object or array with own data properties only, and no holes. */
function assertPlain(value: unknown, seen = new Set<unknown>()): void {
	if (value === null || typeof value !== "object" || seen.has(value)) return;
	seen.add(value);
	assert.notEqual(value, Object.prototype);
	assert.notEqual(value, Array.prototype);
	assert.equal(Object.getPrototypeOf(value), Array.isArray(value) ? Array.prototype : Object.prototype, "the prototype of a node changed");
	const keys = Reflect.ownKeys(value);
	assert.ok(
		keys.every((key) => typeof key === "string"),
		"a symbol key",
	);
	for (const key of keys) {
		if (Array.isArray(value) && key === "length") continue;
		const descriptor = Object.getOwnPropertyDescriptor(value, key) as PropertyDescriptor;
		assert.ok("value" in descriptor && descriptor.enumerable === true, `property ${String(key)} is not an own enumerable data property`);
		assertPlain(descriptor.value, seen);
	}
	if (Array.isArray(value)) assert.equal(keys.length, value.length + 1, "an array has holes or extra properties");
}

describe("fuzz: applyOps", () => {
	const results = { applied: 0, refused: 0 };

	it("applies or throws OpError, never modifies the built-in prototypes, and changes the target through own properties only", () => {
		const objectBefore = snapshot(Object.prototype);
		const arrayBefore = snapshot(Array.prototype);
		fc.assert(
			fc.property(tree, ops, (target, batch) => {
				let root: Json = target;
				try {
					root = applyOps(target, batch);
					results.applied++;
				} catch (error) {
					assert.ok(error instanceof OpError, `threw ${error instanceof Error ? error.constructor.name : typeof error}: ${String(error)}`);
					results.refused++;
				}
				assert.deepEqual(snapshot(Object.prototype), objectBefore, "Object.prototype changed");
				assert.deepEqual(snapshot(Array.prototype), arrayBefore, "Array.prototype changed");
				assert.equal(({} as Record<string, unknown>).a, undefined);
				assert.deepEqual(Object.keys({}), []);
				assertPlain(target);
				assertPlain(root);
				// What is left serializes and parses back to itself: no inherited or hidden state.
				assert.deepEqual(JSON.parse(JSON.stringify(root)), root);
			}),
			params(8000),
		);
		// Not vacuous: the generators reach both outcomes.
		if ((RUNS ?? Number.POSITIVE_INFINITY) >= 200) {
			assert.ok(results.applied > 20, `only ${results.applied} batches applied`);
			assert.ok(results.refused > 20, `only ${results.refused} batches refused`);
		}
	});

	it("refuses a reserved name in any path, whatever the verb", () => {
		fc.assert(
			fc.property(
				fc.constantFrom(...RESERVED),
				fc.array(safeSegment, { maxLength: 2 }),
				fc.array(safeSegment, { maxLength: 2 }),
				fc.constantFrom("s", "d", "a", "t", "p", "m"),
				(name, before, after, verb) => {
					const target = { a: { b: [1, 2] } } as Json;
					const at = [...before, name, ...after];
					const rest: Record<string, unknown[]> = { s: [1], d: [], a: ["x"], t: [1], p: [0, 0, []], m: [[0]] };
					assert.throws(() => applyOps(target, [[verb, at, ...(rest[verb] as unknown[])]]), OpError);
					assert.deepEqual(target, { a: { b: [1, 2] } });
					assert.equal(Object.keys(Object.prototype).length, 0);
				},
			),
			params(500),
		);
	});
});

// ---------------------------------------------------------------------------------------------------------------
// readJsonl

/** The committed JSONL fixtures, read once: their directories are copied to a temp dir for every run, never touched. */
const fixtureDirectories = VERSIONS.map((version) => join(STORES, version, "jsonl", "session"));
const fixtureLines = fixtureDirectories.map((directory) =>
	readFileSync(join(directory, "main.jsonl"), "utf8")
		.split("\n")
		.filter((line) => line !== ""),
);

type LineSpec =
	| { k: "fixture"; at: number }
	| { k: "cut"; at: number; length: number }
	| { k: "json"; value: Json }
	| { k: "commit"; seq: Json; format: Json; writes: Json }
	| { k: "bytes"; bytes: Uint8Array };

const write = fc.record(
	{
		type: fc.oneof(
			fc.constantFrom("conversation", "entry", "submission", "task", "task.sidecar", "document.create", "document.change", "document.retire", "future.thing"),
			jsonValue({ maxDepth: 1 }),
		),
		value: fc.oneof(fc.record({ id: fc.nat(5) }), tree, jsonValue({ maxDepth: 1 })),
		record: fc.oneof(
			fc.record({
				id: fc.nat(5),
				scope: fc.record({ kind: fc.constantFrom("conversation", "session"), conversationId: fc.nat(2) }),
				history: fc.constantFrom("latest", "rewindable"),
			}),
			tree,
		),
		id: fc.oneof(fc.nat(5), jsonValue({ maxDepth: 1 })),
		ordinal: fc.oneof(fc.nat(3), jsonValue({ maxDepth: 1 })),
	},
	{ requiredKeys: [] },
);

/** Lines that are valid JSON (objects mostly), so the reader gets past parsing and into the record handling. */
const wellFormedLine: fc.Arbitrary<LineSpec> = fc.oneof(
	{ weight: 6, arbitrary: fc.nat().map((at): LineSpec => ({ k: "fixture", at })) },
	{
		weight: 4,
		arbitrary: fc.record({
			k: fc.constant("commit" as const),
			seq: fc.oneof(fc.integer({ min: 0, max: 40 }), jsonValue({ maxDepth: 1 })),
			format: fc.oneof(fc.constant(1), jsonValue({ maxDepth: 1 })),
			writes: fc.oneof({ weight: 5, arbitrary: fc.array(write, { maxLength: 4 }) as fc.Arbitrary<Json> }, { weight: 1, arbitrary: jsonValue({ maxDepth: 1 }) }),
		}),
	},
	{ weight: 2, arbitrary: jsonValue({ maxDepth: 3 }).map((value): LineSpec => ({ k: "json", value })) },
);

/** Anything at all: torn lines, random bytes and text. A line that is not JSON makes the reader retry, which waits. */
const anyLine: fc.Arbitrary<LineSpec> = fc.oneof(
	{ weight: 4, arbitrary: wellFormedLine },
	{ weight: 2, arbitrary: fc.tuple(fc.nat(), fc.nat()).map(([at, length]): LineSpec => ({ k: "cut", at, length })) },
	{ weight: 1, arbitrary: fc.uint8Array({ maxLength: 120 }).map((bytes): LineSpec => ({ k: "bytes", bytes })) },
	{ weight: 1, arbitrary: fc.string({ unit: "binary", maxLength: 80 }).map((text): LineSpec => ({ k: "bytes", bytes: Buffer.from(text) })) },
);

function render(spec: LineSpec, fixtureIn: string[]): Buffer {
	switch (spec.k) {
		case "fixture":
			return Buffer.from(fixtureIn[spec.at % fixtureIn.length] as string);
		case "cut": {
			const line = Buffer.from(fixtureIn[spec.at % fixtureIn.length] as string);
			return line.subarray(0, spec.length % (line.length + 1));
		}
		case "json":
			return Buffer.from(JSON.stringify(spec.value));
		case "commit":
			return Buffer.from(JSON.stringify({ format: spec.format, type: "commit", seq: spec.seq, writes: spec.writes }));
		case "bytes":
			return Buffer.from(spec.bytes);
	}
}

const sidecar = fc.tuple(fc.constantFrom("doc", "task"), fc.nat(80), fc.array(anyLine, { maxLength: 4 }), fc.boolean());

/** Run readJsonl on a temp copy of a fixture whose main.jsonl (and some sidecars) were replaced. */
async function readFuzzed(version: number, main: LineSpec[], endsWithNewline: boolean, sidecars: [string, number, LineSpec[], boolean][]): Promise<void> {
	const lines = fixtureLines[version] as string[];
	const directory = mkdtempSync(join(tmpdir(), "durable-lens-fuzz-"));
	try {
		cpSync(fixtureDirectories[version] as string, directory, { recursive: true });
		const file = (specs: LineSpec[], newline: boolean) =>
			Buffer.concat([...specs.flatMap((spec, i) => [i === 0 ? Buffer.alloc(0) : Buffer.from("\n"), render(spec, lines)]), Buffer.from(newline ? "\n" : "")]);
		writeFileSync(join(directory, "main.jsonl"), file(main, endsWithNewline));
		for (const [kind, id, specs, newline] of sidecars) writeFileSync(join(directory, `${kind}-${id}.jsonl`), file(specs, newline));
		const before = hashTree(directory);

		const started = performance.now();
		let timer: NodeJS.Timeout | undefined;
		const limit = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error("readJsonl did not finish in 5 s")), 5000);
		});
		let outcome: RawStore | Error;
		try {
			outcome = await Promise.race([readJsonl(directory), limit]).catch((error: unknown) => {
				if (error instanceof Error && error.message === "readJsonl did not finish in 5 s") throw error;
				assert.ok(error instanceof Error, `rejected with ${typeof error}`);
				return error;
			});
		} finally {
			clearTimeout(timer);
		}
		// MAX_ATTEMPTS reads wait 25 + 50 + 75 + 100 + 125 ms between them.
		assert.ok(performance.now() - started < 3000, `took ${Math.round(performance.now() - started)} ms`);
		assert.deepEqual(hashTree(directory), before, "readJsonl changed the directory");
		if (!(outcome instanceof Error)) {
			assert.equal(outcome.kind, "jsonl");
			for (const records of [outcome.conversations, outcome.entries, outcome.tasks, outcome.submissions, outcome.documents, outcome.files, outcome.warnings]) {
				assert.ok(Array.isArray(records));
			}
			// And the model takes what the reader gave it.
			const lens = buildLens(outcome);
			assert.ok(Array.isArray(lens.conversations) && Array.isArray(lens.entries) && Array.isArray(lens.tasks) && Array.isArray(lens.documents));
		}
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

// Concurrent: a read that meets a line that is not JSON waits between its retries, and the other property can run meanwhile.
describe("fuzz: readJsonl", { concurrency: true }, () => {
	it("returns a store or rejects with an Error, in bounded time and without writing, on well-formed lines of any shape", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.nat(VERSIONS.length - 1),
				fc.array(wellFormedLine, { maxLength: 14 }),
				fc.boolean(),
				fc.array(fc.tuple(fc.constantFrom("doc", "task"), fc.nat(80), fc.array(wellFormedLine, { maxLength: 4 }), fc.constant(true)), { maxLength: 3 }),
				readFuzzed,
			),
			params(100),
		);
	});

	it("returns a store or rejects with an Error, in bounded time and without writing, on torn lines and random bytes", async () => {
		await fc.assert(
			fc.asyncProperty(fc.nat(VERSIONS.length - 1), fc.array(anyLine, { maxLength: 14 }), fc.boolean(), fc.array(sidecar, { maxLength: 3 }), readFuzzed),
			params(5),
		);
	});
});

// ---------------------------------------------------------------------------------------------------------------
// buildLens

/** Mostly the right type, sometimes any JSON: the shapes a newer, older or damaged store could hold. */
const maybe = <T extends Json>(right: fc.Arbitrary<T>): fc.Arbitrary<Json> =>
	fc.oneof({ weight: 4, arbitrary: right as fc.Arbitrary<Json> }, { weight: 1, arbitrary: jsonValue({ maxDepth: 2 }) });
const id = maybe(fc.nat(5));
const count = maybe(fc.oneof(fc.nat(1000), fc.double({ noNaN: true, noDefaultInfinity: true })));
const name = maybe(
	fc.oneof(
		fc.constantFrom(...RESERVED, "toString", "pi.tool", "pi.generation", "pi.usage", "pi.agent", "pi.user", "pi.assistant", "pi.tool-result", "m1"),
		fc.string({ maxLength: 6 }),
	),
);
const object = <T extends Record<string, fc.Arbitrary<Json>>>(shape: T) => fc.record(shape, { requiredKeys: [] }) as fc.Arbitrary<JsonObject>;

const usageRecord = object({
	input: count,
	output: count,
	cacheRead: count,
	cacheWrite: count,
	totalTokens: count,
	cost: maybe(fc.oneof(count, object({ total: count }) as fc.Arbitrary<Json>)),
});
const message = maybe(
	object({
		role: maybe(fc.constantFrom("assistant", "user", "toolResult")),
		provider: name,
		model: name,
		stopReason: name,
		errorMessage: name,
		timestamp: count,
		durationMs: count,
		usage: maybe(usageRecord as fc.Arbitrary<Json>),
		content: maybe(
			fc.oneof(
				fc.string(),
				fc.array(maybe(object({ type: maybe(fc.constantFrom("text", "toolCall")), text: name, id: name, name })) as fc.Arbitrary<Json>, { maxLength: 3 }),
			) as fc.Arbitrary<Json>,
		),
	}) as fc.Arbitrary<Json>,
);
const entryRecord = object({
	id,
	conversationId: id,
	kind: name,
	model: maybe(fc.array(message, { maxLength: 3 })),
	data: tree,
	byTaskId: id,
	head: id,
	edits: tree,
});
const rawEntry = fc.record({ record: entryRecord, seq: fc.oneof(fc.nat(9), fc.constant(undefined)) });
const taskRecord = object({
	id,
	kind: name,
	conversationId: id,
	restarts: count,
	abortRequested: maybe(fc.boolean()),
	background: maybe(fc.boolean()),
	version: count,
	owner: id,
	abortReason: name,
	startedAt: count,
	endedAt: count,
	input: maybe(object({ assistant: id, callId: name, name }) as fc.Arbitrary<Json>),
	memos: tree,
	state: maybe(
		object({
			status: maybe(fc.constantFrom("pending", "running", "sleeping", "done")),
			checkpoint: maybe(object({ phase: name }) as fc.Arbitrary<Json>),
			until: count,
			on: maybe(fc.array(id, { maxLength: 3 })),
			policy: name,
			outcome: maybe(object({ status: name, error: tree, reason: name, result: maybe(object({ entryId: id }) as fc.Arbitrary<Json>) }) as fc.Arbitrary<Json>),
		}) as fc.Arbitrary<Json>,
	),
});
const submissionRecord = object({ id, conversationId: id, type: name, status: name, entry: id, answer: id, reason: name, requestId: name });
const conversationRecord = object({
	id,
	parent: maybe(object({ conversationId: id, at: count }) as fc.Arbitrary<Json>),
	owner: maybe(object({ conversationId: id, taskId: id }) as fc.Arbitrary<Json>),
});
const usageValue = maybe(
	object({
		models: maybe(
			fc
				.array(fc.tuple(name as fc.Arbitrary<string>, maybe(usageRecord as fc.Arbitrary<Json>)), { maxLength: 3 })
				.map((entries) => own(entries.map(([key, value]) => [String(key), value]))),
		),
		tools: maybe(fc.array(fc.tuple(fc.constantFrom(...RESERVED, "bash"), usageRecord as fc.Arbitrary<Json>), { maxLength: 3 }).map((entries) => own(entries))),
	}) as fc.Arbitrary<Json>,
);
const revision = fc.oneof(
	fc.record({ seq: fc.nat(9), kind: fc.constant("base" as const), version: fc.nat(9), content: fc.oneof(usageValue, tree) }),
	fc.record({
		seq: fc.nat(9),
		kind: fc.constant("delta" as const),
		version: fc.nat(9),
		content: fc.oneof(ops as fc.Arbitrary<Json>, fc.constant([["s", ["a"], 1]] as Json)),
	}),
);
const documentRecord = object({
	id,
	kind: name,
	key: name,
	createdAt: count,
	retiredAt: count,
	history: maybe(fc.constantFrom("latest", "rewindable")),
	fork: name,
	scope: maybe(object({ kind: maybe(fc.constantFrom("conversation", "session", "task")), conversationId: id, taskId: id }) as fc.Arbitrary<Json>),
});
const rawDocument: fc.Arbitrary<RawDocument> = fc.record({ record: documentRecord, revisions: fc.array(revision, { maxLength: 5 }) });

const rawStores: fc.Arbitrary<RawStore> = fc
	.record(
		{
			kind: fc.constantFrom("sqlite" as const, "jsonl" as const),
			conversations: fc.array(conversationRecord, { maxLength: 4 }),
			entries: fc.array(rawEntry, { maxLength: 6 }),
			tasks: fc.array(taskRecord, { maxLength: 6 }),
			submissions: fc.array(submissionRecord, { maxLength: 3 }),
			documents: fc.array(rawDocument, { maxLength: 4 }),
			schemaVersion: fc.oneof(fc.nat(4), fc.constant(undefined)),
			prefix: fc.oneof(fc.string({ maxLength: 4 }), fc.constant(undefined)),
			warnings: fc.array(fc.string({ maxLength: 10 }), { maxLength: 2 }),
		},
		{ requiredKeys: ["conversations", "entries", "tasks", "submissions", "documents"] },
	)
	.map((parts) => rawStore(parts as Partial<RawStore>));

describe("fuzz: buildLens", () => {
	it("builds a lens from records of the wrong shape: arrays for conversations, entries, tasks and documents, and valid JSON", () => {
		fc.assert(
			fc.property(rawStores, fc.oneof(fc.constant(undefined), fc.integer({ min: -2, max: 8 })), (raw, restartLimit) => {
				const lens = buildLens(raw, restartLimit === undefined ? {} : { restartLimit });
				for (const list of [lens.conversations, lens.entries, lens.tasks, lens.documents, lens.submissions, lens.warnings]) assert.ok(Array.isArray(list));
				assert.ok(lens.conversations.every((conversation) => Number.isFinite(conversation.id)));
				assert.equal(typeof JSON.stringify(lens), "string");
				assert.equal(Object.getPrototypeOf(lens.usage.byModel), Object.prototype);
				assert.equal(Object.keys(Object.prototype).length, 0);
			}),
			params(2000),
		);
	});
});
