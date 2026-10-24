// Check what `npm publish` would ship, by packing the package, inspecting the tarball, installing it into a fresh
// project and using it the way a user does: the bin, the server, the module and its types.
// Usage: npm run check:package   (builds, then packs and checks a fresh tarball)
//        node scripts/check-package.mjs <tarball>   (checks that tarball instead, e.g. the one a release publishes)
import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const STORE = join(ROOT, "fixtures", "stores", "1.4.0", "sqlite", "session.sqlite");
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

/** What may ship, besides dist/: the files a package page and a license audit need. */
const ROOT_FILES = new Set(["package.json", "README.md", "LICENSE", "CHANGELOG.md"]);
const REQUIRED = [
	...ROOT_FILES,
	"dist/cli.js",
	"dist/index.js",
	"dist/index.d.ts",
	"dist/server.js",
	"dist/web/index.html",
	"dist/web/app.js",
	"dist/web/styles.css",
	"dist/web/mark.svg",
];
const FORBIDDEN = /^(src|test|fixtures|scripts|docs|site|examples|coverage|_site|\.github)\/|\.test\.|tsconfig|biome\.json|package-lock\.json|\.tgz$|\.sqlite/;

const problems = [];
const problem = (message) => problems.push(message);
const note = (message) => console.log(`  ok  ${message}`);

function run(command, args, options = {}) {
	const result = spawnSync(command, args, { encoding: "utf8", shell: process.platform === "win32", ...options });
	if (result.status !== 0) {
		throw new Error(`${command} ${args.join(" ")} exited ${result.status}\n${result.stdout}\n${result.stderr}`);
	}
	return result.stdout;
}

const given = process.argv[2];
if (given !== undefined && !existsSync(given)) {
	console.error(`check:package: no tarball at ${given}`);
	process.exit(1);
}
if (given === undefined && !existsSync(join(ROOT, "dist", "cli.js"))) {
	console.error("check:package: dist/ is missing; run npm run build first");
	process.exit(1);
}
if (!existsSync(STORE)) {
	console.error(`check:package: fixture ${STORE} is missing`);
	process.exit(1);
}

