/**
 * QR Code encoder — no dependencies, no DOM, no network.
 *
 * SUPPORTED: ISO/IEC 18004 model-2 symbols, versions 1 to 40 (21x21 .. 177x177),
 * error-correction levels L / M / Q / H, all eight data masks, and three encoding
 * modes: numeric, alphanumeric and byte. Byte mode emits UTF-8.
 *
 * NOT SUPPORTED: kanji mode, ECI headers, structured append, FNC1, Micro QR.
 *
 * One mode is chosen for the whole string; mixed-mode segmentation is deliberately
 * not attempted. Every payload this app produces (URL, vCard, Wi-Fi login) lands in
 * byte mode anyway, and a mis-split segment produces a symbol that still *looks*
 * like a QR code but decodes to garbage — the worst possible failure here.
 *
 * Byte mode has no ECI header, so a decoder is formally entitled to read the bytes
 * as ISO-8859-1. For ASCII the two encodings are identical; for anything above
 * U+007F we rely on the UTF-8 auto-detection that every real-world scanner does.
 * Adding an ECI header would break more scanners than it fixes.
 *
 * VERIFICATION (see test/qrcode.test.js): the version 1-M symbol for "01234567"
 * reproduces the ISO/IEC 18004 Annex I worked example codeword for codeword; the
 * format and version information match Tables C.1 and D.1 exactly; and every
 * version 1..40 at all four levels and all eight masks is decoded back by an
 * independent decoder in the test file with zero Reed-Solomon syndromes.
 *
 * The mask penalty uses ZXing's formulation of the four rules rather than the
 * spec's prose, because that is the encoder most scanners were regression-tested
 * against. Mask choice never affects decodability — the chosen mask is recorded in
 * the format information — so this only matters for matching other encoders.
 */

/* ═══════════════════════════════════════════════════════════════════════════
   Tables
   ═══════════════════════════════════════════════════════════════════════════ */

