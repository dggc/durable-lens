import { type Child, clock, cost, duration, h, pill, tokens } from "./dom.ts";
import { jsonTree } from "./json.ts";
import type { Json, LensConversation, LensEntry, LensTask } from "./lens.ts";
import { markdown } from "./markdown.ts";
import type { Context } from "./state.ts";

type Obj = { [key: string]: Json };
const isObj = (value: unknown): value is Obj => value !== null && typeof value === "object" && !Array.isArray(value);

export const KIND_LABEL: Record<string, string> = {
	"pi.user": "User",
	"pi.assistant": "Assistant",
	"pi.tool-result": "Tool result",
	"pi.system": "System",
	"pi.compaction": "Compaction",
	"pi.reset": "Reset",
};

/** The entries a conversation shows, oldest first: inherited ones (through `parent.at`) and its own. */
export function transcript(ctx: Context, conversation: LensConversation): { inherited: LensEntry[]; own: LensEntry[] } {
	const own = conversation.entryIds.map((id) => ctx.index.entries.get(id)).filter((entry): entry is LensEntry => entry !== undefined);
	const inherited: LensEntry[] = [];
	let parent = conversation.parent;
	const seen = new Set([conversation.id]);
	while (parent !== undefined && !seen.has(parent.conversationId)) {
		seen.add(parent.conversationId);
		const source = ctx.index.conversations.get(parent.conversationId);
		if (source === undefined) break;
		const at = parent.at;
		inherited.unshift(
			...source.entryIds
				.filter((id) => id <= at)
				.map((id) => ctx.index.entries.get(id))
				.filter((entry): entry is LensEntry => entry !== undefined),
		);
		parent = source.parent;
	}
	inherited.sort((a, b) => a.id - b.id);
	return { inherited, own };
}

/** `{ diagnostics: [] }` and the like: nothing worth a row. */
function isEmpty(value: Json): boolean {
	if (Array.isArray(value)) return value.length === 0;
	if (isObj(value)) return Object.values(value).every(isEmpty);
	return false;
}

function textParts(content: Json | undefined): string[] {
	if (typeof content === "string") return [content];
	if (!Array.isArray(content)) return [];
	return content.filter(isObj).filter((part) => part.type === "text" && typeof part.text === "string").map((part) => String(part.text));
}

function contentBlocks(ctx: Context, entry: LensEntry, content: Json | undefined): Child[] {
	if (typeof content === "string") return [markdown(content)];
	if (!Array.isArray(content)) return [];
	return content.filter(isObj).map((part) => {
		switch (part.type) {
			case "text":
				return markdown(String(part.text ?? ""));
			case "thinking":
				return h("details", { class: "thinking" }, h("summary", null, "thinking"), h("div", { class: "thinking-body" }, String(part.thinking ?? "")));
			case "toolCall":
				return toolCall(ctx, entry, part);
			case "image":
				return h("div", { class: "muted" }, `image (${String(part.mimeType ?? "unknown type")}, not shown)`);
			default:
				return h("div", { class: "raw" }, jsonTree(part, 1));
		}
	});
}

function toolCall(ctx: Context, entry: LensEntry, call: Obj): HTMLElement {
	const id = String(call.id ?? "");
	const result = ctx.index.results.get(`${entry.conversationId}:${id}`);
	const task = ctx.index.toolTasks.get(`${entry.id}:${id}`);
	const owned = task === undefined ? [] : (ctx.index.ownedBy.get(task.id) ?? []);
	const resultMessage = result?.messages.find((message) => isObj(message) && message.toolCallId === id);
	const isError = isObj(resultMessage) && resultMessage.isError === true;
	return h(
		"div",
		{ class: "tool-call" },
		h(
			"div",
			{ class: "tool-call-head" },
			h("span", { class: "tool-name" }, String(call.name ?? "?")),
			h("span", { class: "muted mono" }, id),
			result === undefined
				? pill("no result", "warn")
				: h("a", { class: `chip ${isError ? "tone-bad" : ""}`, href: ctx.link({ entry: result.id }) }, `→ result #${result.id}${result.durationMs === undefined ? "" : ` · ${duration(result.durationMs)}`}`),
			task === undefined ? null : h("a", { class: "chip", href: ctx.link({ view: "tasks", task: task.id }) }, `task #${task.id}`),
			owned.map((conversation) => h("a", { class: "chip tone-accent", href: ctx.link({ view: "timeline", conversation: conversation.id, compare: false }) }, `↳ subagent #${conversation.id}`)),
		),
		h("div", { class: "tool-args" }, jsonTree(call.arguments, 1)),
	);
}

