import { type Child, dateTime, duration, h, pill, relative } from "./dom.ts";
import { jsonTree } from "./json.ts";
import type { LensTask } from "./lens.ts";
import type { Context } from "./state.ts";

const LIVE = new Set(["pending", "running", "waiting", "sleeping", "completing"]);

export function taskTone(task: LensTask): string {
	if (task.parked) return "bad";
	switch (task.outcome?.status ?? task.status) {
		case "running":
			return "accent";
		case "waiting":
		case "completing":
			return "info";
		case "sleeping":
			return "sleep";
		case "pending":
			return "warn";
		case "completed":
			return "ok";
		case "failed":
		case "faulted":
		case "orphaned":
			return "bad";
		case "aborted":
			return "muted";
		default:
			return "muted";
	}
}

export function statusText(task: LensTask): string {
	if (task.parked) return "parked";
	if (task.status === "terminal" || task.status === "completing") return task.outcome?.status ?? task.status;
	return task.status;
}

/** One line of what the task is waiting for, why it stopped, or how long it took. */
function note(ctx: Context, task: LensTask): Child[] {
	const notes: Child[] = [];
	if (task.parked) notes.push(h("span", { class: "tone-bad" }, `crashed ${task.restarts} times in a row; parked until Harness.retryTask(${task.id})`));
	else if (task.restarts !== undefined && task.restarts > 0)
		notes.push(
			h("span", { class: "tone-warn" }, `${task.restarts} restart${task.restarts === 1 ? "" : "s"} after crashes (parks at ${ctx.lens.restartLimit})`),
		);
	if (task.status === "waiting" && task.on !== undefined) {
		notes.push(
			h(
				"span",
				null,
				"waiting on ",
				task.on.map((id, i) => [i > 0 ? ", " : "", h("a", { href: ctx.link({ task: id }) }, `#${id}`)]),
				` (${task.policy ?? "?"})`,
			),
		);
	}
	if (task.status === "sleeping" && task.until !== undefined) notes.push(h("span", null, `sleeps until ${dateTime(task.until)} (${relative(task.until)})`));
	if (task.status === "running" && task.endedAt === undefined)
		notes.push(h("span", { class: "muted" }, "running when the store was last written: a live owner, or a crash its next open recovers"));
	const error = task.outcome?.error;
	if (error !== undefined && error !== null && typeof error === "object" && !Array.isArray(error) && typeof error.message === "string")
		notes.push(h("span", { class: "tone-bad" }, error.message));
	if (task.outcome?.reason !== undefined) notes.push(h("span", { class: "muted" }, task.outcome.reason));
	if (task.abortRequested) notes.push(pill(task.abortReason === "restart" ? "abandoned on restart" : "abort requested", "warn"));
	if (task.background) notes.push(pill("background", "muted"));
	return notes;
}

function row(ctx: Context, task: LensTask): HTMLElement {
	const took = task.startedAt !== undefined && task.endedAt !== undefined ? duration(task.endedAt - task.startedAt) : LIVE.has(task.status) ? "live" : "";
	return h(
		"a",
		{ class: `task-row ${ctx.route.task === task.id ? "selected" : ""}`, href: ctx.link({ view: "tasks", task: task.id }) },
		h("span", { class: "indent" }),
		pill(statusText(task), taskTone(task)),
		h("span", { class: "task-kind" }, task.kind),
		task.label === undefined ? null : h("span", { class: "tool-name" }, task.label),
		h("span", { class: "muted mono" }, `#${task.id}`),
		task.phase === undefined || !LIVE.has(task.status) ? null : h("span", { class: "muted" }, `phase ${task.phase}`),
		h("span", { class: "task-note" }, note(ctx, task)),
		h("span", { class: "metric" }, took),
	);
}

function tree(ctx: Context, tasks: LensTask[], visible: (task: LensTask) => boolean): HTMLElement[] {
	const byId = ctx.index.tasks;
	const rows: HTMLElement[] = [];
	const walk = (task: LensTask, depth: number) => {
		if (visible(task)) {
			const element = row(ctx, task);
			element.style.setProperty("--depth", String(depth));
			rows.push(element);
		}
		for (const child of task.children) {
			const next = byId.get(child);
			if (next !== undefined) walk(next, visible(task) ? depth + 1 : depth);
		}
	};
	for (const task of tasks) if (task.owner === undefined || !byId.has(task.owner)) walk(task, 0);
	return rows;
}

