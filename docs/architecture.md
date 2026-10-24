# Architecture

durable-lens reads a pi-durable store at file level, builds one normalized view of it, and serves that view to a page in your browser. No pi-durable code runs.

## Data flow

```
store on disk
  SQLite file (+ -wal, -journal)         JSONL directory (main.jsonl, task-N.jsonl, doc-N.jsonl)
        |                                        |
        v                                        v
  snapshotSqlite: private copy             readJsonl: read the files
  readSqlite: SQL over the copy            skip an incomplete last line
        \                                       /
         \                                     /
          v                                   v
                      RawStore                     (src/store/types.ts)
        records exactly as stored, decoded by the decoder hook if there is one
                            |
                            v
                       buildLens                    (src/model.ts)
        materialize documents, link tasks and entries, sum usage, detect the release range
                            |
                            v
                       Lens (JSON)                  (src/web/lens.ts)
                      /            \
                     v              v
            --json prints it     serve() holds the latest Lens   (src/server.ts)
                                    |
                                    v
                         web page in the browser                (src/web/*.ts)
                  fetches api/version, and api/lens when the version changes
```

`openLens(path, options)` in `src/open.ts` is the composition of the first three steps: `readStore`, then `buildLens`. `--json` prints its result and exits. The server calls it again whenever the files change.

## Modules

| Module | Responsibility |
|---|---|
| `src/cli.ts` | Parses arguments, installs the signal handlers that remove scratch copies, loads the decoder, prints `--json` or starts the server, opens the browser for `--open`, and maps failures to exit codes. |
| `src/index.ts` | The library entry point. Re-exports the functions and types listed in [library.md](library.md). |
| `src/open.ts` | `readStore` picks the reader: a directory with `main.jsonl` is JSONL, a file is SQLite. `openLens` reads and builds, and times the read. `loadDecoder` imports a decoder module. |
| `src/store/sqlite.ts` | Takes the snapshot of a SQLite store and reads eight of pi-durable's nine tables from the copy with `node:sqlite` (not `record_ids`). Detects the table prefix. |
| `src/store/jsonl.ts` | Reads `main.jsonl` first, then the sidecars, validates the commit markers, and rebuilds records and document revisions. Starts over when a sidecar a marker confirms is missing. |
| `src/store/ops.ts` | Applies Chord document deltas (`r`, `s`, `d`, `a`, `t`, `p`, `m`) with Chord's validation, including the refusal of `__proto__`, `constructor` and `prototype` path segments. |
| `src/store/scratch.ts` | Creates and removes the private temporary directories that hold snapshots. |
| `src/store/types.ts` | `RawStore`, `ReadOptions`, `Decode` and `DecodeSite`. |
| `src/model.ts` | `buildLens`. Turns raw records into conversations, entries, tasks, documents, submissions and usage. Detects the release range. Unknown fields and kinds pass through as JSON. |
| `src/server.ts` | `serve`, exported from the library. The loopback HTTP server: token, `Host` check, methods, headers, static files, the two API routes, the one-time open link, and polling for changes. |
| `src/web/` | The page. `app.ts` is the shell and the poll loop, `timeline.ts`, `tasks.ts`, `documents.ts` and `usage.ts` are the views, `markdown.ts` and `json.ts` render content, `dom.ts` builds elements and text nodes, `state.ts` holds routing and indexes, `lens.ts` holds the shared types. It is compiled to `dist/web`. |

## The Lens

`buildLens` does not need the page. It takes a `RawStore` and returns a plain JSON object, the `Lens`. The page, `--json` and the library all use that object, so what you see in the page is what a script gets. The fields are described in [json-output.md](json-output.md).

## Snapshot and scratch lifecycle (SQLite)

Opening a SQLite file, even read-only, can write beside it, and `immutable=1` can miss the WAL. So `snapshotSqlite` copies the files and the copy is what gets opened. [reading-pi-durable-storage.md](reading-pi-durable-storage.md) has the reasoning and the measurements.

1. `makeScratch` creates a directory named `durable-lens-<pid>-<random>` under the operating system's temporary directory, with `mkdtemp`, so only the current user can enter it. The first call in a process also removes directories of this form that belong to the same user and to a process that no longer exists, and registers an exit handler.
2. The copy loop records the WAL header (its salts and checkpoint sequence), and the size, mtime and inode of the database and of the rollback journal. It copies the database, the `-wal` and the `-journal` with a reflink where the filesystem supports one. The `-shm` is not copied; SQLite rebuilds it in the private directory.
3. The copy is accepted when the WAL header is the same before and after the copy and in the copied file, the journal did not change, and, when there is no WAL with frames, the database did not change either. With a WAL that has frames, a checkpoint during the copy is harmless, because opening the copy replays every committed frame over the pages. Otherwise it waits (25 ms times the attempt number) and copies again, up to 8 attempts. After the 8th it fails with `kept changing while it was copied`.
4. `readSqlite` opens the copy with `DatabaseSync`, reads every table, and removes the directory in a `finally` block, so each read leaves nothing behind.
5. The CLI also removes any directory it still holds on SIGINT (exit 130), SIGTERM (143) and SIGHUP (129), and on exit. A process that is killed outright cannot clean up; the next run sweeps its directory.

A library caller who uses `snapshotSqlite` directly owns the returned `dispose` function. `disposeScratch` removes every snapshot the process still has.

JSONL needs no copy: the files are read with plain reads, never opened for writing. The "Decision" section of [reading-pi-durable-storage.md](reading-pi-durable-storage.md) explains how a half-written line and a reclaimed sidecar are handled. Up to 6 reads are tried before it gives up.

## Watching and polling

The server holds the latest `Lens` in memory and a version number.

- Every second (`pollMs`), unless `--no-watch` is set, it builds a fingerprint with `stat()` only. For a SQLite store: the size and mtime of the database, and the `-wal` and `-journal` files, present or not. The `-shm` is left out, because it changes with every read lock and holds no data of its own. For a JSONL store: the size and mtime of `main.jsonl` and of every sidecar (`task-N.jsonl`, `doc-N.jsonl`) found in the directory, so a new or removed sidecar changes it too.
- The fingerprint is taken before each read starts. A commit that lands while a read runs therefore differs from the stored fingerprint, and the next poll reads again.
- If the fingerprint differs from the last one and no read is in progress, it reads the store again. Reads never overlap.
- When a read finishes, the version number goes up, also when the read failed. On failure the previous `Lens` stays and the error message is kept.
- The page asks `api/version` every 1.5 seconds. When the version differs from the one it holds, it fetches `api/lens` and redraws. If only the error changed, it updates the "last reread failed" badge.
- If the server stops, the page keeps showing the last read.

With `--no-watch` the store is read once, at start.

## The build

`npm run build` compiles `src/` (without `src/web/`) to `dist/` and the page to `dist/web/`, then copies `index.html` and `styles.css`, and the project mark from `docs/media/mark.svg`, which the page uses as its icon. The server finds the page next to itself in `dist/`, or in `../dist/web` when it runs from the TypeScript sources, as the tests do. Only files whose name matches `[a-z0-9-]+\.(html|js|css|svg)` in that directory are served.
