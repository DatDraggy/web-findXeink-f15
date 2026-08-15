#!/usr/bin/env node
/**
 * make-icons.js — generates the PWA icon set for Web FindXeink F15.
 *
 * The project has no dependencies, so there is no image library here: the icons are
 * rasterised into a plain RGBA byte array and encoded as PNG by hand. Only node:zlib
 * is used, for the IDAT deflate stream.
 *
 * The artwork is a 12x12 grid of the display's own four inks (red / yellow / white /
 * black) inside a rounded "panel" — i.e. the icon is a picture of what the device
 * shows. The grid is drawn with hard edges on purpose; the pixelated look is the
 * point, and it survives being scaled down to a 16px favicon.
 *
 * Usage:  node tools/make-icons.js [outDir]
 *         (outDir defaults to ../icons relative to this script)
 */

import { deflateSync, inflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/* ------------------------------------------------------------------ palette */

/**
 * The device's fixed 4-colour palette, plus the app's UI background.
 * These RGB triples match js/render.js and the panel's own firmware palette,
 * so the icon is literally drawn in the inks the hardware can print.
 * @type {Object<string, [number, number, number]>}
 */
const INK = {
  K: [0x00, 0x00, 0x00], // black
  W: [0xff, 0xff, 0xff], // white  (the e-ink "paper")
  R: [0xdc, 0x28, 0x28], // red    #DC2828
  Y: [0xf0, 0xcd, 0x32]  // yellow #F0CD32
};

/** App chrome background, #0D1117. @type {[number, number, number]} */
const BG = [0x0d, 0x11, 0x17];

/* ------------------------------------------------------------------ artwork */

/**
 * The motif, one character per cell, row-major, top to bottom.
 *   '.' white   'K' black   'R' red   'Y' yellow   'o' red/yellow dither
 * A sun over a ridge line, on a black ground band. Big shapes only, because at
 * 48px a cell is barely 3px wide and anything finer turns to mush.
 * @type {string[]}
 */
const ART = [
  '............',
  '.......ooo..',
  '......oYYYo.',
  '......oYYYo.',
  '......oYYYo.',
  '....R..ooo..',
  '...RRR......',
  '..RRRRR....K',
  '.RRRRRRR..KK',
  'RRRRRRRRRKKK',
  'KKKKKKKKKKKK',
  'KKKKKKKKKKKK'
];

/** Grid side in cells. @type {number} */
const CELLS = ART.length;

/**
 * Dither sub-cells per art cell, per axis. A dither has to be finer than the
 * shapes it shades or it stops reading as shading: at 1 sub-cell the sun's rim
 * looked like solid red rays instead of an orange halo.
 * @type {number}
 */
const SUB = 2;

/** Side of the full sub-cell grid. @type {number} */
const SUBS = CELLS * SUB;

// Cheap invariant: a mis-typed row would silently skew the whole motif.
for (const row of ART) {
  if (row.length !== CELLS) throw new Error(`ART row is ${row.length} cells, expected ${CELLS}`);
}

/**
 * Resolves one sub-cell of the grid to an ink triple.
 * The 'o' cells are a checkerboard of red against yellow. The panel has no
 * orange, so that is how it has to fake one — the sun's rim is the icon quoting
 * the app's own dither, and at icon sizes it really does read as orange.
 * @param {number} sx Sub-cell column, 0-based, 0..SUBS-1.
 * @param {number} sy Sub-cell row, 0-based, 0..SUBS-1.
 * @returns {[number, number, number]} RGB triple.
 */
function subInk(sx, sy) {
  const c = ART[(sy / SUB) | 0][(sx / SUB) | 0];
  if (c === 'o') return ((sx + sy) & 1) ? INK.Y : INK.R;
  if (c === '.') return INK.W;
  const ink = INK[c];
  if (!ink) throw new Error(`unknown art character ${JSON.stringify(c)}`);
  return ink;
}

/* --------------------------------------------------------------- rasteriser */

/**
 * Supersampling factor. Everything is drawn at SS x resolution and box-filtered
 * down, which is the whole anti-aliasing strategy: the only curves in the icon
 * are the two rounded rectangles, and 4x4 samples is plenty for those.
 * @type {number}
 */
const SS = 4;

/**
 * Creates a fully transparent RGBA surface.
 * @param {number} n Side length in pixels.
 * @returns {{n: number, px: Uint8Array}} Surface.
 */
function surface(n) {
  return { n, px: new Uint8Array(n * n * 4) };
}

/**
 * Containment test for a rounded rectangle, evaluated at a point.
 * @param {number} px Sample x.
 * @param {number} py Sample y.
 * @param {number} x Rect left.
 * @param {number} y Rect top.
 * @param {number} w Rect width.
 * @param {number} h Rect height.
 * @param {number} r Corner radius.
 * @returns {boolean} True if the point is inside.
 */
function inRoundRect(px, py, x, y, w, h, r) {
  // Distance past the inner (corner-centre) box on each axis; zero along the
  // straight edges, so only the four corner quadrants get the circular test.
  const dx = Math.max(x + r - px, 0, px - (x + w - r));
  const dy = Math.max(y + r - py, 0, py - (y + h - r));
  return dx * dx + dy * dy <= r * r;
}

/**
 * Paints an opaque axis-aligned rectangle, optionally clipped by a predicate.
 * @param {{n: number, px: Uint8Array}} s Target surface.
 * @param {number} x Left edge, in surface pixels.
 * @param {number} y Top edge.
 * @param {number} w Width.
 * @param {number} h Height.
 * @param {[number, number, number]} rgb Ink.
 * @param {(px: number, py: number) => boolean} [clip] Sample-centre predicate.
 * @returns {void}
 */
function fillRect(s, x, y, w, h, rgb, clip) {
  const x0 = Math.max(0, Math.floor(x));
  const y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(s.n, Math.ceil(x + w));
  const y1 = Math.min(s.n, Math.ceil(y + h));
  for (let py = y0; py < y1; py++) {
    for (let pxi = x0; pxi < x1; pxi++) {
      if (clip && !clip(pxi + 0.5, py + 0.5)) continue;
      const i = (py * s.n + pxi) * 4;
      s.px[i] = rgb[0];
      s.px[i + 1] = rgb[1];
      s.px[i + 2] = rgb[2];
      s.px[i + 3] = 255;
    }
  }
}

/**
 * Box-filters a supersampled surface down to its final size.
 * Transparent samples are stored as (0,0,0,0), so summing RGBA directly is a
 * premultiplied average; dividing the colour by the *covered* sample count
 * un-premultiplies it. Doing it any other way fringes the rounded corners with
 * dark pixels.
 * @param {{n: number, px: Uint8Array}} s Supersampled surface.
 * @param {number} ss Supersampling factor.
 * @returns {{n: number, px: Uint8Array}} Downsampled surface.
 */
function downsample(s, ss) {
  const n = s.n / ss;
  if (!Number.isInteger(n)) throw new Error('surface size is not a multiple of the SS factor');
  const out = surface(n);
  const total = ss * ss;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      let r = 0, g = 0, b = 0, cov = 0;
      for (let sy = 0; sy < ss; sy++) {
        const row = (y * ss + sy) * s.n;
        for (let sx = 0; sx < ss; sx++) {
          const i = (row + x * ss + sx) * 4;
          if (!s.px[i + 3]) continue;
          r += s.px[i];
          g += s.px[i + 1];
          b += s.px[i + 2];
          cov++;
        }
      }
      const o = (y * n + x) * 4;
      if (!cov) continue; // stays transparent black
      out.px[o] = Math.round(r / cov);
      out.px[o + 1] = Math.round(g / cov);
      out.px[o + 2] = Math.round(b / cov);
      out.px[o + 3] = Math.round((cov * 255) / total);
    }
  }
  return out;
}

