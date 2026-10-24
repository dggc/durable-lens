# durable-lens brand

The mark is a lens over a log: three timeline bars run across the picture, and the lens ring brightens the part of them it sits on. It echoes the app, where the same green bars sit on a timeline strip.

## Files

| File | Use |
|---|---|
| `logo.svg` | Mark and wordmark, for light backgrounds. |
| `logo-dark.svg` | The same, for dark backgrounds. |
| `mark.svg` | Square icon on its own dark tile. Legible at 16 px; use it as a favicon or an avatar on any background. |
| `mark-512.png` | `mark.svg` at 512 px, for places that take a raster (repository or organization avatar, app icon). |
| `social-preview.png` | 1280x640 card for the GitHub social preview and link unfurls. Upload it under Settings, Social preview. |
| `src/outline.mjs` | Regenerates `logo.svg`, `logo-dark.svg` and `src/social-preview.svg` from the font. |
| `src/social-preview.svg`, `src/mark-512.html` | Sources of the two PNGs. |

`logo.svg`, `logo-dark.svg` and `mark.svg` are plain SVG with a `viewBox`, no embedded raster and no external references. The wordmark and the tagline in the social preview are outlined paths, not text, so they look the same everywhere.

In a README or a page, switch on the color scheme:

```html
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/media/logo-dark.svg">
  <img alt="durable-lens" src="docs/media/logo.svg" height="48">
</picture>
```

## Regenerating

```sh
# PNGs, from the SVG sources (needs a Chromium-based browser and playwright-core, which the repository already has)
CHROME_BIN=/path/to/chrome node scripts/render-brand.mjs

# Logos and the social-preview source, from the font (only when the wordmark or the tagline changes)
mkdir /tmp/outline && cd /tmp/outline && npm install --ignore-scripts opentype.js@1.3.4
node /path/to/durable-lens/docs/media/src/outline.mjs JetBrainsMono-Bold.ttf JetBrainsMono-Regular.ttf
```

`mark.svg` is drawn by hand; `outline.mjs` repeats its lens geometry for the logos, so change both together. The social preview crops `timeline.png`; when the app's look changes, recapture that screenshot and render again.

## Font

The wordmark is set in **JetBrains Mono Bold** and the social-preview tagline in **JetBrains Mono Regular**, version 2.304, copyright 2020 The JetBrains Mono Project Authors, <https://github.com/JetBrains/JetBrainsMono>. It is licensed under the **SIL Open Font License 1.1** (<https://openfontlicense.org>). The outlines were taken from the Nerd Fonts 3.5.0 build of the family, which keeps JetBrains Mono's Latin glyphs. Turning glyphs into artwork does not distribute the font; no font file is in this repository, and none is loaded by the site.

A monospaced face fits a tool that reads logs, and the hyphen becomes a bar of the same green as the log bars in the mark.

## Colors

The brand colors are the app's own (`src/web/styles.css`). Each variant uses the app's dark or light tone of the same hue, so a logo looks like it belongs to the page it sits on.

| Role | On dark (`logo-dark.svg`, `mark.svg`) | On light (`logo.svg`) | Where |
|---|---|---|---|
| Ink | `#dde3ec` | `#1c2330` | Wordmark |
| Lens (accent blue) | `#7aa2ff` | `#3563e9` | Ring and handle |
| Log green | `#4cc38a` | `#18864f` | Bars and the wordmark hyphen |
| Log violet | `#b48cf2` | `#7a4cc9` | One bar |
| Tile and page | `#0d1016` | white | `mark.svg` tile; page background |

Contrast against the background it is meant for: ink 14.8:1 on dark and 15.8:1 on light; lens 7.7:1 on dark and 5.1:1 on light; green 8.6:1 and 4.6:1; violet 7.2:1 and 5.7:1. The bars outside the lens are the same colors at about one third opacity (`0.35` on dark, `0.32` on light).

## Clear space and size

- Keep clear space around the logo of at least half the lens ring's outer diameter, on every side.
- Smallest size: the mark alone at 16 px; the full logo at 24 px high.
- Give the logo at least 3:1 contrast against its background: `logo.svg` on white or near-white, `logo-dark.svg` on `#0d1016` or similar dark. On anything in between, or on a photo, use `mark.svg`, which carries its own tile.

## Do and don't

- Do use the files as they are, and scale them proportionally.
- Do use `mark.svg` for favicons, avatars and anywhere the background is not under your control.
- Don't recolor, outline, rotate, stretch, add effects, or retype the wordmark in another font.
- Don't put `logo.svg` on a dark background or `logo-dark.svg` on a light one.
- Don't drop the handle or the bars from the mark, or crop the lens ring.
- Don't combine the mark with Earendil's or pi's marks, or place it so it suggests an affiliation. durable-lens is not affiliated with Earendil or pi.
