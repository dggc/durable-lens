# Contributing to durable-lens

Thank you for helping. This page covers how to set up, what to run before a pull request, what a change must not break, and how a change gets merged. Please also read the [code of conduct](CODE_OF_CONDUCT.md) and, for anything security related, [SECURITY.md](SECURITY.md).

## Never attach real data

A pi-durable store holds prompts, tool output and model answers. Do not attach a real store, a transcript or `--json` output to an issue or a pull request, and do not paste them into one. To show a problem, use a committed fixture, or describe the shape of the store: the pi-durable version, the storage kind, and which feature is involved. If you need to share a store to explain a bug, ask first and remove everything private.

## Setup

You need:

- Node.js 24 (recommended) or 22.18 or later, for development. The tests run TypeScript directly, which needs type stripping, available from 22.18. The package itself runs on Node.js 22.13 or later, and the CI runs `check:package` on 22.13.0 to keep it so.
- git and npm.
- For the browser check: Chrome, Chromium or Brave. `check:ui` drives it through `playwright-core`, does not download a browser, and takes the browser's path from `CHROME_BIN`.
- Optional: `ffmpeg`, only to record the demo GIF again with `scripts/record-demo.mjs`.

```sh
git clone https://github.com/dggc/durable-lens.git
cd durable-lens
npm ci
npm run build
```

Some tests start a real pi-durable process on a store, to check that durable-lens writes nothing while an owner holds it open. They need the pinned pi-durable releases, which the fixture generator installs, one directory per release:

```sh
for dir in fixtures/generate/v[0-9]*/; do (cd "$dir" && npm ci --ignore-scripts); done
```

Without them, these tests are skipped and say how to enable them. Everything else runs without them. The unreleased `main` generator needs a checkout of the pi repository; see [fixtures/generate/README.md](fixtures/generate/README.md).

## npm scripts

| Script | What it does | When to run it |
|---|---|---|
| `npm run build` | Compiles `src/` to `dist/` and copies the page files. | After changing `src/`, and before running the CLI from the clone. `test`, `coverage`, `check:ui` and `check:package` run it first. |
| `npm run lint` | Biome, read-only. Reports problems and formatting differences. | Before every commit. |
| `npm run format` | Biome, writes. Formats the files it covers. | When `lint` reports formatting. |
| `npm run typecheck` | TypeScript, no output. | Before every commit. |
| `npm test` | Builds, then runs every test. | After any change to `src/` or `test/`. |
| `npm run coverage` | Runs the tests with coverage thresholds over `src/`. | Before a pull request. A change that lowers coverage below the threshold fails. |
| `npm run check:ui` | Builds, then loads every view in a real browser and fails if anything in the store content could make the page run code, open a dialog, or request something outside the local server. Needs `CHROME_BIN=/path/to/chrome`. | When you change `src/web/`, `src/server.ts` or the rendering of store content. |
| `npm run check:package` | Builds, packs the tarball, checks what it contains, installs it in a temporary directory and runs the installed command. | When you change `package.json`, the build, or what is published. |
| `npm run verify` | `lint`, `typecheck`, `coverage` and `check:package`. | Before opening a pull request. It is what a reviewer expects to pass. |
| `npm run fixtures` | Regenerates the fixtures from every installed pi-durable generator. | Only when you add or change a fixture. See below. |

Example for the browser check, with the path of the Chrome, Chromium or Brave executable on your machine (`command -v google-chrome` or `command -v chromium` finds it on Linux; on macOS it is inside the application bundle, such as `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`):

```sh
CHROME_BIN=/usr/bin/google-chrome npm run check:ui
```

## Project layout

```
src/cli.ts            argument parsing, signal handling, output, exit codes
src/index.ts          the library entry point
src/open.ts           readStore, openLens, loadDecoder
src/model.ts          buildLens: raw records to the Lens that the page and --json use
src/server.ts         the loopback server: token, Host check, headers, polling
src/store/            readers: sqlite.ts, jsonl.ts, ops.ts (Chord ops), scratch.ts, types.ts
src/web/              the browser page, in TypeScript, built to dist/web; lens.ts holds the Lens types
test/                 tests that run with node:test; support.ts has the fixture helpers
fixtures/stores/      committed stores, one directory per pi-durable release
fixtures/generate/    the scenario and one pinned install per release that writes the stores
examples/             an example decoder module
scripts/              build helpers, the browser check, and the media and measurement scripts
docs/                 documentation; docs/media holds images
.github/              workflows, issue and pull request templates
```

[docs/architecture.md](docs/architecture.md) explains how the parts fit together.

## Supporting a new pi-durable release

A new release is supported when a store it writes reads correctly and the tests prove it.