/** Error-correction codewords per block, indexed [ecc][version]; index 0 unused. */
const ECC_CODEWORDS_PER_BLOCK = {
  L: [0, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28,
    28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  M: [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26,
    26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  Q: [0, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30,
    28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  H: [0, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28,
    30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
};

/** Number of error-correction blocks, indexed [ecc][version]; index 0 unused. */
const NUM_ERROR_CORRECTION_BLOCKS = {
  L: [0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8,
    8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  M: [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16,
    17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  Q: [0, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20,
    23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  H: [0, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25,
    25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
};

/** Format-information value for each level. Note this is NOT the L<M<Q<H order. */
const ECC_FORMAT_BITS = { L: 1, M: 0, Q: 3, H: 2 };

/** Mode indicator (4 bits) and character-count-indicator widths per version group. */
const MODES = {
  numeric: { indicator: 0x1, countBits: [10, 12, 14] },
  alnum: { indicator: 0x2, countBits: [9, 11, 13] },
  byte: { indicator: 0x4, countBits: [8, 16, 16] },
};

/** Alphanumeric mode's 45-character set; the index in this string IS the code. */
const ALNUM_CHARSET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

/** Modules of white space the spec requires around the symbol. */
const QUIET_ZONE = 4;

const PENALTY_N1 = 3;
const PENALTY_N2 = 3;
const PENALTY_N3 = 40;
const PENALTY_N4 = 10;

/* ═══════════════════════════════════════════════════════════════════════════
   GF(2^8) arithmetic and Reed-Solomon
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Multiply in GF(2^8) modulo x^8 + x^4 + x^3 + x^2 + 1 (0x11D), the field QR uses.
 * Russian-peasant multiplication: no log/antilog tables to get out of step.
 */
function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

/**
 * Coefficients of the generator polynomial (x - a^0)(x - a^1)...(x - a^(degree-1)),
 * highest power first, with the leading 1 term omitted (it is always 1).
 */
function rsDivisor(degree) {
  const result = new Uint8Array(degree);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    // Multiply the accumulator by (x - a^i), in place.
    for (let j = 0; j < degree; j++) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

/** Remainder of data * x^degree divided by the generator polynomial. */
function rsRemainder(data, divisor) {
  const result = new Uint8Array(divisor.length);
  for (let k = 0; k < data.length; k++) {
    const factor = data[k] ^ result[0];
    result.copyWithin(0, 1);
    result[result.length - 1] = 0;
    for (let i = 0; i < result.length; i++) result[i] ^= gfMul(divisor[i], factor);
  }
  return result;
}

/* ═══════════════════════════════════════════════════════════════════════════
   Capacity
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Number of data modules left once every function pattern is subtracted, i.e. the
 * total bit capacity before error correction is taken out.
 */
function numRawDataModules(ver) {
  let result = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2;
    // Alignment patterns are 5x5 but overlap the timing patterns on the outer row
    // and column, hence the closed form rather than a simple 25 * count.
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (ver >= 7) result -= 36; // two 6x3 version-information blocks
  }
  return result;
}

/** Total codewords in the symbol, data plus error correction. */
function numTotalCodewords(ver) {
  return Math.floor(numRawDataModules(ver) / 8);
}

/** Codewords available for data at this version and level. */
function numDataCodewords(ver, ecc) {
  return numTotalCodewords(ver)
    - ECC_CODEWORDS_PER_BLOCK[ecc][ver] * NUM_ERROR_CORRECTION_BLOCKS[ecc][ver];
}

/** Centre coordinates of the alignment patterns for a version. */
function alignmentPatternPositions(ver) {
  if (ver === 1) return [];
  const numAlign = Math.floor(ver / 7) + 2;
  // Version 32 is the one version whose spacing does not follow the formula.
  const step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (numAlign * 2 - 2)) * 2;
  const result = [6];
  for (let pos = ver * 4 + 17 - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
  return result;
}

/* ═══════════════════════════════════════════════════════════════════════════
   Segment encoding
   ═══════════════════════════════════════════════════════════════════════════ */

/** UTF-8 bytes of a string. TextEncoder exists in every browser we target and in Node. */
function utf8(text) {
  return new TextEncoder().encode(text);
}

/**
 * Pick the densest mode that can represent the whole string.
 * @returns {{mode:'numeric'|'alnum'|'byte', chars:number, bytes:Uint8Array|null}}
 */
function chooseSegment(text) {
  if (/^[0-9]*$/.test(text)) return { mode: 'numeric', chars: text.length, bytes: null };
  let alnum = true;
  for (const ch of text) {
    if (ALNUM_CHARSET.indexOf(ch) < 0) { alnum = false; break; }
  }
  if (alnum) return { mode: 'alnum', chars: text.length, bytes: null };
  const bytes = utf8(text);
  return { mode: 'byte', chars: bytes.length, bytes };
}

/** Version group index used by the character-count-indicator width table. */
function countBits(mode, ver) {
  return MODES[mode].countBits[ver <= 9 ? 0 : ver <= 26 ? 1 : 2];
}

/** Bits the payload itself occupies, excluding mode indicator and count field. */
function segmentDataBits(seg) {
  if (seg.mode === 'numeric') {
    const full = Math.floor(seg.chars / 3);
    const rest = seg.chars % 3;
    return full * 10 + (rest === 2 ? 7 : rest === 1 ? 4 : 0);
  }
  if (seg.mode === 'alnum') {
    return Math.floor(seg.chars / 2) * 11 + (seg.chars % 2) * 6;
  }
  return seg.bytes.length * 8;
}

/** Append the low `len` bits of `val`, most significant first. */
function appendBits(bits, val, len) {
  for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
}

/** Write mode indicator, character count and payload into the bit array. */
function writeSegment(bits, seg, text, ver) {
  appendBits(bits, MODES[seg.mode].indicator, 4);
  appendBits(bits, seg.chars, countBits(seg.mode, ver));
  if (seg.mode === 'numeric') {
    for (let i = 0; i < text.length;) {
      const n = Math.min(3, text.length - i);
      appendBits(bits, parseInt(text.substr(i, n), 10), n * 3 + 1);
      i += n;
    }
  } else if (seg.mode === 'alnum') {
    for (let i = 0; i + 1 < text.length; i += 2) {
      appendBits(bits, ALNUM_CHARSET.indexOf(text[i]) * 45 + ALNUM_CHARSET.indexOf(text[i + 1]), 11);
    }
    if (text.length % 2) appendBits(bits, ALNUM_CHARSET.indexOf(text[text.length - 1]), 6);
  } else {
    for (const b of seg.bytes) appendBits(bits, b, 8);
  }
}

/**
 * Smallest version that holds the payload, honouring minVersion.
 * The character-count field widens at versions 10 and 27, so the fit has to be
 * re-tested at every version rather than solved once.
 */
function chooseVersion(seg, ecc, minVersion) {
  for (let ver = Math.max(1, minVersion | 0); ver <= 40; ver++) {
    const capacityBits = numDataCodewords(ver, ecc) * 8;
    const used = 4 + countBits(seg.mode, ver) + segmentDataBits(seg);
    if (used <= capacityBits) return ver;
  }
  throw new Error('QR: data too long — does not fit in version 40 at level ' + ecc);
}

/* ═══════════════════════════════════════════════════════════════════════════
   Codewords
   ═══════════════════════════════════════════════════════════════════════════ */

/** Bit array -> padded data codewords for the chosen version. */
function padToCodewords(bits, ver, ecc) {
  const capacityBits = numDataCodewords(ver, ecc) * 8;
  // Terminator: up to four zero bits, truncated if the symbol is nearly full.
  appendBits(bits, 0, Math.min(4, capacityBits - bits.length));
  appendBits(bits, 0, (8 - (bits.length % 8)) % 8);
  // Alternating pad codewords, fixed by the spec.
  for (let pad = 0xec; bits.length < capacityBits; pad ^= 0xec ^ 0x11) appendBits(bits, pad, 8);
  const out = new Uint8Array(bits.length / 8);
  for (let i = 0; i < bits.length; i++) out[i >>> 3] |= bits[i] << (7 - (i & 7));
  return out;
}

/**
 * Split the data into blocks, append each block's error-correction codewords, then
 * interleave. Blocks come in two lengths and the short ones are one codeword
 * shorter, which is what the skip in the interleave loop is guarding.
 */
function addEccAndInterleave(data, ver, ecc) {
  const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[ecc][ver];
  const blockEccLen = ECC_CODEWORDS_PER_BLOCK[ecc][ver];
  const rawCodewords = numTotalCodewords(ver);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);

  const divisor = rsDivisor(blockEccLen);
  const blocks = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const datLen = shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1);
    const dat = data.subarray(k, k + datLen);
    k += datLen;
    const block = new Uint8Array(shortBlockLen + 1);
    block.set(dat, 0);
    // Short blocks keep a dummy byte at index datLen so every block has the same
    // length here; the interleave loop below skips it.
    block.set(rsRemainder(dat, divisor), shortBlockLen + 1 - blockEccLen);
    blocks.push(block);
  }

  const result = new Uint8Array(rawCodewords);
  let n = 0;
  for (let i = 0; i < shortBlockLen + 1; i++) {
    for (let j = 0; j < numBlocks; j++) {
      if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) result[n++] = blocks[j][i];
    }
  }
  return result;
}

/* ═══════════════════════════════════════════════════════════════════════════
   Symbol construction
   ═══════════════════════════════════════════════════════════════════════════ */

function getBit(x, i) {
  return (x >>> i) & 1;
}

/** Mutable drawing state for one symbol. */
function newCanvas(size) {
  return {
    size,
    modules: new Uint8Array(size * size),
    isFunction: new Uint8Array(size * size),
  };
}

function setFunctionModule(c, x, y, dark) {
  c.modules[y * c.size + x] = dark ? 1 : 0;
  c.isFunction[y * c.size + x] = 1;
}

/** Finder pattern plus its white separator ring, clipped at the symbol edge. */
function drawFinder(c, cx, cy) {
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || x >= c.size || y < 0 || y >= c.size) continue;
      const dist = Math.max(Math.abs(dx), Math.abs(dy)); // Chebyshev ring index
      setFunctionModule(c, x, y, dist !== 2 && dist !== 4);
    }
  }
}

/** 5x5 alignment pattern: dark border, light ring, dark centre. */
function drawAlignment(c, cx, cy) {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      setFunctionModule(c, cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
}

/** The 15 format bits: 5 data bits, BCH(15,5) parity, masked with 0x5412. */
function formatBits(ecc, mask) {
  const data = (ECC_FORMAT_BITS[ecc] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

/** The 18 version bits for versions 7+: 6 data bits and BCH(18,6) parity. */
function versionBits(ver) {
  let rem = ver;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (ver << 12) | rem;
}

/** Both copies of the format information, plus the module that is always dark. */
function drawFormatBits(c, ecc, mask) {
  const bits = formatBits(ecc, mask);
  const size = c.size;
  for (let i = 0; i <= 5; i++) setFunctionModule(c, 8, i, getBit(bits, i));
  setFunctionModule(c, 8, 7, getBit(bits, 6));
  setFunctionModule(c, 8, 8, getBit(bits, 7));
  setFunctionModule(c, 7, 8, getBit(bits, 8));
  for (let i = 9; i < 15; i++) setFunctionModule(c, 14 - i, 8, getBit(bits, i));

  for (let i = 0; i < 8; i++) setFunctionModule(c, size - 1 - i, 8, getBit(bits, i));
  for (let i = 8; i < 15; i++) setFunctionModule(c, 8, size - 15 + i, getBit(bits, i));
  setFunctionModule(c, 8, size - 8, 1); // the "dark module", always set
}

function drawFunctionPatterns(c, ver, ecc) {
  const size = c.size;
  for (let i = 0; i < size; i++) {
    setFunctionModule(c, 6, i, i % 2 === 0);
    setFunctionModule(c, i, 6, i % 2 === 0);
  }
  drawFinder(c, 3, 3);
  drawFinder(c, size - 4, 3);
  drawFinder(c, 3, size - 4);

  const pos = alignmentPatternPositions(ver);
  for (let i = 0; i < pos.length; i++) {
    for (let j = 0; j < pos.length; j++) {
      // The three corners are occupied by finder patterns.
      const corner = (i === 0 && j === 0) || (i === 0 && j === pos.length - 1)
        || (i === pos.length - 1 && j === 0);
      if (!corner) drawAlignment(c, pos[i], pos[j]);
    }
  }

  // Drawn with mask 0 for now; the real mask is written once it has been chosen,
  // but the cells must be reserved before any data is placed.
  drawFormatBits(c, ecc, 0);

  if (ver >= 7) {
    const bits = versionBits(ver);
    for (let i = 0; i < 18; i++) {
      const bit = getBit(bits, i);
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setFunctionModule(c, a, b, bit);
      setFunctionModule(c, b, a, bit);
    }
  }
}

/** Zig-zag the codeword bits up and down two-module-wide columns, right to left. */
function drawCodewords(c, data) {
  const size = c.size;
  let i = 0;
  for (let pair = size - 1; pair >= 1; pair -= 2) {
    // Column 6 is the vertical timing pattern and is never a data column, so every
    // column pair at or below it shifts one to the left: ..., 8|7, 5|4, 3|2, 1|0.
    // Assigning to the loop variable instead (right = 5) produces the same columns
    // by luck of the -= 2 step, but silently changes which cells are visited the
    // moment anyone rewrites the loop. Keep the shift local and obvious.
    const right = pair <= 6 ? pair - 1 : pair;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!c.isFunction[y * size + x] && i < data.length * 8) {
          c.modules[y * size + x] = getBit(data[i >>> 3], 7 - (i & 7));
          i++;
        }
        // Remaining modules stay light: the spec's remainder bits are always 0.
      }
    }
  }
}

/** Mask condition for mask number `m` at column x, row y. */
function maskBit(m, x, y) {
  switch (m) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default: return ((((x + y) % 2) + ((x * y) % 3)) % 2) === 0;
  }
}

