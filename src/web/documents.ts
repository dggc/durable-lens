import { h, pill } from "./dom.ts";
import { jsonTree } from "./json.ts";
import type { LensDocument } from "./lens.ts";
import type { Context } from "./state.ts";

function scopeLabel(document: LensDocument): string {
	if (document.scope.kind === "session") return "session";
	if (document.scope.kind === "conversation") return `conversation #${document.scope.conversationId}`;
	if (document.scope.kind === "task") return `task #${document.scope.taskId}`;
	return document.scope.kind;
}

function revisionSummary(document: LensDocument): string {
	const bases = document.revisions.filter((revision) => revision.kind === "base").length;
	const deltas = document.revisions.length - bases;
	return `${bases} base${bases === 1 ? "" : "s"}${deltas === 0 ? "" : ` · ${deltas} delta${deltas === 1 ? "" : "s"}`}`;
}

function details(ctx: Context, document: LensDocument): HTMLElement {
	const states = document.states ?? [];
	const value = h("div", { class: "json-block" }, jsonTree(document.value, 3));
	let slider: HTMLElement | null = null;
	if (states.length > 1) {
		const label = h("span", { class: "metric" });
		const input = h("input", { type: "range", min: 0, max: states.length - 1, value: states.length - 1, class: "slider" });
		const show = () => {
			const state = states[Number(input.value)];
			if (state === undefined) return;
			label.textContent = `as of commit ${state.seq} (${Number(input.value) + 1} of ${states.length})`;
			value.replaceChildren(jsonTree(state.value, 3));
		};
		input.addEventListener("input", show);
		show();
		slider = h("div", { class: "rewind" }, h("span", { class: "field-label" }, "rewind"), input, label);
	}
	return h(
		"aside",
		{ class: "details" },
		h(
			"div",
			{ class: "details-head" },
			h("h3", null, document.kind),
			document.key === undefined ? null : h("span", { class: "mono" }, `[${document.key}]`),
			h("span", { class: "muted mono" }, `#${document.id}`),
		),
		h(
			"div",
			{ class: "fields-inline" },
			pill(scopeLabel(document), "info"),
			document.history === undefined ? null : pill(document.history, document.history === "rewindable" ? "accent" : "muted", "history kept for as-of reads"),
			document.fork === undefined ? null : pill(`fork: ${document.fork}`, "muted", "what a fork starts with"),
			document.retiredAt === undefined ? null : pill(`retired at ${document.retiredAt}`, "warn"),
			h("span", { class: "muted" }, `created at commit ${document.createdAt ?? "?"} · ${revisionSummary(document)} · version ${document.version ?? "?"}`),
		),
		document.error === undefined ? null : h("div", { class: "error-line" }, document.error),
		slider,
		value,
		document.scope.conversationId === undefined
			? null
			: h(
					"a",
					{ class: "chip", href: ctx.link({ view: "timeline", conversation: document.scope.conversationId }) },
					`open conversation #${document.scope.conversationId}`,
				),
	);
}

export function documentsView(ctx: Context): HTMLElement {
	const documents = ctx.lens.documents;
	const selected = ctx.route.document === undefined ? undefined : ctx.index.documents.get(ctx.route.document);
	const groups = new Map<string, LensDocument[]>();
	for (const document of documents) groups.set(scopeLabel(document), [...(groups.get(scopeLabel(document)) ?? []), document]);
	return h(
		"div",
		{ class: "view split" },
		h(
			"div",
			{ class: "split-main" },
			h(
				"header",
				{ class: "view-head" },
				h("div", { class: "view-title" }, h("h2", null, "Documents")),
				h("div", { class: "view-sub muted" }, `${documents.length} document incarnations; pi.* ones are the Harness's own`),
			),
			[...groups].map(([scope, list]) =>
				h(
					"section",
					{ class: "task-group" },
					h("h4", null, scope),
					list
						.sort((a, b) => Number(a.kind.startsWith("pi.")) - Number(b.kind.startsWith("pi.")) || a.id - b.id)
						.map((document) =>
							h(
								"a",
								{
									class: `task-row ${selected?.id === document.id ? "selected" : ""} ${document.retiredAt === undefined ? "" : "retired"}`,
									href: ctx.link({ view: "documents", document: document.id }),
								},
								h("span", { class: `task-kind ${document.kind.startsWith("pi.") ? "muted" : ""}` }, document.kind),
								document.key === undefined ? null : h("span", { class: "mono" }, `[${document.key}]`),
								h("span", { class: "muted mono" }, `#${document.id}`),
								document.history === "rewindable" ? pill("rewindable", "accent") : null,
								document.retiredAt === undefined ? null : pill("retired", "warn"),
								document.error === undefined ? null : pill("unreadable", "bad"),
								h("span", { class: "task-note" }),
								h("span", { class: "metric" }, revisionSummary(document)),
							),
						),
				),
			),
		),
		selected === undefined
			? h("aside", { class: "details empty" }, "Select a document to see its value; rewindable ones can be stepped back through their stored revisions.")
			: details(ctx, selected),
	);
}
