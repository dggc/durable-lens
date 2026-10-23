// Record docs/media/demo.gif and the README screenshots from the 1.4.0 fixture.
// Usage: npm run build && CHROME_BIN=/path/to/chrome node scripts/record-demo.mjs   (needs ffmpeg on PATH)
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { serve } from "../dist/server.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const media = join(root, "docs", "media");
mkdirSync(media, { recursive: true });

// A neutral file name in a scratch directory: the page shows the path as typed.
const scratch = mkdtempSync(join(tmpdir(), "durable-lens-demo-"));
copyFileSync(join(root, "fixtures", "stores", "1.4.0", "sqlite", "session.sqlite"), join(scratch, "acme-triage.sqlite"));
process.chdir(scratch);
const running = await serve("acme-triage.sqlite", { watch: false, restartLimit: 3 });
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}) });
const page = await browser.newPage({ viewport: { width: 1280, height: 760 }, colorScheme: "dark" });

const frames = [];
let count = 0;
async function frame(seconds) {
	const file = join(scratch, `frame-${String(++count).padStart(3, "0")}.png`);
	await page.screenshot({ path: file });
	frames.push({ file, seconds });
}
async function still(name) {
	await page.screenshot({ path: join(media, `${name}.png`) });
}
const scrollTo = async (top, steps) => {
	const from = await page.evaluate(() => document.querySelector(".content").scrollTop);
	for (let i = 1; i <= steps; i++) {
		await page.evaluate((y) => document.querySelector(".content").scrollTo(0, y), from + ((top - from) * i) / steps);
		await frame(0.08);
	}
};

try {
	await page.goto(`${running.url}#v=timeline&c=1`);
	await page.waitForSelector(".gantt");
	await frame(2.2);
	await still("timeline");
	// Down the transcript to the answer: a Markdown table, and pasted HTML that stays text.
	const answer = await page.evaluate(() => document.querySelector(".fork-mark").closest(".card").offsetTop - 120);
	await scrollTo(answer, 14);
	await frame(2.6);
	await still("transcript");
	await scrollTo(0, 6);

	await page.click(".tab >> text=Tasks");
	await page.waitForSelector(".task-row");
	await frame(1.4);
	await page.click(".task-row >> text=app.mirror-sync");
	await page.waitForSelector(".details-head");
	await frame(2.4);
	await still("tasks");
	await page.click(".task-row >> text=app.publish");
	await frame(1.8);

	await page.click(".tab >> text=Documents");
	await page.click(".task-row >> text=app.notes");
	await page.waitForSelector(".slider");
	await frame(1.2);
	for (const value of [2, 1, 0, 1, 2, 3]) {
		await page.evaluate((v) => {
			const slider = document.querySelector(".slider");
			slider.value = String(v);
			slider.dispatchEvent(new Event("input"));
		}, value);
		await frame(0.7);
	}
	await still("documents");

	await page.click(".conv >> text=Fork of #1");
	await page.waitForSelector(".view-head");
	await page.click("a.chip >> text=compare branches");
	await page.waitForSelector(".compare-cols");
	await frame(3);
	await still("compare");

	await page.click(".tab >> text=Usage");
	await page.waitForSelector(".stat-cards");
	await frame(2.4);
	await still("usage");
} finally {
	await browser.close();
	await running.close();
}

// ffmpeg's concat demuxer holds each frame for its duration; one palette for the whole GIF.
const list = frames.map(({ file, seconds }) => `file '${file}'\nduration ${seconds}`).join("\n");
writeFileSync(join(scratch, "frames.txt"), `${list}\nfile '${frames.at(-1).file}'\n`);
execFileSync("ffmpeg", [
	"-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", join(scratch, "frames.txt"),
	"-vf", "fps=12,scale=1100:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=160:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle",
	"-loop", "0", join(media, "demo.gif"),
]);
rmSync(scratch, { recursive: true, force: true });
console.log(`${frames.length} frames → docs/media/demo.gif`);
