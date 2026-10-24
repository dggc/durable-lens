// Synthetic pi-durable session used for every fixture version.
//
// Everything here is invented: the project "acme/widgets", its issues, files and people. The faux provider stands in for
// the model, so no request leaves the machine. Each `v<version>/run.mjs` imports this file and passes in the modules of
// its own pi-durable version, so bare imports resolve against that version's node_modules.

import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const LARGE = { provider: "faux", modelId: "faux-large" };
const SMALL = { provider: "faux", modelId: "faux-small" };

/** Prices per million tokens, so the stored usage carries a nonzero cost as a real provider's would. */
const FAUX_MODELS = [
	{ id: "faux-large", name: "Faux Large", reasoning: true, cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } },
	{ id: "faux-small", name: "Faux Small", cost: { input: 0.25, output: 1.25, cacheRead: 0.03, cacheWrite: 0.3 } },
];

const ISSUES = {
	crash: [
		"#412 Renderer crashes when a widget has zero width (opened by a fictional user, 14 thumbs up)",
		"#418 Segfault in the native color picker on resize",
		"#431 Crash on startup when the cache directory is read-only",
	],
	regression: ["#405 Layout regression in 2.3.1: nested grids collapse", "#433 Tooltips render behind modals since 2.3.0"],
};

const RENDER_TS = `export function measure(widget: Widget): Size {
  const ratio = widget.height / widget.width; // #412: width can be 0
  return { width: widget.width, height: widget.width * ratio };
}`;

const UNTRUSTED_ANSWER = `Here is the fix order I propose for **acme/widgets**:

| Order | Issue | Why first |
|---|---|---|
| 1 | #412 | Crash on a common path; one-line guard in \`measure()\` |
| 2 | #431 | Startup crash, easy to reproduce |
| 3 | #418 | Native code, needs a debugger session |

\`\`\`ts
const ratio = widget.width === 0 ? 0 : widget.height / widget.width;
\`\`\`

A bug report pasted this, which must show as text and never run:
<img src=x onerror="alert('xss')"> <script>alert(1)</script> [docs](javascript:alert(1))`;

/** Wrap a pi-ai provider so each response's usage carries its cost, computed the way pi-ai providers do. */
function pricedProvider(provider, ai) {
	const price = (message, model) =>
		message?.usage === undefined ? message : { ...message, usage: { ...message.usage, cost: ai.calculateCost(model, { ...message.usage }) } };
	const wrap = (inner, model) => {
		const outer = ai.createAssistantMessageEventStream();
		void (async () => {
			for await (const event of inner) {
				if (event.type === "done") outer.push({ ...event, message: price(event.message, model) });
				else if (event.type === "error") outer.push({ ...event, error: price(event.error, model) });
				else outer.push(event);
			}
			outer.end(price(await inner.result(), model));
		})();
		return outer;
	};
	return {
		...provider,
		stream: (model, context, options) => wrap(provider.stream(model, context, options), model),
		streamSimple: (model, context, options) => wrap(provider.streamSimple(model, context, options), model),
	};
}