1. Add `fixtures/generate/vX.Y.Z/`. Copy the newest release directory (`package.json`, `package-lock.json`, `run.mjs`), set the three `@earendil-works/*` dependencies in `package.json` to the new version, and keep `run.mjs` identical to `fixtures/generate/run.template.mjs`.
2. Install it: `(cd fixtures/generate/vX.Y.Z && npm ci)`.
3. Regenerate only that version: `node fixtures/generate/build.mjs X.Y.Z`. This writes `fixtures/stores/X.Y.Z/` with `sqlite`, `sqlite-crashed`, `jsonl` and `jsonl-crashed`. Regenerating an older version rewrites its stores with new timestamps and ids, so leave those alone.
4. Extend the matrix: add the version to `VERSIONS` in `test/support.ts`, and to the version checks in the tests that depend on features (for example `durableSleep` in `test/fixtures.test.ts`). Add the version to the owner tests in `test/zero-write.test.ts` if it runs as an owner.
5. Run `npm test`. If the new release changes a record shape or the schema, teach `src/store/` or `src/model.ts` about it, and update `detectVersion` in `src/model.ts`, so that the page names the right release range. Anything the reader does not know must still reach the page as JSON.
6. Update the version tables in the [README](README.md) and in [docs/reading-pi-durable-storage.md](docs/reading-pi-durable-storage.md), add a line to the [CHANGELOG](CHANGELOG.md). The CI workflows install every `fixtures/generate/v<digits>` directory, so they need no change.

The generators use pi-ai's faux provider. They make no model calls and contain no real data. Keep it so.

## Invariants

A pull request must not break these. Each is covered by a test, and a change that needs to alter one needs a discussion in an issue first.

- **Zero writes.** durable-lens never opens a file of the store for writing, creates nothing next to it, and takes no lock. SQLite is read from a private copy; JSONL files are only read. `test/zero-write.test.ts` hashes every file before and after a read, with and without a live owner.
- **Loopback, token, Host check, CSP.** The server listens on 127.0.0.1 or ::1 only, serves everything under a random token, rejects a request whose `Host` is not its own with 421, answers only GET and HEAD, and sends the Content-Security-Policy and the other headers in `src/server.ts`. `test/server.test.ts` and `npm run check:ui` cover this.
- **Content is rendered as text.** Store content reaches the page only as text nodes. Do not use `innerHTML`, `insertAdjacentHTML`, `document.write`, `eval`, or a generated link or image whose target comes from the store. `test/hardening.test.ts` and `check:ui` cover this.
- **No network calls, no telemetry, no runtime dependencies.** Do not add a package to `dependencies`.
- **Scratch copies do not outlive the process.** Every snapshot of a SQLite store is removed after the read, on exit and on a signal.

## Tests

Add tests with the change.

- A bug fix comes with a test that fails without the fix.
- A change to how records are read or turned into the Lens comes with a test, using a fixture where one fits, or a small hand-written store.
- A change to what the page renders comes with a `check:ui` pass, and a screenshot in the pull request. The screenshot must come from a fixture.
- A change that touches reading or writing files comes with a zero-write check.
- Keep tests free of real data and of network access.

`test/fuzz.test.ts` fuzzes the code that reads untrusted store content (the Markdown renderer, the op applier, the JSONL reader and the model) with [fast-check](https://fast-check.dev/), and runs with the other tests. A failure prints the seed and a shrunk counterexample; run `FUZZ_SEED=<seed> node --test test/fuzz.test.ts` to repeat it, and turn the counterexample into a plain test next to the fix. `FUZZ_RUNS=<n>` sets the number of runs of every property (the default keeps the file near four seconds; the JSONL properties wait on their retries, so `FUZZ_RUNS=200` already takes about a minute). Without `FUZZ_SEED` the seed is random.

## Commit style

- A short subject in the imperative, in sentence case, without a type prefix and without a final period: "Skip an incomplete last line in JSONL sidecars".
- Keep the subject under 72 characters. Use the body to say why the change is needed, what you considered, and what it does not cover.
- One logical change per commit. Do not mix a refactor with a fix.

## Pull requests

1. Open an issue first for anything larger than a small fix, so that the direction can be agreed.
2. Fork the repository and branch from `main`.
3. Make the change, with tests and documentation. Add an entry under "Unreleased" in [CHANGELOG.md](CHANGELOG.md) for anything a user would notice.
4. Run `npm run verify`, and `npm run check:ui` if the page changed.
5. Open the pull request and fill in the template. The CI must pass on all of its jobs.
6. A maintainer reviews. Expect questions, and expect that a change which weakens an invariant is declined.

## AI-assisted contributions

Contributions written with AI coding tools are welcome. This project is itself written with them. If you used one, you are the author: read every line, run the tests, understand the change and be ready to explain it. Say in the pull request that the change was AI-assisted, and what you checked yourself. A pull request that the author has not reviewed or tested will be closed.

## Licensing

durable-lens is released under the [MIT license](LICENSE). By submitting a contribution you agree that it is licensed under the same terms, and you confirm that you have the right to submit it.
