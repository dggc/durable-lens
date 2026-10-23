// Copied into each v<version>/ directory as run.mjs (see ../README.md), so these bare imports resolve against that
// version's own node_modules. Usage: node run.mjs <generate|crash|settle|hold|churn> <sqlite|jsonl> <path> [crashes]
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as chord from "@earendil-works/chord/context";
import { calculateCost, createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import * as durable from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Type } from "typebox";
import { churn, crashChild, generate, hold, settle } from "../scenario.mjs";

const installed = JSON.parse(
	readFileSync(new URL("./node_modules/@earendil-works/pi-durable/package.json", import.meta.url), "utf8"),
).version;
const [major, minor] = installed.split(".").map(Number);
const mods = {
	version: installed,
	features: { sleep: major > 1 || minor >= 4 },
	chord,
	durable,
	Type,
	ai: { calculateCost, createModels, createAssistantMessageEventStream, fauxAssistantMessage, fauxProvider, fauxText, fauxThinking, fauxToolCall },
	openSqlite: (path) => openNodeSqliteStorage(path),
	openJsonl: (path, context) => openNodeJsonlStorage(path, context),
};

const [mode, kind, path, crashes = "4"] = process.argv.slice(2);
const options = { kind, path, runScript: fileURLToPath(import.meta.url), crashes: Number(crashes) };
const run = { generate, crash: crashChild, settle, hold, churn }[mode];
if (run === undefined || (kind !== "sqlite" && kind !== "jsonl") || path === undefined) {
	console.error("usage: node run.mjs <generate|crash|settle|hold|churn> <sqlite|jsonl> <path> [crashes]");
	process.exit(2);
}
await run(mods, options);
