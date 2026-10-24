// Regenerates docs/media/logo.svg, docs/media/logo-dark.svg and docs/media/src/social-preview.svg.
// The wordmark and the tagline are outlined from JetBrains Mono (SIL Open Font License 1.1), so the
// files render the same on a machine without the font. docs/media/mark.svg is hand-authored and is not
// produced here; the lens geometry below repeats it.
//
// Usage, from a directory where `npm install --ignore-scripts opentype.js@1.3.4` has been run:
//   node /path/to/outline.mjs <JetBrainsMono-Bold.ttf> <JetBrainsMono-Regular.ttf>
// Then render the PNGs with `node scripts/render-brand.mjs`.
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const require = createRequire(`${process.cwd()}/`);
const opentype = require("opentype.js");
const [boldPath, regularPath] = process.argv.slice(2);
if (!boldPath || !regularPath) {
	console.error("usage: node outline.mjs <JetBrainsMono-Bold.ttf> <JetBrainsMono-Regular.ttf>");
	process.exit(2);
}
const bold = opentype.loadSync(boldPath);
const regular = opentype.loadSync(regularPath);
const media = fileURLToPath(new URL("..", import.meta.url));

const palettes = {
	light: { ink: "#1c2330", ring: "#3563e9", green: "#18864f", violet: "#7a4cc9", dim: 0.32 },
	dark: { ink: "#dde3ec", ring: "#7aa2ff", green: "#4cc38a", violet: "#b48cf2", dim: 0.35 },
};

function outline(font, text, x, y, size) {
	return font.getPath(text, x, y, size).toPathData(2);
}

// The lens over the log, on the same 64-unit grid as mark.svg, without the tile.
function lens(p, id) {
	return `<defs>
		<clipPath id="${id}-glass"><circle cx="27.5" cy="27.5" r="15.5"/></clipPath>
		<g id="${id}-log">
			<rect x="5" y="16.5" width="31" height="6.5" rx="3.25" fill="${p.green}"/>
			<rect x="20" y="24.25" width="40" height="6.5" rx="3.25" fill="${p.violet}"/>
			<rect x="5" y="32" width="21" height="6.5" rx="3.25" fill="${p.green}"/>
			<rect x="31" y="32" width="11" height="6.5" rx="3.25" fill="${p.green}"/>
		</g>
	</defs>
	<use href="#${id}-log" opacity="${p.dim}"/>
	<use href="#${id}-log" clip-path="url(#${id}-glass)"/>
	<circle cx="27.5" cy="27.5" r="15.5" fill="none" stroke="${p.ring}" stroke-width="6.5"/>
	<path d="M39.5 39.5 52 52" fill="none" stroke="${p.ring}" stroke-width="8" stroke-linecap="round"/>`;
}

const WORD_X = 72;
const WORD_Y = 45;
const WORD_SIZE = 42;
const advance = (WORD_SIZE * bold.glyphs.get(bold.charToGlyphIndex("d")).advanceWidth) / bold.unitsPerEm;

// "durable" + "-" + "lens": the hyphen takes the colour of the log bars.
function wordmark(p) {
	const hyphenX = WORD_X + advance * 7;
	const lensX = WORD_X + advance * 8;
	return `<path d="${outline(bold, "durable", WORD_X, WORD_Y, WORD_SIZE)}" fill="${p.ink}"/>
	<path d="${outline(bold, "-", hyphenX, WORD_Y, WORD_SIZE)}" fill="${p.green}"/>
	<path d="${outline(bold, "lens", lensX, WORD_Y, WORD_SIZE)}" fill="${p.ink}"/>`;
}

const LOCKUP = { x: 4, y: 8, width: Math.ceil(WORD_X + advance * 12 - 4 + 1), height: 49 };

function lockup(p, id) {
	return `${lens(p, id)}
	${wordmark(p)}`;
}

function logo(p, id) {
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${LOCKUP.x} ${LOCKUP.y} ${LOCKUP.width} ${LOCKUP.height}" width="${LOCKUP.width * 2}" height="${LOCKUP.height * 2}" role="img" aria-label="durable-lens">
	<title>durable-lens</title>
	${lockup(p, id)}
</svg>
`;
}

writeFileSync(`${media}logo.svg`, logo(palettes.light, "dl"));
writeFileSync(`${media}logo-dark.svg`, logo(palettes.dark, "dl"));

// Social preview, 1280x640. The screenshot is cropped from timeline.png and bleeds off the right and bottom edges.
const d = palettes.dark;
const scale = 1.35;
const tagSize = 38;
const command = "npx durable-lens ./session.sqlite";
const cmdSize = 22;
const cmdAdvance = (cmdSize * regular.glyphs.get(regular.charToGlyphIndex("a")).advanceWidth) / regular.unitsPerEm;
const cmdWidth = Math.round(command.length * cmdAdvance + 48);
const shotScale = 0.8;
const shotX = 618;
const shotY = 112;
const cropX = 290;
const cropY = 50;

const social = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 640" width="1280" height="640" role="img" aria-label="durable-lens: a read-only inspector for pi-durable storage">
	<title>durable-lens: a read-only inspector for pi-durable storage</title>
	<defs>
		<radialGradient id="glow" cx="0.12" cy="0.05" r="0.75">
			<stop offset="0" stop-color="${d.ring}" stop-opacity="0.16"/>
			<stop offset="1" stop-color="${d.ring}" stop-opacity="0"/>
		</radialGradient>
		<clipPath id="shot"><rect x="${shotX}" y="${shotY}" width="760" height="620" rx="14"/></clipPath>
		<filter id="shadow" x="-10%" y="-10%" width="130%" height="130%">
			<feDropShadow dx="0" dy="14" stdDeviation="18" flood-color="#000000" flood-opacity="0.55"/>
		</filter>
	</defs>
	<rect width="1280" height="640" fill="#0d1016"/>
	<rect width="1280" height="640" fill="url(#glow)"/>
	<g transform="translate(72 128) scale(${scale}) translate(${-LOCKUP.x} ${-LOCKUP.y})">
		${lockup(d, "sp")}
	</g>
	<path d="${outline(regular, "A read-only inspector", 72, 296, tagSize)}" fill="${d.ink}"/>
	<path d="${outline(regular, "for pi-durable storage", 72, 346, tagSize)}" fill="${d.ink}"/>
	<rect x="72" y="410" width="${cmdWidth}" height="56" rx="12" fill="#141922" stroke="#262e3b" stroke-width="2"/>
	<path d="${outline(regular, command, 96, 446, cmdSize)}" fill="${d.green}"/>
	<rect x="${shotX}" y="${shotY}" width="760" height="620" rx="14" fill="#141922" filter="url(#shadow)"/>
	<image href="../timeline.png" x="${shotX - cropX * shotScale}" y="${shotY - cropY * shotScale}" width="${1280 * shotScale}" height="${760 * shotScale}" clip-path="url(#shot)"/>
	<rect x="${shotX}" y="${shotY}" width="760" height="620" rx="14" fill="none" stroke="#262e3b" stroke-width="2"/>
</svg>
`;
writeFileSync(`${media}src/social-preview.svg`, social);
console.log("wrote logo.svg, logo-dark.svg, src/social-preview.svg");