function header(ctx: Context, entry: LensEntry): HTMLElement {
	const label = KIND_LABEL[entry.kind] ?? entry.kind;
	const toolName = entry.messages.filter(isObj).find((message) => message.role === "toolResult")?.toolName;
	return h(
		"div",
		{ class: "card-head" },
		h("span", { class: "card-kind" }, label, toolName === undefined ? null : h("span", { class: "tool-name" }, ` ${String(toolName)}`)),
		entry.model === undefined ? null : h("span", { class: "muted" }, entry.model),
		entry.durationMs === undefined ? null : h("span", { class: "metric" }, duration(entry.durationMs)),
		entry.usage === undefined ? null : h("span", { class: "metric", title: `in ${entry.usage.input} · out ${entry.usage.output} · cache read ${entry.usage.cacheRead} · cache write ${entry.usage.cacheWrite}` }, `${tokens(entry.usage.totalTokens)} tok`),
		entry.usage === undefined ? null : h("span", { class: "metric cost" }, cost(entry.usage.cost)),
		entry.stopReason === undefined || entry.stopReason === "stop" || entry.stopReason === "toolUse" ? null : pill(entry.stopReason, "warn"),
		h("span", { class: "spacer" }),
		entry.byTaskId === undefined ? null : h("a", { class: "chip", href: ctx.link({ view: "tasks", task: entry.byTaskId }) }, `task #${entry.byTaskId}`),
		h("span", { class: "muted mono", title: entry.seq === undefined ? undefined : `committed in seq ${entry.seq}` }, `#${entry.id}`),
	);
}

function body(ctx: Context, entry: LensEntry): Child[] {
	const blocks: Child[] = [];
	for (const message of entry.messages.filter(isObj)) {
		if (message.role === "system") {
			const text = typeof message.content === "string" ? message.content : textParts(message.content).join("\n");
			const added = Array.isArray(message.toolsAdded) ? message.toolsAdded.filter(isObj).map((tool) => String(tool.name)) : [];
			const removed = Array.isArray(message.toolsRemoved) ? message.toolsRemoved.map(String) : [];
			// Named sections replace earlier ones by name; `null` removes one.
			const sections = isObj(message.sections) ? Object.entries(message.sections) : [];
			const summary = [
				text === "" ? null : `${text.length} chars of instructions`,
				sections.length === 0 ? null : `sections ${sections.map(([name, value]) => (value === null ? `−${name}` : name)).join(", ")}`,
				added.length === 0 ? null : `tools +${added.join(", +")}`,
				removed.length === 0 ? null : `tools −${removed.join(", −")}`,
			].filter((part) => part !== null);
			blocks.push(
				h(
					"details",
					{ class: "system" },
					h("summary", null, summary.length === 0 ? "no prompt change" : summary.join(" · ")),
					text === "" ? null : h("pre", { class: "pre" }, text),
					sections.map(([name, value]) => h("div", { class: "section" }, h("div", { class: "muted small mono" }, value === null ? `${name} (removed)` : name), value === null ? null : h("pre", { class: "pre" }, String(value)))),
					h("div", { class: "raw" }, jsonTree(message, 0)),
				),
			);
		} else if (message.role === "toolResult") {
			const text = textParts(message.content).join("\n");
			blocks.push(h("pre", { class: `pre ${message.isError === true ? "tone-bad" : ""}` }, text));
			if (message.details !== undefined) blocks.push(h("div", { class: "raw" }, h("span", { class: "muted" }, "details "), jsonTree(message.details, 0)));
		} else {
			blocks.push(...contentBlocks(ctx, entry, message.content));
			if (typeof message.errorMessage === "string") blocks.push(h("div", { class: "error-line" }, message.errorMessage));
		}
	}
	if (entry.data !== undefined && !isEmpty(entry.data)) {
		blocks.push(h("div", { class: "raw" }, h("span", { class: "muted" }, "data "), jsonTree(entry.data, 1)));
	}
	if (entry.edits !== undefined) blocks.push(h("div", { class: "raw" }, h("span", { class: "muted" }, "context edits "), jsonTree(entry.edits, 1)));
	return blocks;
}

