// A small Markdown subset rendered as DOM nodes. Transcript text is untrusted: raw HTML stays literal text, and links
// show their label and target as text without becoming clickable.

import { type Child, h } from "./dom.ts";

function inline(text: string): Child[] {
	const out: Child[] = [];
	// Code spans first, so their contents stay literal; then **bold**, *italic*, and [label](target).
	const pattern = /(`+)([\s\S]*?[^`])\1(?!`)|\*\*([^*]+)\*\*|(?<![*\w])\*([^*\s][^*]*)\*(?![*\w])|\[([^\]]+)\]\(([^)\s]+)\)/g;
	let last = 0;
	for (const match of text.matchAll(pattern)) {
		const index = match.index ?? 0;
		if (index > last) out.push(text.slice(last, index));
		if (match[2] !== undefined) out.push(h("code", null, match[2]));
		else if (match[3] !== undefined) out.push(h("strong", null, ...inline(match[3])));
		else if (match[4] !== undefined) out.push(h("em", null, ...inline(match[4])));
		else if (match[5] !== undefined) {
			out.push(h("span", { class: "md-link", title: `link target (not followed): ${match[6]}` }, match[5], h("span", { class: "md-target" }, ` ⟨${match[6]}⟩`)));
		}
		last = index + match[0].length;
	}
	if (last < text.length) out.push(text.slice(last));
	return out;
}

function table(rows: string[]): HTMLElement | undefined {
	const cells = (row: string) =>
		row
			.trim()
			.replace(/^\|/, "")
			.replace(/\|$/, "")
			.split("|")
			.map((cell) => cell.trim());
	if (rows.length < 2 || !/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(rows[1] as string)) return undefined;
	const head = cells(rows[0] as string);
	return h(
		"table",
		{ class: "md-table" },
		h("thead", null, h("tr", null, head.map((cell) => h("th", null, ...inline(cell))))),
		h(
			"tbody",
			null,
			rows.slice(2).map((row) => h("tr", null, cells(row).map((cell) => h("td", null, ...inline(cell))))),
		),
	);
}

export function markdown(source: string): HTMLElement {
	const root = h("div", { class: "md" });
	const lines = source.replace(/\r\n?/g, "\n").split("\n");
	let i = 0;
	while (i < lines.length) {
		const line = lines[i] as string;
		const fence = /^(\s*)(```+|~~~+)\s*([\w+-]*)\s*$/.exec(line);
		if (fence !== null) {
			const close = fence[2] as string;
			const body: string[] = [];
			i++;
			while (i < lines.length && !(lines[i] as string).trim().startsWith(close)) body.push(lines[i++] as string);
			i++;
			root.append(h("pre", { class: "md-code", "data-lang": fence[3] || undefined }, h("code", null, body.join("\n"))));
			continue;
		}
		if (line.trim() === "") {
			i++;
			continue;
		}
		const heading = /^(#{1,6})\s+(.*)$/.exec(line);
		if (heading !== null) {
			root.append(h("div", { class: `md-h md-h${(heading[1] as string).length}` }, ...inline(heading[2] as string)));
			i++;
			continue;
		}
		if (line.trim().startsWith("|")) {
			const rows: string[] = [];
			while (i < lines.length && (lines[i] as string).trim().startsWith("|")) rows.push(lines[i++] as string);
			root.append(table(rows) ?? h("p", null, rows.join("\n")));
			continue;
		}
		const item = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line);
		if (item !== null) {
			const ordered = /\d/.test(item[1] as string);
			const list = h(ordered ? "ol" : "ul", null);
			while (i < lines.length) {
				const next = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i] as string);
				if (next === null) break;
				list.append(h("li", null, ...inline(next[2] as string)));
				i++;
			}
			root.append(list);
			continue;
		}
		if (/^\s*>/.test(line)) {
			const quoted: string[] = [];
			while (i < lines.length && /^\s*>/.test(lines[i] as string)) quoted.push((lines[i++] as string).replace(/^\s*>\s?/, ""));
			root.append(h("blockquote", null, ...inline(quoted.join("\n"))));
			continue;
		}
		const paragraph: string[] = [];
		while (i < lines.length && (lines[i] as string).trim() !== "" && !/^(\s*(```|~~~)|#{1,6}\s|\s*\|)/.test(lines[i] as string)) {
			paragraph.push(lines[i++] as string);
		}
		root.append(h("p", null, ...inline(paragraph.join("\n"))));
	}
	return root;
}
