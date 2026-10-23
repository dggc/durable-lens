import type { Json } from "./lens.ts";
import { h } from "./dom.ts";

const LONG = 400;

function scalar(value: Json): HTMLElement {
	if (value === null) return h("span", { class: "j-null" }, "null");
	if (typeof value === "string") {
		const quoted = JSON.stringify(value);
		if (quoted.length <= LONG) return h("span", { class: "j-str" }, quoted);
		const span = h("span", { class: "j-str" }, `${quoted.slice(0, LONG)}…`);
		const more = h("button", { class: "j-more", type: "button" }, `+${quoted.length - LONG} chars`);
		more.addEventListener("click", () => {
			span.textContent = quoted;
			more.remove();
		});
		return h("span", null, span, more);
	}
	return h("span", { class: typeof value === "number" ? "j-num" : "j-bool" }, String(value));
}

/** A collapsible JSON tree; nodes deeper than `open` levels start closed. */
export function jsonTree(value: Json | undefined, open = 2, depth = 0): HTMLElement {
	if (value === undefined) return h("span", { class: "j-null" }, "—");
	if (value === null || typeof value !== "object") return scalar(value);
	const entries: [string, Json][] = Array.isArray(value) ? value.map((item, index) => [String(index), item]) : Object.entries(value);
	const [left, right] = Array.isArray(value) ? ["[", "]"] : ["{", "}"];
	if (entries.length === 0) return h("span", { class: "j-punct" }, left + right);
	const details = h("details", { class: "j-node" });
	if (depth < open) details.open = true;
	details.append(h("summary", null, h("span", { class: "j-punct" }, left), h("span", { class: "j-count" }, ` ${entries.length} ${Array.isArray(value) ? "items" : "keys"} `)));
	const body = h("div", { class: "j-body" });
	for (const [key, item] of entries) {
		body.append(h("div", { class: "j-row" }, h("span", { class: "j-key" }, Array.isArray(value) ? key : JSON.stringify(key)), h("span", { class: "j-punct" }, ": "), jsonTree(item, open, depth + 1)));
	}
	details.append(body, h("span", { class: "j-punct" }, right));
	return details;
}
