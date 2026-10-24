// The Markdown subset the page renders for transcripts: what becomes structure, and what must stay literal text.
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { inline, markdown } from "../src/web/markdown.ts";
import { asFake, type FakeNode, findAll, installFakeDocument, tagsIn } from "./fake-dom.ts";

/** A compact serialization for assertions: `<tag class=...>children</tag>`, text escaped as nothing special. */
function show(node: FakeNode): string {
	if (node.tag === "#text") return node.text ?? "";
	const klass = node.attributes.class === undefined ? "" : `.${node.attributes.class.replaceAll(" ", ".")}`;
	return `<${node.tag}${klass}>${node.children.map(show).join("")}</${node.tag}>`;
}

const render = (source: string) => show(asFake(markdown(source)));
const body = (source: string) =>
	render(source)
		.replace(/^<div\.md>/, "")
		.replace(/<\/div>$/, "");

describe("block rules", () => {
	before(() => {
		installFakeDocument();
	});

	it("renders nothing for an empty or blank source", () => {
		assert.equal(render(""), "<div.md></div>");
		assert.equal(render("  \n\n \t\n"), "<div.md></div>");
	});

	it("joins consecutive lines into one paragraph and splits on blank lines", () => {
		assert.equal(body("one\ntwo\n\nthree"), "<p>one\ntwo</p><p>three</p>");
	});

	it("reads CRLF and bare CR line endings", () => {
		assert.equal(body("a\r\nb\r\rc"), "<p>a\nb</p><p>c</p>");
	});

	it("renders headings of level one to six, but not seven or an unspaced hash", () => {
		assert.equal(body("# One"), "<div.md-h.md-h1>One</div>");
		assert.equal(body("###### Six"), "<div.md-h.md-h6>Six</div>");
		assert.equal(body("####### Seven"), "<p>####### Seven</p>");
		assert.equal(body("#nospace"), "<p>#nospace</p>");
	});

	it("renders bulleted and numbered lists", () => {
		assert.equal(body("- a\n* b\n+ c"), "<ul><li>a</li><li>b</li><li>c</li></ul>");
		assert.equal(body("1. a\n2) b"), "<ol><li>a</li><li>b</li></ol>");
		assert.equal(body("- **x** y"), "<ul><li><strong>x</strong> y</li></ul>");
	});

	it("renders block quotes, dropping the marker", () => {
		assert.equal(body("> quoted\n> text"), "<blockquote>quoted\ntext</blockquote>");
		assert.equal(body(">tight"), "<blockquote>tight</blockquote>");
	});

	it("renders fenced code literally, with its language", () => {
		const root = asFake(markdown("```ts\nconst a = **1**;\n  <b>x</b>\n```\nafter"));
		const [pre] = findAll(root, (node) => node.tag === "pre");
		assert.equal(pre?.attributes["data-lang"], "ts");
		assert.equal(pre?.textContent, "const a = **1**;\n  <b>x</b>");
		assert.equal(tagsIn(pre as FakeNode).has("strong"), false);
		assert.match(show(root), /<p>after<\/p>/);
	});

	it("closes a fence only with a marker of the same kind, and runs unterminated fences to the end", () => {
		assert.equal(asFake(markdown("~~~\na\n```\nb")).textContent, "a\n```\nb");
		const [pre] = findAll(asFake(markdown("```\n")), (node) => node.tag === "pre");
		assert.equal(pre?.attributes["data-lang"], undefined);
	});

	it("renders a pipe table with a header, a rule and rows", () => {
		assert.equal(
			body("| a | b |\n|---|:---:|\n| 1 | `2` |"),
			"<table.md-table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td><code>2</code></td></tr></tbody></table>",
		);
	});

	it("keeps pipe lines without a rule row as plain text", () => {
		assert.equal(body("| not | a table |"), "<p>| not | a table |</p>");
		assert.equal(body("| a |\n| b |"), "<p>| a |\n| b |</p>");
	});

	it("stops a paragraph at a heading, a fence or a table", () => {
		assert.equal(body("text\n# H"), "<p>text</p><div.md-h.md-h1>H</div>");
		assert.match(body("text\n```\ncode\n```"), /^<p>text<\/p><pre/);
		assert.match(body("text\n|a|\n|---|"), /^<p>text<\/p><table/);
	});
});

