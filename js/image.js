/**
 * Image pipeline: palettes, adjustments, dithering, quantisation and bit packing.
 *
 * Pure functions over plain typed arrays. No canvas, no DOM, no imports -- this
 * module runs identically in the browser and in Node, which is what makes the
 * byte-exact tests meaningful.
 *
 * Encoding facts, all confirmed against real hardware:
 *
 *   2 bpp (advertised type >= 1). The palette codes are fixed by the firmware:
 *       0 = RED, 1 = YELLOW, 2 = WHITE, 3 = BLACK
 *     Four pixels per byte, MSB first:  byte = p0<<6 | p1<<4 | p2<<2 | p3
 *     Length = (width*height + 3) >> 2.
 *
 *   1 bpp (type < 1). Eight pixels per byte, MSB first, a SET BIT MEANS BLACK.
 *     Length = (width*height + 7) >> 3.
 *
 *   Both are a FLAT pixel stream: there is no per-row byte padding, so a 200 px
 *   row at 2 bpp is exactly 50 bytes and rows may start mid-byte.
 *
 *   Scan order is row-major, top to bottom, left to right -- except model 4 (the
 *   F20), which is column-major from the right edge.
 *
 * Reference byte values at 200x200 type 1: 10000 bytes; all-white 0xaa, all-black
 * 0xff, all-red 0x00, all-yellow 0x55; a single black top-left pixel makes byte 0
 * equal 0xea.
 */

/**
 * The four inks, in FIRMWARE CODE ORDER. `code` is what goes on the wire; `rgb`
 * is the approximate on-panel appearance, used both for colour matching and for
 * the preview so what you see is what the panel prints.
 *
 * @type {ReadonlyArray<{id: string, code: number, rgb: number[], label: string}>}
 */
export const INKS = Object.freeze([
  { id: 'red', code: 0, rgb: Object.freeze([220, 40, 40]), label: 'Red' },
  { id: 'yellow', code: 1, rgb: Object.freeze([240, 205, 50]), label: 'Yellow' },
  { id: 'white', code: 2, rgb: Object.freeze([255, 255, 255]), label: 'White' },
  { id: 'black', code: 3, rgb: Object.freeze([0, 0, 0]), label: 'Black' },
].map(Object.freeze));

/** Dither modes, in menu order. @type {ReadonlyArray<{id: string, label: string}>} */
export const DITHERS = Object.freeze([
  { id: 'fs', label: 'Floyd-Steinberg' },
  { id: 'atkinson', label: 'Atkinson' },
  { id: 'ordered', label: 'Ordered 8x8' },
  { id: 'none', label: 'None (nearest)' },
].map(Object.freeze));

/* Standard 8x8 Bayer threshold matrix, flattened. */
const BAYER8 = Uint8Array.from([
  0, 32, 8, 40, 2, 34, 10, 42,
  48, 16, 56, 24, 50, 18, 58, 26,
  12, 44, 4, 36, 14, 46, 6, 38,
  60, 28, 52, 20, 62, 30, 54, 22,
  3, 35, 11, 43, 1, 33, 9, 41,
  51, 19, 59, 27, 49, 17, 57, 25,
  15, 47, 7, 39, 13, 45, 5, 37,
  63, 31, 55, 23, 61, 29, 53, 21,
]);

/* Firmware palette codes, for identifying inks in a caller-supplied palette that
   may have been built without our `id` strings. */
const CODE_WHITE = 2;
const CODE_BLACK = 3;

function clamp(n, lo, hi) {
  return n < lo ? lo : n > hi ? hi : n;
}

/** Clamp to a byte and round, so plain Arrays behave exactly like typed arrays. */
function byte(n) {
  return n <= 0 ? 0 : n >= 255 ? 255 : Math.round(n);
}

function isWhiteInk(ink) {
  return ink.id === 'white' || ink.code === CODE_WHITE;
}

function isBlackInk(ink) {
  return ink.id === 'black' || ink.code === CODE_BLACK;
}

function checkPalette(palette) {
  if (!Array.isArray(palette) || palette.length === 0) {
    throw new TypeError('image: palette must be a non-empty array of inks');
  }
  return palette;
}

function checkDims(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new RangeError(`image: bad dimensions ${width}x${height}`);
  }
}

