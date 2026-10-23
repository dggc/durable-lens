import { cost, h, tokens } from "./dom.ts";
import type { LensUsage } from "./lens.ts";
import type { Context } from "./state.ts";

function table(title: string, rows: [string, LensUsage, string?][], note?: string): HTMLElement {
	const max = Math.max(...rows.map(([, usage]) => usage.cost), 1e-12);
	return h(
		"section",
		{ class: "usage-table" },
		h("h4", null, title),
		note === undefined ? null : h("div", { class: "muted small" }, note),
		rows.length === 0
			? h("div", { class: "empty" }, "nothing recorded")
			: h(
					"table",
					null,
					h("thead", null, h("tr", null, ["", "cost", "input", "output", "cache read", "cache write", "total"].map((label) => h("th", null, label)))),
					h(
						"tbody",
						null,
						rows.map(([name, usage, href]) => {
							const bar = h("span", { class: "cost-bar" });
							bar.style.width = `${(usage.cost / max) * 100}%`;
							return h(
								"tr",
								null,
								h("td", { class: "mono" }, href === undefined ? name : h("a", { href }, name)),
								h("td", { class: "cost-cell" }, bar, h("span", null, cost(usage.cost))),
								[usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.totalTokens].map((value) => h("td", { class: "num" }, tokens(value))),
							);
						}),
					),
				),
	);
}

export function usageView(ctx: Context): HTMLElement {
	const { total, byModel, byTool } = ctx.lens.usage;
	const card = (label: string, value: string) => h("div", { class: "stat-card" }, h("div", { class: "stat-value" }, value), h("div", { class: "stat-label" }, label));
	const sorted = (record: Record<string, LensUsage>) => Object.entries(record).sort(([, a], [, b]) => b.cost - a.cost) as [string, LensUsage][];
	return h(
		"div",
		{ class: "view" },
		h("header", { class: "view-head" }, h("div", { class: "view-title" }, h("h2", null, "Usage and cost")), h("div", { class: "view-sub muted" }, "From each conversation's pi.usage document, which also counts failed and aborted attempts.")),
		h("div", { class: "stat-cards" }, card("spent", cost(total.cost)), card("input tokens", tokens(total.input)), card("output tokens", tokens(total.output)), card("cache read", tokens(total.cacheRead)), card("cache write", tokens(total.cacheWrite))),
		table("By model", sorted(byModel)),
		table("By tool", sorted(byTool), "Only tools that report their own spend, such as ones that call a model."),
		table(
			"By conversation",
			ctx.lens.conversations.map((conversation) => [`#${conversation.id} ${conversation.label}`, conversation.usage, ctx.link({ view: "timeline", conversation: conversation.id })] as [string, LensUsage, string]),
		),
	);
}
