// durable-lens never writes to a store: every file hashes the same before and after a read, also while a pi-durable
// process owns the store, and reads stay consistent while the owner keeps committing.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { openLens } from "../src/open.ts";
import { copyFixture, fixture, generatorInstalled, hashTree, STORES, startOwner, VARIANTS, VERSIONS, type Version } from "./support.ts";

describe("zero writes to committed fixtures", () => {
	for (const version of VERSIONS) {
		for (const variant of VARIANTS) {
			it(`${version} ${variant}`, async () => {
				const directory = join(STORES, version, variant);
				const before = hashTree(directory);
				for (let i = 0; i < 3; i++) await openLens(fixture(version, variant));
				assert.deepEqual(hashTree(directory), before, "same files, same bytes");
			});
		}
	}
});

const owners: Version[] = ["1.2.0", "1.4.0", "main"];

describe("zero writes while a pi-durable process owns the store", () => {
	for (const version of owners) {
		for (const kind of ["sqlite", "jsonl"] as const) {
			it(`${version} ${kind}: owner open and idle`, { skip: !generatorInstalled(version) && `run npm ci in fixtures/generate/v${version}` }, async () => {
				const copy = copyFixture(version, kind);
				const owner = await startOwner(version, "hold", kind, copy.store);
				try {
					if (kind === "sqlite") {
						assert.ok(existsSync(`${copy.store}-wal`) && existsSync(`${copy.store}-shm`), "the owner has the WAL and its index open");
					}
					const before = hashTree(copy.directory);
					for (let i = 0; i < 5; i++) {
						const lens = await openLens(copy.store);
						assert.equal(lens.entries.length, 27);
					}
					assert.deepEqual(hashTree(copy.directory), before, "database, -wal and -shm (or JSONL files) unchanged");
				} finally {
					await owner.stop();
					copy.dispose();
				}
			});
		}
	}
});

describe("consistent reads while the owner commits", () => {
	for (const version of ["1.2.0", "1.4.0"] as const) {
		for (const kind of ["sqlite", "jsonl"] as const) {
			it(`${version} ${kind}: every read succeeds and only moves forward`, {
				skip: !generatorInstalled(version) && `run npm ci in fixtures/generate/v${version}`,
			}, async () => {
				const copy = copyFixture(version, kind);
				const owner = await startOwner(version, "churn", kind, copy.store);
				try {
					let previous = 0;
					let advanced = 0;
					for (let i = 0; i < 25; i++) {
						const lens = await openLens(copy.store);
						const seq = lens.format.nextSeq ?? 0;
						assert.ok(seq >= previous, `commit sequence went back from ${previous} to ${seq}`);
						if (seq > previous) advanced++;
						previous = seq;
						const settings = lens.documents.find((document) => document.kind === "app.settings");
						assert.ok(settings !== undefined && settings.error === undefined, "the churned document materializes");
						assert.deepEqual(
							lens.warnings.filter((warning) => !warning.includes("incomplete last line")),
							[],
						);
						await delay(15);
					}
					assert.ok(advanced > 5, `reads saw the owner's commits (${advanced} advances)`);
				} finally {
					await owner.stop();
					copy.dispose();
				}
			});
		}
	}
});
