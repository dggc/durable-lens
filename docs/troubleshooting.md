# Troubleshooting

The messages below are the ones durable-lens prints, with `durable-lens: ` in front on the command line. If the first read fails, `serve` throws and the command line prints the message and exits with 1; no page starts. Once the page is open, warnings are listed under the badge in the header, and a failed reread shows as a badge (see In the browser).

Please do not paste store content into an issue. Messages that name a file or a line number are safe to share, after you remove private paths.

## Command line

| Message | Cause and what to do |
|---|---|
| `<path> does not exist; give a SQLite file or a JSONL storage directory` | The store path does not exist. Check the path and the directory you ran the command from. |
| `<path> is not a SQLite database` | The file does not start with the SQLite header. It may be a different file, an empty file, or a database that is encrypted as a whole (for example with SQLCipher), which durable-lens cannot open. Payload-level encryption is a different case; see Decoders below. |
| `<path> is a directory without main.jsonl, so not a pi-durable JSONL store` | Point at the JSONL storage directory itself, the one that contains `main.jsonl`, not at its parent. |
| `no pi-durable tables in this database (no durable_schema table)` | The database has no pi-durable tables. It is another database, or an adapter names its tables differently. |
| `no such table: <prefix>durable_schema` | `--prefix` names a prefix that the database does not have. Leave `--prefix` out to see the prefixes it detects. |
| `--restart-limit must be a positive number` | Give a number of 1 or more. |
| `Unknown option '--x'. To specify a positional argument starting with a '-', place it at the end of the command after '--', ...` | The option does not exist. Compare with `durable-lens --help`. |
| `options.port should be >= 0 and < 65536. Received type number (NaN).` | `--port` is not a port number. |
| `listen EADDRINUSE: address already in use 127.0.0.1:<port>` | Something else uses the port. Use another one, or leave `--port` out. |
| `could not open a browser; open the URL above` (printed without the `durable-lens:` prefix) | `--open` could not start the browser command, for example because `xdg-open` is not installed. Open the printed address yourself. |
| `durable-lens only listens on loopback (127.0.0.1 or ::1), not <host>` | Library only: `serve` was given another host. The command line has no host option. |
| usage text, exit code 2 | No store was given, or more than one. |

## Reading a SQLite store

| Message | Cause and what to do |
|---|---|
| `<path> kept changing while it was copied (8 attempts)` | The owner changed the database or its WAL, or reset the WAL, every time durable-lens tried to take a consistent copy. Try again, or stop the owner for a moment. |
| warning `several pi-durable storages share this database (prefixes a, b); showing "a", pick one with --prefix` | The database holds more than one pi-durable storage, each under its own table prefix. Pass `--prefix` for the one you want. `(none)` means the unprefixed tables. |
| warning `N records have no id: the adapter may encrypt or compress payloads at rest; pass --decoder with a module that decodes them` | The payloads are not pi-durable's plain JSON. See [decoders.md](decoders.md). |
| `Unexpected token ... is not valid JSON` (or another `JSON.parse` message) | A payload column does not hold JSON text. An adapter that stores raw bytes cannot be decoded. |
| page badge `SQLite schema vN: newer than this durable-lens knows; showing what it can read` (in the hints of the version badge) | The store has a schema newer than the ones tested. Update durable-lens. If it is already the latest, open an issue with the pi-durable version, without store content. |

## Reading a JSONL store