/** XOR the mask into every non-function module. Applying it twice undoes it. */
function applyMask(c, m) {
  for (let y = 0; y < c.size; y++) {
    for (let x = 0; x < c.size; x++) {
      const i = y * c.size + x;
      if (!c.isFunction[i] && maskBit(m, x, y)) c.modules[i] ^= 1;
    }
  }
}

/**
 * True when every module in [from, to) along one row or column is light.
 * Anything outside the symbol counts as light: the quiet zone is white paper.
 */
function allLight(m, size, from, to, fixed, horizontal) {
  const a = Math.max(from, 0);
  const b = Math.min(to, size);
  for (let i = a; i < b; i++) {
    if (m[horizontal ? fixed * size + i : i * size + fixed]) return false;
  }
  return true;
}

/** The four penalty rules from the spec; lower is better. */
function penaltyScore(c) {
  const size = c.size;
  const m = c.modules;
  let result = 0;

  // Rule 1: runs of five or more same-coloured modules in a row or column.
  for (let y = 0; y < size; y++) {
    let runColor = 0;
    let runLen = 0;
    for (let x = 0; x < size; x++) {
      if (m[y * size + x] === runColor) {
        runLen++;
        if (runLen === 5) result += PENALTY_N1;
        else if (runLen > 5) result++;
      } else {
        runColor = m[y * size + x];
        runLen = 1;
      }
    }
  }
  for (let x = 0; x < size; x++) {
    let runColor = 0;
    let runLen = 0;
    for (let y = 0; y < size; y++) {
      if (m[y * size + x] === runColor) {
        runLen++;
        if (runLen === 5) result += PENALTY_N1;
        else if (runLen > 5) result++;
      } else {
        runColor = m[y * size + x];
        runLen = 1;
      }
    }
  }

  // Rule 3: a finder-like 1:1:3:1:1 run (dark light dark*3 light dark) with four
  // light modules on either side. Counted at module scale, matching ZXing, so our
  // symbols come out byte-identical to the encoder most scanners were tested against.
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (x + 6 < size
        && m[y * size + x] && !m[y * size + x + 1] && m[y * size + x + 2]
        && m[y * size + x + 3] && m[y * size + x + 4] && !m[y * size + x + 5]
        && m[y * size + x + 6]
        && (allLight(m, size, x - 4, x, y, true) || allLight(m, size, x + 7, x + 11, y, true))) {
        result += PENALTY_N3;
      }
      if (y + 6 < size
        && m[y * size + x] && !m[(y + 1) * size + x] && m[(y + 2) * size + x]
        && m[(y + 3) * size + x] && m[(y + 4) * size + x] && !m[(y + 5) * size + x]
        && m[(y + 6) * size + x]
        && (allLight(m, size, y - 4, y, x, false) || allLight(m, size, y + 7, y + 11, x, false))) {
        result += PENALTY_N3;
      }
    }
  }

  // Rule 2: every 2x2 block of one colour. An m x n block scores N2*(m-1)*(n-1),
  // which falls out of counting each 2x2 sub-block separately.
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c0 = m[y * size + x];
      if (c0 === m[y * size + x + 1] && c0 === m[(y + 1) * size + x]
        && c0 === m[(y + 1) * size + x + 1]) result += PENALTY_N2;
    }
  }

  // Rule 4: imbalance between dark and light modules.
  let dark = 0;
  for (let i = 0; i < m.length; i++) dark += m[i];
  const total = size * size;
  // How far the dark proportion strays from 50%, in whole 5% steps. Integer form of
  // floor(|percent - 50| / 5) — the rounding matters: several encoders in the wild
  // round the wrong way here and pick a different (still legal) mask because of it.
  const k = Math.floor(Math.abs(dark * 20 - total * 10) / total);
  result += k * PENALTY_N4;
  return result;
}

