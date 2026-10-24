// Renders the brand PNGs from their SVG sources in a real browser:
//   docs/media/mark-512.png         from docs/media/mark.svg
//   docs/media/social-preview.png   from docs/media/src/social-preview.svg (1280x640, the GitHub social preview)
// Usage: CHROME_BIN=/path/to/chrome node scripts/render-brand.mjs
// The wordmark and tagline in the SVGs are outlined paths, so the output does not depend on installed fonts.
import { statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

const media = new URL("../docs/media/", import.meta.url);
const jobs = [
	{ source: "src/mark-512.html", output: "mark-512.png", width: 512, height: 512, transparent: true },
	{ source: "src/social-preview.svg", output: "social-preview.png", width: 1280, height: 640, transparent: false },
];

const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}) });
try {
	for (const job of jobs) {
		const page = await browser.newPage({ viewport: { width: job.width, height: job.height }, deviceScaleFactor: 1 });
		const problems = [];
		page.on("requestfailed", (request) => problems.push(`failed request: ${request.url()}`));
		page.on("console", (message) => {
			if (message.type() === "error") problems.push(`console: ${message.text()}`);
		});
		await page.goto(pathToFileURL(new URL(job.source, media).pathname).href, { waitUntil: "load" });
		await page.screenshot({ path: new URL(job.output, media).pathname, omitBackground: job.transparent });
		await page.close();
		if (problems.length > 0) throw new Error(`${job.source}: ${problems.join("; ")}`);
		console.log(`${job.output}: ${statSync(new URL(job.output, media)).size} bytes`);
	}
} finally {
	await browser.close();
}