/**
 * Works out where the panel sits inside an icon of a given size.
 * Shared by the renderer and by the verifier's probe points so the two cannot
 * drift apart.
 * @param {number} size Icon side length in pixels.
 * @param {number} panelFrac Panel side as a fraction of the icon.
 * @returns {{panel: number, sub: number, x0: number, y0: number, panelR: number, plateR: number}}
 */
function geometry(size, panelFrac) {
  // Panel side is snapped to a whole multiple of the sub-cell grid so every cell
  // and every dither square is exactly the same width — uneven cells are very
  // visible in a blocky motif, and an uneven dither shimmers.
  const panel = Math.round((size * panelFrac) / SUBS) * SUBS;
  return {
    panel,
    sub: panel / SUBS,
    x0: Math.round((size - panel) / 2),
    y0: Math.round((size - panel) / 2),
    panelR: Math.round(panel * 0.16),
    plateR: Math.round(size * 0.22) // ~ the iOS/Android squircle radius
  };
}

/**
 * Draws one icon variant.
 * @param {number} size Output side length in pixels.
 * @param {{fullBleed: boolean, panelFrac: number}} opts
 *   fullBleed: paint the background edge to edge (maskable / iOS, which do their
 *   own masking and dislike transparency); otherwise the background is a rounded
 *   plate with transparent corners.
 *   panelFrac: panel side as a fraction of the icon.
 * @returns {Uint8Array} RGBA pixels, size*size*4.
 */