/* ═══════════════════════════════════════════════════════════════════════════
   Public API
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Encode text as a QR Code matrix.
 *
 * @param {string} text Payload. Encoded as UTF-8 when byte mode is used.
 * @param {{ecc?:'L'|'M'|'Q'|'H', minVersion?:number, mask?:number|null}} [opts]
 *   ecc defaults to 'M'; minVersion defaults to 1; mask null/undefined picks the
 *   lowest-penalty mask, otherwise 0..7 forces one.
 * @returns {{size:number, version:number, ecc:string, mask:number, modules:Uint8Array}}
 *   modules is size*size, row-major, 1 = dark. The quiet zone is NOT included.
 */
export function qrMatrix(text, opts) {
  const o = opts || {};
  const str = text == null ? '' : String(text);
  const ecc = String(o.ecc || 'M').toUpperCase();
  if (!ECC_FORMAT_BITS.hasOwnProperty(ecc)) throw new Error('QR: unknown ecc level ' + o.ecc);
  // -1 is the internal "pick one" sentinel, so the range has to be checked before
  // the option collapses into it — otherwise an explicit mask of -1 would be read
  // as "automatic" instead of being rejected.
  let forced = -1;
  if (o.mask !== null && o.mask !== undefined) {
    forced = o.mask | 0;
    if (forced < 0 || forced > 7) throw new Error('QR: mask must be 0..7');
  }
  const minVersion = o.minVersion == null ? 1 : o.minVersion | 0;
  if (minVersion < 1 || minVersion > 40) throw new Error('QR: minVersion must be 1..40');

  const seg = chooseSegment(str);
  const version = chooseVersion(seg, ecc, minVersion);

  const bits = [];
  writeSegment(bits, seg, str, version);
  const dataCodewords = padToCodewords(bits, version, ecc);
  const allCodewords = addEccAndInterleave(dataCodewords, version, ecc);

  const size = version * 4 + 17;
  const c = newCanvas(size);
  drawFunctionPatterns(c, version, ecc);
  drawCodewords(c, allCodewords);

  let mask = forced;
  if (mask === -1) {
    let best = Infinity;
    for (let m = 0; m < 8; m++) {
      applyMask(c, m);
      drawFormatBits(c, ecc, m);
      const score = penaltyScore(c);
      if (score < best) { best = score; mask = m; }
      applyMask(c, m); // XOR again to undo
    }
  }
  applyMask(c, mask);
  drawFormatBits(c, ecc, mask);

  return { size, version, ecc, mask, modules: c.modules };
}