| Message | Cause and what to do |
|---|---|
| warning `main.jsonl: skipped an incomplete last line (an owner may be writing it)`, also for `task-N.jsonl` and `doc-N.jsonl` | A last line without its newline is an append in progress. It is normal while a harness runs, and the next reread clears it. If it stays after the owner stopped, a crash left a torn line. durable-lens leaves it alone; pi-durable truncates it the next time it opens the store. |
| `<dir>: main.jsonl line N is not JSON, still after 6 reads; an owner may be writing very fast, or the store is damaged` | A line in the middle of a file is not valid JSON, and stayed so across six reads. The store is damaged, or an owner is rewriting it constantly. |
| `<dir>: task-N.jsonl lacks the record of commit S, still after 6 reads; ...` and `<dir>: doc-N.jsonl lacks the record of commit S, still after 6 reads; ...` | A commit marker confirms a sidecar record that is not there. The owner may have reclaimed the sidecar while durable-lens read, in which case a retry works. If it persists, files were deleted or copied incompletely. Copy the whole directory together. |
| `main.jsonl line N: unknown marker format X` | A commit marker is not format 1. The store comes from a pi-durable newer than the ones tested, or it is not a pi-durable store. |
| `main.jsonl line N: commit sequence does not increase`, `... no writes`, `... a write is not an object`, `... malformed <type> write`, `... malformed document.create write`, `... malformed document.retire write`, `... change of unknown document N` | The main file is damaged or in a format that durable-lens does not know. |
| `main.jsonl line N: a <type> without an id; pass --decoder if the store is encrypted`, or `task-N.jsonl: a task without an id; ...` for a sidecar | A record has no `id`. If the adapter encrypts payloads, use a decoder. |
| `<file> line N is not a JSON object` and `doc-N.jsonl: malformed record of commit S` | A sidecar holds something other than a pi-durable record. |
| warning `main.jsonl line N: skipped unknown write type X` | The store has a write type that durable-lens does not know, from a newer pi-durable. The rest is shown. Open an issue. |

## Documents

| Message | Cause and what to do |
|---|---|
| warning `document N (kind): no base revision` | The document has deltas but no base, for instance because pi-durable reclaimed the base. Its value is shown as `null`. |
| warning `document N (kind): could not apply revision: <reason>` | A delta did not apply: a wrong path, an out-of-range index, or an unsafe path segment. The value shown is the last one that applied. The reasons are the messages of `OpError`, such as `path ["a"] does not exist`, `index 5 out of range`, `unknown op x`, `permutation is not a bijection`, `unsafe path segment __proto__`. |

## Decoders

| Message | Cause and what to do |
|---|---|
| `<path> exports no decode function (default export or "decode")` | The module has neither a default function export nor a named `decode` export. |
| `Cannot find module '<path>' imported from ...` | The `--decoder` path is wrong. It is resolved against the current directory. |
| `set DURABLE_LENS_KEY to the base64 of the 32-byte key` | From the AES example: the key is missing or the wrong length. |
| `Unsupported state or unable to authenticate data` | From the AES example: the key is wrong, or the payload was altered. |
| `the read never finished; does the decoder return a promise that never settles?` | The decoder's promise never resolves and nothing else keeps the process alive. Fix the decoder. |

See [decoders.md](decoders.md) for more.

## In the browser

| What you see | Cause and what to do |
|---|---|
| `wrong host` (HTTP 421) | The request's `Host` is not `127.0.0.1:<port>`, `localhost:<port>` or `[::1]:<port>`. This is the DNS rebinding check. Through an SSH tunnel or a port forward, forward the same port number that durable-lens printed and open `http://127.0.0.1:<port>/<token>/`. |
| `not found` (HTTP 404) | The address is missing its token, or the token is from an earlier run. Copy the whole address from the terminal. |
| `link already used` (HTTP 404) | The one-time link from `--open` was opened already. Use the full address in the terminal. |
| `read-only` (HTTP 405) | Only GET and HEAD are answered. |
| `Could not load the store: <message>` | The page could not fetch `api/lens`: the server stopped, or the request failed. A store that fails to read at start never gets this far; the command line reports it and exits. |
| badge `last reread failed`, with a message on hover | A reread failed, for example because a file changed or was removed. The page keeps showing the last good read and tries again when the files change. |
| The page does not change when the harness works | Watching polls file size and mtime once a second. With `--no-watch` it does not follow. |
| A fork or document is missing | Only what the store holds is shown. A JSONL document that pi-durable keeps as current-only has its older revisions reclaimed. Rewind covers the last 100 revisions. |

## Leftover files

durable-lens copies SQLite stores into directories named `durable-lens-<pid>-<random>` in your temporary directory, and removes them after each read. If the process was killed with SIGKILL, a directory can stay. The next durable-lens run of the same user removes the directories of processes that no longer exist. You can also delete them by hand; they contain a copy of your transcripts.

## Still stuck

Open an issue with the durable-lens version, the Node.js version, the operating system, the pi-durable version, the storage kind, and the exact message. Do not attach the store.
