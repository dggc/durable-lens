// Load every view in a real browser and fail on anything the store's content could make the page do:
// an element parsed from transcript text, a dialog, a request beyond the loopback server, or a console error.
// Usage: CHROME_BIN=/path/to/chrome node scripts/check-ui.mjs   (after npm run build)
import { chromium } from "playwright-core";
import { serve } from "../dist/server.js";

const store = new URL("../fixtures/stores/1.4.0/sqlite/session.sqlite", import.meta.url).pathname;
const running = await serve(store, { watch: false, restartLimit: 3 });
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}) });
const problems = [];
try {
	const page = await browser.newPage();
	page.on("dialog", (dialog) => {
		problems.push(`dialog: ${dialog.message()}`);
		void dialog.dismiss();
	});
	page.on("request", (request) => {
		if (!request.url().startsWith(new URL(running.url).origin) && !request.url().startsWith("data:")) problems.push(`request: ${request.url()}`);
	});
	page.on("console", (message) => {
		if (message.type() === "error") problems.push(`console: ${message.text()}`);
	});
	page.on("pageerror", (error) => problems.push(`page error: ${error.message}`));
	const lens = running.lens();
	const hashes = [
		...lens.conversations.map((conversation) => `#v=timeline&c=${conversation.id}`),
		...lens.conversations.filter((conversation) => conversation.parent).map((conversation) => `#v=timeline&c=${conversation.id}&cmp=1`),
		"#v=tasks&c=1&all=1",
		...lens.tasks.slice(-8).map((task) => `#v=tasks&c=1&t=${task.id}`),
		...lens.documents.map((document) => `#v=documents&c=1&d=${document.id}`),
		"#v=usage&c=1",
	];
	for (const hash of hashes) {
		await page.goto(running.url + hash);
		await page.waitForSelector(".tabs");
		// Open every collapsed block, so nothing escapes the check by being hidden.
		await page.evaluate(() => document.querySelectorAll("details").forEach((element) => (element.open = true)));
		const injected = await page.evaluate(() => document.querySelectorAll("#app img, #app script, #app iframe, #app object, #app embed, #app [onerror], #app [onclick], #app a[href^='javascript']").length);
		if (injected > 0) problems.push(`${hash}: ${injected} elements parsed from content`);
	}
	await page.goto(`${running.url}#v=timeline&c=1`);
	const text = await page.evaluate(() => document.body.innerText);
	if (!text.includes(`<img src=x onerror="alert('xss')">`) || !text.includes("<script>alert(1)</script>")) problems.push("the untrusted HTML is not shown as text");
	console.log(`checked ${hashes.length} views`);
} finally {
	await browser.close();
	await running.close();
}
if (problems.length > 0) {
	console.error(problems.join("\n"));
	process.exit(1);
}
console.log("no injected elements, dialogs, outside requests or console errors");