/**
 * Pick a subset of INKS by id, always in firmware order regardless of the order
 * the ids arrive in -- the order of the palette array decides the index values in
 * every other function here, so it must be stable.
 *
 * Returns [] when nothing matches; the caller decides what to fall back to (the
 * UI falls back to black + white).
 *
 * @param {Iterable<string>} ids
 * @returns {Array<{id: string, code: number, rgb: number[], label: string}>}
 */
export function inksFor(ids) {
  const want = new Set(ids || []);
  return INKS.filter((ink) => want.has(ink.id));
}

/**
 * Packed buffer size in bytes. The stream is flat, so this is just a bit count
 * rounded up -- no row padding. Multiplying before dividing (rather than the
 * usual >> 2) keeps it correct for panels large enough to overflow 32-bit shifts.
 *
 * @param {number} width
 * @param {number} height
 * @param {1|2} bpp
 * @returns {number}
 */
export function bufferSize(width, height, bpp) {
  checkDims(width, height);
  if (bpp !== 1 && bpp !== 2) throw new RangeError(`image: bpp must be 1 or 2, got ${bpp}`);
  return Math.ceil((width * height * bpp) / 8);
}

/* Gamma is a pure function of one slider, so one cached table is enough: the UI
   re-runs the whole pipeline on every drag of every other slider too. */
let gammaCache = { pct: 0, lut: null };

function gammaLut(pct) {
  if (gammaCache.pct === pct) return gammaCache.lut;
  const lut = new Uint8Array(256);
  // pct is a percentage: 100 is neutral, >100 brightens. The exponent is the
  // reciprocal, matching the convention of every photo tool's gamma slider.
  const exp = 100 / pct;
  for (let i = 0; i < 256; i++) lut[i] = byte(255 * Math.pow(i / 255, exp));
  gammaCache = { pct, lut };
  return lut;
}

/**
 * Brightness / contrast / saturation / gamma, applied in place to an RGBA byte
 * array. Alpha is left alone.
 *
 * Order is gamma, then saturation, then contrast, then brightness. Gamma has to
 * run first because the 256-entry lookup table is only exact while the channels
 * are still integers straight out of the decoder; once contrast has turned them
 * into floats a table lookup would silently quantise them again.
 *
 * @param {Uint8ClampedArray|Uint8Array|number[]} rgba mutated in place
 * @param {{brightness?: number, contrast?: number, saturation?: number, gamma?: number}} [opts]
 *   brightness/contrast -100..100 (0 neutral), saturation 0..300 (100 neutral),
 *   gamma 10..300 percent (100 neutral). Out-of-range values are clamped.
 * @returns {typeof rgba} the same array, for chaining
 */
export function adjust(rgba, opts = {}) {
  const bri = clamp(+opts.brightness || 0, -100, 100) * 2.55;
  const con = clamp(+opts.contrast || 0, -100, 100) / 100;
  const sat = clamp(opts.saturation == null ? 100 : +opts.saturation, 0, 300) / 100;
  const gam = clamp(opts.gamma == null ? 100 : +opts.gamma, 10, 300);

  // Classic contrast curve. The 1.015 fudge keeps the slope finite at con = 1
  // instead of dividing by zero.
  const cf = (1.015 * (con + 1)) / (1.015 - con);
  const lut = gam === 100 ? null : gammaLut(gam);
  const neutral = bri === 0 && con === 0 && sat === 1 && lut === null;
  if (neutral) return rgba;

  for (let i = 0; i + 3 < rgba.length; i += 4) {
    let r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];

    if (lut) {
      r = lut[byte(r)];
      g = lut[byte(g)];
      b = lut[byte(b)];
    }
    if (sat !== 1) {
      // Rec.709 luma for the grey axis, as in the tool these settings were dialled
      // in on. (Colour *matching* further down uses a different weighting -- see
      // makeMatcher; the two are unrelated jobs.)
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      r = l + (r - l) * sat;
      g = l + (g - l) * sat;
      b = l + (b - l) * sat;
    }
    if (cf !== 1) {
      r = cf * (r - 128) + 128;
      g = cf * (g - 128) + 128;
      b = cf * (b - 128) + 128;
    }
    if (bri !== 0) {
      r += bri;
      g += bri;
      b += bri;
    }

    // Clamp explicitly: a Uint8Array would wrap and a plain Array would keep the
    // float, and quantize() must never see either.
    rgba[i] = byte(r);
    rgba[i + 1] = byte(g);
    rgba[i + 2] = byte(b);
  }
  return rgba;
}

