// Prepare vmain/ to run pi-durable's unreleased main branch from source.
// Usage: node fixtures/generate/link-main.mjs <checkout of github.com/earendil-works/pi>
// Copies v1.4.0's third-party node_modules and links the Earendil packages to the checkout's sources, which run with
// `node --conditions=source` (Node strips the TypeScript types). Records the checkout's commit in vmain/SOURCE.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const checkout = process.argv[2] && resolve(process.argv[2]);
if (!checkout || !existsSync(join(checkout, "packages", "durable", "src"))) {
	console.error("usage: node link-main.mjs <pi checkout with packages/{chord,ai,durable,codemode,telemetry}>");
	process.exit(2);
}
const base = join(here, "v1.4.0", "node_modules");
if (!existsSync(base)) throw new Error("install v1.4.0 first (npm ci in fixtures/generate/v1.4.0)");

const target = join(here, "vmain");
const modules = join(target, "node_modules");
rmSync(modules, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
cpSync(base, modules, { recursive: true, verbatimSymlinks: true });
const packages = { chord: "chord", "pi-ai": "ai", "pi-durable": "durable", "pi-codemode": "codemode", "pi-telemetry": "telemetry" };
for (const [name, directory] of Object.entries(packages)) {
	const link = join(modules, "@earendil-works", name);
	rmSync(link, { recursive: true, force: true });
	symlinkSync(join(checkout, "packages", directory), link, "dir");
}
// Node resolves the linked sources by their real path, so their own bare imports look in <checkout>/node_modules.
// Type stripping refuses files under node_modules, which rules out --preserve-symlinks.
const checkoutModules = join(checkout, "node_modules");
if (existsSync(checkoutModules) && !lstatSync(checkoutModules).isSymbolicLink()) {
	throw new Error(`${checkoutModules} exists; use a checkout without an npm install`);
}
rmSync(checkoutModules, { force: true });
symlinkSync(modules, checkoutModules, "dir");
const commit = execFileSync("git", ["-C", checkout, "log", "-1", "--format=%H %cI"], { encoding: "utf8" }).trim();
writeFileSync(join(target, "SOURCE"), `https://github.com/earendil-works/pi ${commit}\n`);
cpSync(join(here, "run.template.mjs"), join(target, "run.mjs"));
console.log(`vmain: ${commit}`);