export function card(ctx: Context, entry: LensEntry, previousAt: number | undefined): HTMLElement {
	const role = entry.kind.replace(/^pi\./, "");
	const forks = ctx.index.forksAt.get(entry.id) ?? [];
	return h(
		"article",
		{ class: `card role-${role} ${ctx.route.entry === entry.id ? "selected" : ""}`, id: `entry-${entry.id}` },
		h(
			"div",
			{ class: "gutter" },
			h("div", { class: "time", title: entry.atEstimated ? "estimated from its task or the entry before" : undefined }, clock(entry.at), entry.atEstimated ? "≈" : ""),
			previousAt === undefined || entry.at === undefined ? null : h("div", { class: "delta" }, `+${duration(entry.at - previousAt)}`),
		),
		h(
			"div",
			{ class: "card-main" },
			header(ctx, entry),
			h("div", { class: "card-body" }, body(ctx, entry)),
			forks.map((fork) =>
				h(
					"div",
					{ class: "fork-mark" },
					"⑂ ",
					h("a", { href: ctx.link({ view: "timeline", conversation: fork.id, compare: true }) }, `Fork #${fork.id}`),
					` continues from here${fork.model === undefined ? "" : ` on ${fork.model}`}`,
				),
			),
		),
	);
}

/** Bars of the conversation's tasks on one time axis; app tasks that outlive the transcript are cut at its edge. */
function gantt(ctx: Context, conversation: LensConversation, entries: LensEntry[]): HTMLElement | null {
	const tasks = ctx.index.tasks;
	const own = [...tasks.values()].filter((task) => task.conversationId === conversation.id && task.startedAt !== undefined);
	const times = entries.map((entry) => entry.at).filter((at): at is number => at !== undefined);
	for (const task of own) if (task.kind.startsWith("pi.")) times.push(task.startedAt as number, task.endedAt ?? (task.startedAt as number));
	if (times.length < 2) return null;
	const start = Math.min(...times);
	const end = Math.max(...times);
	const span = Math.max(end - start, 1);
	const x = (ms: number) => `${Math.min(100, Math.max(0, ((ms - start) / span) * 100))}%`;
	const lanes = new Map<string, LensTask[]>();
	// Tasks that start after the transcript's last activity would only be slivers at the edge; the Tasks view has them.
	const later = own.filter((task) => (task.startedAt as number) > end);
	for (const task of own.filter((task) => (task.startedAt as number) <= end).sort((a, b) => (a.startedAt as number) - (b.startedAt as number))) {
		const lane = task.kind === "pi.generation" ? "model" : task.kind === "pi.tool" ? `tool ${task.label ?? ""}` : task.kind;
		lanes.set(lane, [...(lanes.get(lane) ?? []), task]);
	}
	const rows = [...lanes].map(([lane, laneTasks]) => {
		const track = h("div", { class: "lane-track" });
		for (const task of laneTasks) {
			const from = task.startedAt as number;
			const to = task.endedAt ?? end;
			const live = task.endedAt === undefined;
			const status = task.outcome?.status ?? task.status;
			const bar = h(
				"a",
				{
					class: `bar status-${status} ${live ? "live" : ""} ${ctx.route.task === task.id ? "selected" : ""}`,
					href: task.entryId === undefined ? ctx.link({ view: "tasks", task: task.id }) : ctx.link({ entry: task.entryId }),
					title: `${task.kind}${task.label === undefined ? "" : ` ${task.label}`} #${task.id} · ${status} · ${duration(to - from)}${live ? " (still live)" : ""}`,
				},
				live && to >= end ? "→" : "",
			);
			bar.style.left = x(from);
			bar.style.width = `max(3px, calc(${x(to)} - ${x(from)}))`;
			track.append(bar);
		}
		return h("div", { class: "lane" }, h("div", { class: "lane-label", title: lane }, lane), track);
	});
	const marks = h("div", { class: "lane-track marks" });
	for (const entry of entries) {
		if (entry.kind !== "pi.user" || entry.at === undefined) continue;
		const mark = h("a", { class: "mark", href: ctx.link({ entry: entry.id }), title: `input #${entry.id} at ${clock(entry.at)}` });
		mark.style.left = x(entry.at);
		marks.append(mark);
	}
	return h(
		"section",
		{ class: "gantt" },
		h("div", { class: "lane" }, h("div", { class: "lane-label" }, "inputs"), marks),
		rows,
		h("div", { class: "axis" }, h("span", null, clock(start)), h("span", null, duration(end - start)), h("span", null, clock(end))),
		later.length === 0 ? null : h("div", { class: "gantt-note muted" }, `${later.length} more task${later.length === 1 ? "" : "s"} started after this, `, h("a", { href: ctx.link({ view: "tasks" }) }, later.map((task) => task.kind).filter((kind, i, all) => all.indexOf(kind) === i).join(", "))),
	);
}

function stats(conversation: LensConversation, entries: LensEntry[]): HTMLElement {
	const span = conversation.firstAt === undefined || conversation.lastAt === undefined ? undefined : conversation.lastAt - conversation.firstAt;
	return h(
		"div",
		{ class: "stats" },
		h("div", null, h("b", null, String(entries.length)), " entries"),
		h("div", null, h("b", null, cost(conversation.usage.cost)), " spent"),
		h("div", null, h("b", null, tokens(conversation.usage.totalTokens)), " tokens"),
		h("div", null, h("b", null, duration(span)), " wall time"),
		conversation.model === undefined ? null : h("div", null, h("b", null, conversation.model)),
	);
}

