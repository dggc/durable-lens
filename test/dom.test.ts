// The page's DOM helpers and number formatters, against a fake document.
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { append, bytes, clear, clock, cost, dateTime, duration, h, pill, relative, tokens } from "../src/web/dom.ts";
import { asFake, installFakeDocument } from "./fake-dom.ts";

describe("formatters", () => {
	it("shows a missing value as a dash", () => {
		for (const format of [clock, dateTime, duration, cost, tokens]) assert.equal(format(undefined), "—", format.name);
		assert.equal(duration(Number.NaN), "—");
		assert.equal(duration(Number.POSITIVE_INFINITY), "—");
	});

	it("formats clock times and dates in local time, zero padded", () => {
		const at = new Date(2026, 0, 2, 3, 4, 5, 6).getTime();
		assert.equal(clock(at), "03:04:05.006");
		assert.equal(dateTime(at), "2026-01-02 03:04");
	});

	it("scales durations from milliseconds to days", () => {
		assert.equal(duration(0), "0 ms");
		assert.equal(duration(999.4), "999 ms");
		assert.equal(duration(1500), "1.50 s");
		assert.equal(duration(12_345), "12.3 s");
		assert.equal(duration(125_000), "2 min 5 s");
		assert.equal(duration(5_400_000), "1.5 h");
		assert.equal(duration(3 * 86_400_000), "3.0 d");
		assert.equal(duration(-2500), "-2.50 s", "negative spans keep their sign");
		assert.equal(duration(-125_000), "-2 min 5 s", "and their magnitude, above a minute too");
		assert.equal(duration(-0.4), "0 ms", "no negative zero");
		assert.equal(duration(999.6), "1.00 s", "no 1000 ms");
		assert.equal(duration(59_960), "1 min 0 s", "no 60.0 s");
		assert.equal(duration(119_600), "2 min 0 s", "no 1 min 60 s");
		assert.equal(duration(3_599_600), "1.0 h", "no 60 min 0 s");
	});

	it("says whether a time is ahead or behind", () => {
		assert.equal(relative(11_000, 10_000), "in 1.00 s");
		assert.equal(relative(10_000, 10_000), "in 0 ms");
		assert.equal(relative(7_500, 10_000), "2.50 s ago");
	});

	it("formats costs with more digits the smaller they are", () => {
		assert.equal(cost(0), "$0");
		assert.equal(cost(0.00123), "$0.0012");
		assert.equal(cost(0.5), "$0.500");
		assert.equal(cost(9.9999), "$10.000");
		assert.equal(cost(12.345), "$12.35");
	});

	it("abbreviates token counts", () => {
		assert.equal(tokens(0), "0");
		assert.equal(tokens(999), "999");
		assert.equal(tokens(1234), "1.2k");
		assert.equal(tokens(45_678), "46k");
		assert.equal(tokens(2_500_000), "2.50M");
	});

	it("formats byte sizes", () => {
		assert.equal(bytes(10), "10 B");
		assert.equal(bytes(2048), "2.0 KiB");
		assert.equal(bytes(5 * 1024 * 1024), "5.0 MiB");
	});
});

describe("element helpers", () => {
	before(() => {
		installFakeDocument();
	});

	it("builds elements from props: class, attributes, boolean flags and listeners", () => {
		let clicked = 0;
		const element = asFake(
			h("a", { class: "chip", href: "#x", hidden: true, title: undefined, "data-off": false, onclick: () => clicked++ }, "label", 7, null, false, ["nested"]),
		);
		assert.equal(element.tag, "a");
		assert.equal(element.className, "chip");
		assert.equal(element.attributes.href, "#x");
		assert.equal(element.attributes.hidden, "");
		assert.equal("title" in element.attributes, false, "undefined props are skipped");
		assert.equal("data-off" in element.attributes, false, "false props are skipped");
		assert.equal(element.textContent, "label7nested");
		element.dispatch("click");
		assert.equal(clicked, 1);
	});

	it("appends strings as text nodes, never as markup", () => {
		const parent = asFake(h("div"));
		append(parent as unknown as Node, ["<b>bold</b>", [5, [null]]]);
		assert.deepEqual(
			parent.children.map((child) => [child.tag, child.text]),
			[
				["#text", "<b>bold</b>"],
				["#text", "5"],
			],
		);
	});

	it("clears an element", () => {
		const parent = h("ul", null, h("li"), h("li"));
		clear(parent);
		assert.equal(asFake(parent).children.length, 0);
	});

	it("makes a pill with a tone class and a title", () => {
		const element = asFake(pill("parked", "bad", "why"));
		assert.equal(element.className, "pill tone-bad");
		assert.equal(element.attributes.title, "why");
		assert.equal(element.textContent, "parked");
	});
});
