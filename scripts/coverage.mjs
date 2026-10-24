// Run the tests with coverage over src/ and enforce the thresholds below. The spec report goes to the terminal and an
// lcov report to coverage/lcov.info, which CI uploads. Run after a build: the CLI tests start dist/cli.js.
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync } from "node:fs";

// Just below what the tests reach (see the report), rounded down to a multiple of 5, so a real drop fails the build
// and ordinary churn does not. Raise them when coverage rises.
const THRESHOLDS = { lines: 95, branches: 90, functions: 95 };

const root = new URL("..", import.meta.url);
mkdirSync(new URL("coverage/", root), { recursive: true });
const tests = readdirSync(new URL("test/", root))
	.filter((name) => name.endsWith(".test.ts"))
	.sort()
	.map((name) => `test/${name}`);

const result = spawnSync(
	process.execPath,
	[
		"--test",
		"--experimental-test-coverage",
		"--test-coverage-include=src/**",
		`--test-coverage-lines=${THRESHOLDS.lines}`,
		`--test-coverage-branches=${THRESHOLDS.branches}`,
		`--test-coverage-functions=${THRESHOLDS.functions}`,
		"--test-reporter=spec",
		"--test-reporter-destination=stdout",
		"--test-reporter=lcov",
		"--test-reporter-destination=coverage/lcov.info",
		...tests,
	],
	{ cwd: root, stdio: "inherit" },
);
process.exit(result.status ?? 1);
