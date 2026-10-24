// durable-lens's op applier against Chord's own: random edits recorded by Chord's tracker, as pi-durable records
// document changes, must replay to the same value.
import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { applyOps, type Json, OpError } from "../src/store/ops.ts";
import { GENERATE, generatorInstalled } from "./support.ts";

type Tracker = {
	value: Json;
	beginChange(): { state: Record<string, unknown>; prepare(): { ops: unknown[]; value: Json } };
	adopt(prepared: unknown): void;
};

/** Deterministic PRNG, so a failure reproduces. */
function random(seed: number) {
	let state = seed;
	return () => {
		state = (state * 1103515245 + 12345) % 2 ** 31;
		return state / 2 ** 31;
	};
}

function mutate(draft: Record<string, unknown>, next: () => number): void {
	const pick = <T>(items: T[]) => items[Math.floor(next() * items.length)] as T;
	const list = draft.list as unknown[];
	const text = () => pick(["a", "bc", "#412", "ünï", "🙂", ""]);
	switch (Math.floor(next() * 9)) {
		case 0:
			list.push(text());
			break;
		case 1:
			if (list.length > 0) list.splice(Math.floor(next() * list.length), 1);
			break;
		case 2:
			list.splice(Math.floor(next() * (list.length + 1)), 0, { n: Math.floor(next() * 100) }, text());
			break;
		case 3:
			draft.note = `${draft.note as string}${text()}`;
			break;
		case 4:
			draft.note = (draft.note as string).slice(Math.min(2, (draft.note as string).length));
			break;
		case 5:
			(draft.map as Record<string, unknown>)[pick(["x", "y", "z"])] = { deep: [next() > 0.5, null, text()] };
			break;
		case 6:
			delete (draft.map as Record<string, unknown>)[pick(["x", "y", "z"])];
			break;
		case 7:
			list.reverse();
			break;
		default:
			draft.count = (draft.count as number) + 1;
	}
}

describe("Chord ops", () => {
	it("replays tracker changes to the same value as Chord", { skip: !generatorInstalled("1.4.0") && "run npm ci in fixtures/generate/v1.4.0" }, async () => {
		const delta = (await import(pathToFileURL(join(GENERATE, "v1.4.0", "node_modules", "@earendil-works", "chord", "dist", "delta", "index.js")).href)) as {
			track(initial: object): Tracker;
			apply(target: unknown, ops: unknown[]): Json;
		};
		const seen = new Set<string>();
		for (let seed = 1; seed <= 40; seed++) {
			const next = random(seed);
			const initial = { list: ["start"], note: "hello", map: {}, count: 0 };
			const tracker = delta.track(structuredClone(initial));
			let ours: Json = structuredClone(initial);
			for (let step = 0; step < 30; step++) {
				const change = tracker.beginChange();
				for (let k = 0, n = 1 + Math.floor(next() * 3); k < n; k++) mutate(change.state, next);
				const prepared = change.prepare();
				for (const op of prepared.ops as unknown[][]) seen.add(String(op[0]));
				ours = applyOps(ours, structuredClone(prepared.ops));
				tracker.adopt(prepared);
				assert.deepEqual(ours, tracker.value, `seed ${seed} step ${step}`);
			}
		}
		for (const name of ["s", "d", "a", "t", "p"]) assert.ok(seen.has(name), `the random edits produced ${name} ops`);
	});

	it("applies each op kind", () => {
		let value: Json = { a: [1, 2, 3], s: "hello" };
		value = applyOps(value, [
			["s", ["b"], { c: true }],
			["a", ["s"], " world"],
			["t", ["s"], 1],
			["p", ["a"], 1, 1, ["x", "y"]],
			["m", ["a"], [3, 2, 1, 0]],
			["d", ["b", "c"]],
		]);
		assert.deepEqual(value, { a: [3, "y", "x", 1], s: "ello world", b: {} });
		assert.deepEqual(applyOps(value, [["r", { replaced: 1 }]]), { replaced: 1 });
		assert.deepEqual(applyOps([1, 2], [["p", [], 0, 0, [0]]]), [0, 1, 2]);
	});

	it("refuses unsafe paths and unknown ops", () => {
		assert.throws(() => applyOps({}, [["s", ["__proto__", "polluted"], 1]]), OpError);
		assert.throws(() => applyOps({}, [["s", ["constructor"], 1]]), OpError);
		assert.throws(() => applyOps({}, [["x", ["a"]]]), OpError);
		assert.throws(() => applyOps({}, [["s", [], 1]]), OpError);
		assert.throws(() => applyOps({ a: "text" }, [["a", ["a"], 5]]), OpError);
		assert.equal(({} as Record<string, unknown>).polluted, undefined);
	});
});