/**
 * Resolve which entry of a render palette is the ink we want.
 * Accepts the app's ink objects ({id, code, rgb}) or a bare array of firmware
 * palette codes; falls back to the darkest/lightest rgb so an unexpected palette
 * still produces a readable symbol instead of throwing.
 *
 * @param {Array|null|undefined} palette
 * @param {'black'|'white'} want
 * @returns {number} index into `palette`, or the firmware code when no palette given
 */
function inkIndex(palette, want) {
  const code = want === 'black' ? 3 : 2; // firmware: 0=RED 1=YELLOW 2=WHITE 3=BLACK
  if (!Array.isArray(palette) || palette.length === 0) return code;

  if (typeof palette[0] === 'number') {
    const i = palette.indexOf(code);
    return i >= 0 ? i : want === 'black' ? 0 : palette.length - 1;
  }
  let byId = -1;
  let byCode = -1;
  let extreme = 0;
  let extremeLum = null;
  for (let i = 0; i < palette.length; i++) {
    const p = palette[i] || {};
    if (byId < 0 && p.id === want) byId = i;
    if (byCode < 0 && p.code === code) byCode = i;
    if (Array.isArray(p.rgb)) {
      const lum = 0.3 * p.rgb[0] + 0.59 * p.rgb[1] + 0.11 * p.rgb[2];
      if (extremeLum === null || (want === 'black' ? lum < extremeLum : lum > extremeLum)) {
        extremeLum = lum;
        extreme = i;
      }
    }
  }
  if (byId >= 0) return byId;
  if (byCode >= 0) return byCode;
  return extreme;
}

