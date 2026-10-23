// Every fixture version and variant reads into the same story.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { openLens } from "../src/open.ts";
import type { Lens } from "../src/web/lens.ts";
import { fixture, VARIANTS, VERSIONS, type Variant, type Version } from "./support.ts";

const durableSleep = (version: Version) => version === "1.4.0" || version === "main";

function appTasks(lens: Lens): Record<string, string> {
	return Object.fromEntries(
		lens.tasks
			.filter((task) => task.kind.startsWith("app.") && task.kind !== "app.build")
			.map((task) => [task.kind, task.parked ? "parked" : task.status === "terminal" ? (task.outcome?.status ?? "?") : task.status]),
	);
}

// Each backend's fixture is its own run of the scenario, so clock readings and random session IDs differ.
const RUN_SPECIFIC = new Set(["timestamp", "durationMs", "api", "responseId", "startedAt", "endedAt", "until", "window", "at", "sessionId"]);
const withoutRunSpecific = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (key, item) => (RUN_SPECIFIC.has(key) ? undefined : item)));

/** What a store holds, without where it came from, when it ran, or how each backend numbers commits. */
function story(lens: Lens) {
	return withoutRunSpecific({
		conversations: lens.conversations.map(({ id, role, parent, owner, entryIds, model }) => ({ id, role, parent, owner, entryIds, model })),
		entries: lens.entries.map(({ id, kind, messages, byTaskId }) => ({ id, kind, messages, byTaskId })),
		tasks: lens.tasks.map(({ id, kind, status, owner, outcome, restarts, input }) => ({ id, kind, status, owner, outcome, restarts, input })),
		documents: lens.documents
			.filter((document) => document.kind !== "pi.live" && document.kind !== "pi.provider")
			.map(({ id, kind, scope, value }) => ({ id, kind, scope, value })),
		usage: lens.usage,
	});
}

for (const version of VERSIONS) {
	describe(`pi-durable ${version} fixtures`, () => {
		const lenses = new Map<Variant, Lens>();
		const read = async (variant: Variant) => {
			const cached = lenses.get(variant);
			if (cached !== undefined) return cached;
			const lens = await openLens(fixture(version, variant), { restartLimit: 3 });
			lenses.set(variant, lens);
			return lens;
		};

		for (const variant of VARIANTS) {
			it(`${variant}: conversations, transcript, tasks, documents and usage`, async () => {
				const lens = await read(variant);
				assert.deepEqual(lens.warnings, []);
				assert.deepEqual(
					lens.conversations.map((conversation) => conversation.role),
					["root", "subagent", "fork"],
				);
				const [root, subagent, fork] = lens.conversations;
				assert.equal(root?.model, "faux/faux-large");
				assert.equal(subagent?.model, "faux/faux-small");
				assert.equal(fork?.model, "faux/faux-small");
				assert.equal(fork?.parent?.conversationId, 1);
				assert.equal(subagent?.owner?.conversationId, 1);

				assert.equal(lens.entries.length, 27);
				const results = lens.entries.filter((entry) => entry.kind === "pi.tool-result");
				assert.ok(results.every((entry) => (entry.durationMs ?? 0) >= 0 && entry.at !== undefined));
				const answer = lens.entries.find((entry) => entry.id === fork?.parent?.at);
				assert.equal(answer?.kind, "pi.assistant");
				assert.ok((answer?.usage?.cost ?? 0) > 0);

				const tools = lens.tasks.filter((task) => task.kind === "pi.tool");
				assert.ok(tools.length >= 7);
				assert.ok(tools.every((task) => task.label !== undefined), "every tool task is labelled with its tool");
				assert.ok(lens.tasks.filter((task) => task.kind === "pi.generation").every((task) => task.label?.startsWith("faux/")));

				const crashed = variant.endsWith("crashed");
				const expected = durableSleep(version)
					? { "app.release": "waiting", "app.recheck": "sleeping", "app.mirror-sync": "parked", "app.cleanup": "failed", "app.publish": "sleeping" }
					: { "app.release": "waiting", "app.recheck": crashed ? "running" : "pending", "app.mirror-sync": crashed ? "running" : "pending", "app.cleanup": "failed", "app.publish": crashed ? "running" : "pending" };
				assert.deepEqual(appTasks(lens), expected);

				const notes = lens.documents.find((document) => document.kind === "app.notes" && document.scope.conversationId === 1);
				assert.deepEqual(notes?.value, {
					items: ["#412 is a divide-by-zero in measure()", "Subagent drafted the #412 patch", "Release 2.4.0 after #412 lands", "#418 moves to 2.4.1"],
				});
				assert.equal(notes?.states?.length, 4);
				assert.deepEqual(notes?.states?.[0]?.value, { items: ["#412 is a divide-by-zero in measure()"] });
				const forkNotes = lens.documents.find((document) => document.kind === "app.notes" && document.scope.conversationId === fork?.id);
				assert.deepEqual(forkNotes?.value, { items: ["#412 is a divide-by-zero in measure()", "Fork: focus on #412 only"] }, "fork: asOf starts from the notes at the fork entry");

				assert.deepEqual(Object.keys(lens.usage.byModel).sort(), ["faux/faux-large", "faux/faux-small"]);
				assert.ok(lens.usage.total.cost > 0);
			});
		}

		it("detects the release range", async () => {
			const sqlite = await read("sqlite");
			const jsonl = await read("jsonl");
			assert.equal(sqlite.format.version, durableSleep(version) ? "pi-durable 1.4 or later" : "pi-durable 1.2–1.3");
			assert.equal(sqlite.format.schemaVersion, durableSleep(version) ? 2 : 1);
			assert.equal(jsonl.format.version, durableSleep(version) ? "pi-durable 1.4 or later" : "pi-durable 1.2 or later");
			assert.equal(jsonl.format.jsonlFormat, 1);
		});

		it("reads the same story from SQLite and JSONL", async () => {
			assert.deepEqual(story(await read("jsonl")), story(await read("sqlite")));
			assert.deepEqual(story(await read("jsonl-crashed")), story(await read("sqlite-crashed")));
		});

		it("reads a crashed SQLite store's WAL", async () => {
			const crashed = await read("sqlite-crashed");
			assert.ok(crashed.source.files.some((file) => file.name.endsWith("-wal") && file.size > 0), "the fixture still has its WAL");
			assert.deepEqual(
				crashed.entries.map((entry) => entry.id),
				(await read("sqlite")).entries.map((entry) => entry.id),
			);
		});
	});
}
