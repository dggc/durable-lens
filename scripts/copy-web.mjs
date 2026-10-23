// Copy the browser app's static files next to its compiled scripts.
import { cpSync } from "node:fs";
for (const file of ["index.html", "styles.css"]) {
	cpSync(new URL(`../src/web/${file}`, import.meta.url), new URL(`../dist/web/${file}`, import.meta.url));
}
