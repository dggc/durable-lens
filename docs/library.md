# Library

durable-lens can be used from Node.js code. The package is an ES module, needs Node.js 22.13 or later, and ships its types. It is not on npm yet. From a clone, build it and import `dist/index.js`:

```js
import { openLens } from "/path/to/durable-lens/dist/index.js";
```

Once it is published, `import { openLens } from "durable-lens"` will work. The API may change in any release before 1.0.

The library keeps the guarantees of the command line: it never opens a store for writing. It also exports `serve`, the web server that the command line uses.

## Reading a store

### `openLens(path, options?)`

```ts
function openLens(path: string, options?: OpenOptions): Promise<Lens>

type OpenOptions = ReadOptions & {
  restartLimit?: number;   // default 5, see DEFAULT_RESTART_LIMIT
  decoderName?: string;    // shown as lens.source.decoder
  displayPath?: string;    // lens.source.path; defaults to `path` as given
};
```

Reads the store and returns the [Lens](json-output.md): the same object as `--json`. `path` is a SQLite file or a JSONL directory. It rejects with an `Error` whose message is one of those in [troubleshooting.md](troubleshooting.md).

```js
import { openLens } from "durable-lens";

const lens = await openLens("./session.sqlite", { restartLimit: 3 });
console.log(lens.format.version);                  // "pi-durable 1.4 or later"
console.log(lens.usage.total.cost);                // total cost
const parked = lens.tasks.filter((task) => task.parked);
console.log(parked.map((task) => `${task.id} ${task.kind} restarts=${task.restarts}`));
```

`OpenOptions` is exported as a type.

### `readStore(path, options?)`

```ts
function readStore(path: string, options?: ReadOptions): Promise<RawStore>
```

Reads the records of a store as pi-durable wrote them, without building the Lens. A directory with `main.jsonl` is read as JSONL; a file as SQLite.

```js
const raw = await readStore("./session");
console.log(raw.kind, raw.entries.length, raw.warnings);
```

### `ReadOptions`

```ts
type ReadOptions = {
  decode?: Decode;   // see decoders.md
  prefix?: string;   // SQLite table prefix (pi-durable 1.3.0 and later); detected when there is exactly one
};
```

### `buildLens(raw, options?)`

```ts
function buildLens(raw: RawStore, options?: BuildOptions): Lens

type BuildOptions = {
  restartLimit?: number;   // default 5
  readMs?: number;         // lens.source.readMs
  decoder?: string;        // lens.source.decoder
  displayPath?: string;    // lens.source.path; defaults to raw.path
};
```

Turns raw records into the Lens. It is synchronous and does no I/O. Use it with `readStore`, or with a `RawStore` you made yourself, for instance in a test.

### `DEFAULT_RESTART_LIMIT`

```ts
const DEFAULT_RESTART_LIMIT: 5
```

pi-durable 1.4.0's default `settings.restartLimit`.

## Decoders

### `loadDecoder(path)`

```ts
function loadDecoder(path: string): Promise<Decode>

type Decode = (value: Json, site: DecodeSite) => Json | Promise<Json>;
type DecodeSite = {
  readonly store: "sqlite" | "jsonl";
  readonly table: string;    // SQLite table (unprefixed) or JSONL write type
  readonly column: string;   // SQLite column or JSONL field
};
```

Imports a module and returns its default export, or its `decode` export if the default is not a function. It throws if neither is a function. The module runs in your process. See [decoders.md](decoders.md).

```js
const decode = await loadDecoder("./my-decoder.mjs");
const lens = await openLens("./app.sqlite", { decode, decoderName: "my-decoder.mjs" });
```

## Serving a store

### `serve(path, options?)`

```ts
function serve(path: string, options?: ServeOptions): Promise<Running>

type ServeOptions = OpenOptions & {
  host?: string;     // "127.0.0.1" (default) or "::1"; any other host throws
  port?: number;     // default 0: a free port
  watch?: boolean;   // default true: poll the files and reread when they change
  pollMs?: number;   // polling interval, default 1000
  token?: string;    // the path token; default 18 random bytes, base64url
};

type Running = {
  readonly url: string;                  // http://127.0.0.1:<port>/<token>/
  readonly openLink: () => string;       // a link that works once and redirects to `url`
  readonly server: import("node:http").Server;
  readonly lens: () => Lens | undefined; // the latest successful read
  readonly close: () => Promise<void>;   // stops polling and closes the server
};
```

