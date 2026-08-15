/**
 * Tests for js/image.js -- the palette / dither / pack pipeline.
 *
 * The byte values here are not invented: they come from a transfer that a real
 * FindXeink F15 accepted and displayed. Treat a failure as a regression in the
 * encoder, not as a test that needs relaxing.
 */

import {
  INKS, DITHERS, inksFor, bufferSize, adjust, quantize,
  applyCircleMask, pack, unpack, indicesToRGBA,
} from '../js/image.js';

const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0').toUpperCase()).join(' ');
const list = (a) => Array.from(a).join(',');

/** Flat RGBA field of one colour. */
function solid(w, h, r, g, b) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < d.length; i += 4) {
    d[i] = r;
    d[i + 1] = g;
    d[i + 2] = b;
    d[i + 3] = 255;
  }
  return d;
}

/** Deterministic two-axis gradient, so dithering has something to chew on. */
function gradient(w, h) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      d[i] = Math.round((x * 255) / (w - 1));
      d[i + 1] = Math.round((y * 255) / (h - 1));
      d[i + 2] = Math.round(((x + y) * 255) / (w + h - 2));
      d[i + 3] = 255;
    }
  }
  return d;
}

/** Reproducible pseudo-random indices, no RNG dependency. */
function noiseIndices(n, palLen) {
  const out = new Uint8Array(n);
  let s = 12345;
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    out[i] = (s >>> 7) % palLen;
  }
  return out;
}

