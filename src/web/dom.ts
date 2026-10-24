// DOM helpers. Store content only ever reaches the page as text nodes: nothing here parses HTML.

export type Child = Node | string | number | false | null | undefined | Child[];
type Props = Record<string, string | number | boolean | undefined | ((event: Event) => void)>;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props | null = null, ...children: Child[]): HTMLElementTagNameMap[K] {
	const element = document.createElement(tag);
	for (const [name, value] of Object.entries(props ?? {})) {
		if (value === undefined || value === false) continue;
		if (typeof value === "function") element.addEventListener(name.replace(/^on/, ""), value);
		else if (name === "class") element.className = String(value);
		else element.setAttribute(name, value === true ? "" : String(value));
	}
	append(element, children);
	return element;
}

export function append(parent: Node, children: Child[]): void {
	for (const child of children) {
		if (child === null || child === undefined || child === false) continue;
		if (Array.isArray(child)) append(parent, child);
		else parent.appendChild(typeof child === "string" || typeof child === "number" ? document.createTextNode(String(child)) : child);
	}
}

export function clear(element: Element): void {
	while (element.firstChild !== null) element.removeChild(element.firstChild);
}

const pad = (value: number, size = 2) => String(value).padStart(size, "0");

export function clock(ms: number | undefined): string {
	if (ms === undefined) return "—";
	const date = new Date(ms);
	return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

export function dateTime(ms: number | undefined): string {
	if (ms === undefined) return "—";
	const date = new Date(ms);
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function duration(ms: number | undefined): string {
	if (ms === undefined || !Number.isFinite(ms)) return "—";
	// A span from clocks out of order: the magnitude formatted as usual, with its sign in front.
	if (ms <= -0.5) return `-${duration(-ms)}`;
	if (ms < 999.5) return `${Math.abs(Math.round(ms))} ms`;
	if (ms < 59_950) return `${(ms / 1000).toFixed(ms < 9_995 ? 2 : 1)} s`;
	if (ms < 3_599_500) {
		const seconds = Math.round(ms / 1000);
		return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
	}
	if (ms < 172_800_000) return `${(ms / 3_600_000).toFixed(1)} h`;
	return `${(ms / 86_400_000).toFixed(1)} d`;
}

export function relative(ms: number, now = Date.now()): string {
	const delta = ms - now;
	return delta >= 0 ? `in ${duration(delta)}` : `${duration(-delta)} ago`;
}

export function cost(value: number | undefined): string {
	if (value === undefined) return "—";
	if (value === 0) return "$0";
	if (value < 0.01) return `$${value.toFixed(4)}`;
	return `$${value.toFixed(value < 10 ? 3 : 2)}`;
}

export function tokens(value: number | undefined): string {
	if (value === undefined) return "—";
	if (value < 1000) return String(value);
	if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
	return `${(value / 1_000_000).toFixed(2)}M`;
}

export function bytes(value: number): string {
	if (value < 1024) return `${value} B`;
	if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
	return `${(value / 1024 / 1024).toFixed(1)} MiB`;
}

export function pill(text: string, tone: string, title?: string): HTMLElement {
	return h("span", { class: `pill tone-${tone}`, title }, text);
}