/** Registry, models and definitions shared by the generating process and the crash children. */
export function buildSetup(mods) {
	const { durable, ai, Type, chord } = mods;
	const { defineDoc, defineExtension, defineTask, defineTool, createRegistry, section } = durable;
	const hasSleep = mods.features.sleep;
	const never = (context) => chord.awaitWithContext(new Promise(() => {}), context);

	const faux = ai.fauxProvider({ models: FAUX_MODELS, tokensPerSecond: 600 });
	const models = ai.createModels();
	models.setProvider(pricedProvider(faux.provider, ai));

	const Notes = defineDoc({
		kind: "app.notes",
		version: 1,
		scope: "conversation",
		history: "rewindable",
		fork: "asOf",
		initial: () => ({ items: [] }),
		// Every third change is a complete base, so the store holds both bases and deltas.
		checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 2,
	});
	const Settings = defineDoc({
		kind: "app.settings",
		version: 1,
		scope: "session",
		initial: () => ({ repository: "acme/widgets", triageLabel: "crash", reviewers: [] }),
		checkpointWhen: () => false,
	});

	const Build = defineTask({
		name: "app.build",
		version: 1,
		initial: () => ({ phase: "compile" }),
		phases: {
			compile: async (_task, runtime, context) => {
				await delay(150);
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: { artifact: "widgets-2.4.0.tgz" } } }), context);
			},
		},
		abort: (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
	});
	// Waits for the release window: a durable sleep from 1.4.0 on, a phase that waits in memory before it.
	const Publish = defineTask({
		name: "app.publish",
		version: 1,
		initial: () => ({ phase: "wait" }),
		phases: {
			wait: (task, runtime, context) => (hasSleep ? runtime.sleepUntil(task.input.window, { phase: "upload" }, context) : never(context)),
			upload: (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context),
		},
		abort: (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
	});
	const Release = defineTask({
		name: "app.release",
		version: 1,
		initial: () => ({ phase: "start" }),
		phases: {
			start: async (task, runtime, context) => {
				await runtime.commit(async (tx) => {
					const owner = { ownership: { kind: "task", taskId: task.id } };
					const build = await tx.createTask(Build, { version: task.input.version }, owner);
					const publish = await tx.createTask(Publish, { version: task.input.version, window: task.input.window }, owner);
					return { status: "waiting", checkpoint: { phase: "announce", build, publish }, on: [build, publish], policy: "allSettled" };
				}, context);
			},
			announce: (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context),
		},
		abort: (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
	});
	const Recheck = defineTask({
		name: "app.recheck",
		version: 1,
		initial: () => ({ phase: "wait" }),
		phases: {
			wait: (task, runtime, context) => (hasSleep ? runtime.sleepUntil(task.input.at, { phase: "check" }, context) : never(context)),
			check: (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context),
		},
		abort: (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
	});
	// Never commits progress: each crash child cuts it off while it runs, which 1.4.0 counts as a restart.
	const MirrorSync = defineTask({
		name: "app.mirror-sync",
		version: 1,
		initial: () => ({ phase: "sync" }),
		phases: { sync: (_task, _runtime, context) => never(context) },
		abort: (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
	});
	const Cleanup = defineTask({
		name: "app.cleanup",
		version: 1,
		initial: () => ({ phase: "run" }),
		phases: {
			run: (_task, runtime, context) =>
				runtime.commit(
					() => ({
						status: "terminal",
						outcome: { status: "failed", error: { message: "Cache directory is read-only", detail: { path: "/var/cache/widgets" } } },
					}),
					context,
				),
		},
		abort: (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
	});

	const text = (value) => ({ output: [{ type: "text", text: value }] });
	const tools = [
		defineTool({
			name: "search_issues",
			description: "Search the issue tracker by label.",
			parameters: Type.Object({ label: Type.String() }),
			execute: async (args) => {
				await delay(350);
				return text((ISSUES[args.label] ?? []).join("\n") || "No issues found.");
			},
		}),
		defineTool({
			name: "read_file",
			description: "Read a file from the repository.",
			parameters: Type.Object({ path: Type.String() }),
			execute: async () => {
				await delay(120);
				return text(RENDER_TS);
			},
		}),
		defineTool({
			name: "take_note",
			description: "Save a note on this conversation.",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (args, api, context) => {
				await api.commit(async (tx) => {
					(await tx.doc(Notes, api.conversationId)).items.push(args.text);
				}, context);
				return text("Noted.");
			},
		}),
		defineTool({
			name: "delegate",
			description: "Delegate a self-contained task to a subagent and get its answer back.",
			parameters: Type.Object({ task: Type.String() }),
			replay: "safe",
			execute: async (args, api, context) => {
				const child = await api.commit(async (tx) => {
					const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
					if (existing !== undefined) return existing.id;
					const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
					await durable.configure(tx, created.id, { model: SMALL });
					return created.id;
				}, context);
				await api.details({ conversationId: child }, context);
				const handle = await api.conversation(child, context);
				const request = { type: "input", content: args.task, requestId: `delegate:${api.taskId}` };
				const settled = await (await handle.submit(request, context)).wait(context);
				return text(`Subagent finished: ${settled.status}`);
			},
		}),
	];

	const registry = createRegistry();
	registry.install(
		defineExtension({
			name: "triage",
			sections: [
				section(
					"triage",
					() => "You triage issues for the acme/widgets repository. Search before you answer, keep notes with take_note, and delegate patches to a subagent.",
				),
			],
			tools,
			tasks: [Build, Publish, Release, Recheck, MirrorSync, Cleanup],
		}),
	);
	const settings = hasSleep ? { restartLimit: 3 } : {};
	return { faux, models, registry, settings, docs: { Notes, Settings }, tasks: { Release, Recheck, MirrorSync, Cleanup, Build } };
}

async function openStorage(mods, kind, path) {
	return kind === "sqlite" ? mods.openSqlite(path) : mods.openJsonl(path, mods.chord.BACKGROUND_CONTEXT);
}

async function openHarness(mods, setup, kind, path) {
	const storage = await openStorage(mods, kind, path);
	return mods.durable.Harness.open(
		storage,
		{ models: setup.models, registry: setup.registry, settings: setup.settings, onReport: () => {} },
		mods.chord.BACKGROUND_CONTEXT,
	);
}

async function ask(conversation, content, context) {
	const settled = await (await conversation.submit({ type: "input", content }, context)).wait(context);
	if (settled.status !== "done") throw new Error(`input was ${settled.status}: ${settled.reason ?? ""}`);
	return settled;
}

/** Write the full scenario into a new store, then cut the mirror sync off with crashing child processes. */
export async function generate(mods, { kind, path, runScript, crashes }) {
	const context = mods.chord.BACKGROUND_CONTEXT;
	const setup = buildSetup(mods);
	const { faux } = setup;
	const { fauxAssistantMessage, fauxToolCall: call, fauxThinking: think } = mods.ai;
	// Factories build each message when the model is called, as a real provider does, so pi-ai times the response.
	const say =
		(...args) =>
		() =>
			fauxAssistantMessage(...args);
	const harness = await openHarness(mods, setup, kind, path);
	const root = await harness.root(context, { agent: { model: LARGE } });

	await harness.commit(async (tx) => {
		const settings = await tx.doc(setup.docs.Settings);
		settings.reviewers.push("ana", "bruno");
	}, context);

	// Turn 1: two rounds of tools, then a Markdown answer that carries untrusted HTML.
	faux.setResponses([
		say([think("The user wants crash bugs first. Search by label."), call("search_issues", { label: "crash" }, { id: "call_search_1" })], {
			stopReason: "toolUse",
		}),
		say(
			[
				call("read_file", { path: "src/render.ts" }, { id: "call_read_1" }),
				call("search_issues", { label: "regression" }, { id: "call_search_2" }),
				call("take_note", { text: "#412 is a divide-by-zero in measure()" }, { id: "call_note_1" }),
			],
			{ stopReason: "toolUse" },
		),
		say(UNTRUSTED_ANSWER),
	]);
	const first = await ask(root, "Summarize the open bugs labelled `crash` in acme/widgets and propose a fix order.", context);

	// Turn 2: a subagent drafts the patch on the cheaper model.
	faux.setResponses([
		say([call("delegate", { task: "Draft a patch for #412 with a regression test." }, { id: "call_delegate_1" })], { stopReason: "toolUse" }),
		say("Patch drafted: guard `measure()` against zero width and add `measure.test.ts` covering width 0."),
		say([call("take_note", { text: "Subagent drafted the #412 patch" }, { id: "call_note_2" })], { stopReason: "toolUse" }),
		say("The subagent drafted the patch for #412. I noted it; review it before the 2.4.0 release."),
	]);
	await ask(root, "Have a subagent draft the patch for #412.", context);

	// Turn 3: a short exchange, so the transcript has a plain question and answer after the tools.
	faux.setResponses([
		say(
			[
				call("take_note", { text: "Release 2.4.0 after #412 lands" }, { id: "call_note_3" }),
				call("take_note", { text: "#418 moves to 2.4.1" }, { id: "call_note_4" }),
			],
			{ stopReason: "toolUse" },
		),
		say("Yes. Ship 2.4.0 once #412 is merged; #418 can wait for 2.4.1."),
	]);
	await ask(root, "Can we ship 2.4.0 this week?", context);

	// A fork from the first answer, continued on the small model: the branch the viewer shows side by side.
	const fork = await root.fork(first.answer, { ownership: { kind: "ownerless" }, agent: { model: SMALL } }, context);
	faux.setResponses([
		say([call("take_note", { text: "Fork: focus on #412 only" }, { id: "call_note_fork" })], { stopReason: "toolUse" }),
		say("Only #412 matters for this week: it crashes on a common path and the fix is one line."),
	]);
	await ask(fork, "Same question, but list only the single most urgent issue.", context);

	// Tasks: a release waiting on its build and publish, a recheck for tomorrow, a failed cleanup, an aborted one.
	const now = Date.now();
	const tomorrow = now + 24 * 60 * 60 * 1000;
	await root.commit(async (tx) => {
		await tx.createTask(setup.tasks.Release, { version: "2.4.0", window: tomorrow }, { ownership: { kind: "conversation" } });
		await tx.createTask(setup.tasks.Recheck, { issue: 412, at: tomorrow }, { ownership: { kind: "conversation" }, background: true });
		await tx.createTask(setup.tasks.MirrorSync, { remote: "mirror.example.invalid" }, { ownership: { kind: "conversation" }, background: true });
	}, context);
	const cleanup = await root.commit((tx) => tx.createTask(setup.tasks.Cleanup, {}, { ownership: { kind: "conversation" } }), context);
	await harness.waitForTask(cleanup, context);
	const aborted = await root.commit((tx) => tx.createTask(setup.tasks.Build, { version: "2.3.9" }, { ownership: { kind: "conversation" } }), context);
	await harness.abortTask(aborted, context);
	await waitFor(async () => (await harness.inspect(context)).tasks?.some?.((t) => t.record?.kind === "app.publish"));
	await delay(400);
	await harness.close(context);

	// Crash loop: each child opens the store, lets the mirror sync start, and exits without closing.
	for (let i = 0; i < crashes; i++) await runChild(runScript, ["crash", kind, path]);
}

/** Child process: open, resume, and die once the mirror sync is running (or after a short wait once it is parked). */
export async function crashChild(mods, { kind, path }) {
	const context = mods.chord.BACKGROUND_CONTEXT;
	const setup = buildSetup(mods);
	const harness = await openHarness(mods, setup, kind, path);
	harness.resume();
	const deadline = Date.now() + 3000;
	while (Date.now() < deadline) {
		const inspection = await harness.inspect(context);
		const running = (inspection.tasks ?? []).some((task) => task.record?.kind === "app.mirror-sync" && task.record.state.status === "running");
		if (running) break;
		await delay(50);
	}
	await delay(200);
	process.exit(0);
}

/** Reopen without resuming and close, which leaves an idle store (SQLite checkpoints and drops its WAL). */
export async function settle(mods, { kind, path }) {
	const context = mods.chord.BACKGROUND_CONTEXT;
	const setup = buildSetup(mods);
	const harness = await openHarness(mods, setup, kind, path);
	await harness.close(context);
}

/** Owner process for the live test: open, keep the Harness open, and print "ready" until stdin closes. */
export async function hold(mods, { kind, path }) {
	const context = mods.chord.BACKGROUND_CONTEXT;
	const setup = buildSetup(mods);
	const harness = await openHarness(mods, setup, kind, path);
	process.stdout.write("ready\n");
	process.stdin.resume();
	await new Promise((resolve) => process.stdin.on("end", resolve));
	await harness.close(context);
}

/** Owner process that keeps committing: a session document change every few milliseconds until stdin closes. */
export async function churn(mods, { kind, path }) {
	const context = mods.chord.BACKGROUND_CONTEXT;
	const setup = buildSetup(mods);
	const harness = await openHarness(mods, setup, kind, path);
	let open = true;
	process.stdin.on("end", () => {
		open = false;
	});
	process.stdin.resume();
	process.stdout.write("ready\n");
	for (let i = 0; open; i++) {
		await harness.commit(async (tx) => {
			const settings = await tx.doc(setup.docs.Settings);
			settings.reviewers.push(`reviewer-${i}`);
			if (settings.reviewers.length > 20) settings.reviewers.splice(0, 10);
		}, context);
		await delay(2);
	}
	await harness.close(context);
}

async function waitFor(check, timeoutMs = 5000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await check()) return;
		await delay(50);
	}
}

function runChild(script, args) {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [script, ...args], { stdio: ["ignore", "inherit", "inherit"] });
		child.on("error", reject);
		child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`crash child exited ${code}`))));
	});
}