function threw(fn) {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

export default function run(t) {
  /* ── palette constants ──────────────────────────────────────────────────── */

  // The codes are fixed by the firmware; the array order defines every index
  // value the rest of the module produces.
  t.check('ink codes in firmware order', INKS.map((i) => `${i.id}=${i.code}`).join(','),
    'red=0,yellow=1,white=2,black=3');
  t.ok('every ink has an rgb triple and a label',
    INKS.length === 4 && INKS.every((i) => i.rgb.length === 3 && typeof i.label === 'string' && i.label.length > 0));
  t.check('dither ids', DITHERS.map((d) => d.id).join(','), 'fs,atkinson,ordered,none');
  t.ok('every dither has a label', DITHERS.every((d) => typeof d.label === 'string' && d.label.length > 0));

  t.check('inksFor keeps firmware order, not argument order',
    inksFor(['black', 'red']).map((i) => i.id).join(','), 'red,black');
  t.check('inksFor dedupes', inksFor(['white', 'white']).map((i) => i.id).join(','), 'white');
  t.check('inksFor ignores unknown ids', inksFor(['puce']).length, 0);
  t.check('inksFor(undefined) is empty, not a throw', inksFor().length, 0);
  t.check('inksFor accepts a Set', inksFor(new Set(['yellow', 'white'])).map((i) => i.id).join(','),
    'yellow,white');

  /* ── buffer sizes ───────────────────────────────────────────────────────── */

  t.check('200x200 at 2 bpp is exactly 10000 B', bufferSize(200, 200, 2), 10000);
  t.check('one 200 px row at 2 bpp is 50 B (no row padding)', bufferSize(200, 1, 2), 50);
  t.check('200x200 at 1 bpp is 5000 B', bufferSize(200, 200, 1), 5000);
  t.check('400x300 at 2 bpp is 30000 B', bufferSize(400, 300, 2), 30000);

  // Pixel counts that do not fill the last byte: it is still allocated whole.
  t.check('5 px at 2 bpp needs 2 B', bufferSize(5, 1, 2), 2);
  t.check('9 px at 2 bpp needs 3 B', bufferSize(3, 3, 2), 3);
  t.check('1 px at 2 bpp needs 1 B', bufferSize(1, 1, 2), 1);
  t.check('91 px at 2 bpp needs 23 B', bufferSize(13, 7, 2), 23);
  t.check('5 px at 1 bpp needs 1 B', bufferSize(5, 1, 1), 1);
  t.check('9 px at 1 bpp needs 2 B', bufferSize(9, 1, 1), 2);
  t.check('91 px at 1 bpp needs 12 B', bufferSize(13, 7, 1), 12);

  t.ok('bufferSize rejects a bpp the firmware has no format for', threw(() => bufferSize(8, 8, 4)));
  t.ok('bufferSize rejects zero dimensions', threw(() => bufferSize(0, 8, 2)));

  /* ── the four solid colours at 200x200, verified on hardware ────────────── */

  const N = 200 * 200;
  const solidCases = [
    ['white', 2, 0xaa],
    ['black', 3, 0xff],
    ['red', 0, 0x00],
    ['yellow', 1, 0x55],
  ];
  for (const [name, idx, want] of solidCases) {
    const px = new Uint8Array(N).fill(idx);
    const bytes = pack(px, 200, 200, INKS, { bpp: 2, model: 3 });
    t.check(`all-${name} packs to 10000 B`, bytes.length, 10000);
    t.check(`all-${name} byte value`, hex(bytes.subarray(0, 4)),
      hex(new Uint8Array(4).fill(want)));
    t.ok(`all-${name} is that byte for the whole buffer`, bytes.every((b) => b === want));
  }

  // A single black pixel top-left: 11 10 10 10 -- proves MSB-first ordering and
  // that pixel 0 is the top-left of the first row.
  const oneBlack = new Uint8Array(N).fill(2);
  oneBlack[0] = 3;
  const oneBlackBytes = pack(oneBlack, 200, 200, INKS, { bpp: 2, model: 3 });
  t.check('one black top-left pixel makes byte 0 = 0xEA', hex(oneBlackBytes.subarray(0, 2)), 'EA AA');

  // Same thing through the real pipeline rather than hand-built indices.
  const whiteQ = quantize(solid(200, 200, 255, 255, 255), 200, 200, INKS, { dither: 'none' });
  t.check('white photo -> white ink everywhere', hex(pack(whiteQ, 200, 200, INKS).subarray(0, 2)), 'AA AA');
  const blackQ = quantize(solid(200, 200, 0, 0, 0), 200, 200, INKS, { dither: 'none' });
  t.check('black photo -> black ink everywhere', hex(pack(blackQ, 200, 200, INKS).subarray(0, 2)), 'FF FF');

  /* ── scan order: model 3 (F15) vs model 4 (F20) ─────────────────────────── */

  // 8x2, deliberately asymmetric: row 1 is row 0 reversed, so a row/column mix-up
  // cannot pass by accident.
  const W = 8, H = 2;
  const asym = new Uint8Array([0, 1, 2, 3, 0, 1, 2, 3, 3, 2, 1, 0, 3, 2, 1, 0]);

  t.check('2 bpp row-major (model 3)', hex(pack(asym, W, H, INKS, { bpp: 2, model: 3 })), '1B 1B E4 E4');
  t.check('2 bpp buffer size matches bufferSize', pack(asym, W, H, INKS, { bpp: 2, model: 3 }).length,
    bufferSize(W, H, 2));
  // Model 4 starts at x=7 and walks down each column: 3,0 then 2,1 -> 0xC9.
  t.check('2 bpp column-major from the right edge (model 4)',
    hex(pack(asym, W, H, INKS, { bpp: 2, model: 4 })), 'C9 63 C9 63');
  t.ok('model 3 and model 4 really differ', hex(pack(asym, W, H, INKS, { bpp: 2, model: 3 }))
    !== hex(pack(asym, W, H, INKS, { bpp: 2, model: 4 })));
  t.check('models 1 and 2 are row-major like model 3',
    hex(pack(asym, W, H, INKS, { bpp: 2, model: 1 })) + ' / ' + hex(pack(asym, W, H, INKS, { bpp: 2, model: 2 })),
    '1B 1B E4 E4 / 1B 1B E4 E4');

  // 1 bpp: set bit = black. Row 0 has black at x=3 and x=7, row 1 at x=0 and x=4.
  t.check('1 bpp, a set bit means black', hex(pack(asym, W, H, INKS, { bpp: 1, model: 3 })), '11 88');
  t.check('1 bpp column-major (model 4)', hex(pack(asym, W, H, INKS, { bpp: 1, model: 4 })), '81 81');
  t.check('1 bpp buffer size', pack(asym, W, H, INKS, { bpp: 1 }).length, bufferSize(W, H, 1));
  t.check('bpp defaults to 2', hex(pack(asym, W, H, INKS)), '1B 1B E4 E4');

  /* ── ragged trailing byte ───────────────────────────────────────────────── */

  // 3 black pixels at 2 bpp: 11 11 11 + two unused bits left at 0.
  t.check('partial 2 bpp byte leaves the unused low bits at 0',
    hex(pack(new Uint8Array([3, 3, 3]), 3, 1, INKS, { bpp: 2 })), 'FC');
  t.check('partial 1 bpp byte leaves the unused low bits at 0',
    hex(pack(new Uint8Array([3, 3, 3]), 3, 1, INKS, { bpp: 1 })), 'E0');
  t.check('5 px at 2 bpp spills one pixel into a second byte',
    hex(pack(new Uint8Array([3, 3, 3, 3, 3]), 5, 1, INKS, { bpp: 2 })), 'FF C0');
  t.check('9 px at 1 bpp spills one pixel into a second byte',
    hex(pack(new Uint8Array(9).fill(3), 9, 1, INKS, { bpp: 1 })), 'FF 80');

  t.ok('pack rejects an index outside the palette',
    threw(() => pack(new Uint8Array([9, 0, 0, 0]), 2, 2, INKS)));

  /* ── pack / unpack round trips ──────────────────────────────────────────── */

  const RW = 13, RH = 7;          // 91 px: not a multiple of 4 or of 8
  const rnd4 = noiseIndices(RW * RH, 4);
  for (const model of [3, 4]) {
    const bytes = pack(rnd4, RW, RH, INKS, { bpp: 2, model });
    t.check(`2 bpp round trip, model ${model}`,
      list(unpack(bytes, RW, RH, { bpp: 2, model, palette: INKS })), list(rnd4));
  }

  const bw = inksFor(['white', 'black']);
  t.check('two-ink palette is white then black', bw.map((i) => i.id).join(','), 'white,black');
  const rnd2 = noiseIndices(RW * RH, 2);
  for (const model of [3, 4]) {
    const bytes = pack(rnd2, RW, RH, bw, { bpp: 1, model });
    t.check(`1 bpp round trip on a 2-ink palette, model ${model}`,
      list(unpack(bytes, RW, RH, { bpp: 1, model, palette: bw })), list(rnd2));
  }
  // And a 2 bpp round trip on the same 2-ink palette: codes 2 and 3 must map back
  // to indices 0 and 1, not to themselves.
  const twoBpp2Ink = pack(rnd2, RW, RH, bw, { bpp: 2, model: 3 });
  t.check('2 bpp round trip on a 2-ink palette',
    list(unpack(twoBpp2Ink, RW, RH, { bpp: 2, model: 3, palette: bw })), list(rnd2));

  // Without a palette, unpack yields raw firmware codes.
  t.check('unpack without a palette yields firmware codes',
    list(unpack(pack(asym, W, H, INKS, { bpp: 2 }), W, H, { bpp: 2 }).subarray(0, 8)), '0,1,2,3,0,1,2,3');
  t.check('unpack 1 bpp without a palette yields 1 = black',
    list(unpack(pack(asym, W, H, INKS, { bpp: 1 }), W, H, { bpp: 1 }).subarray(0, 8)), '0,0,0,1,0,0,0,1');

  t.ok('unpack rejects a code the palette does not contain',
    threw(() => unpack(pack(asym, W, H, INKS, { bpp: 2 }), W, H, { bpp: 2, palette: bw })));
  t.ok('unpack rejects a short buffer',
    threw(() => unpack(new Uint8Array(3), 8, 2, { bpp: 2 })));

  /* ── colour matching ────────────────────────────────────────────────────── */

  const one = (r, g, b, pal = INKS, opts = { dither: 'none' }) =>
    quantize(solid(1, 1, r, g, b), 1, 1, pal, opts)[0];

  t.check('white matches white', one(255, 255, 255), 2);
  t.check('black matches black', one(0, 0, 0), 3);
  t.check('saturated red matches red', one(255, 0, 0), 0);
  t.check('panel yellow matches yellow', one(240, 205, 50), 1);
  // The metric is luminance-weighted on purpose: plain Euclidean RGB puts mid grey
  // (and with it most of a photo) in RED, which looks awful on the panel.
  t.check('mid grey matches yellow, not red -- luminance weighting is live', one(128, 128, 128), 1);

  /* ── dithering ──────────────────────────────────────────────────────────── */

  const GW = 32, GH = 16;
  const grad = gradient(GW, GH);
  const modes = ['fs', 'atkinson', 'ordered', 'none'];
  const palettes = [['4-ink', INKS], ['2-ink', bw]];

  for (const [palName, pal] of palettes) {
    const nearestOut = list(quantize(grad, GW, GH, pal, { dither: 'none' }));
    for (const mode of modes) {
      for (const serpentine of [false, true]) {
        const tag = `${mode}${serpentine ? '+serp' : ''} / ${palName}`;
        const out = quantize(grad, GW, GH, pal, { dither: mode, strength: 1, serpentine });
        t.check(`${tag}: one index per pixel`, out.length, GW * GH);
        t.ok(`${tag}: only valid palette indices`, out.every((v) => v >= 0 && v < pal.length));
        // strength 0 means no error is diffused at all, so every mode collapses
        // to plain nearest-colour.
        t.check(`${tag}: strength 0 equals nearest`,
          list(quantize(grad, GW, GH, pal, { dither: mode, strength: 0, serpentine })), nearestOut);
      }
    }
  }

  t.check('quantize is deterministic',
    list(quantize(grad, GW, GH, INKS, { dither: 'fs', strength: 1 })),
    list(quantize(grad, GW, GH, INKS, { dither: 'fs', strength: 1 })));
  t.check('an unknown dither id falls back to nearest instead of throwing',
    list(quantize(grad, GW, GH, INKS, { dither: 'nonsense' })),
    list(quantize(grad, GW, GH, INKS, { dither: 'none' })));
  t.check('serpentine has no effect without error diffusion',
    list(quantize(grad, GW, GH, INKS, { dither: 'ordered', serpentine: true })),
    list(quantize(grad, GW, GH, INKS, { dither: 'ordered', serpentine: false })));

  // A flat mid-grey is the honest test that diffusion happens: nearest gives one
  // solid colour, every dither mode has to break it up.
  const grey = solid(24, 24, 128, 128, 128);
  const uniq = (a) => new Set(a).size;
  t.check('nearest leaves flat grey solid', uniq(quantize(grey, 24, 24, bw, { dither: 'none' })), 1);
  for (const mode of ['fs', 'atkinson', 'ordered']) {
    t.ok(`${mode} breaks flat grey into both inks`,
      uniq(quantize(grey, 24, 24, bw, { dither: mode, strength: 1 })) === 2);
  }
  t.ok('serpentine fs differs from raster fs on a gradient',
    list(quantize(grad, GW, GH, INKS, { dither: 'fs', serpentine: true }))
    !== list(quantize(grad, GW, GH, INKS, { dither: 'fs', serpentine: false })));

  t.ok('quantize rejects an empty palette', threw(() => quantize(grad, GW, GH, [], {})));
  t.ok('quantize rejects an undersized source', threw(() => quantize(new Uint8ClampedArray(8), 4, 4, INKS)));

  /* ── adjust ─────────────────────────────────────────────────────────────── */

  const px = (r, g, b, a = 255) => new Uint8Array([r, g, b, a]);

  t.check('no options is a no-op', list(adjust(px(10, 128, 250), {})), '10,128,250,255');
  t.check('omitted opts object is a no-op', list(adjust(px(10, 128, 250))), '10,128,250,255');
  t.check('neutral settings are a no-op',
    list(adjust(px(10, 128, 250), { brightness: 0, contrast: 0, saturation: 100, gamma: 100 })),
    '10,128,250,255');

  // Clamping: unclamped arithmetic would wrap these to 199 and 51 in a Uint8Array.
  t.check('brightness +100 clamps at 255', list(adjust(px(200, 200, 200), { brightness: 100 })),
    '255,255,255,255');
  t.check('brightness -100 clamps at 0', list(adjust(px(50, 50, 50), { brightness: -100 })), '0,0,0,255');
  t.check('alpha is left alone', adjust(px(10, 20, 30, 123), { brightness: 50 })[3], 123);

  // Plain Array: no typed-array clamping to hide behind, so this proves the maths
  // itself stays inside 0..255.
  const wild = [];
  for (let i = 0; i < 256; i++) wild.push(i, 255 - i, (i * 7) & 255, 255);
  adjust(wild, { brightness: 100, contrast: 100, saturation: 300, gamma: 10 });
  t.ok('adjust clamps every channel into 0..255',
    wild.every((v, i) => (i % 4 === 3 ? v === 255 : Number.isInteger(v) && v >= 0 && v <= 255)));

  const wild2 = [];
  for (let i = 0; i < 256; i++) wild2.push(i, 255 - i, (i * 3) & 255, 255);
  adjust(wild2, { brightness: -100, contrast: -100, saturation: 0, gamma: 300 });
  t.ok('adjust clamps at the other extreme too',
    wild2.every((v, i) => (i % 4 === 3 ? v === 255 : Number.isInteger(v) && v >= 0 && v <= 255)));

  t.check('out-of-range options are clamped, not obeyed',
    list(adjust(px(200, 200, 200), { brightness: 5000 })), '255,255,255,255');

  // Gamma is a 256-entry LUT: 100 % neutral, >100 brightens, <100 darkens.
  t.check('gamma 100 changes nothing', list(adjust(px(64, 128, 192), { gamma: 100 })), '64,128,192,255');
  t.check('gamma 200 lifts 64 to 128', adjust(px(64, 64, 64), { gamma: 200 })[0], 128);
  t.check('gamma 50 drops 128 to 64', adjust(px(128, 128, 128), { gamma: 50 })[0], 64);
  t.check('gamma keeps the endpoints', list(adjust(px(0, 255, 0), { gamma: 250 })), '0,255,0,255');

  // Saturation 0 collapses to the Rec.709 grey axis.
  t.check('saturation 0 greys out pure red', list(adjust(px(255, 0, 0), { saturation: 0 })), '54,54,54,255');
  t.ok('saturation 200 pushes red further from grey',
    adjust(px(200, 100, 100), { saturation: 200 })[0] > 200);

  t.ok('adjust returns the same array it was given', (() => {
    const a = px(1, 2, 3);
    return adjust(a, { brightness: 10 }) === a;
  })());

  /* ── circle mask ────────────────────────────────────────────────────────── */

  const mask = new Uint8Array(10 * 10).fill(3);
  applyCircleMask(mask, 10, 10, INKS);
  t.check('corner outside the circle becomes white', mask[0], 2);
  t.check('centre is untouched', mask[5 * 10 + 5], 3);
  t.check('top edge midpoint is inside the circle', mask[0 * 10 + 5], 3);
  t.ok('the mask whitens exactly the corners-ish ring, not the whole image',
    mask.some((v) => v === 3) && mask.some((v) => v === 2));

  // No white ink: the lightest available one stands in rather than doing nothing.
  const rk = inksFor(['red', 'black']);
  const mask2 = new Uint8Array(10 * 10).fill(1);
  applyCircleMask(mask2, 10, 10, rk);
  t.check('without white ink the lightest ink is used', mask2[0], 0);

  t.ok('applyCircleMask returns its input', (() => {
    const m = new Uint8Array(4);
    return applyCircleMask(m, 2, 2, INKS) === m;
  })());

  /* ── preview expansion ──────────────────────────────────────────────────── */

  const rgba = indicesToRGBA(new Uint8Array([3, 2]), 2, 1, INKS);
  t.check('indicesToRGBA length', rgba.length, 8);
  t.check('indicesToRGBA uses the ink colours', list(rgba), '0,0,0,255,255,255,255,255');
  t.ok('indicesToRGBA returns a Uint8ClampedArray', rgba instanceof Uint8ClampedArray);
  t.ok('indicesToRGBA rejects an index outside the palette',
    threw(() => indicesToRGBA(new Uint8Array([7]), 1, 1, INKS)));

  /* ── full pipeline on the user's actual panel ───────────────────────────── */

  const photo = gradient(200, 200);
  adjust(photo, { brightness: 5, contrast: 10, saturation: 120, gamma: 110 });
  const idx = quantize(photo, 200, 200, INKS, { dither: 'fs', strength: 1, serpentine: true });
  applyCircleMask(idx, 200, 200, INKS);
  const out = pack(idx, 200, 200, INKS, { bpp: 2, model: 3 });
  t.check('F15 pipeline produces exactly 10000 bytes', out.length, 10000);
  t.check('F15 pipeline survives a round trip',
    list(unpack(out, 200, 200, { bpp: 2, model: 3, palette: INKS })), list(idx));
}