function drawIcon(size, opts) {
  const s = surface(size * SS);
  const { panel, sub, x0: px0, y0: py0, panelR, plateR } = geometry(size, opts.panelFrac);

  // Background.
  if (opts.fullBleed) {
    fillRect(s, 0, 0, s.n, s.n, BG);
  } else {
    fillRect(s, 0, 0, s.n, s.n, BG,
      (x, y) => inRoundRect(x, y, 0, 0, s.n, s.n, plateR * SS));
  }

  // Panel, clipped to its rounded rect so the solid black bottom row follows the
  // corners instead of poking out of them.
  const inPanel = (x, y) =>
    inRoundRect(x, y, px0 * SS, py0 * SS, panel * SS, panel * SS, panelR * SS);
  fillRect(s, px0 * SS, py0 * SS, panel * SS, panel * SS, INK.W, inPanel);
  for (let gy = 0; gy < SUBS; gy++) {
    for (let gx = 0; gx < SUBS; gx++) {
      const ink = subInk(gx, gy);
      if (ink === INK.W) continue; // already painted by the panel fill
      fillRect(s, (px0 + gx * sub) * SS, (py0 + gy * sub) * SS, sub * SS, sub * SS, ink, inPanel);
    }
  }

  return downsample(s, SS).px;
}

/* ------------------------------------------------------------- PNG encoding */

/**
 * CRC-32 table (IEEE 802.3 polynomial, reflected 0xEDB88320) for PNG chunk CRCs.
 * Note this is *not* the CRC-16/CCITT the device protocol uses — different job.
 * @type {Uint32Array}
 */
const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
})();

/**
 * CRC-32 of a buffer, as PNG defines it.
 * @param {Buffer} buf Bytes to checksum.
 * @returns {number} Unsigned 32-bit CRC.
 */
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC32_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Builds one PNG chunk: length, type, data, CRC-32 over type+data.
 * @param {string} type Four ASCII characters.
 * @param {Buffer} data Chunk payload.
 * @returns {Buffer} The framed chunk.
 */
function chunk(type, data) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([head, body, crc]);
}

/** PNG file signature. @type {Buffer} */
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Colour type 6 = truecolour with alpha, 8 bits per sample. @type {number} */
const COLOR_TYPE_RGBA = 6;

/**
 * Encodes an RGBA buffer as a PNG (8-bit, colour type 6, non-interlaced).
 * @param {Uint8Array} rgba Pixels, w*h*4 bytes.
 * @param {number} w Width.
 * @param {number} h Height.
 * @returns {Buffer} Complete PNG file.
 */
function encodePng(rgba, w, h) {
  if (rgba.length !== w * h * 4) throw new Error('pixel buffer does not match dimensions');

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;                  // bit depth
  ihdr[9] = COLOR_TYPE_RGBA;    // colour type
  ihdr[10] = 0;                 // compression: deflate
  ihdr[11] = 0;                 // filter method: adaptive
  ihdr[12] = 0;                 // interlace: none

  // Every scanline gets filter type 0 (None). Adaptive filters would shave a few
  // bytes, but flat colour deflates well enough that it is not worth the code.
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  const src = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.length);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    src.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    PNG_SIG,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ------------------------------------------------------------- SVG favicon */