function details(ctx: Context, task: LensTask): HTMLElement {
	const conversation = ctx.index.conversations.get(task.conversationId);
	const owned = ctx.index.ownedBy.get(task.id) ?? [];
	const field = (label: string, value: Child) =>
		h("div", { class: "field" }, h("div", { class: "field-label" }, label), h("div", { class: "field-value" }, value));
	return h(
		"aside",
		{ class: "details" },
		h(
			"div",
			{ class: "details-head" },
			pill(statusText(task), taskTone(task)),
			h("h3", null, task.kind, task.label === undefined ? "" : ` ${task.label}`),
			h("span", { class: "muted mono" }, `#${task.id}`),
		),
		h("div", { class: "task-note block" }, note(ctx, task)),
		field(
			"conversation",
			h(
				"a",
				{ href: ctx.link({ view: "timeline", conversation: task.conversationId, entry: task.entryId ?? task.callEntryId }) },
				`#${task.conversationId} ${conversation?.label ?? ""}`,
			),
		),
		task.owner === undefined ? field("owner", "its conversation") : field("owner", h("a", { href: ctx.link({ task: task.owner }) }, `task #${task.owner}`)),
		task.children.length === 0
			? null
			: field(
					"owns",
					task.children.map((id, i) => [i > 0 ? " " : "", h("a", { class: "chip", href: ctx.link({ task: id }) }, `#${id}`)]),
				),
		owned.length === 0
			? null
			: field(
					"conversations",
					owned.map((c) => h("a", { class: "chip tone-accent", href: ctx.link({ view: "timeline", conversation: c.id }) }, `↳ #${c.id}`)),
				),
		field("started", task.startedAt === undefined ? "—" : `${dateTime(task.startedAt)} (${relative(task.startedAt)})`),
		field("ended", task.endedAt === undefined ? "—" : `${dateTime(task.endedAt)} · took ${duration(task.endedAt - (task.startedAt ?? task.endedAt))}`),
		task.version === undefined ? null : field("definition version", String(task.version)),
		task.restarts === undefined
			? null
			: field("restarts", `${task.restarts} (restart limit ${ctx.lens.restartLimit}; set --restart-limit to your settings.restartLimit)`),
		task.entryId === undefined
			? null
			: field("produced", h("a", { href: ctx.link({ view: "timeline", conversation: task.conversationId, entry: task.entryId }) }, `entry #${task.entryId}`)),
		h("div", { class: "json-block" }, h("div", { class: "field-label" }, "input"), jsonTree(task.input, 2)),
		task.checkpoint === undefined ? null : h("div", { class: "json-block" }, h("div", { class: "field-label" }, "checkpoint"), jsonTree(task.checkpoint, 2)),
		task.outcome === undefined ? null : h("div", { class: "json-block" }, h("div", { class: "field-label" }, "outcome"), jsonTree(task.outcome as never, 3)),
		task.memos === undefined ? null : h("div", { class: "json-block" }, h("div", { class: "field-label" }, "memos"), jsonTree(task.memos, 1)),
	);
}

export function tasksView(ctx: Context): HTMLElement {
	const tasks = ctx.lens.tasks;
	const builtins = ctx.route.builtins === true;
	// Finished generations and tool calls are the transcript's own story; by default the graph shows the rest.
	const visible = (task: LensTask) => builtins || LIVE.has(task.status) || !task.kind.startsWith("pi.");
	const counts = new Map<string, number>();
	for (const task of tasks) counts.set(statusText(task), (counts.get(statusText(task)) ?? 0) + 1);
	const selected = ctx.route.task === undefined ? undefined : ctx.index.tasks.get(ctx.route.task);
	const groups = ctx.lens.conversations
		.map((conversation) => ({
			conversation,
			rows: tree(
				ctx,
				tasks.filter((task) => task.conversationId === conversation.id),
				visible,
			),
		}))
		.filter((group) => group.rows.length > 0);
	return h(
		"div",
		{ class: "view split" },
		h(
			"div",
			{ class: "split-main" },
			h(
				"header",
				{ class: "view-head" },
				h("div", { class: "view-title" }, h("h2", null, "Task graph")),
				h(
					"div",
					{ class: "view-sub" },
					[...counts].map(([status, count]) => {
						const sample = tasks.find((task) => statusText(task) === status) as LensTask;
						return pill(`${count} ${status}`, taskTone(sample));
					}),
					h(
						"a",
						{ class: `chip ${builtins ? "tone-accent" : ""}`, href: ctx.link({ builtins: !builtins }) },
						builtins ? "hide finished pi.generation / pi.tool" : "show finished pi.generation / pi.tool",
					),
				),
			),
			groups.length === 0
				? h("div", { class: "empty" }, "No tasks to show.")
				: groups.map(({ conversation, rows }) =>
						h(
							"section",
							{ class: "task-group" },
							h("h4", null, h("a", { href: ctx.link({ view: "timeline", conversation: conversation.id }) }, `#${conversation.id} ${conversation.label}`)),
							rows,
						),
					),
		),
		selected === undefined ? h("aside", { class: "details empty" }, "Select a task to see its input, checkpoint and outcome.") : details(ctx, selected),
	);
}
