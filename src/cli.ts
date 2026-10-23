#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { DEFAULT_RESTART_LIMIT } from "./model.ts";
import { loadDecoder, openLens } from "./open.ts";
import { serve } from "./server.ts";

const USAGE = `durable-lens: a read-only inspector for pi-durable storage

Usage: durable-lens <store> [options]

  <store>               a SQLite file, or a JSONL storage directory (the one with main.jsonl)

Options:
  -p, --port <n>        port on 127.0.0.1 (default: a free one)
      --open            open the page in your browser
      --json            print the store as JSON and exit, without a server
      --decoder <file>  module whose default export decodes payloads an adapter encrypted or compressed
      --prefix <p>      SQLite table prefix, when several storages share one database
      --restart-limit <n>
                        the host's settings.restartLimit, to mark parked tasks (default ${DEFAULT_RESTART_LIMIT})
      --no-watch        read once; do not follow changes
  -v, --version
  -h, --help

durable-lens never opens your store for writing. SQLite is read from a private copy of the database and its WAL, and
JSONL files are only read, so it is safe to point at a store a running harness owns.`;

async function main(): Promise<number> {
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		options: {
			port: { type: "string", short: "p" },
			open: { type: "boolean" },
			json: { type: "boolean" },
			decoder: { type: "string" },
			prefix: { type: "string" },
			"restart-limit": { type: "string" },
			"no-watch": { type: "boolean" },
			version: { type: "boolean", short: "v" },
			help: { type: "boolean", short: "h" },
		},
	});
	if (values.help) {
		console.log(USAGE);
		return 0;
	}
	if (values.version) {
		const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
		console.log(pkg.version);
		return 0;
	}
	const [store] = positionals;
	if (store === undefined || positionals.length > 1) {
		console.error(USAGE);
		return 2;
	}
	const restartLimit = values["restart-limit"] === undefined ? undefined : Number(values["restart-limit"]);
	if (restartLimit !== undefined && !(restartLimit >= 1)) throw new Error("--restart-limit must be a positive number");
	const options = {
		...(values.decoder === undefined ? {} : { decode: await loadDecoder(values.decoder), decoderName: values.decoder }),
		...(values.prefix === undefined ? {} : { prefix: values.prefix }),
		...(restartLimit === undefined ? {} : { restartLimit }),
	};

	if (values.json) {
		process.stdout.write(`${JSON.stringify(await openLens(store, options), null, 2)}\n`);
		return 0;
	}
	const running = await serve(store, {
		...options,
		...(values.port === undefined ? {} : { port: Number(values.port) }),
		watch: !values["no-watch"],
	});
	const lens = running.lens();
	console.log(`durable-lens: ${lens?.format.version}, ${lens?.conversations.length} conversations, ${lens?.tasks.length} tasks`);
	console.log(`  ${running.url}`);
	console.log("  read-only; Ctrl-C to stop");
	if (values.open) openBrowser(running.url);
	await new Promise<void>((done) => {
		process.once("SIGINT", done);
		process.once("SIGTERM", done);
	});
	await running.close();
	return 0;
}

function openBrowser(url: string): void {
	const [command, args] =
		process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
	const child = spawn(command as string, args as string[], { stdio: "ignore", detached: true });
	child.on("error", () => console.error(`could not open a browser; open ${url}`));
	child.unref();
}

main().then(
	(code) => process.exit(code),
	(error: Error) => {
		console.error(`durable-lens: ${error.message}`);
		process.exit(1);
	},
);