/**
 * Build a nearest-ink matcher over a palette.
 *
 * The metric is luminance-weighted: each channel delta is scaled by 0.30 / 0.59 /
 * 0.11 before squaring. This is not cosmetic. Plain Euclidean RGB throws far too
 * much of a photo into red on these four-colour panels -- mid grey, for one,
 * matches red under Euclidean and yellow under this metric -- and yellow is much
 * closer to right. Found by eye on real hardware; do not "simplify" it away.
 */
function makeMatcher(palette) {
  const n = palette.length;
  const pr = new Float64Array(n);
  const pg = new Float64Array(n);
  const pb = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const c = palette[i].rgb;
    pr[i] = c[0];
    pg[i] = c[1];
    pb[i] = c[2];
  }
  return function nearest(r, g, b) {
    let best = 0;
    let bd = Infinity;
    for (let i = 0; i < n; i++) {
      const dr = (r - pr[i]) * 0.30;
      const dg = (g - pg[i]) * 0.59;
      const db = (b - pb[i]) * 0.11;
      const d = dr * dr + dg * dg + db * db;
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    return best;
  };
}

/* Error-diffusion kernels as [dx, dy, weight]. dx is mirrored on right-to-left
   serpentine rows. */
const KERNEL_FS = [
  [1, 0, 7 / 16], [-1, 1, 3 / 16], [0, 1, 5 / 16], [1, 1, 1 / 16],
];
/* Atkinson spreads only 6/8 of the error over six neighbours and deliberately
   drops the remaining quarter. That loss is the point: it keeps highlights and
   shadows clean instead of smearing them, which suits a four-ink panel. */
const KERNEL_ATKINSON = [
  [1, 0, 1 / 8], [2, 0, 1 / 8], [-1, 1, 1 / 8], [0, 1, 1 / 8], [1, 1, 1 / 8], [0, 2, 1 / 8],
];

/**
 * Quantise an RGBA image down to palette indices.
 *
 * @param {Uint8ClampedArray|Uint8Array|number[]} rgba source, width*height*4 bytes
 * @param {number} width
 * @param {number} height
 * @param {Array<{rgb: number[]}>} palette the active inks, in the order their
 *   indices should refer to (use INKS or inksFor())
 * @param {{dither?: 'fs'|'atkinson'|'ordered'|'none', strength?: number, serpentine?: boolean}} [opts]
 *   strength 0..1 scales the diffused (or ordered) error; 0 is identical to
 *   nearest for every mode. serpentine only affects the diffusion modes.
 * @returns {Uint8Array} width*height indices into `palette`
 */
export function quantize(rgba, width, height, palette, opts = {}) {
  checkDims(width, height);
  checkPalette(palette);
  const n = width * height;
  if (rgba.length < n * 4) {
    throw new RangeError(`image: rgba is ${rgba.length} bytes, need ${n * 4} for ${width}x${height}`);
  }

  const mode = opts.dither || 'none';
  const strength = clamp(opts.strength == null ? 1 : +opts.strength, 0, 1);
  const nearest = makeMatcher(palette);
  const out = new Uint8Array(n);

  if (mode !== 'fs' && mode !== 'atkinson') {
    // 'none', 'ordered', and anything unrecognised (a UI should never send one,
    // but falling back to nearest beats throwing mid-render).
    const ordered = mode === 'ordered' || mode === 'bayer';
    // Spread the threshold over one full step between palette levels. A half step
    // is the textbook value; the full step is deliberate here because the four
    // inks are nowhere near evenly spaced in luminance and half a step barely
    // registers on the panel.
    const span = (255 / Math.max(1, palette.length - 1)) * strength * 2;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        let r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
        if (ordered && span !== 0) {
          const t = (BAYER8[(y & 7) * 8 + (x & 7)] / 64 - 0.5) * span;
          r += t;
          g += t;
          b += t;
        }
        out[y * width + x] = nearest(r, g, b);
      }
    }
    return out;
  }

  const kernel = mode === 'fs' ? KERNEL_FS : KERNEL_ATKINSON;
  const serpentine = !!opts.serpentine;

  // Float working copy: the accumulated error routinely runs outside 0..255 and
  // must not be clipped until the pixel is actually matched.
  const buf = new Float32Array(n * 3);
  for (let p = 0, i = 0, j = 0; p < n; p++, i += 4, j += 3) {
    buf[j] = rgba[i];
    buf[j + 1] = rgba[i + 1];
    buf[j + 2] = rgba[i + 2];
  }

  for (let y = 0; y < height; y++) {
    const ltr = !serpentine || (y & 1) === 0;
    const dir = ltr ? 1 : -1;
    let x = ltr ? 0 : width - 1;
    for (let k = 0; k < width; k++, x += dir) {
      const j = (y * width + x) * 3;
      const r = buf[j], g = buf[j + 1], b = buf[j + 2];
      const idx = nearest(r, g, b);
      out[y * width + x] = idx;

      const ink = palette[idx].rgb;
      const er = (r - ink[0]) * strength;
      const eg = (g - ink[1]) * strength;
      const eb = (b - ink[2]) * strength;
      if (er === 0 && eg === 0 && eb === 0) continue;

      for (let q = 0; q < kernel.length; q++) {
        const kx = x + kernel[q][0] * dir;
        const ky = y + kernel[q][1];
        if (kx < 0 || kx >= width || ky >= height) continue;
        const f = kernel[q][2];
        const t = (ky * width + kx) * 3;
        buf[t] += er * f;
        buf[t + 1] += eg * f;
        buf[t + 2] += eb * f;
      }
    }
  }
  return out;
}