const work = mkdtempSync(join(tmpdir(), "durable-lens-package-"));
const privateTmp = join(work, "tmp"); // the CLI's snapshots land here, so leftovers show
try {
	mkdirSync(privateTmp);
	const packDir = join(work, "pack");
	mkdirSync(packDir);

	// 1. The tarball holds exactly what should ship.
	let packed;
	let files;
	if (given === undefined) {
		[packed] = JSON.parse(run(NPM, ["pack", "--json", "--ignore-scripts", "--pack-destination", packDir], { cwd: ROOT }));
		files = packed.files.map((file) => file.path);
	} else {
		writeFileSync(join(packDir, "given.tgz"), readFileSync(given));
		packed = JSON.parse(run("tar", ["-xzOf", given, "package/package.json"]));
		files = run("tar", ["-tzf", given])
			.split("\n")
			.filter((line) => line !== "" && !line.endsWith("/"))
			.map((line) => line.replace(/^package\//, ""));
	}
	for (const required of REQUIRED) if (!files.includes(required)) problem(`the tarball lacks ${required}`);
	for (const file of files) {
		if (FORBIDDEN.test(file)) problem(`the tarball holds ${file}, which should not ship`);
		else if (!file.startsWith("dist/") && !ROOT_FILES.has(file))
			problem(`the tarball holds ${file}, which is neither dist/ nor one of ${[...ROOT_FILES].join(", ")}`);
	}
	if (packed.name !== pkg.name || packed.version !== pkg.version) problem(`packed ${packed.name}@${packed.version}, expected ${pkg.name}@${pkg.version}`);
	if (problems.length === 0) note(`${files.length} files, all of them dist/ or ${[...ROOT_FILES].join(", ")}`);
	const tarball = join(
		packDir,
		readdirSync(packDir).find((name) => name.endsWith(".tgz")),
	);

	// 2. Installing it needs no network: the package has no runtime dependencies.
	if (Object.keys(pkg.dependencies ?? {}).length > 0) problem(`runtime dependencies: ${Object.keys(pkg.dependencies).join(", ")}`);
	const project = join(work, "project");
	mkdirSync(project);
	writeFileSync(join(project, "package.json"), `${JSON.stringify({ name: "durable-lens-package-check", private: true, type: "module" })}\n`);
	run(NPM, ["install", "--no-audit", "--no-fund", tarball], { cwd: project });
	const installed = join(project, "node_modules", "durable-lens");
	note("installed the tarball into a fresh project");

	// 3. The bin has its shebang and is executable once installed.
	const bin = join(installed, "dist", "cli.js");
	const firstLine = readFileSync(bin, "utf8").split("\n", 1)[0];
	if (firstLine !== "#!/usr/bin/env node") problem(`dist/cli.js starts with ${JSON.stringify(firstLine)}, not a node shebang`);
	const link = join(project, "node_modules", ".bin", process.platform === "win32" ? "durable-lens.cmd" : "durable-lens");
	if (!existsSync(link)) problem("npm did not link the durable-lens bin");
	if (process.platform !== "win32") {
		try {
			accessSync(link, constants.X_OK);
			accessSync(bin, constants.X_OK);
		} catch {
			problem("the installed bin is not executable");
		}
	}

	// 4. The bin runs: --version, and --json on a fixture.
	const env = { ...process.env, TMPDIR: privateTmp, TMP: privateTmp, TEMP: privateTmp };
	const version = run(link, ["--version"], { cwd: project, env }).trim();
	if (version !== pkg.version) problem(`durable-lens --version printed ${JSON.stringify(version)}, expected ${pkg.version}`);
	else note(`durable-lens --version -> ${version}`);
	const lens = JSON.parse(run(link, ["--json", STORE], { cwd: project, env }));
	if (lens?.source?.kind !== "sqlite" || !Array.isArray(lens.entries) || lens.entries.length === 0 || typeof lens.format?.version !== "string") {
		problem("durable-lens --json did not print a lens of the fixture");
	} else {
		note(`durable-lens --json -> ${lens.entries.length} entries, ${lens.tasks.length} tasks, ${lens.format.version}`);
	}

	// 5. The server starts from the installed package and serves the page and its script.
	const served = await new Promise((resolve) => {
		const child = spawn(link, [STORE, "--no-watch"], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" });
		let out = "";
		const finish = (value) => {
			clearTimeout(timer);
			child.kill("SIGTERM");
			resolve(value);
		};
		const timer = setTimeout(() => finish(`no URL after 20 s: ${out}`), 20_000);
		child.stdout.on("data", async (chunk) => {
			out += chunk;
			const url = /(http:\/\/127\.0\.0\.1:\d+\/\S+\/)/.exec(out)?.[1];
			if (url === undefined) return;
			try {
				const page = await fetch(url);
				const script = await fetch(`${url}app.js`);
				const icon = await fetch(`${url}mark.svg`);
				const ok = page.status === 200 && script.status === 200 && icon.status === 200 && (await page.text()).includes("<title>");
				finish(ok ? true : `page ${page.status}, app.js ${script.status}, mark.svg ${icon.status}`);
			} catch (error) {
				finish(String(error));
			}
		});
		child.on("exit", (code) => code !== null && code !== 143 && finish(`exited ${code}: ${out}`));
	});
	if (served === true) note("durable-lens <store> serves the page, app.js and mark.svg");
	else problem(`the installed server failed: ${served}`);
	const leftovers = readdirSync(privateTmp);
	if (leftovers.length > 0) problem(`the CLI left ${leftovers.join(", ")} in its temp directory`);

	// 6. The module imports, and works.
	const probe = `import * as api from "durable-lens";
const lens = await api.openLens(${JSON.stringify(STORE)});
console.log(JSON.stringify({ exports: Object.keys(api).sort(), entries: lens.entries.length }));`;
	const imported = JSON.parse(run(process.execPath, ["--input-type=module", "-e", probe], { cwd: project, env }));
	for (const name of ["openLens", "buildLens", "serve", "applyOps"]) if (!imported.exports.includes(name)) problem(`import "durable-lens" lacks ${name}`);
	if (imported.entries !== lens.entries.length) problem("openLens through the module and --json disagree");
	else note(`import "durable-lens" -> ${imported.exports.length} exports`);

	// 7. A TypeScript consumer typechecks against the shipped declarations, without any special compiler options.
	const tsc = join(ROOT, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");
	writeFileSync(
		join(project, "consumer.ts"),
		`import { openLens, type Lens, type LensSubmission, type OpenOptions } from "durable-lens";

type IsAny<T> = 0 extends 1 & T ? true : false;
const resolved: IsAny<Lens> extends false ? true : never = true; // the types came from the package, not from \`any\`
const options: OpenOptions = { restartLimit: 3 };
const lens: Lens = await openLens("store.sqlite", options);
const id: number | undefined = lens.entries[0]?.id;
const submission: LensSubmission | undefined = lens.submissions[0];
export { id, resolved, submission };
`,
	);
	for (const [module, moduleResolution] of [
		["nodenext", "nodenext"],
		["esnext", "bundler"],
	]) {
		writeFileSync(
			join(project, `tsconfig.${moduleResolution}.json`),
			JSON.stringify({
				compilerOptions: {
					module,
					moduleResolution,
					target: "ES2023",
					strict: true,
					noEmit: true,
					skipLibCheck: false,
					types: ["node"],
					typeRoots: [join(ROOT, "node_modules", "@types")],
				},
				files: ["consumer.ts"],
			}),
		);
		const result = spawnSync(tsc, ["-p", `tsconfig.${moduleResolution}.json`], { cwd: project, encoding: "utf8", shell: process.platform === "win32" });
		if (result.status === 0) note(`TypeScript consumer typechecks (moduleResolution ${moduleResolution})`);
		else problem(`a TypeScript consumer fails to typecheck with moduleResolution ${moduleResolution}:\n${result.stdout}${result.stderr}`);
	}
} catch (error) {
	problem(error instanceof Error ? error.message : String(error));
} finally {
	rmSync(work, { recursive: true, force: true });
}

if (problems.length > 0) {
	console.error(`\ncheck:package found ${problems.length} problem${problems.length === 1 ? "" : "s"}:`);
	for (const message of problems) console.error(`  - ${message}`);
	process.exit(1);
}
console.log("check:package: ok");
