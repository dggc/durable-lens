# Decoders

pi-durable's storage adapters can encrypt or compress what they write. durable-lens reads the files as they are, so it sees only the encrypted form, and it cannot guess your scheme. A decoder is a small module of yours that turns each stored payload back into the JSON that pi-durable wrote.

A store that needs a decoder looks like this without one: the page is empty, and the warnings say `N records have no id: the adapter may encrypt or compress payloads at rest; pass --decoder with a module that decodes them`. A JSONL store fails to load with a message that ends `pass --decoder if the store is encrypted`.

## The hook

```js
// my-decoder.mjs
export default function decode(value, site) {
  // site = { store: "sqlite" | "jsonl", table, column }
  return isMyEnvelope(value) ? JSON.parse(decrypt(value)) : value;
}
```

Run it with `--decoder`:

```sh
DURABLE_LENS_KEY=... node dist/cli.js ./app.sqlite --decoder ./my-decoder.mjs
```

The module's default export is the function. A named export `decode` also works, if there is no default function. Anything else is an error: `<path> exports no decode function (default export or "decode")`.

`decode(value, site)` may return a value or a promise of one. It must return the JSON that pi-durable would have stored. If a payload is stored in the clear, return it unchanged, as in the example. The result must be an object with an `id` for records, or the shape pi-durable uses for a document revision.

## What value and site are

`value` is the payload after `JSON.parse`. So the column or field must still hold valid JSON text. The AES example stores `{"enc": "<base64>"}`, which keeps SQLite's `json_valid()` checks passing. An adapter that stores raw bytes is not supported, because the read fails when it parses the column, before your function is called.

`site` says where the payload is.

SQLite: `store` is `"sqlite"`, `table` is the table name without the prefix, and `column` is the column.

| `table` | `column` | Payload |
|---|---|---|
| `conversations`, `entries`, `tasks`, `submissions`, `documents` | `record` | The record of one row. |
| `document_revisions` | `content` | One document revision: a base value, or a list of delta ops. |

JSONL: `store` is `"jsonl"`. `table` is the kind of write, and `column` the field.

| `table` | `column` | Payload |
|---|---|---|
| `conversation`, `entry`, `submission`, `task` | `value` | A record in a commit marker, or in a task sidecar. |
| `document` | `record` | The record of a created document. |
| `document` | `content` | A revision in a document sidecar. |

The tests check these sites. Do not rely on any other.

## Example: AES-256-GCM

[examples/decoder-aes-gcm.mjs](../examples/decoder-aes-gcm.mjs) decodes an adapter that stores each payload as `{"enc": "<base64 of 12-byte IV | 16-byte GCM tag | ciphertext>"}`, encrypted with AES-256-GCM. It reads the key from the environment:

```sh
DURABLE_LENS_KEY=<base64 of the 32-byte key> node dist/cli.js app.sqlite --decoder ./examples/decoder-aes-gcm.mjs
```

It throws at load if the key is not 32 bytes: `set DURABLE_LENS_KEY to the base64 of the 32-byte key`. `test/decoder.test.ts` encrypts a copy of a fixture the same way and checks that the decoded result equals the plain one. Adapt the envelope and the cipher to yours.

## Behavior and errors

- **Keys.** durable-lens never handles keys. The module reads them from wherever you keep them. Do not put a key on the command line, where other users of the machine can see it.
- **Trust.** The module is loaded with `import()` into the durable-lens process and runs with your permissions. It is not sandboxed. Use only a decoder you wrote or reviewed. See the [security model](security-model.md).
- **Loaded once.** The module is imported when the command starts, and reused for every reread. After you edit it, restart durable-lens.
- **Concurrency.** For SQLite, the decoder is called for many rows at the same time when it returns promises. For JSONL it is called one payload at a time. Write it so that either is safe.
- **A decoder that throws,** or returns a rejected promise, makes the read fail. At start, the command prints `durable-lens: <message>` and exits with 1. While the page is open, the page keeps the last good read and shows a "last reread failed" badge, whose tooltip has the message.
- **A decoder that never settles** hangs the read. If nothing else keeps the process alive, durable-lens prints `durable-lens: the read never finished; does the decoder return a promise that never settles?` and exits with 1. If something does, it waits forever; press Ctrl-C.
- **A decoder that returns the wrong shape.** For SQLite, records without an `id` are left out and counted in the warning above. For JSONL, a record without an `id` is an error that names the file, and the line for a record in `main.jsonl`: `main.jsonl line N: a task without an id; pass --decoder if the store is encrypted`, or `task-N.jsonl: a task without an id; ...` for a sidecar.
- **Output.** The page shows a `decoded` badge when a decoder is in use. `--json` includes its name in `source.decoder`.
- **Library.** `loadDecoder(path)` loads a module the same way, and `openLens(path, { decode })` accepts the function. See [library.md](library.md).
