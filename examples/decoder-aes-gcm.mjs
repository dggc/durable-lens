// Example decoder for an adapter that encrypts every pi-durable payload at rest.
//
// The adapter this matches stores each JSON payload (a record, or a document revision) as
//   {"enc": "<base64 of 12-byte IV | 16-byte GCM tag | ciphertext>"}
// encrypted with AES-256-GCM, which keeps SQLite's json_valid() checks passing. Adapt the envelope and cipher to yours.
//
//   DURABLE_LENS_KEY=<base64 of the 32-byte key> node dist/cli.js app.sqlite --decoder ./examples/decoder-aes-gcm.mjs
//
// durable-lens calls decode(value, site) for each payload, where site is { store, table, column }, and never sees the
// key: this module reads it from your environment.
import { createDecipheriv } from "node:crypto";

const key = Buffer.from(process.env.DURABLE_LENS_KEY ?? "", "base64");
if (key.length !== 32) throw new Error("set DURABLE_LENS_KEY to the base64 of the 32-byte key");

export default function decode(value) {
	const sealed = value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 1 ? value.enc : undefined;
	if (typeof sealed !== "string") return value; // stored in the clear
	const data = Buffer.from(sealed, "base64");
	const decipher = createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
	decipher.setAuthTag(data.subarray(12, 28));
	return JSON.parse(Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString("utf8"));
}
