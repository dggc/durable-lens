import { bytes, clear, clock, cost, h, pill, tokens } from "./dom.ts";
import { documentsView } from "./documents.ts";
import type { Lens, LensConversation } from "./lens.ts";
import { buildIndex, type Context, type Index, parseRoute, type Route, routeHash, type View } from "./state.ts";
import { statusText, taskTone, tasksView } from "./tasks.ts";
import { timelineView } from "./timeline.ts";
import { usageView } from "./usage.ts";

const POLL_MS = 1500;
const root = document.getElementById("app") as HTMLElement;

let lens: Lens | undefined;
let index: Index | undefined;
let version = -1;
let readError: string | null = null;
let lastUpdate = 0;

function context(route: Route): Context {
	const link = (patch: Partial<Route>) => {
		const next: Route = { ...route, ...patch };
		// Moving to another conversation or view drops selections that belonged to the old one.
		if (patch.conversation !== undefined && patch.conversation !== route.conversation && patch.entry === undefined) delete next.entry;
		if (patch.view !== undefined && patch.view !== route.view) {
			if (patch.task === undefined) delete next.task;
			if (patch.document === undefined) delete next.document;
			if (patch.entry === undefined && patch.view !== "timeline") delete next.entry;
		}
		for (const key of Object.keys(next) as (keyof Route)[]) if (next[key] === undefined || next[key] === false) delete next[key];
		return routeHash(next);
	};
	return {
		lens: lens as Lens,
		index: index as Index,
		route,
		link,
		go: (patch, replace = false) => {
			const hash = link(patch);
			if (replace) history.replaceState(null, "", hash);
			else location.hash = hash;
			render();
		},
	};
}