function entryList(ctx: Context, entries: LensEntry[]): HTMLElement {
	let previous: number | undefined;
	return h(
		"div",
		{ class: "cards" },
		entries.map((entry) => {
			const element = card(ctx, entry, previous);
			if (entry.at !== undefined) previous = entry.at;
			return element;
		}),
	);
}

function compare(ctx: Context, conversation: LensConversation): HTMLElement | null {
	const parent = conversation.parent;
	if (parent === undefined) return null;
	const source = ctx.index.conversations.get(parent.conversationId);
	if (source === undefined) return null;
	const original = source.entryIds.filter((id) => id > parent.at).map((id) => ctx.index.entries.get(id)).filter((entry): entry is LensEntry => entry !== undefined);
	const branch = transcript(ctx, conversation).own;
	const column = (title: string, model: string | undefined, list: LensEntry[], href: string) => {
		const spent = list.reduce((sum, entry) => sum + (entry.usage?.cost ?? 0), 0);
		const used = list.reduce((sum, entry) => sum + (entry.usage?.totalTokens ?? 0), 0);
		return h(
			"div",
			{ class: "compare-col" },
			h("div", { class: "compare-head" }, h("a", { href }, title), h("span", { class: "muted" }, model ?? ""), h("span", { class: "metric" }, `${list.length} entries`), h("span", { class: "metric" }, `${tokens(used)} tok`), h("span", { class: "metric cost" }, cost(spent))),
			list.length === 0 ? h("div", { class: "empty" }, "nothing after the fork point") : entryList(ctx, list),
		);
	};
	return h(
		"section",
		{ class: "compare" },
		h("div", { class: "compare-title" }, `Both branches after entry #${parent.at}`),
		h(
			"div",
			{ class: "compare-cols" },
			column(source.role === "root" ? "Root" : `#${source.id}`, source.model, original, ctx.link({ conversation: source.id, compare: false })),
			column(`Fork #${conversation.id}`, conversation.model, branch, ctx.link({ conversation: conversation.id, compare: false })),
		),
	);
}

export function timelineView(ctx: Context): HTMLElement {
	const conversation = ctx.index.conversations.get(ctx.route.conversation);
	if (conversation === undefined) {
		return h("div", { class: "empty" }, ctx.lens.conversations.length === 0 ? "This store has no conversations." : `This store has no conversation #${ctx.route.conversation}.`);
	}
	const { inherited, own } = transcript(ctx, conversation);
	const owner = conversation.owner;
	const parent = conversation.parent;
	const head = h(
		"header",
		{ class: "view-head" },
		h("div", { class: "view-title" }, h("span", { class: `role-badge role-${conversation.role}` }, conversation.role), h("h2", null, conversation.title ?? conversation.label)),
		h(
			"div",
			{ class: "view-sub" },
			h("span", { class: "muted" }, `conversation #${conversation.id} · ${conversation.label}`),
			parent === undefined ? null : h("a", { class: "chip", href: ctx.link({ conversation: parent.conversationId, entry: parent.at, compare: false }) }, `parent #${parent.conversationId} at entry ${parent.at}`),
			parent === undefined ? null : h("a", { class: `chip ${ctx.route.compare ? "tone-accent" : ""}`, href: ctx.link({ compare: !ctx.route.compare }) }, ctx.route.compare ? "hide comparison" : "compare branches"),
			owner === undefined ? null : h("a", { class: "chip", href: ctx.link({ conversation: owner.conversationId, compare: false }) }, `owner: conversation #${owner.conversationId}`),
			owner === undefined ? null : h("a", { class: "chip", href: ctx.link({ view: "tasks", task: owner.taskId }) }, `owner task #${owner.taskId}`),
		),
		stats(conversation, own),
	);
	if (ctx.route.compare && parent !== undefined) return h("div", { class: "view" }, head, compare(ctx, conversation));
	return h(
		"div",
		{ class: "view" },
		head,
		gantt(ctx, conversation, own),
		inherited.length === 0
			? null
			: h(
					"details",
					{ class: "inherited" },
					h("summary", null, `${inherited.length} entries inherited from conversation #${parent?.conversationId} (up to entry #${parent?.at})`),
					entryList(ctx, inherited),
				),
		own.length === 0 ? h("div", { class: "empty" }, "No entries of its own yet.") : entryList(ctx, own),
	);
}
