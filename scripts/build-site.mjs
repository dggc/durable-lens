// Assembles _site/ for GitHub Pages from site/ plus the images it uses from docs/media/.
// Pages in site/ refer to those images as media/<name>; this script copies each one it finds referenced, and fails
// when a referenced local file is missing, so a renamed image breaks the build rather than the page.
// Usage: node scripts/build-site.mjs
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, extname, join, posix, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const siteDir = join(root, "site");
const mediaDir = join(root, "docs", "media");
const outDir = join(root, "_site");
const origin = "https://dggc.github.io";
const basePath = "/durable-lens/";
const textTypes = new Set([".html", ".css"]);

function listFiles(dir) {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		return entry.isDirectory() ? listFiles(path) : [path];
	});
}

// Local references in a page or a stylesheet: href, src, srcset, content="..." of og:image / twitter:image, and url().
function references(path, text) {
	const found = [];
	if (extname(path) === ".css") {
		for (const match of text.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) found.push(match[1]);
		return found;
	}
	for (const match of text.matchAll(/\b(?:href|src)\s*=\s*"([^"]*)"/g)) found.push(match[1]);
	for (const match of text.matchAll(/\bsrcset\s*=\s*"([^"]*)"/g)) {
		for (const candidate of match[1].split(",")) found.push(candidate.trim().split(/\s+/)[0]);
	}
	for (const match of text.matchAll(/<meta\b[^>]*\b(?:property|name)="(?:og|twitter):image"[^>]*\bcontent="([^"]*)"/g)) found.push(match[1]);
	return found;
}

// Where a reference points inside the site, as a path relative to the site root, or null for an external link,
// a fragment, or a non-file scheme.
function localTarget(reference, fromFile) {
	if (reference === "" || reference.startsWith("#") || /^(?:mailto|tel|data|javascript):/.test(reference)) return null;
	let path = reference.split("#")[0].split("?")[0];
	if (/^https?:\/\//.test(path)) {
		if (!path.startsWith(origin + basePath)) return null;
		path = path.slice(origin.length);
	}
	if (path.startsWith("//")) return null;
	if (path.startsWith("/")) {
		if (!path.startsWith(basePath)) throw new Error(`${fromFile}: "${reference}" is absolute but not under ${basePath}`);
		path = path.slice(basePath.length);
	} else {
		path = posix.join(dirname(relative(siteDir, fromFile)).split("\\").join("/"), path);
	}
	path = posix.normalize(path);
	if (path.startsWith("..")) throw new Error(`${fromFile}: "${reference}" leaves the site`);
	return path === "." || path === "" || path.endsWith("/") ? posix.join(path === "." ? "" : path, "index.html") : path;
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
cpSync(siteDir, outDir, { recursive: true });

const problems = [];
const copied = new Set();
for (const file of listFiles(siteDir).filter((path) => textTypes.has(extname(path)))) {
	const text = readFileSync(file, "utf8");
	for (const reference of references(file, text)) {
		let target;
		try {
			target = localTarget(reference, file);
		} catch (error) {
			problems.push(error.message);
			continue;
		}
		if (target === null) continue;
		if (existsSync(join(outDir, target))) continue;
		const mediaName = target.startsWith("media/") ? target.slice("media/".length) : null;
		const source = mediaName === null ? null : join(mediaDir, mediaName);
		if (source === null || !existsSync(source) || !statSync(source).isFile()) {
			problems.push(`${relative(root, file)}: "${reference}" does not exist (looked for ${target}${mediaName === null ? "" : ` in docs/media`})`);
			continue;
		}
		mkdirSync(dirname(join(outDir, target)), { recursive: true });
		cpSync(source, join(outDir, target));
		copied.add(target);
	}
}

for (const required of ["index.html", "404.html", ".nojekyll"]) {
	if (!existsSync(join(outDir, required))) problems.push(`site/${required} is missing`);
}

if (problems.length > 0) {
	console.error(`Site build failed:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
	process.exit(1);
}

const files = listFiles(outDir).map((path) => relative(outDir, path));
const bytes = files.reduce((total, path) => total + statSync(join(outDir, path)).size, 0);
console.log(`_site: ${files.length} files, ${(bytes / 1024).toFixed(0)} KiB (copied from docs/media: ${[...copied].sort().join(", ")})`);