/**
 * Force everything outside the inscribed circle to white, in place, for round
 * panels and round crops.
 *
 * If the palette has no white ink the lightest one stands in, so the mask is
 * still visible rather than silently doing nothing.
 *
 * @param {Uint8Array} indices mutated in place
 * @param {number} width
 * @param {number} height
 * @param {Array<{id?: string, code?: number, rgb: number[]}>} palette
 * @returns {Uint8Array} the same array
 */
export function applyCircleMask(indices, width, height, palette) {
  checkDims(width, height);
  checkPalette(palette);
  let white = palette.findIndex(isWhiteInk);
  if (white < 0) white = makeMatcher(palette)(255, 255, 255);

  const cx = width / 2;
  const cy = height / 2;
  const r = Math.min(width, height) / 2;
  const r2 = r * r;
  for (let y = 0; y < height; y++) {
    const dy = y - cy;
    const dy2 = dy * dy;
    for (let x = 0; x < width; x++) {
      const dx = x - cx;
      if (dx * dx + dy2 > r2) indices[y * width + x] = white;
    }
  }
  return indices;
}

/**
 * Walk every pixel in the order the firmware expects, calling fn(pixelIndex,
 * streamPosition).
 *
 * Model 4 (the F20) is scanned column-major from the right edge, which amounts to
 * a 90-degree rotation baked into the transfer. Every other model -- F15 (3),
 * Wallet (2), Air Wallet Pro (1) -- is plain row-major.
 */
function eachInDeviceOrder(width, height, model, fn) {
  if (model === 4) {
    let n = 0;
    for (let x = width - 1; x >= 0; x--) {
      for (let y = 0; y < height; y++) fn(y * width + x, n++);
    }
  } else {
    const total = width * height;
    for (let p = 0; p < total; p++) fn(p, p);
  }
}

/**
 * Pack palette indices into the wire format.
 *
 * A trailing partial byte (width*height not a multiple of 4, or of 8 at 1 bpp) is
 * emitted as-is with its unused low bits left at 0.
 *
 * @param {Uint8Array|number[]} indices width*height indices into `palette`
 * @param {number} width
 * @param {number} height
 * @param {Array<{id?: string, code: number}>} palette
 * @param {{bpp?: 1|2, model?: number}} [opts] bpp defaults to 2, model to 3
 * @returns {Uint8Array}
 */
