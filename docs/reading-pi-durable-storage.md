# Reading pi-durable storage without writing to it

How durable-lens reads a store, why, and the measurements behind it. Checked on 2026-10-23 against pi-durable 1.2.0, 1.3.0, 1.4.0 (npm) and `main` at [36be9c6](https://github.com/earendil-works/pi/commit/36be9c612e64082a4f0d4d0a94706c38ecbc20a1), with Node 24.16. Rerun the numbers with `node scripts/measure-open-modes.mjs`.

## The requirement

A store may belong to a process that is running right now, or to a product pinned to an older release. Opening it must change no byte of the database, its `-wal`, its `-shm`, or any JSONL file, must not lock the owner out or delay its checkpoints, and must still show the latest committed state.

## The formats

**SQLite.** Nine tables (`durable_schema`, `durable_metadata`, `record_ids`, `conversations`, `entries`, `tasks`, `submissions`, `documents`, `document_revisions`), optionally under a table prefix (1.3.0+). Each row keeps its record as JSON in a `record` column; indexed columns repeat a few fields. Documents are revisions: a `base` holding the value, or a `delta` holding a list of Chord ops. Schema v1 (1.0.0 to 1.3.0) and v2 (1.4.0 on) differ only in the `tasks.status` CHECK constraint, which v2 rebuilds to allow `sleeping`. Opening a v1 database with 1.4.0 code migrates it for good ([CHANGELOG, 1.4.0](https://github.com/earendil-works/pi/blob/main/packages/durable/CHANGELOG.md)). The Node storage runs in WAL mode with `synchronous = NORMAL` ([README, Storage](https://github.com/earendil-works/pi/blob/main/packages/durable/README.md#storage)).

**JSONL.** A directory with `main.jsonl`, one commit marker per line (`{"format":1,"type":"commit","seq":…,"writes":[…]}`), and sidecars `task-<id>.jsonl` and `doc-<id>.jsonl` with live task records and document revisions that markers confirm by `(seq, ordinal)`. The owner appends sidecars first and the marker last. It reclaims space by rewriting a sidecar through `<file>.reclaim` and a rename, and by deleting a terminal task's sidecar. The format is 1 in every release so far; `src/storage/jsonl/storage.ts` is identical from 1.2.0 to 1.4.0, and `main` changes only the commit callback.

**Chord ops**, as stored: `["r", value]`, `["s", path, value]`, `["d", path]`, `["a", path, text]`, `["t", path, count]`, `["p", path, start, deleteCount, items]`, `["m", path, permutation]`.

## Three ways to read

- **(a) Own readers per format**: SQL and JSONL parsing in durable-lens, with no pi-durable code at run time.
- **(b) pi-durable's API**: load the release that matches the file and open it with `HarnessOptions.readOnly`, which is on `main` and not yet released.
- **(c) A mix**: own readers for the bytes, pi-durable's functions for the rest.

## Measurements

Each line opens a private copy of a fixture, hashes every file before and after, and reports what changed. `sqlite` is a store closed cleanly (no WAL file); `sqlite-crashed` is the same store right after its owner died, with its WAL and index still on disk. `next_seq` is the next commit number the read saw; 118 is the latest.

```
node:sqlite { readOnly: true }               1.4.0 sqlite           next_seq 118     CHANGED: -shm (none) → fd4c9fda9cd3; -wal (none) → e3b0c44298fc
node:sqlite file: URI mode=ro                1.4.0 sqlite           next_seq 118     CHANGED: -shm (none) → fd4c9fda9cd3; -wal (none) → e3b0c44298fc
node:sqlite file: URI immutable=1            1.4.0 sqlite           next_seq 118     unchanged
durable-lens                                 1.4.0 sqlite           next_seq 118     unchanged
node:sqlite { readOnly: true }               1.4.0 sqlite-crashed   next_seq 118     CHANGED: -shm 486ad0eec4aa → eb5b910bf243
node:sqlite file: URI mode=ro                1.4.0 sqlite-crashed   next_seq 118     CHANGED: -shm 486ad0eec4aa → eb5b910bf243
node:sqlite file: URI immutable=1            1.4.0 sqlite-crashed   next_seq 112     unchanged
durable-lens                                 1.4.0 sqlite-crashed   next_seq 118     unchanged
pi-durable main storage + readOnly Harness   1.2.0 sqlite           schema v1 → v2   CHANGED: session.sqlite, -shm, -wal
pi-durable main storage + readOnly Harness   1.2.0 sqlite-crashed   schema v1 → v2   CHANGED: session.sqlite, -shm, -wal
pi-durable main storage + readOnly Harness   1.4.0 sqlite-crashed   schema v2 → v2   CHANGED: session.sqlite, -shm, -wal
pi-durable main JSONL + readOnly, torn tail  1.4.0 jsonl            main.jsonl 38132 → 38089 B   CHANGED: session/main.jsonl
durable-lens, torn tail                      1.4.0 jsonl            27 entries       unchanged
```

What they show:

1. A SQLite read-only connection is not a zero-write read. On an idle WAL database it creates `-wal` and `-shm`; on a live one it writes read marks into `-shm`, which is shared memory the owner uses too.
2. `immutable=1` writes nothing but skips the WAL: on the crashed store it missed the last six commits.
3. `HarnessOptions.readOnly` guards the Harness, not the storage. `readOnly` rejects the Harness's own commits, but opening the storage runs before it and still writes. On SQLite it applies migrations, so a 1.2.0 database became schema v2, and it checkpointed the WAL into the database file. On JSONL, recovery truncated the torn last line of `main.jsonl`; a viewer of a session another process drives would cut off the owner's append in progress. Recovery also rewrites and deletes sidecars. Loading the matching old release instead (approach b) avoids the migration but still writes on open.

## Decision: (a), with one borrowed piece checked rather than imported

durable-lens reads at file level and runs no pi-durable code.

- **SQLite**: copy the database and its WAL or rollback journal into a private temporary directory, with a reflink where the filesystem supports one (`COPYFILE_FICLONE`), then open the copy. In WAL mode the database file changes only by checkpointing frames that stay in the WAL until a reset, and a reset changes the salts in the WAL header. So while a WAL with frames keeps the same header, a checkpoint that tears the database copy is harmless: replaying the copied WAL over it gives the latest committed state. The copy is accepted when the WAL header is the same before and after it (and in the copied file), the rollback journal did not change, and, if there is no WAL with frames, the database's size, mtime and inode did not change either. Otherwise it copies again, up to eight times. The `-shm` is not copied; SQLite rebuilds it in the private directory. No lock is taken, so the owner's checkpoints are never held back.
- **JSONL**: read `main.jsonl` first, then the sidecars. A last line without its newline is an append in progress and is left out, not truncated. Any sidecar record a marker confirms was written before the marker. If one is missing, the owner reclaimed it after the main file was read, and the whole read starts over. Records before a current-only document's newest base may be gone; the read replays from that base.
- **Chord ops**: reimplemented in `src/store/ops.ts`, about a hundred lines, with Chord's path checks (no `__proto__`, `constructor` or `prototype` segments). `test/ops.test.ts` replays random edits recorded by Chord's own tracker, the way pi-durable records document changes, and compares the result with Chord's value after every change.

## The criteria

| Criterion | (a) own readers | (b) pi-durable + readOnly |
|---|---|---|
| Zero writes (db, WAL, SHM hashes) | met for every fixture, also with a pi-durable owner holding the store open (`test/zero-write.test.ts`) | not met: migrates, checkpoints, truncates |
| Safe read of a live WAL store | met: no locks, no shared-memory writes; 25 consecutive reads while an owner commits every 2 ms all succeed and never go back in sequence | needs a writable connection to the owner's database |
| Cost of a schema change | low so far: v1 → v2 changed one CHECK constraint, no column; JSONL format 1 unchanged since 1.0.0. New record fields pass through as JSON. A new release costs a fixture directory and its test run. | one pinned install per release, and every release's open behaviour to audit |

Approach (a) would have been abandoned if safe reading needed a write lock or stopping the owner, or if each version needed the reader rewritten. Neither happened: no lock and no stop, and the reader needed no change from 1.2.0 to `main`; only the UI learned the `sleeping` status and restart counts.

## Version matrix

The fixtures come from `fixtures/generate/scenario.mjs` run by each release: a root conversation with three inputs, parallel tool calls, a subagent on a cheaper model, a fork continued on that model, rewindable and session documents, a release task waiting on its build and publish, a durable sleep (1.4.0+), a background task cut off by four crashing owners (restart count and parking in 1.4.0+), a failed and an aborted task. Each release writes it to SQLite and JSONL, kept closed cleanly and as left by the last crash.

| | sqlite | sqlite-crashed | jsonl | jsonl-crashed |
|---|---|---|---|---|
| 1.2.0 | v1 | v1, live WAL | format 1 | format 1 |
| 1.3.0 | v1 | v1, live WAL | format 1 | format 1 |
| 1.4.0 | v2 | v2, live WAL | format 1 | format 1 |
| main 36be9c6 | v2 | v2, live WAL | format 1 | format 1 |

## Not covered yet

IndexedDB (browser), Cloudflare Durable Object SQLite (no file to open), and the third-party Postgres and CouchDB backends.