describe("inline rules", () => {
	before(() => {
		installFakeDocument();
	});

	const inlineHtml = (text: string) =>
		inline(text)
			.map((child) => (typeof child === "string" ? child : show(asFake(child))))
			.join("");

	it("renders bold, italic and code spans", () => {
		assert.equal(inlineHtml("a **b** *c* `d`"), "a <strong>b</strong> <em>c</em> <code>d</code>");
	});

	it("nests links in emphasis, and leaves code span contents literal", () => {
		assert.equal(inlineHtml("**see [x](y)**"), "<strong>see <span.md-link>x<span.md-target> ⟨y⟩</span></span></strong>");
		assert.equal(inlineHtml("`**a**`"), "<code>**a**</code>");
	});

	it("does not nest bold and italic markers inside each other", () => {
		// Each pattern excludes asterisks from its body so it takes bounded time; the markers then stay visible.
		assert.equal(inlineHtml("**a *b* c**"), "**a <em>b</em> c**");
	});

	it("matches a code span only to a closing run of the same length", () => {
		assert.equal(inlineHtml("``a ` b``"), "<code>a ` b</code>");
		assert.equal(inlineHtml("`a``b`"), "<code>a``b</code>");
		assert.equal(inlineHtml("`unclosed"), "`unclosed");
		assert.equal(inlineHtml("`` ``"), "<code> </code>");
		assert.equal(inlineHtml("````"), "````", "an empty span is not a span");
	});

	it("does not treat arithmetic or snake_case asterisks as italics", () => {
		assert.equal(inlineHtml("2 * 3 * 4"), "2 * 3 * 4");
		assert.equal(inlineHtml("a*b*c"), "a*b*c");
	});

	it("shows a link as text with its target, not as an anchor", () => {
		const out = inline("see [the docs](https://example.com/x) now");
		const [, link] = out;
		const node = asFake(link);
		assert.equal(node.tag, "span");
		assert.equal(node.className, "md-link");
		assert.equal(node.attributes.href, undefined);
		assert.equal(node.attributes.title, "link target (not followed): https://example.com/x");
		assert.equal(node.textContent, "the docs ⟨https://example.com/x⟩");
	});

	it("leaves malformed links alone", () => {
		assert.equal(inlineHtml("[a](b c)"), "[a](b c)");
		assert.equal(inlineHtml("[a] (b)"), "[a] (b)");
	});
});

describe("hostile content", () => {
	before(() => {
		installFakeDocument();
	});

	const hostile = [
		'<img src=x onerror="alert(1)">',
		"<script>alert(2)</script>",
		"<iframe src=//evil.example></iframe>",
		"[x](javascript:alert(3))",
		"[x](data:text/html;base64,PHNjcmlwdD4=)",
		"![pixel](https://evil.example/p.png)",
		"<a href=//evil.example>click</a>",
		"<style>*{display:none}</style>",
	].join("\n\n");

	it("only ever builds a short list of inert elements", () => {
		const root = asFake(markdown(hostile));
		assert.deepEqual([...tagsIn(root)].sort(), ["div", "p", "span"]);
		for (const node of findAll(root, () => true)) {
			for (const name of Object.keys(node.attributes)) assert.ok(["class", "title"].includes(name), `attribute ${name} on <${node.tag}>`);
			assert.equal(Object.keys(node.listeners).length, 0);
		}
	});

	it("keeps the markup as visible text", () => {
		const text = asFake(markdown(hostile)).textContent;
		for (const piece of ['<img src=x onerror="alert(1)">', "<script>alert(2)</script>", "<iframe", "<a href=//evil.example>", "<style>"]) {
			assert.ok(text.includes(piece), piece);
		}
	});

	it("renders a markdown image as plain text rather than an img", () => {
		const root = asFake(markdown("![pixel](https://evil.example/p.png)"));
		assert.equal(tagsIn(root).has("img"), false);
		assert.match(root.textContent, /pixel/);
	});
});
