# Icons

**These files are generated. Do not edit them by hand — your changes will be overwritten.**

Regenerate with:

```
node tools/make-icons.js
```

It writes every file in this directory, then verifies each PNG by re-parsing it from disk
(signature, per-chunk CRC-32, IHDR fields, inflated scanlines, a handful of pixel probes, and —
for the maskable icon — that no artwork escapes the 80% safe circle) and prints what it found.
Any failure throws and the script exits non-zero, so a broken icon cannot be written silently.
No arguments needed; an optional first argument overrides the output directory. Node 18+, no
dependencies — the project has none, so the PNGs are rasterised into a byte array and encoded
by hand using only `node:zlib` for the IDAT deflate stream.

Output is deterministic: regenerating without changing the source produces byte-identical files,
so an accidental rerun will not show up as a diff.

| File | Size | Notes |
| --- | --- | --- |
| `icon-192.png` | 192×192 | Manifest icon, `purpose: any`. Rounded plate, transparent corners. |
| `icon-512.png` | 512×512 | Manifest icon, `purpose: any`. |
| `icon-maskable-512.png` | 512×512 | Manifest icon, `purpose: maskable`. Full-bleed background; artwork stays inside the 80% safe circle. |
| `apple-touch-icon.png` | 180×180 | `<link rel="apple-touch-icon">`. Full-bleed and fully opaque — iOS renders alpha as black and applies its own squircle. |
| `favicon.svg` | vector | `<link rel="icon" type="image/svg+xml">`. Same artwork as rects on a 48-unit viewBox. |

All PNGs are 8-bit RGBA (colour type 6), non-interlaced, with filter type 0 on every scanline.

## The artwork

A sun over a ridge on a rounded panel — the icon is a picture of what the device displays,
drawn only in the four inks the hardware can actually print: black `#000000`, white `#FFFFFF`,
red `#DC2828`, yellow `#F0CD32`, on the app background `#0D1117`.

It is deliberately blocky: a 12×12 cell grid, defined as ASCII art in the `ART` constant near
the top of the generator, so editing the picture means editing twelve strings. Each cell is
split into 2×2 sub-cells for dithering. The sun's rim uses the one dither in the set — a
red/yellow checkerboard, which is exactly how a 4-colour panel fakes an orange it cannot print.
At full size it reads as a checkered ring; below about 32px it blends into orange.

Panel sizes are snapped to a whole multiple of the sub-cell grid so that no cell or dither
square is a fraction of a pixel wider than its neighbours. That is why `panelFrac` in the
variant table is approximate: 0.75 lands on 144/192, 384/512 and 144/180.

If you edit `ART` or a `panelFrac`, just rerun the generator — the maskable safe-circle check
is an assertion, not a comment, so it will fail the build rather than ship a clipped icon. The
current maskable layout clears the circle by about 19px.

If you change the palette here, change it in `js/render.js` too — they are meant to match.
