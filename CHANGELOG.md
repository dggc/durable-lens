# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Until 1.0, the JSON output and the library API may change in any release.

## [Unreleased]

## [0.1.0] - Unreleased

The first release: a read-only viewer for pi-durable storage.

### Added

- A command line, `durable-lens <store>`, that serves a local web page for a pi-durable SQLite file or JSONL directory. Options: `--port`, `--open`, `--json`, `--decoder`, `--prefix`, `--restart-limit`, `--no-watch`, `--version` and `--help`.
- Readers for SQLite stores (schema v1 and v2, with table prefixes) and JSONL stores (format 1), written by pi-durable 1.2.0, 1.3.0, 1.4.0 and the unreleased main branch (commit 36be9c6).
- A read that never writes to the store and works against a live owner. SQLite is read from a private copy of the database and its WAL, which is taken again if the WAL header changes during the copy (or, without a WAL with frames, if the database changes). JSONL files are only read; an incomplete last line is skipped, and a read that races a sidecar reclaim starts again.
- A timeline of every entry with time, the gap since the previous entry, model, latency, tokens and cost, and a strip of generations and tool calls on one clock.
- Links between a tool call, its result, its task and the subagent conversation it started.
- A task graph with owner edges, wait policies, sleeping tasks, restart counts, parked tasks, outcomes and errors, and the input, checkpoint and outcome of each task.
- Documents materialized from their stored bases and deltas, with a revision slider for rewindable documents.
- Usage and cost by model, by tool and by conversation.
- Fork comparison, which shows the parent's continuation and the fork's side by side.
- Detection of the pi-durable release range that wrote a store, from the schema version and record shapes. Unknown fields and kinds are shown as JSON.
- Following the store: the server checks the files once a second and the page rereads when they change.
- A decoder hook for stores whose adapter encrypts or compresses payloads at rest, with an AES-256-GCM example.
- `--json`, which prints the normalized view of a store, and a library API (`openLens`, `readStore`, `buildLens`, the readers and the types).
- Protections for the local server: loopback only, a random token in every path, a `Host` header check, GET and HEAD only, a restrictive Content-Security-Policy, and a one-time link for `--open`.
- Rendering of store content as text only, with a small Markdown renderer that builds DOM nodes, keeps HTML literal and does not make links clickable.
- Removal of snapshot copies after each read, on exit and on SIGINT, SIGTERM and SIGHUP, and removal of copies left by a killed process on the next run.
- Committed fixtures for each supported release, from 1.2.0 on, in a clean and a crashed state, with the generator that writes them.
- Tests for fixtures, zero writes (also while a pi-durable process owns the store), consistency while an owner commits, the decoder hook, the server and hostile content.
- Documentation: README, VISION, CONTRIBUTING, SECURITY, and the pages under `docs/`.

[Unreleased]: https://github.com/dggc/durable-lens/commits/main
[0.1.0]: https://github.com/dggc/durable-lens/commits/main
