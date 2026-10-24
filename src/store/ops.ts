// Chord document deltas, as pi-durable stores them: decoded `Op` tuples, never the wire form.
//
//   ["r", value]                          replace the whole value
//   ["s", path, value]                    set a key or index
//   ["d", path]                           delete a key, or splice out an index
//   ["a", path, text]                     append to a string
//   ["t", path, count]                    drop the first `count` characters of a string
//   ["p", path, start, deleteCount, items] splice an array (the path may be the root)
//   ["m", path, permutation]              reorder an array: next[i] = previous[permutation[i]]
//
// Same semantics as `apply()` in @earendil-works/chord/delta; test/ops.test.ts checks them against Chord.

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Segment = string | number;

const RESERVED = new Set(["__proto__", "constructor", "prototype"]);

export class OpError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "OpError";
	}
}

function checkPath(path: unknown): Segment[] {
	if (!Array.isArray(path)) throw new OpError("op path is not an array");
	for (const segment of path) {
		if (typeof segment === "number") {
			if (!Number.isInteger(segment) || segment < 0) throw new OpError(`invalid index ${segment}`);
		} else if (typeof segment !== "string" || RESERVED.has(segment)) {
			throw new OpError(`unsafe path segment ${String(segment)}`);
		}
	}
	return path as Segment[];
}

function resolve(root: Json, path: Segment[]): Json {
	let current: Json = root;
	for (const segment of path) {
		if (current === null || typeof current !== "object") throw new OpError(`path ${JSON.stringify(path)} does not exist`);
		const next: Json | undefined = Array.isArray(current)
			? typeof segment === "number"
				? current[segment]
				: undefined
			: Object.hasOwn(current, segment)
				? current[segment as string]
				: undefined;
		if (next === undefined) throw new OpError(`path ${JSON.stringify(path)} does not exist`);
		current = next;
	}
	return current;
}

const isIndex = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0;

/** Verb, arity and payload of a decoded op, as Chord's `assertValidOp` checks them; paths are checked where used. */
function checkOp(op: unknown): asserts op is unknown[] {
	if (!Array.isArray(op) || op.length === 0) throw new OpError("op is not a tuple");
	const arity: Record<string, number> = { r: 2, s: 3, d: 2, a: 3, t: 3, p: 5, m: 3 };
	const name = String(op[0]);
	if (!Object.hasOwn(arity, name)) throw new OpError(`unknown op ${name}`);
	if (op.length !== arity[name]) throw new OpError(`${name} op with ${op.length} elements`);
	if (name === "a" && typeof op[2] !== "string") throw new OpError("append of a non-string");
	if (name === "t" && !isIndex(op[2])) throw new OpError("trim count is not a non-negative integer");
	if (name === "p" && (!isIndex(op[2]) || !isIndex(op[3]) || !Array.isArray(op[4]))) throw new OpError("invalid splice");
	if (name === "m") {
		const permutation = op[2];
		if (!Array.isArray(permutation)) throw new OpError("permutation is not an array");
		const seen = new Uint8Array(permutation.length);
		for (const index of permutation) {
			if (!isIndex(index) || index >= permutation.length || seen[index] !== 0) throw new OpError("permutation is not a bijection");
			seen[index] = 1;
		}
	}
}

/** Apply one batch of ops to `target` in place, returning the new root (an `r` op replaces it). */
export function applyOps(target: Json, ops: unknown): Json {
	if (!Array.isArray(ops)) throw new OpError("ops are not an array");
	let root = target;
	for (const op of ops) {
		checkOp(op);
		const name = op[0];
		if (name === "r") {
			root = structuredClone(op[1] as Json);
			continue;
		}
		const path = checkPath(op[1]);
		if (name === "p" || name === "m") {
			const array = path.length === 0 ? root : resolve(root, path);
			if (!Array.isArray(array)) throw new OpError(`path ${JSON.stringify(path)} is not an array`);
			if (name === "p") {
				const [, , start, deleteCount, items] = op as [string, Segment[], number, number, Json[]];
				array.splice(start, deleteCount);
				// In chunks, as Chord does: spreading a huge array into one call overflows the stack.
				const copy = structuredClone(items);
				for (let offset = 0; offset < copy.length; offset += 10_000) array.splice(start + offset, 0, ...copy.slice(offset, offset + 10_000));
			} else {
				const permutation = op[2] as number[];
				if (permutation.length !== array.length) throw new OpError("permutation does not match the array");
				const previous = array.slice();
				permutation.forEach((from, index) => {
					array[index] = previous[from] as Json;
				});
			}
			continue;
		}
		if (path.length === 0) throw new OpError(`op ${name} cannot target the root`);
		const parent = resolve(root, path.slice(0, -1));
		const key = path[path.length - 1] as Segment;
		if (parent === null || typeof parent !== "object") throw new OpError(`parent of ${JSON.stringify(path)} is not a container`);
		const read = (): Json | undefined =>
			Array.isArray(parent) ? (typeof key === "number" ? parent[key] : undefined) : Object.hasOwn(parent, key) ? parent[key as string] : undefined;
		const write = (value: Json): void => {
			if (Array.isArray(parent)) {
				if (typeof key !== "number" || key > parent.length) throw new OpError(`index ${String(key)} out of range`);
				parent[key] = value;
			} else {
				Object.defineProperty(parent, key, { value, writable: true, enumerable: true, configurable: true });
			}
		};
		switch (name) {
			case "s":
				write(structuredClone(op[2] as Json));
				break;
			case "d":
				if (Array.isArray(parent)) {
					if (typeof key !== "number" || key >= parent.length) throw new OpError(`index ${String(key)} out of range`);
					parent.splice(key, 1);
				} else {
					delete parent[key as string];
				}
				break;
			case "a": {
				const current = read();
				if (typeof current !== "string") throw new OpError("append to a non-string");
				write(current + (op[2] as string));
				break;
			}
			case "t": {
				const current = read();
				if (typeof current !== "string") throw new OpError("trim of a non-string");
				write(current.slice(op[2] as number));
				break;
			}
			default:
				throw new OpError(`unknown op ${name}`);
		}
	}
	return root;
}
