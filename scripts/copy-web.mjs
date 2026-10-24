// Copy the browser app's static files next to its compiled scripts; the icon is the project mark.
import { cpSync } from "node:fs";

for (const file of ["index.html", "styles.css"]) {
	cpSync(new URL(`../src/web/${file}`, import.meta.url), new URL(`../dist/web/${file}`, import.meta.url));
}
cpSync(new URL("../docs/media/mark.svg", import.meta.url), new URL("../dist/web/mark.svg", import.meta.url));