function conversationTree(ctx: Context): HTMLElement {
	const items: HTMLElement[] = [];
	const icon = { root: "●", fork: "⑂", subagent: "↳", conversation: "○" } as const;
	const visit = (conversation: LensConversation, depth: number, seen: Set<number>) => {
		if (seen.has(conversation.id)) return;
		seen.add(conversation.id);
		const item = h(
			"a",
			{ class: `conv ${ctx.route.conversation === conversation.id && ctx.route.view === "timeline" ? "selected" : ""}`, href: ctx.link({ view: "timeline", conversation: conversation.id, compare: false }) },
			h("span", { class: `conv-icon role-${conversation.role}` }, icon[conversation.role]),
			h(
				"span",
				{ class: "conv-text" },
				h("span", { class: "conv-label" }, conversation.role === "root" ? "Root" : conversation.label),
				h("span", { class: "conv-meta" }, `${conversation.entryIds.length} entries · ${cost(conversation.usage.cost)}${conversation.model === undefined ? "" : ` · ${conversation.model.replace(/^[^/]+\//, "")}`}`),
			),
		);
		item.style.setProperty("--depth", String(depth));
		items.push(item);
		for (const child of conversation.children) {
			const next = ctx.index.conversations.get(child);
			if (next !== undefined) visit(next, depth + 1, seen);
		}
	};
	const seen = new Set<number>();
	for (const conversation of ctx.lens.conversations) {
		if (conversation.parent === undefined && conversation.owner === undefined) visit(conversation, 0, seen);
	}
	for (const conversation of ctx.lens.conversations) visit(conversation, 0, seen);
	return h("nav", { class: "convs" }, items);
}

function sidebar(ctx: Context): HTMLElement {
	const live = ctx.lens.tasks.filter((task) => task.status !== "terminal");
	const counts = new Map<string, { count: number; tone: string }>();
	for (const task of live) {
		const status = statusText(task);
		counts.set(status, { count: (counts.get(status)?.count ?? 0) + 1, tone: taskTone(task) });
	}
	const failed = ctx.lens.tasks.filter((task) => ["failed", "faulted", "orphaned"].includes(task.outcome?.status ?? "")).length;
	return h(
		"aside",
		{ class: "sidebar" },
		h("div", { class: "side-title" }, "Conversations"),
		conversationTree(ctx),
		h("div", { class: "side-title" }, "Tasks"),
		h(
			"a",
			{ class: "side-block", href: ctx.link({ view: "tasks" }) },
			live.length === 0 ? h("span", { class: "muted" }, "no live tasks") : [...counts].map(([status, { count, tone }]) => pill(`${count} ${status}`, tone)),
			failed === 0 ? null : pill(`${failed} failed`, "bad"),
			h("div", { class: "muted small" }, `${ctx.lens.tasks.length} task records`),
		),
		h("div", { class: "side-title" }, "Spend"),
		h("a", { class: "side-block", href: ctx.link({ view: "usage" }) }, h("div", { class: "big" }, cost(ctx.lens.usage.total.cost)), h("div", { class: "muted small" }, `${tokens(ctx.lens.usage.total.totalTokens)} tokens · ${Object.keys(ctx.lens.usage.byModel).length} models`)),
	);
}

function topbar(ctx: Context): HTMLElement {
	const source = ctx.lens.source;
	const format = ctx.lens.format;
	const files = source.files.map((file) => `${file.name} ${bytes(file.size)}`).join("\n");
	const kind = source.kind === "sqlite" ? `SQLite schema v${format.schemaVersion ?? "?"}${format.prefix === undefined ? "" : `, prefix ${format.prefix}`}` : `JSONL format ${format.jsonlFormat ?? "?"}`;
	const warnings = ctx.lens.warnings;
	return h(
		"header",
		{ class: "topbar" },
		h("div", { class: "brand" }, h("span", { class: "brand-mark" }, "◎"), "durable-lens"),
		h("div", { class: "store-path mono", title: `${source.path}\n${files}` }, source.path.length > 64 ? `…${source.path.slice(-63)}` : source.path),
		h("span", { class: "badge", title: format.hints.join("\n") }, format.version),
		h("span", { class: "badge muted" }, kind),
		h("span", { class: "badge ok", title: "durable-lens copied the database and WAL to a private directory; the store itself is only read" }, source.kind === "sqlite" ? "read-only copy" : "read-only"),
		source.decoder === undefined ? null : h("span", { class: "badge accent", title: source.decoder }, "decoded"),
		warnings.length === 0 ? null : h("details", { class: "warnings" }, h("summary", { class: "badge warn" }, `${warnings.length} warning${warnings.length === 1 ? "" : "s"}`), h("ul", null, warnings.map((warning) => h("li", null, warning)))),
		h("span", { class: "spacer" }),
		readError === null ? null : h("span", { class: "badge bad", title: readError }, "last reread failed"),
		h("span", { class: `live-dot ${Date.now() - lastUpdate < 2500 ? "pulse" : ""}`, title: `read at ${clock(source.readAt)} in ${source.readMs} ms${source.attempts > 1 ? `, ${source.attempts} attempts` : ""}; rereads when the files change` }),
		h("span", { class: "muted small" }, `read ${clock(source.readAt)}`),
	);
}

function tabs(ctx: Context): HTMLElement {
	const tab = (view: View, label: string) => h("a", { class: `tab ${ctx.route.view === view ? "active" : ""}`, href: ctx.link({ view }) }, label);
	return h("nav", { class: "tabs" }, tab("timeline", "Timeline"), tab("tasks", "Tasks"), tab("documents", "Documents"), tab("usage", "Usage"));
}

function render(): void {
	if (lens === undefined) return;
	const route = parseRoute(location.hash);
	const ctx = context(route);
	const scrolled = document.querySelector(".content")?.scrollTop ?? 0;
	const views = { timeline: timelineView, tasks: tasksView, documents: documentsView, usage: usageView };
	clear(root);
	root.append(topbar(ctx), h("div", { class: "layout" }, sidebar(ctx), h("main", { class: "content" }, tabs(ctx), views[route.view](ctx))));
	const content = document.querySelector(".content") as HTMLElement;
	content.scrollTop = scrolled;
	if (route.entry !== undefined && route.view === "timeline" && pendingScroll) {
		document.getElementById(`entry-${route.entry}`)?.scrollIntoView({ block: "center" });
	}
	pendingScroll = false;
}

let pendingScroll = true;
window.addEventListener("hashchange", () => {
	pendingScroll = true;
	render();
});

async function load(): Promise<void> {
	const response = await fetch("api/lens", { cache: "no-store" });
	const body = (await response.json()) as { version: number; error: string | null; lens: Lens };
	readError = body.error;
	if (body.version !== version) {
		version = body.version;
		lens = body.lens;
		index = buildIndex(lens);
		lastUpdate = Date.now();
		render();
	}
}

async function poll(): Promise<void> {
	try {
		const response = await fetch("api/version", { cache: "no-store" });
		const body = (await response.json()) as { version: number; error: string | null };
		if (body.version !== version) await load();
		else if (body.error !== readError) {
			readError = body.error;
			render();
		}
	} catch {
		// The server stopped; keep showing the last read.
	}
	setTimeout(poll, POLL_MS);
}

load().then(
	() => setTimeout(poll, POLL_MS),
	(error: Error) => {
		root.replaceChildren(h("div", { class: "empty" }, `Could not load the store: ${error.message}`));
	},
);
