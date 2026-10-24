# Security model

durable-lens reads a store that holds prompts, tool output and model answers, and shows it in a browser. This page lists what it protects against and how, with the place in the code and the test that covers each. To report a problem, follow [SECURITY.md](../SECURITY.md).

## Assets and trust

- **The store** must not change. It may belong to a running process.
- **The content of the store** is private to the user. It is a full record of what an agent was told and did.
- **The content of the store is also untrusted input.** It contains text from models, tools, web pages and users. Any of it can be hostile: HTML, scripts, Markdown that tries to trick a renderer, huge or deeply nested values, and names such as `__proto__`.
- **The user, and the programs the user runs as the same account,** are trusted. durable-lens does not defend against a process that already runs as the same local user or as root.
- **A decoder module** is trusted code that the user chose to run. See [decoders.md](decoders.md).

## Threats and mitigations

| Threat | Mitigation | Code | Tests |
|---|---|---|---|
| durable-lens changes the store, or leaves files next to it | SQLite is read from a private copy of the database and WAL. JSONL files are opened only to read. No lock is taken and nothing is created beside the store. | `src/store/sqlite.ts`, `src/store/jsonl.ts` | `test/zero-write.test.ts` hashes every file of every fixture before and after a read, also while a pi-durable process holds the store, and while an owner commits. |
| The snapshot copy of a SQLite store, a full copy of the transcripts, is left behind or read by others | The copy is in a directory made with `mkdtemp`, which only the current user can enter. It is removed after every read, on exit, and on SIGINT, SIGTERM and SIGHUP in the CLI. The next run removes copies of dead processes of the same user. | `src/store/scratch.ts`, `src/cli.ts` | `test/hardening.test.ts` interrupts a read and checks that no copy remains and that a stale one is swept. |
| Store content runs code in the page (cross-site scripting) | Content reaches the page only as text nodes. Nothing parses HTML. Markdown is rendered by a small renderer that builds DOM elements from a fixed set. Raw HTML stays literal. Links show their target as text and are not clickable. | `src/web/dom.ts`, `src/web/markdown.ts` | `test/hardening.test.ts` renders hostile text and checks the nodes and attributes. `npm run check:ui` loads every view in a real browser and fails on a dialog, a console error, or an unexpected request. |
| A script or resource from elsewhere runs or loads | A Content-Security-Policy of `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`. The page loads its script modules, one stylesheet and its icon from the same server and nothing else. | `src/server.ts` | `test/server.test.ts` checks the header. `check:ui` fails on any request outside the local server. |
| Another site, in your browser, reads the server | Every route needs a random token (18 random bytes, base64url) in the path. Requests without it get 404. Responses carry no CORS headers, `Cross-Origin-Resource-Policy: same-origin` and `Cross-Origin-Opener-Policy: same-origin`, so a page from another origin cannot read them. The page cannot be framed: `X-Frame-Options: DENY` and `frame-ancestors 'none'`. | `src/server.ts` | `test/server.test.ts` |
| DNS rebinding: a hostile site rebinds its name to 127.0.0.1 and talks to the server | The server answers only requests whose `Host` is `127.0.0.1:<port>`, `localhost:<port>` or `[::1]:<port>`, and replies 421 to the rest. A rebound page still sends its own name as `Host`. Together with the token, a page that does not know the URL cannot reach a route. | `src/server.ts` | `test/server.test.ts` sends a foreign `Host`. |
| A request changes something | Only GET and HEAD are answered. Everything else gets 405. The server has no route that writes. | `src/server.ts` | `test/server.test.ts` sends a POST. |
| The server is reachable from the network | `serve` refuses any host except `127.0.0.1` and `::1`. The command line has no option to change the address. | `src/server.ts` | `test/server.test.ts` asks for `0.0.0.0`. |
| Another user of the machine reads the store through the port | Loopback is reachable by every local user, so the token is the barrier. It is printed only to your terminal. It is not in the command line of the process. `--open` passes the browser a link that works once and redirects to the tokened address, because command lines are visible to other users. The token has 144 bits. | `src/server.ts`, `src/cli.ts` | `test/hardening.test.ts` uses an open link twice. |
| The token leaks through a Referer header | `Referrer-Policy: no-referrer` and `<meta name="referrer" content="no-referrer">`. The page makes no cross-origin requests. | `src/server.ts`, `src/web/index.html` | |
| A request reads a file outside the page assets | The route after the token must match `[a-z0-9-]+\.(html\|js\|css\|svg)` and is read from the page directory only. `..` and encoded separators do not match. | `src/server.ts` | `test/server.test.ts` tries `..%2F` and `%2e%2e/`. |
| A response is mistaken for another type | `X-Content-Type-Options: nosniff` and explicit content types. | `src/server.ts` | `test/server.test.ts` |
| A store key such as `__proto__` or `constructor` pollutes an object | Usage per model and per tool is collected in a `Map` and turned into an object with `Object.fromEntries`, which defines own properties. Chord path segments `__proto__`, `constructor` and `prototype` are refused. | `src/model.ts`, `src/store/ops.ts` | `test/hardening.test.ts` |
| A crafted store makes durable-lens hang or crash | The Markdown renderer works in linear time on long runs of backticks, brackets, asterisks and table rules. Sums over long transcripts use loops, not argument spreading. A rewindable document keeps a bounded number of states for the page. Ops are validated like Chord's. | `src/web/markdown.ts`, `src/model.ts`, `src/store/ops.ts` | `test/hardening.test.ts` |
| A store written in an unknown format is misread silently | A JSONL marker with an unknown format is an error. Unknown write types are skipped with a warning. Unknown fields and kinds are shown as JSON. A newer SQLite schema is reported in the page header. | `src/store/jsonl.ts`, `src/model.ts` | |
| Data leaves the machine | The viewer (the server and the page) makes no network calls beyond the local server. There is no telemetry, update check or font or script download. | whole code base | `check:ui` fails on any request outside the local server. |
| A dependency is compromised | There are no runtime dependencies. Development dependencies are pinned in the lock file. The pi-durable releases used to generate fixtures are pinned in their own directories. | `package.json` | `check:package` checks what the tarball contains. |

The repository also runs CodeQL, dependency review, secret scanning, OSV-Scanner, zizmor, npm provenance checks and OpenSSF Scorecard in GitHub Actions. See `.github/workflows/`. From the second release on, versions are published from GitHub Actions with npm provenance. The first one is published by hand and has none. See [releasing.md](releasing.md).

## Not covered

- **A decoder module.** It runs in the durable-lens process with your permissions, and it can do anything the process can. Use only a decoder you wrote or reviewed. durable-lens never sees the keys; the decoder reads them from its own environment.
- **A process running as you, or as root.** It can read the store, the process memory, the terminal output with the address and token, and the scratch copy while it exists.
- **The address in your browser.** The tokened URL is in your browser's history and address bar, and anyone you share it with, while the server runs, can read the store. A screenshot of the page shows the store path as you typed it. Do not share the URL.
- **Browser extensions** that can read pages.
- **Memory and time on large stores.** The whole store is read into memory. A very large store is slow and can exhaust memory. This is documented under Limits in the [README](../README.md).
- **Other users on a multi-user machine who can read the store file itself.** File permissions are the operating system's job.

## Reporting

A vulnerability in any of the above, or a way around a mitigation, is in scope. [SECURITY.md](../SECURITY.md) says how to report it.