/**
 * Emits the same motif as an SVG, for the favicon.
 * The viewBox is 48 units so the 36-unit panel divides into exactly 1.5 units
 * per sub-cell; shape-rendering=crispEdges keeps the pixel-art edges hard and,
 * more importantly, stops adjacent fills from anti-aliasing into hairline seams.
 * Same-ink sub-cells are greedily merged into the largest rectangles that fit,
 * which roughly halves the node count — the ground band alone is 4 rows deep.
 * @returns {string} SVG source.
 */
function buildSvg() {
  const U = 48, P = 36, OFF = 6, C = P / SUBS;
  const done = Array.from({ length: SUBS }, () => new Array(SUBS).fill(false));
  const rects = [];

  for (let y = 0; y < SUBS; y++) {
    for (let x = 0; x < SUBS; x++) {
      const ink = subInk(x, y);
      if (done[y][x] || ink === INK.W) continue; // white is the panel fill underneath

      // Widen, then deepen while the whole span still matches.
      let w = 1;
      while (x + w < SUBS && !done[y][x + w] && subInk(x + w, y) === ink) w++;
      let h = 1;
      while (y + h < SUBS) {
        let ok = true;
        for (let i = 0; i < w && ok; i++) ok = !done[y + h][x + i] && subInk(x + i, y + h) === ink;
        if (!ok) break;
        h++;
      }
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) done[y + j][x + i] = true;

      const hex = '#' + ink.map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase();
      rects.push(`    <rect x="${OFF + x * C}" y="${OFF + y * C}" ` +
        `width="${w * C}" height="${h * C}" fill="${hex}"/>`);
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${U} ${U}" width="${U}" height="${U}">
  <!-- Generated by tools/make-icons.js — do not edit by hand. -->
  <title>Web FindXeink F15</title>
  <defs>
    <!-- Namespaced id: this file may end up inlined into a page next to other SVGs. -->
    <clipPath id="fx15-panel">
      <rect x="${OFF}" y="${OFF}" width="${P}" height="${P}" rx="6"/>
    </clipPath>
  </defs>
  <rect width="${U}" height="${U}" rx="11" fill="#0D1117"/>
  <rect x="${OFF}" y="${OFF}" width="${P}" height="${P}" rx="6" fill="#FFFFFF"/>
  <g clip-path="url(#fx15-panel)" shape-rendering="crispEdges">
${rects.join('\n')}
  </g>
</svg>
`;
}

/* ---------------------------------------------------------------- verifying */

/**
 * Re-reads a written PNG and checks it from scratch: signature, every chunk CRC,
 * the IHDR fields, and the inflated scanlines. Hand-rolled encoders fail quietly
 * (a viewer may accept a file that another tool rejects), so nothing is trusted
 * here that has not been parsed back out of the file on disk.
 * @param {string} path File to check.
 * @param {{w: number, h: number, colorType: number, cornerAlpha: number, opaque: boolean,
 *   safeZone?: number,
 *   probes: Array<{x: number, y: number, rgb: [number, number, number], what: string}>}} expect
 *   Intended geometry, the expected alpha of the top-left pixel (which is what
 *   distinguishes a full-bleed icon from a rounded plate), whether the whole
 *   image must be opaque, the maskable safe-circle diameter as a fraction of the
 *   icon (omit for non-maskable variants), and pixels that must carry a specific ink.
 * @returns {{path: string, w: number, h: number, bitDepth: number, colorType: number,
 *   chunks: string[], bytes: number, cornerAlpha: number, probes: number,
 *   clearance: number|null}} Parsed facts.
 */
function verifyPng(path, expect) {
  const buf = readFileSync(path);
  if (!buf.subarray(0, 8).equals(PNG_SIG)) throw new Error(`${path}: bad PNG signature`);

  const chunks = [];
  const idat = [];
  let ihdr = null;
  let p = 8;
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    const stored = buf.readUInt32BE(p + 8 + len);
    const actual = crc32(buf.subarray(p + 4, p + 8 + len));
    if (stored !== actual) {
      throw new Error(`${path}: ${type} CRC ${stored.toString(16)} != ${actual.toString(16)}`);
    }
    chunks.push(type);
    if (type === 'IHDR') ihdr = data;
    if (type === 'IDAT') idat.push(data);
    p += 12 + len;
  }
  if (p !== buf.length) throw new Error(`${path}: trailing bytes after last chunk`);
  if (!ihdr) throw new Error(`${path}: no IHDR`);
  if (chunks[0] !== 'IHDR' || chunks[chunks.length - 1] !== 'IEND') {
    throw new Error(`${path}: chunk order is ${chunks.join(',')}`);
  }

  const w = ihdr.readUInt32BE(0);
  const h = ihdr.readUInt32BE(4);
  const bitDepth = ihdr[8];
  const colorType = ihdr[9];
  if (w !== expect.w || h !== expect.h) {
    throw new Error(`${path}: IHDR says ${w}x${h}, intended ${expect.w}x${expect.h}`);
  }
  if (colorType !== expect.colorType) {
    throw new Error(`${path}: IHDR colour type ${colorType}, intended ${expect.colorType}`);
  }
  if (bitDepth !== 8) throw new Error(`${path}: IHDR bit depth ${bitDepth}, intended 8`);
  if (ihdr[10] !== 0 || ihdr[11] !== 0 || ihdr[12] !== 0) {
    throw new Error(`${path}: IHDR compression/filter/interlace must all be 0`);
  }

  // Inflate and walk the scanlines back out, so a truncated or mis-strided IDAT
  // cannot pass as valid.
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * 4;
  if (raw.length !== (stride + 1) * h) {
    throw new Error(`${path}: inflated ${raw.length} bytes, expected ${(stride + 1) * h}`);
  }
  for (let y = 0; y < h; y++) {
    if (raw[y * (stride + 1)] !== 0) throw new Error(`${path}: scanline ${y} filter is not 0`);
  }
  const at = (x, y) => {
    const i = y * (stride + 1) + 1 + x * 4;
    return [raw[i], raw[i + 1], raw[i + 2], raw[i + 3]];
  };
  const cornerAlpha = at(0, 0)[3];
  if (cornerAlpha !== expect.cornerAlpha) {
    throw new Error(`${path}: corner alpha ${cornerAlpha}, intended ${expect.cornerAlpha}`);
  }
  // A full-bleed icon must be opaque *everywhere*, not just at the corner: iOS
  // composites apple-touch-icon over black, so a single stray transparent pixel
  // would show up as a dark speck.
  if (expect.opaque) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (at(x, y)[3] !== 255) throw new Error(`${path}: pixel ${x},${y} is not opaque`);
      }
    }
  }
  // Maskable safe zone. Launchers may crop a maskable icon to any shape that fits
  // inside a centred circle of 80% diameter, so anything that is not background
  // has to stay inside it — a panel corner poking out gets sliced off on the
  // devices that mask hardest. This is asserted rather than eyeballed because it
  // is the constraint that silently breaks when the art or panelFrac is edited.
  let clearance = null;
  if (expect.safeZone) {
    const cx = w / 2, cy = h / 2, radius = (w * expect.safeZone) / 2;
    clearance = Infinity;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const [r, g, b] = at(x, y);
        // Anti-aliased edge pixels are blends of background and ink; counting
        // them as content keeps the test on the conservative side.
        if (r === BG[0] && g === BG[1] && b === BG[2]) continue;
        // Use the far corner of the pixel, not its centre, so a pixel straddling
        // the boundary counts as outside.
        const dx = Math.abs(x + 0.5 - cx) + 0.5;
        const dy = Math.abs(y + 0.5 - cy) + 0.5;
        const d = Math.hypot(dx, dy);
        if (d > radius) {
          throw new Error(`${path}: content at ${x},${y} is ${d.toFixed(1)}px from centre, outside the ${radius}px safe circle`);
        }
        clearance = Math.min(clearance, radius - d);
      }
    }
    if (clearance === Infinity) throw new Error(`${path}: no content found at all`);
  }

  // Probe the middle of known art cells. These sit well away from any edge, so
  // downsampling leaves them at the exact ink — an off-by-one stride or a
  // mis-scaled grid shows up here immediately.
  for (const probe of expect.probes) {
    const got = at(probe.x, probe.y);
    const want = [...probe.rgb, 255];
    if (got.join() !== want.join()) {
      throw new Error(`${path}: ${probe.what} at ${probe.x},${probe.y} is ${got.join()}, intended ${want.join()}`);
    }
  }

  return {
    path, w, h, bitDepth, colorType, chunks,
    bytes: buf.length, cornerAlpha, probes: expect.probes.length, clearance
  };
}

/* --------------------------------------------------------------------- main */

/**
 * Builds every icon, writes it, and verifies it by re-parsing the file.
 * @param {string} outDir Directory to write into.
 * @returns {void}
 */
function main(outDir) {
  mkdirSync(outDir, { recursive: true });

  /**
   * fullBleed variants have no transparency at all: Android's maskable slot and
   * iOS both composite the icon over their own shape, and iOS turns any alpha
   * into black.
   *
   * The maskable panel has to survive an aggressive mask: only a centred circle
   * of 80% diameter (radius 204.8px at 512) is guaranteed. 0.5625 snaps to a
   * 288px panel; a plain square that size would reach 203.6px into the corners
   * and clear the circle by barely a pixel, but the 16% corner radius pulls the
   * diagonal extremes back to 98*sqrt(2) + 46 = 185px, leaving real margin.
   *
   * Note the panel is snapped to a whole multiple of SUBS px, so panelFrac 0.75
   * lands on 144/192, 384/512 and 144/180 — the last is proportionally larger,
   * which suits the Apple icon since iOS crops the corners with its own squircle.
   */
  const variants = [
    { file: 'icon-192.png', size: 192, fullBleed: false, panelFrac: 0.75 },
    { file: 'icon-512.png', size: 512, fullBleed: false, panelFrac: 0.75 },
    { file: 'icon-maskable-512.png', size: 512, fullBleed: true, panelFrac: 0.5625, safeZone: 0.8 },
    { file: 'apple-touch-icon.png', size: 180, fullBleed: true, panelFrac: 0.75 }
  ];

  // One sub-cell of each ink, in sub-grid coordinates: sky, sun core, both
  // phases of the dithered rim, mountain, ground.
  const PROBE_CELLS = [
    { sx: 3, sy: 3, what: 'sky (white)' },
    { sx: 17, sy: 7, what: 'sun core (yellow)' },
    { sx: 12, sy: 6, what: 'sun rim, even phase (red)' },
    { sx: 13, sy: 6, what: 'sun rim, odd phase (yellow)' },
    { sx: 7, sy: 17, what: 'mountain (red)' },
    { sx: 11, sy: 23, what: 'ground (black)' }
  ];

  const report = [];
  for (const v of variants) {
    const path = join(outDir, v.file);
    const rgba = drawIcon(v.size, { fullBleed: v.fullBleed, panelFrac: v.panelFrac });
    writeFileSync(path, encodePng(rgba, v.size, v.size));

    const g = geometry(v.size, v.panelFrac);
    const probes = PROBE_CELLS.map(c => ({
      x: Math.floor(g.x0 + (c.sx + 0.5) * g.sub),
      y: Math.floor(g.y0 + (c.sy + 0.5) * g.sub),
      rgb: subInk(c.sx, c.sy),
      what: c.what
    }));

    report.push(verifyPng(path, {
      w: v.size,
      h: v.size,
      colorType: COLOR_TYPE_RGBA,
      cornerAlpha: v.fullBleed ? 255 : 0,
      opaque: v.fullBleed,
      safeZone: v.safeZone,
      probes
    }));
  }

  const svgPath = join(outDir, 'favicon.svg');
  writeFileSync(svgPath, buildSvg(), 'utf8');

  for (const r of report) {
    console.log(
      `${r.path.padEnd(48)} ${String(r.w).padStart(3)}x${String(r.h).padEnd(3)}` +
      ` depth ${r.bitDepth} colour ${r.colorType} (RGBA)` +
      ` corner a=${String(r.cornerAlpha).padStart(3)}` +
      ` ${r.probes} ink probes ok` +
      (r.clearance === null ? '' : ` safe-zone +${r.clearance.toFixed(1)}px`) +
      ` ${String(r.bytes).padStart(6)} B  [${r.chunks.join(' ')}]`
    );
  }
  console.log(`${svgPath.padEnd(48)}  48x48   vector`);
  console.log(`\n${report.length + 1} icons written and verified.`);
}

main(resolve(process.argv[2] || fileURLToPath(new URL('../assets/icons/', import.meta.url))));
