// The Chord op applier by hand: what each verb does, and every way an op can be refused. (ops.test.ts replays random
// edits against Chord itself when its generator is installed; these need nothing installed.)
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyOps, type Json, OpError } from "../src/store/ops.ts";

const apply = (target: Json, ...ops: unknown[]): Json => applyOps(structuredClone(target), ops);
const refuses = (target: Json, op: unknown, message: RegExp) =>
	assert.throws(
		() => applyOps(structuredClone(target), [op]),
		(error) => error instanceof OpError && message.test(error.message),
		JSON.stringify(op),
	);

describe("verbs", () => {
	it("r replaces the whole value, copying it", () => {
		const replacement = { fresh: [1] };
		const result = apply({ old: true }, ["r", replacement]) as { fresh: number[] };
		assert.deepEqual(result, replacement);
		assert.notEqual(result, replacement);
		assert.equal(apply([1], ["r", null]), null);
	});

	it("s sets a key or an array index, and may append at the end of an array", () => {
		assert.deepEqual(apply({ a: { b: 1 } }, ["s", ["a", "c"], 2], ["s", ["a", "b"], 3]), { a: { b: 3, c: 2 } });
		assert.deepEqual(apply({ list: [1, 2] }, ["s", ["list", 0], 9], ["s", ["list", 2], 3]), { list: [9, 2, 3] });
	});

	it("d deletes a key or splices out an index", () => {
		assert.deepEqual(apply({ a: 1, b: 2 }, ["d", ["a"]]), { b: 2 });
		assert.deepEqual(apply({ list: [1, 2, 3] }, ["d", ["list", 1]]), { list: [1, 3] });
		assert.deepEqual(apply({ a: 1 }, ["d", ["missing"]]), { a: 1 }, "deleting an absent key is not an error");
	});

	it("a appends to a string and t trims its start", () => {
		assert.deepEqual(apply({ s: "ab" }, ["a", ["s"], "cd"], ["t", ["s"], 1]), { s: "bcd" });
		assert.deepEqual(apply({ s: "ab" }, ["t", ["s"], 10]), { s: "" });
	});

	it("p splices an array at its path or at the root", () => {
		assert.deepEqual(apply({ list: [1, 2, 3, 4] }, ["p", ["list"], 1, 2, ["x"]]), { list: [1, "x", 4] });
		assert.deepEqual(apply([1, 2], ["p", [], 2, 0, [3]]), [1, 2, 3]);
		assert.deepEqual(apply({ list: [] }, ["p", ["list"], 0, 0, [{ n: 1 }]]), { list: [{ n: 1 }] });
	});

	it("m reorders an array so that next[i] = previous[permutation[i]]", () => {
		assert.deepEqual(apply({ list: ["a", "b", "c"] }, ["m", ["list"], [2, 0, 1]]), { list: ["c", "a", "b"] });
		assert.deepEqual(apply(["a", "b"], ["m", [], [1, 0]]), ["b", "a"]);
	});

	it("applies a batch in order, each op seeing the one before", () => {
		assert.deepEqual(apply({}, ["s", ["a"], 1], ["s", ["b"], { c: 2 }], ["s", ["b", "c"], 3], ["d", ["a"]]), { b: { c: 3 } });
	});

	it("copies values it stores, so the op list can be reused", () => {
		const value = { shared: [1] };
		const result = apply({}, ["s", ["k"], value]) as { k: { shared: number[] } };
		result.k.shared.push(2);
		assert.deepEqual(value, { shared: [1] });
	});

	it("keeps __proto__-like content in values as data", () => {
		const hostile = JSON.parse('{"__proto__": {"polluted": true}}');
		const result = apply({}, ["s", ["k"], hostile]) as { k: object };
		assert.equal(({} as Record<string, unknown>).polluted, undefined);
		assert.deepEqual(Object.keys(result.k), ["__proto__"]);
	});
});

describe("refusals", () => {
	it("refuses anything that is not an op tuple", () => {
		for (const ops of ["x", {}, null, 5]) assert.throws(() => applyOps({}, ops), /ops are not an array/);
		for (const op of [null, "s", {}, []]) refuses({}, op, /op is not a tuple/);
	});

	it("refuses an unknown verb or the wrong number of elements", () => {
		refuses({}, ["x", []], /unknown op x/);
		refuses({}, ["constructor", []], /unknown op constructor/);
		refuses({}, ["r"], /r op with 1 elements/);
		refuses({}, ["s", ["a"]], /s op with 2 elements/);
		refuses({}, ["d", ["a"], 1], /d op with 3 elements/);
	});

	it("refuses unsafe or malformed paths", () => {
		for (const segment of ["__proto__", "constructor", "prototype"]) refuses({ a: {} }, ["s", [segment], 1], /unsafe path segment/);
		refuses({}, ["s", [{}], 1], /unsafe path segment/);
		refuses({}, ["s", "a", 1], /path is not an array/);
		refuses({ list: [] }, ["s", ["list", -1], 1], /invalid index -1/);
		refuses({ list: [] }, ["s", ["list", 1.5], 1], /invalid index 1.5/);
	});

	it("refuses paths that do not exist or run through scalars", () => {
		refuses({ a: 1 }, ["s", ["a", "b", "c"], 1], /does not exist/);
		refuses({ a: 1 }, ["s", ["missing", "b"], 1], /does not exist/);
		refuses({ list: [1] }, ["s", ["list", 5, "x"], 1], /does not exist/);
		refuses({ list: [1] }, ["s", ["list", "x", "y"], 1], /does not exist/);
		refuses({ a: 1 }, ["s", ["a", "b"], 1], /parent of .* is not a container|does not exist/);
	});

	it("refuses to set the root, or past the end of an array", () => {
		refuses({}, ["s", [], 1], /cannot target the root/);
		refuses({}, ["a", [], "x"], /cannot target the root/);
		refuses({ list: [1] }, ["s", ["list", 3], 1], /out of range/);
		refuses({ list: [1] }, ["s", ["list", "k"], 1], /out of range/);
		refuses({ list: [1] }, ["d", ["list", 1]], /out of range/);
		refuses({ list: [1] }, ["d", ["list", "k"]], /out of range/);
	});

	it("refuses string ops on non-strings", () => {
		refuses({ n: 1 }, ["a", ["n"], "x"], /append to a non-string/);
		refuses({ n: 1 }, ["t", ["n"], 1], /trim of a non-string/);
		refuses({ s: "" }, ["a", ["s"], 5], /append of a non-string/);
		refuses({ s: "" }, ["t", ["s"], -1], /trim count/);
		refuses({ s: "" }, ["t", ["s"], 1.5], /trim count/);
	});

	it("refuses bad splices and permutations", () => {
		refuses({ a: 1 }, ["p", ["a"], 0, 0, []], /is not an array/);
		refuses({ list: [] }, ["p", ["list"], 0, 0, "x"], /invalid splice/);
		refuses({ list: [] }, ["p", ["list"], 0.5, 0, []], /invalid splice/);
		refuses({ list: [1, 2] }, ["m", ["list"], "x"], /permutation is not an array/);
		refuses({ list: [1, 2] }, ["m", ["list"], [0, 2]], /not a bijection/);
		refuses({ list: [1, 2] }, ["m", ["list"], [0, 0]], /not a bijection/);
		refuses({ list: [1, 2] }, ["m", ["list"], [0]], /permutation does not match/);
		refuses({ a: 1 }, ["m", ["a"], [0]], /is not an array/);
	});
});
