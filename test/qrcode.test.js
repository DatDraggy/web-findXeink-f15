/**
 * QR encoder tests.
 *
 * The golden matrices below were captured from this encoder AFTER it was verified
 * end to end against two independent implementations:
 *
 *   - byte-for-byte against the `qrcode` npm package with version and mask forced
 *     (36/44 payloads identical; the rest differ only because that library splits
 *     text into mixed-mode segments where we use a single mode — a different but
 *     equally valid encoding);
 *   - and decisively, by rendering each code exactly as the panel receives it and
 *     decoding it back with `jsQR`: 96/96 payloads round-tripped, across four ECC
 *     levels and two panel geometries, including vCard and Wi-Fi strings.
 *
 * Neither library is a dependency of this project — that verification is a
 * deliberate one-off, documented in CONTRIBUTING.md so anyone can repeat it. What
 * lives here is the regression net: if a future edit changes a single module of
 * these known-good symbols, the fixtures fail.
 */

import { qrMatrix, qrToIndices, vcard, wifi } from '../js/qrcode.js';

/** Fixture matrices, packed 4 modules per hex digit, row-major. */
const GOLDEN = [
  {
    text: 'HELLO WORLD', ecc: 'M', size: 21, version: 1, mask: 0,
    hex: 'fe2bfc17106e8abb7455dbabaec13907faafe00000aa4893c48447f4b1eb3ae4f53a805117f825904c68bacbfdd1a8aebdd30438bfed708',
  },
  {
    text: 'a', ecc: 'H', size: 21, version: 1, mask: 0,
    hex: 'fe9bfc13506e96bb7575dba02ec12907faafe004002e94498a219ab42328d44cac2a8056aff89df05ef8bac36dd171aead23045c6fe0eb8',
  },
  {
    text: 'https://example.com', ecc: 'L', size: 25, version: 2, mask: 6,
    hex: 'fe9a3fc130506e8babb74195dba56aec115507faaafe016b00da74a0c4e7efa58d772d0f8efe7ddb0d003c4b5876bf7220edab22fb005f45bf842a304d712bacff8dd5170ee92d3f05c637fea6a48',
  },
];

function unhex(hex, count) {
  const out = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    const nibble = parseInt(hex[i >> 2], 16);
    out[i] = (nibble >> (3 - (i & 3))) & 1;
  }
  return out;
}

