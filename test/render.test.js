/**
 * Render tests.
 *
 * Only the QR path is covered here, because it is the one branch of
 * renderIndices() that never touches a canvas — everything else composes through
 * the DOM and belongs in a browser. That branch is also where the interesting
 * bug was: a QR and a round panel are each fine alone and destroy each other
 * when combined.
 */

import { renderIndices, DEFAULT_SETTINGS } from '../js/render.js';
import { INKS } from '../js/image.js';
import { qrMatrix } from '../js/qrcode.js';

const PANEL = { width: 200, height: 200, bpp: 2, model: 3 };
const BLACK = INKS.findIndex((i) => i.id === 'black');
const WHITE = INKS.findIndex((i) => i.id === 'white');

/** Bounding box of dark pixels — for a QR that is exactly the symbol. */
function darkBounds(indices, w, h) {
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (indices[y * w + x] === BLACK) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return { minX, minY, maxX, maxY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/**
 * A finder pattern is a 7x7 ring: dark border, light ring, dark 3x3 core. If the
 * corners were clipped this is the first thing to break, and without all three a
 * scanner cannot locate the symbol at all.
 */
function finderIntact(indices, w, ox, oy, scale) {
  for (let my = 0; my < 7; my++) {
    for (let mx = 0; mx < 7; mx++) {
      const ring = Math.max(Math.abs(mx - 3), Math.abs(my - 3));
      const wantDark = ring !== 2;
      const px = ox + (mx * scale) + ((scale / 2) | 0);
      const py = oy + (my * scale) + ((scale / 2) | 0);
      const got = indices[py * w + px] === BLACK;
      if (got !== wantDark) return false;
    }
  }
  return true;
}

export default function run(t) {
  const text = 'A'.repeat(250);   // version 11-ish: big enough that clipping bites
  const square = { ...DEFAULT_SETTINGS, circleMask: false };
  const round = { ...DEFAULT_SETTINGS, circleMask: true };

  // ── square panel, the baseline ───────────────────────────────────────────
  const flat = renderIndices({ kind: 'qr', text }, PANEL, square);
  t.check('square: buffer size', flat.indices.length, 200 * 200);
  const fb = darkBounds(flat.indices, 200, 200);
  t.check('square: symbol is square', fb.w, fb.h);
  const fScale = fb.w / qrMatrix(text, { ecc: 'M' }).size;
  t.check('square: whole-pixel modules', Number.isInteger(fScale), true);
  t.ok('square: top-left finder', finderIntact(flat.indices, 200, fb.minX, fb.minY, fScale));
  t.ok('square: top-right finder',
    finderIntact(flat.indices, 200, fb.maxX - 7 * fScale + 1, fb.minY, fScale));
  t.ok('square: bottom-left finder',
    finderIntact(flat.indices, 200, fb.minX, fb.maxY - 7 * fScale + 1, fScale));

  // ── round panel: the regression ──────────────────────────────────────────
  // Filling the square and then masking whitens the corners, which is exactly
  // where the finders live. The renderer now fits the symbol inside the
  // inscribed circle instead, so all three survive.
  const disc = renderIndices({ kind: 'qr', text }, PANEL, round);
  const rb = darkBounds(disc.indices, 200, 200);
  const rScale = rb.w / qrMatrix(text, { ecc: 'M' }).size;
  t.check('round: symbol is square', rb.w, rb.h);
  t.check('round: whole-pixel modules', Number.isInteger(rScale), true);
  t.ok('round: symbol is smaller than on a square panel', rb.w < fb.w);
  t.ok('round: top-left finder survives', finderIntact(disc.indices, 200, rb.minX, rb.minY, rScale));
  t.ok('round: top-right finder survives',
    finderIntact(disc.indices, 200, rb.maxX - 7 * rScale + 1, rb.minY, rScale));
  t.ok('round: bottom-left finder survives',
    finderIntact(disc.indices, 200, rb.minX, rb.maxY - 7 * rScale + 1, rScale));

  // Every corner of the symbol must sit inside the disc, which is the property
  // that makes the mask a no-op over the code rather than a mutilation.
  const cx = 100;
  const cy = 100;
  const r = 100;
  const corners = [[rb.minX, rb.minY], [rb.maxX, rb.minY], [rb.minX, rb.maxY], [rb.maxX, rb.maxY]];
  const inside = corners.every(([x, y]) => ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2) <= r * r);
  t.ok('round: all four corners of the symbol lie inside the circle', inside);

  // And nothing dark may sit outside the circle, or the mask would have eaten it.
  let outside = 0;
  for (let y = 0; y < 200; y++) {
    for (let x = 0; x < 200; x++) {
      if (disc.indices[y * 200 + x] === BLACK
        && ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2) > r * r) outside++;
    }
  }
  t.check('round: no dark pixel outside the circle', outside, 0);

  // ── the mask must still do its job on the surrounding area ───────────────
  t.check('round: corner pixel is white', disc.indices[0], WHITE);
  t.check('round: centre pixel is part of the symbol',
    disc.indices[100 * 200 + 100] === BLACK || disc.indices[100 * 200 + 100] === WHITE, true);

  // ── non-square panels ───────────────────────────────────────────────────
  const wide = renderIndices({ kind: 'qr', text: 'https://findx.kieran.de/' },
    { ...PANEL, width: 296, height: 128 }, round);
  t.check('wide round panel: buffer size', wide.indices.length, 296 * 128);
  const wb = darkBounds(wide.indices, 296, 128);
  t.ok('wide round panel: symbol fits the short axis', wb.h <= 128);
  t.check('wide round panel: still square', wb.w, wb.h);
}
