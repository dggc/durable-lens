# Command line

```
durable-lens <store> [options]
```

The examples here use `npx durable-lens`. After `npm install --global durable-lens`, drop the `npx`. From a clone, after `npm ci && npm run build`, `node dist/cli.js` takes its place.

`<store>` is one of:

- a SQLite file written by a pi-durable SQLite storage;
- a JSONL storage directory, the one that contains `main.jsonl`.

Anything else is an error: a directory without `main.jsonl`, a file that is not a SQLite database, or a database without a `durable_schema` table. A relative path is resolved against the current directory. durable-lens never opens the store for writing.

## Options

| Option | Meaning |
|---|---|
| `-p`, `--port <n>` | Port to listen on, on 127.0.0.1. The default is a free port chosen by the system. Ignored with `--json`. |
| `--open` | Open the page in your browser. durable-lens runs `xdg-open` (Linux and other systems), `open` (macOS) or `cmd /c start` (Windows) with a link that works once and redirects to the tokened address. If the command cannot be started (for example, `xdg-open` is not installed), it prints `could not open a browser; open the URL above` on standard error, without the `durable-lens:` prefix. The address is printed in any case. |
| `--json` | Print the store as JSON on standard output and exit. No server starts. The output is the [Lens](json-output.md), indented by two spaces. |
| `--decoder <file>` | A module whose default export (or a named export `decode`) decodes payloads that an adapter encrypted or compressed. See [decoders.md](decoders.md). The module runs in the durable-lens process. |
| `--prefix <p>` | The SQLite table prefix, for a database that holds several pi-durable storages. Without it, durable-lens detects the prefix, and warns if it finds more than one. |
| `--restart-limit <n>` | The host's `settings.restartLimit`, used to mark parked tasks. The store does not record it. The default is 5, which is pi-durable 1.4.0's default. It must be a number of 1 or more. |
| `--no-watch` | Read the store once. Without it, the server checks the files every second and rereads when they change. |
| `-v`, `--version` | Print the version and exit. |
| `-h`, `--help` | Print the usage text and exit. |

The usage text printed by `--help` is:

```
durable-lens: a read-only inspector for pi-durable storage

Usage: durable-lens <store> [options]

  <store>               a SQLite file, or a JSONL storage directory (the one with main.jsonl)

Options:
  -p, --port <n>        port on 127.0.0.1 (default: a free one)
      --open            open the page in your browser
      --json            print the store as JSON and exit, without a server
      --decoder <file>  module whose default export decodes payloads an adapter encrypted or compressed
      --prefix <p>      SQLite table prefix, when several storages share one database
      --restart-limit <n>
                        the host's settings.restartLimit, to mark parked tasks (default 5)
      --no-watch        read once; do not follow changes
  -v, --version
  -h, --help

durable-lens never opens your store for writing. SQLite is read from a private copy of the database and its WAL, and
JSONL files are only read, so it is safe to point at a store a running harness owns.
```

There is no option to listen on another address. The server always uses 127.0.0.1.

## What it prints

With a server, three lines on standard output once the first read has finished:

```
durable-lens: pi-durable 1.4 or later, 3 conversations, 27 tasks
  http://127.0.0.1:38135/lT-dAgpmrBe1XrmFtxZUHHz6/
  read-only; Ctrl-C to stop
```

The second line is the address. The last part of it is a random token that changes on every run, and everything is served under it. Treat the address as private. The process keeps running until a signal arrives.

Errors go to standard error as `durable-lens: <message>`. The messages are listed in [troubleshooting.md](troubleshooting.md).

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Finished: `--help`, `--version`, or `--json` printed the store. |
| 1 | An error: the store could not be read, an option is invalid or unknown, the decoder could not be loaded or failed, or the server could not start. The message is on standard error. Also when the read never finished because the decoder returned a promise that never settles. |
| 2 | No store given, or more than one. The usage text is printed on standard error. |
| 129 | Stopped by SIGHUP. |
| 130 | Stopped by SIGINT (Ctrl-C). |
| 143 | Stopped by SIGTERM. |

On a signal, durable-lens first removes any snapshot copy of a SQLite store that it still holds.

## Environment

durable-lens reads no environment variables of its own. The temporary directory for snapshot copies is the operating system's (`TMPDIR` on Linux and macOS). A decoder module can read whatever variables it needs, such as `DURABLE_LENS_KEY` in the example.

## Examples

Look at a SQLite store:

```sh
npx durable-lens ./session.sqlite
```

A JSONL store, on a fixed port, opened in the browser:

```sh
npx durable-lens ./session --port 4800 --open
```

A database that holds several pi-durable storages, with table names such as `agent_entries`:

```sh
npx durable-lens ./app.sqlite --prefix agent_
```

A store from a host that sets `restartLimit` to 3, read once:

```sh
npx durable-lens ./session.sqlite --restart-limit 3 --no-watch
```

An encrypted store, with a copy of the [example decoder](../examples/decoder-aes-gcm.mjs) in the current directory:

```sh
DURABLE_LENS_KEY=... npx durable-lens ./app.sqlite --decoder ./decoder-aes-gcm.mjs
```

Total cost, and the parked tasks, from the JSON output:

```sh
npx durable-lens ./session.sqlite --json | jq '.usage.total.cost'
npx durable-lens ./session.sqlite --json | jq '[.tasks[] | select(.parked) | {id, kind, restarts}]'
```

`--json` output holds your transcripts. Do not attach it to an issue.