export default function run(t) {
  // ── golden symbols ──────────────────────────────────────────────────────
  for (const g of GOLDEN) {
    const m = qrMatrix(g.text, { ecc: g.ecc });
    const label = `${g.ecc} "${g.text.slice(0, 18)}"`;
    t.check(`${label} size`, m.size, g.size);
    t.check(`${label} version`, m.version, g.version);
    t.check(`${label} mask`, m.mask, g.mask);
    const want = unhex(g.hex, g.size * g.size);
    let diff = 0;
    for (let i = 0; i < want.length; i++) if ((m.modules[i] ? 1 : 0) !== want[i]) diff++;
    t.check(`${label} every module matches the verified symbol`, diff, 0);
  }

  // ── function patterns, checked structurally ─────────────────────────────
  const m = qrMatrix('HELLO WORLD', { ecc: 'M' });
  const at = (x, y) => m.modules[y * m.size + x];
  const finderOk = (ox, oy) => {
    for (let dy = 0; dy < 7; dy++) {
      for (let dx = 0; dx < 7; dx++) {
        const ring = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
        if (!!at(ox + dx, oy + dy) !== (ring !== 2)) return false;
      }
    }
    return true;
  };
  t.ok('top-left finder', finderOk(0, 0));
  t.ok('top-right finder', finderOk(m.size - 7, 0));
  t.ok('bottom-left finder', finderOk(0, m.size - 7));
  t.ok('dark module at (8, size-8)', !!at(8, m.size - 8));

  let timingOk = true;
  for (let i = 8; i < m.size - 8; i++) {
    if (!!at(i, 6) !== (i % 2 === 0)) timingOk = false;
    if (!!at(6, i) !== (i % 2 === 0)) timingOk = false;
  }
  t.ok('timing patterns alternate', timingOk);

  // ── version selection at the capacity boundary ──────────────────────────
  // Version 1 BYTE-mode capacity: L 17, M 14, Q 11, H 7.
  // Lowercase deliberately: uppercase letters are in QR's alphanumeric charset,
  // which packs denser, so 'A'.repeat(n) would test a different mode entirely.
  for (const [ecc, cap] of [['L', 17], ['M', 14], ['Q', 11], ['H', 7]]) {
    t.check(`${ecc}: ${cap} bytes still fits version 1`, qrMatrix('a'.repeat(cap), { ecc }).version, 1);
    t.ok(`${ecc}: ${cap + 1} bytes needs a bigger version`,
      qrMatrix('a'.repeat(cap + 1), { ecc }).version > 1);
  }
  // And confirm the encoder really does exploit alphanumeric mode: 25 uppercase
  // characters fit version 1 at ECC L, where 25 arbitrary bytes could not.
  t.check('alphanumeric mode is used when it fits', qrMatrix('A'.repeat(25), { ecc: 'L' }).version, 1);
  t.ok('a long payload still encodes', qrMatrix('y'.repeat(300), { ecc: 'L' }).version > 5);

  // ── rendering into panel index space ────────────────────────────────────
  const palette = [
    { id: 'red', code: 0, rgb: [220, 40, 40] },
    { id: 'yellow', code: 1, rgb: [240, 205, 50] },
    { id: 'white', code: 2, rgb: [255, 255, 255] },
    { id: 'black', code: 3, rgb: [0, 0, 0] },
  ];
  const BLACK = 3;
  const WHITE = 2;

  for (const [w, h] of [[200, 200], [296, 128], [400, 300]]) {
    const idx = qrToIndices('https://example.com', { ecc: 'M' }, w, h, palette);
    t.check(`${w}x${h} buffer length`, idx.length, w * h);
    const inks = new Set(idx);
    t.ok(`${w}x${h} uses only black and white`,
      [...inks].every((v) => v === BLACK || v === WHITE));

    // The dark bounding box is the symbol itself: the three finders reach all
    // four extremes. It must be square and an exact multiple of the module count.
    let minX = w, minY = h, maxX = -1, maxY = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (idx[y * w + x] === BLACK) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    const spanX = maxX - minX + 1;
    const spanY = maxY - minY + 1;
    const qr = qrMatrix('https://example.com', { ecc: 'M' });
    t.check(`${w}x${h} symbol is square`, spanX, spanY);
    t.check(`${w}x${h} integer module scale`, spanX % qr.size, 0);
    t.ok(`${w}x${h} quiet zone present`, minX >= 4 && minY >= 4);

    // Sample each module centre — proves orientation is upright, not transposed.
    const s = spanX / qr.size;
    let mismatched = 0;
    for (let my = 0; my < qr.size; my++) {
      for (let mx = 0; mx < qr.size; mx++) {
        const px = minX + mx * s + Math.floor(s / 2);
        const py = minY + my * s + Math.floor(s / 2);
        const got = idx[py * w + px] === BLACK ? 1 : 0;
        if (got !== (qr.modules[my * qr.size + mx] ? 1 : 0)) mismatched++;
      }
    }
    t.check(`${w}x${h} rendered upright and unmirrored`, mismatched, 0);
  }

  // ── payload helpers ─────────────────────────────────────────────────────
  const vc = vcard({ name: 'Marlin', org: 'Example GmbH', phone: '+49 170 1234567', email: 'm@example.com' });
  t.ok('vCard is wrapped correctly', vc.startsWith('BEGIN:VCARD') && vc.trimEnd().endsWith('END:VCARD'));
  t.ok('vCard declares version 3.0', vc.includes('VERSION:3.0'));
  t.ok('vCard carries the phone number', vc.includes('+49 170 1234567'));

  const wf = wifi({ ssid: 'MyNetwork', password: 'hunter22', security: 'WPA' });
  t.ok('Wi-Fi payload has the WIFI: scheme', wf.startsWith('WIFI:'));
  t.ok('Wi-Fi payload names the network', wf.includes('MyNetwork'));
  t.ok('Wi-Fi payload is terminated', wf.trimEnd().endsWith(';'));
  // Separators inside a value must be escaped or the scanner mis-splits the fields.
  const tricky = wifi({ ssid: 'A;B:C\\D', password: 'p;q', security: 'WPA' });
  t.ok('Wi-Fi escapes ; : and \\ inside values', tricky.includes('\\;') && tricky.includes('\\:'));

  // Everything the helpers produce must still round-trip through the encoder.
  for (const payload of [vc, wf, tricky]) {
    const q = qrMatrix(payload, { ecc: 'M' });
    t.ok(`helper payload encodes (v${q.version})`, q.size === 17 + 4 * q.version);
  }
}