/**
 * Render a QR code into a width*height palette-index buffer ready for pack().
 *
 * The symbol is centred and scaled by a whole number of pixels per module. A
 * fractional module size would put module edges between pixels, which on a 200x200
 * panel is the difference between a code that scans instantly and one that never
 * scans at all — so we floor the scale and pad with quiet zone instead.
 *
 * @param {string} text Payload.
 * @param {object} [opts] Same options as qrMatrix, plus quiet (default 4 modules).
 * @param {number} width Target width in pixels.
 * @param {number} height Target height in pixels.
 * @param {Array} [palette] Render palette; index 3=black / 2=white is assumed if omitted.
 * @returns {Uint8Array} width*height palette indices, row-major.
 */
export function qrToIndices(text, opts, width, height, palette) {
  const w = Math.floor(width);
  const h = Math.floor(height);
  if (!(w > 0) || !(h > 0)) throw new Error('QR: target size must be positive');

  const o = opts || {};
  const quiet = o.quiet == null ? QUIET_ZONE : Math.max(0, o.quiet | 0);
  const qr = qrMatrix(text, o);
  const span = qr.size + 2 * quiet;
  const scale = Math.floor(Math.min(w, h) / span);
  if (scale < 1) {
    throw new Error(
      `QR: version ${qr.version} needs at least ${span}x${span} px at 1 px per module, `
      + `target is ${w}x${h} — shorten the text or lower the ecc level`
    );
  }

  const dark = inkIndex(palette, 'black');
  const light = inkIndex(palette, 'white');
  const out = new Uint8Array(w * h).fill(light);

  const drawn = qr.size * scale;
  const ox = Math.floor((w - drawn) / 2);
  const oy = Math.floor((h - drawn) / 2);
  for (let my = 0; my < qr.size; my++) {
    for (let mx = 0; mx < qr.size; mx++) {
      if (!qr.modules[my * qr.size + mx]) continue;
      const px0 = ox + mx * scale;
      const py0 = oy + my * scale;
      for (let dy = 0; dy < scale; dy++) {
        const row = (py0 + dy) * w;
        for (let dx = 0; dx < scale; dx++) out[row + px0 + dx] = dark;
      }
    }
  }
  return out;
}

