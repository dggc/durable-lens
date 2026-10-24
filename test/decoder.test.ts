// A store whose adapter encrypts every payload reads like the plaintext one through a decoder module.
import assert from "node:assert/strict";
import { createCipheriv, randomBytes } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { loadDecoder, openLens } from "../src/open.ts";
import { copyFixture, ROOT } from "./support.ts";

const key = randomBytes(32);

function seal(text: string): string {
	const iv = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", key, iv);
	const body = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
	return JSON.stringify({ enc: Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64") });
}

/** Encrypt every record and revision of a private copy, as an encrypting SqliteDatabase adapter would store them. */
function encrypt(path: string): void {
	const db = new DatabaseSync(path);
	for (const table of ["conversations", "entries", "tasks", "submissions", "documents"]) {
		for (const row of db.prepare(`SELECT id, record FROM ${table}`).all() as { id: number; record: string }[]) {
			db.prepare(`UPDATE ${table} SET record = ? WHERE id = ?`).run(seal(row.record), row.id);
		}
	}
	for (const row of db.prepare("SELECT document_id, seq, content FROM document_revisions").all() as { document_id: number; seq: number; content: string }[]) {
		db.prepare("UPDATE document_revisions SET content = ? WHERE document_id = ? AND seq = ?").run(seal(row.content), row.document_id, row.seq);
	}
	db.close();
}

describe("decoder hook", () => {
	it("decodes an encrypted SQLite store and warns without a decoder", async () => {
		const plain = copyFixture("1.4.0", "sqlite");
		const sealed = copyFixture("1.4.0", "sqlite");
		try {
			encrypt(sealed.store);
			const blind = await openLens(sealed.store);
			assert.ok(
				blind.warnings.some((warning) => warning.includes("--decoder")),
				blind.warnings.join("\n"),
			);
			assert.equal(blind.entries.length, 0);

			process.env.DURABLE_LENS_KEY = key.toString("base64");
			const decode = await loadDecoder(join(ROOT, "examples", "decoder-aes-gcm.mjs"));
			const decoded = await openLens(sealed.store, { decode, decoderName: "decoder-aes-gcm.mjs" });
			const expected = await openLens(plain.store);
			assert.deepEqual(decoded.warnings, []);
			assert.equal(decoded.source.decoder, "decoder-aes-gcm.mjs");
			assert.deepEqual(decoded.entries, expected.entries);
			assert.deepEqual(decoded.tasks, expected.tasks);
			assert.deepEqual(decoded.documents, expected.documents);
			assert.deepEqual(decoded.usage, expected.usage);
		} finally {
			delete process.env.DURABLE_LENS_KEY;
			plain.dispose();
			sealed.dispose();
		}
	});

	it("passes every payload with its site", async () => {
		const sites = new Set<string>();
		await openLens(join(ROOT, "fixtures", "stores", "1.2.0", "jsonl", "session"), {
			decode: (value, site) => {
				sites.add(`${site.store}:${site.table}.${site.column}`);
				return value;
			},
		});
		assert.deepEqual([...sites].sort(), [
			"jsonl:conversation.value",
			"jsonl:document.content",
			"jsonl:document.record",
			"jsonl:entry.value",
			"jsonl:submission.value",
			"jsonl:task.value",
		]);
	});
});