Reads the store, starts the loopback server, and resolves once it listens. It takes every option of `openLens` too (`decode`, `prefix`, `restartLimit`, `decoderName`, `displayPath`). It rejects with the read's error if the first read fails, and with `durable-lens only listens on loopback (127.0.0.1 or ::1), not <host>` for another host. It prints nothing and installs no signal handlers; the command line does both.

```js
import { serve } from "durable-lens";

const running = await serve("./session.sqlite", { watch: false });
console.log(running.url);          // give this to a browser, and keep it private
console.log(running.lens()?.tasks.length);
await running.close();
```

The server has all the protections described in the [security model](security-model.md). `url` contains the access token, which gives read access to the whole store. Use `openLink()` when you pass an address on a command line. `url` and `openLink()` name the address it listens on: `127.0.0.1`, or `[::1]` with `host: "::1"`.

## Lower-level readers

### `readSqlite(source, options?)` and `readJsonl(directory, options?)`

```ts
function readSqlite(source: string, options?: ReadOptions): Promise<RawStore>
function readJsonl(directory: string, options?: ReadOptions): Promise<RawStore>
```

The two readers that `readStore` chooses between. `readSqlite` takes its own snapshot and removes it before it returns. Neither checks what kind of path it got, beyond the errors in [troubleshooting.md](troubleshooting.md).

### `snapshotSqlite(source)`

```ts
function snapshotSqlite(source: string): Promise<Snapshot>

type Snapshot = {
  readonly path: string;                   // the private copy of the database
  readonly files: FileInfo[];              // the source files, as { name, size, mtimeMs }
  readonly attempts: number;               // copies taken until one was consistent
  readonly dispose: () => void;            // removes the private directory
};
```

Copies a SQLite database and its WAL or rollback journal into a new private directory, and returns the copy's path. The caller must call `dispose()`. Use it when you want to run your own queries against a consistent copy of a live database, without touching the original.

```js
import { DatabaseSync } from "node:sqlite";
import { snapshotSqlite } from "durable-lens";

const snapshot = await snapshotSqlite("./session.sqlite");
try {
  const db = new DatabaseSync(snapshot.path);
  // ... read ...
  db.close();
} finally {
  snapshot.dispose();
}
```

### `disposeScratch()`

```ts
function disposeScratch(): void
```

Removes every snapshot directory the process still holds. The library registers an exit handler that does this, but it does not install signal handlers; the command line does. If your program handles SIGINT or SIGTERM and exits, call `disposeScratch()` first.

## Chord ops

### `applyOps(target, ops)` and `OpError`

```ts
function applyOps(target: Json, ops: unknown): Json

class OpError extends Error {}
```

Applies a list of Chord delta ops, as pi-durable stores them, to `target`, and returns the new root. It changes `target` in place; an `r` op returns a fresh value. It validates ops and paths the way Chord does, and throws `OpError` on an invalid one, including a path segment named `__proto__`, `constructor` or `prototype`.

```js
const value = applyOps({ items: ["a"] }, [["p", ["items"], 1, 0, ["b"]]]);
// { items: ["a", "b"] }
```

The ops are `["r", value]`, `["s", path, value]`, `["d", path]`, `["a", path, text]`, `["t", path, count]`, `["p", path, start, deleteCount, items]` and `["m", path, permutation]`.

## Types

Every type below is exported with `export type`.

| Type | Meaning |
|---|---|
| `Lens` | The normalized view of a store. See [json-output.md](json-output.md). |
| `LensConversation`, `LensEntry`, `LensTask`, `LensDocument`, `LensSubmission`, `LensUsage` | The elements of the Lens. |
| `OpenOptions`, `BuildOptions`, `ServeOptions` | Options of `openLens`, `buildLens` and `serve`. |
| `Running` | What `serve` returns. |
| `Snapshot` | What `snapshotSqlite` returns. |
| `RawStore` | The records of a store as stored: `kind`, `path`, `files`, `conversations`, `entries` (each `{ record, seq }`), `tasks`, `submissions`, `documents`, the optional `schemaVersion`, `jsonlFormat`, `prefix`, `nextSeq` and `nextId`, `attempts` and `warnings`. |
| `RawDocument`, `RawRevision` | A document record with its `revisions`; a revision is `{ seq, kind: "base" \| "delta", version, content }`. |
| `FileInfo` | `{ name, size, mtimeMs }`. |
| `ReadOptions`, `Decode`, `DecodeSite` | As above. |
| `Json`, `JsonObject` | JSON values: `null`, boolean, number, string, arrays and objects of them. |