/** Escape a value for a vCard text field per RFC 2426 §5. */
function vcardEscape(s) {
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;')
    .replace(/\r/g, '');
}

/**
 * Build a vCard 3.0 string suitable for a QR contact card.
 *
 * @param {{name?:string, org?:string, title?:string, phone?:string, email?:string,
 *          url?:string, note?:string}} fields Empty fields are omitted.
 * @returns {string} CRLF-delimited vCard.
 */
export function vcard(fields) {
  const f = fields || {};
  const lines = ['BEGIN:VCARD', 'VERSION:3.0'];
  const name = (f.name || '').trim();
  if (name) {
    // N is mandatory in 3.0 and structured as Family;Given;Middle;Prefix;Suffix.
    // We only ever get a display name, so treat the last word as the family name.
    const parts = name.split(/\s+/);
    const family = parts.length > 1 ? parts.pop() : '';
    lines.push(`N:${vcardEscape(family)};${vcardEscape(parts.join(' '))};;;`);
    lines.push(`FN:${vcardEscape(name)}`);
  }
  if (f.org) lines.push(`ORG:${vcardEscape(f.org)}`);
  if (f.title) lines.push(`TITLE:${vcardEscape(f.title)}`);
  if (f.phone) lines.push(`TEL;TYPE=CELL:${vcardEscape(f.phone)}`);
  if (f.email) lines.push(`EMAIL;TYPE=INTERNET:${vcardEscape(f.email)}`);
  if (f.url) lines.push(`URL:${vcardEscape(f.url)}`);
  if (f.note) lines.push(`NOTE:${vcardEscape(f.note)}`);
  lines.push('END:VCARD');
  return lines.join('\r\n');
}

/**
 * Escape a Wi-Fi field. Values that look like hex would be read as a raw hex key,
 * so those get quoted — a password of "12345678" is not the same as 0x12345678.
 */
function wifiEscape(s) {
  const v = String(s).replace(/([\\;,:"'])/g, '\\$1');
  return /^[0-9a-fA-F]+$/.test(String(s)) && String(s).length % 2 === 0 ? `"${v}"` : v;
}

/**
 * Build a WIFI: join string (the de-facto ZXing format Android and iOS both read).
 *
 * @param {{ssid?:string, password?:string, security?:'WPA'|'WEP'|'nopass',
 *          hidden?:boolean}} opts
 * @returns {string}
 */
export function wifi(opts) {
  const o = opts || {};
  const ssid = o.ssid || '';
  const sec = o.password ? String(o.security || 'WPA') : String(o.security || 'nopass');
  const type = /^wep$/i.test(sec) ? 'WEP' : /^nopass$/i.test(sec) ? 'nopass' : 'WPA';
  let out = `WIFI:T:${type};S:${wifiEscape(ssid)};`;
  if (type !== 'nopass') out += `P:${wifiEscape(o.password || '')};`;
  if (o.hidden) out += 'H:true;';
  return out + ';'; // the trailing empty field terminates the record
}
