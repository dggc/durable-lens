// The package's public surface: what `import "durable-lens"` exposes, at run time and in types.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
	BuildOptions,
	Decode,
	DecodeSite,
	FileInfo,
	Json,
	JsonObject,
	Lens,
	LensConversation,
	LensDocument,
	LensEntry,
	LensSubmission,
	LensTask,
	LensUsage,
	OpenOptions,
	RawDocument,
	RawRevision,
	RawStore,
	ReadOptions,
	Running,
	ServeOptions,
	Snapshot,
} from "../src/index.ts";
import * as api from "../src/index.ts";

describe("public API", () => {
	it("exports exactly these values", () => {
		assert.deepEqual(Object.keys(api).sort(), [
			"DEFAULT_RESTART_LIMIT",
			"OpError",
			"applyOps",
			"buildLens",
			"disposeScratch",
			"loadDecoder",
			"openLens",
			"readJsonl",
			"readSqlite",
			"readStore",
			"serve",
			"snapshotSqlite",
		]);
	});

	it("exports every type its signatures mention", () => {
		// Compile-time only: this file fails the typecheck if one of these is not exported.
		type Exported = [
			BuildOptions,
			Decode,
			DecodeSite,
			FileInfo,
			Json,
			JsonObject,
			Lens,
			LensConversation,
			LensDocument,
			LensEntry,
			LensSubmission,
			LensTask,
			LensUsage,
			OpenOptions,
			RawDocument,
			RawRevision,
			RawStore,
			ReadOptions,
			Running,
			ServeOptions,
			Snapshot,
		];
		const none = [] as unknown as Exported;
		assert.equal(none.length, 0);
	});
});