export function pack(indices, width, height, palette, opts = {}) {
  checkDims(width, height);
  checkPalette(palette);
  const bpp = opts.bpp == null ? 2 : opts.bpp;
  const model = opts.model == null ? 3 : opts.model;
  const total = width * height;
  if (indices.length < total) {
    throw new RangeError(`image: ${indices.length} indices, need ${total} for ${width}x${height}`);
  }

  const bytes = new Uint8Array(bufferSize(width, height, bpp));

  if (bpp === 2) {
    // Flatten the palette to codes first: the inner loop runs once per pixel and
    // has no business chasing object properties.
    const codes = Uint8Array.from(palette, (ink) => {
      if (!Number.isInteger(ink.code) || ink.code < 0 || ink.code > 3) {
        throw new RangeError(`image: ink "${ink.id}" has no valid firmware code`);
      }
      return ink.code;
    });
    eachInDeviceOrder(width, height, model, (p, n) => {
      const idx = indices[p];
      if (!(idx >= 0 && idx < codes.length)) {
        throw new RangeError(`image: index ${idx} is outside the palette`);
      }
      bytes[n >> 2] |= codes[idx] << (6 - 2 * (n & 3));
    });
  } else {
    // 1 bpp: a set bit means black, everything else is left white. An ink counts
    // as black by id or by firmware code, so hand-built palettes work too.
    const isBlack = Uint8Array.from(palette, (ink) => (isBlackInk(ink) ? 1 : 0));
    eachInDeviceOrder(width, height, model, (p, n) => {
      const idx = indices[p];
      if (!(idx >= 0 && idx < isBlack.length)) {
        throw new RangeError(`image: index ${idx} is outside the palette`);
      }
      if (isBlack[idx]) bytes[n >> 3] |= 0x80 >> (n & 7);
    });
  }
  return bytes;
}

/**
 * Inverse of pack(): unpack the wire format back into one value per pixel, in
 * row-major order. Exists so the tests can prove pack() is lossless.
 *
 * Without `palette` the values are raw firmware codes (0..3 at 2 bpp; 1 = black,
 * 0 = white at 1 bpp). With a palette they are indices into it, making this an
 * exact inverse of pack() for that palette.
 *
 * @param {Uint8Array} bytes
 * @param {number} width
 * @param {number} height
 * @param {{bpp?: 1|2, model?: number, palette?: Array<{id?: string, code: number}>}} [opts]
 * @returns {Uint8Array} width*height values
 */
export function unpack(bytes, width, height, opts = {}) {
  checkDims(width, height);
  const bpp = opts.bpp == null ? 2 : opts.bpp;
  const model = opts.model == null ? 3 : opts.model;
  const palette = opts.palette;
  const need = bufferSize(width, height, bpp);
  if (bytes.length < need) {
    throw new RangeError(`image: ${bytes.length} bytes, need ${need} for ${width}x${height} at ${bpp} bpp`);
  }

  const out = new Uint8Array(width * height);

  if (bpp === 2) {
    let map = null;
    if (palette) {
      checkPalette(palette);
      map = new Int8Array(4).fill(-1);
      // Later duplicates lose, so the mapping matches pack()'s first-match rule.
      for (let i = palette.length - 1; i >= 0; i--) map[palette[i].code & 3] = i;
    }
    eachInDeviceOrder(width, height, model, (p, n) => {
      const code = (bytes[n >> 2] >> (6 - 2 * (n & 3))) & 3;
      if (!map) {
        out[p] = code;
        return;
      }
      if (map[code] < 0) throw new RangeError(`image: code ${code} is not in the palette`);
      out[p] = map[code];
    });
  } else {
    let blackIdx = 1;
    let whiteIdx = 0;
    if (palette) {
      checkPalette(palette);
      blackIdx = palette.findIndex(isBlackInk);
      whiteIdx = palette.findIndex(isWhiteInk);
      if (blackIdx < 0 || whiteIdx < 0) {
        throw new RangeError('image: a 1 bpp palette needs both a black and a white ink');
      }
    }
    eachInDeviceOrder(width, height, model, (p, n) => {
      const bit = (bytes[n >> 3] >> (7 - (n & 7))) & 1;
      out[p] = bit ? blackIdx : whiteIdx;
    });
  }
  return out;
}

/**
 * Expand palette indices into RGBA for on-screen preview, using the ink colours
 * so the preview shows what the panel will actually print.
 *
 * @param {Uint8Array|number[]} indices
 * @param {number} width
 * @param {number} height
 * @param {Array<{rgb: number[]}>} palette
 * @returns {Uint8ClampedArray} width*height*4, fully opaque
 */
export function indicesToRGBA(indices, width, height, palette) {
  checkDims(width, height);
  checkPalette(palette);
  const n = width * height;
  if (indices.length < n) {
    throw new RangeError(`image: ${indices.length} indices, need ${n} for ${width}x${height}`);
  }
  const out = new Uint8ClampedArray(n * 4);
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    const ink = palette[indices[p]];
    if (!ink) throw new RangeError(`image: index ${indices[p]} is outside the palette`);
    out[i] = ink.rgb[0];
    out[i + 1] = ink.rgb[1];
    out[i + 2] = ink.rgb[2];
    out[i + 3] = 255;
  }
  return out;
}
