// Just enough DOM for the page's renderers: elements with children, attributes, text, a style bag and event listeners.
// Enough to build every view in Node and to inspect what the content could make the page contain. It has no HTML
// parser on purpose: nothing in the page may parse HTML, and a test that needed one would be testing the wrong thing.

export type FakeListener = (event: unknown) => void;

export class FakeNode {
	tag: string;
	text?: string;
	attributes: Record<string, string> = {};
	children: FakeNode[] = [];
	parent: FakeNode | undefined;
	listeners: Record<string, FakeListener[]> = {};
	open = false;
	value = "";
	scrollTop = 0;
	style: Record<string, string> & { setProperty: (name: string, value: string) => void };

	constructor(tag: string, text?: string) {
		this.tag = tag;
		if (text !== undefined) this.text = text;
		const style: Record<string, string> = {};
		this.style = Object.assign(style, {
			setProperty: (name: string, value: string) => {
				style[name] = value;
			},
		});
	}

	get className(): string {
		return this.attributes.class ?? "";
	}

	set className(value: string) {
		this.attributes.class = value;
	}

	get firstChild(): FakeNode | null {
		return this.children[0] ?? null;
	}

	get textContent(): string {
		return this.text ?? this.children.map((child) => child.textContent).join("");
	}

	set textContent(value: string) {
		this.replaceChildren(new FakeNode("#text", value));
	}

	setAttribute(name: string, value: string): void {
		this.attributes[name] = value;
		if (name === "value") this.value = value;
	}

	addEventListener(type: string, listener: FakeListener): void {
		this.listeners[type] = [...(this.listeners[type] ?? []), listener];
	}

	/** Call the listeners of `type`, as the browser would on a user action. */
	dispatch(type: string, event: unknown = {}): void {
		for (const listener of this.listeners[type] ?? []) listener(event);
	}

	appendChild<T extends FakeNode>(child: T): T {
		child.parent = this;
		this.children.push(child);
		return child;
	}

	append(...children: (FakeNode | string)[]): void {
		for (const child of children) this.appendChild(typeof child === "string" ? new FakeNode("#text", child) : child);
	}

	removeChild(child: FakeNode): FakeNode {
		this.children.splice(this.children.indexOf(child), 1);
		child.parent = undefined;
		return child;
	}

	replaceChildren(...children: FakeNode[]): void {
		for (const child of this.children) child.parent = undefined;
		this.children = [];
		this.append(...children);
	}

	remove(): void {
		this.parent?.removeChild(this);
	}
}

/** Install a fake `document` on `globalThis`, and return it. */
export function installFakeDocument(): { createElement: (tag: string) => FakeNode; createTextNode: (text: string) => FakeNode } {
	const fake = {
		createElement: (tag: string) => new FakeNode(tag),
		createTextNode: (text: string) => new FakeNode("#text", text),
	};
	(globalThis as Record<string, unknown>).document = fake;
	return fake;
}

/** Visit a node and everything below it, in document order. */
export function walk(node: FakeNode, visit: (node: FakeNode) => void): void {
	visit(node);
	for (const child of node.children) walk(child, visit);
}

/** Every node under (and including) `root` that satisfies `test`. */
export function findAll(root: FakeNode, test: (node: FakeNode) => boolean): FakeNode[] {
	const found: FakeNode[] = [];
	walk(root, (node) => {
		if (test(node)) found.push(node);
	});
	return found;
}

export const asFake = (node: unknown): FakeNode => node as FakeNode;

/** The tag names that appear under `root`, text nodes excluded. */
export function tagsIn(root: FakeNode): Set<string> {
	const tags = new Set<string>();
	walk(root, (node) => node.tag !== "#text" && tags.add(node.tag));
	return tags;
}
