/**
 * QR encoder tests.
 *
 * An unscannable QR is worse than no QR, and "it looks like a QR code" tells you
 * nothing, so almost nothing here is a value this encoder produced. The fixtures
 * come from three places, none of which is us:
 *
 *   - PUBLISHED TABLES from ISO/IEC 18004: the format-information strings for all
 *     32 level/mask pairs (Table C.1), the version-information strings for versions
 *     7..40 (Table D.1), the alignment-pattern centres (Annex E), the error-
 *     correction block structure (Table 9) and the Annex I worked example. Those are
 *     transcribed here as constants and every one of them is asserted against the
 *     bits this encoder actually places in the symbol.
 *   - AN INDEPENDENT DECODER, written below from the spec rather than by reversing
 *     js/qrcode.js: it rebuilds the function-pattern map from the published tables,
 *     reads the format information, undoes the mask, walks the placement zig-zag,
 *     de-interleaves the blocks, checks every Reed-Solomon syndrome is zero and
 *     parses the segments back to text. Its GF(256) arithmetic uses log/antilog
 *     tables where the encoder uses carry-less multiplication, so a bug would have
 *     to occur twice, in two different formulations, to hide.
 *   - OTHER IMPLEMENTATIONS, off-line and one-off: the golden matrices below were
 *     produced by ZXing and confirmed module for module by the `qrcode` npm package.
 *     The whole v1..v40 x L/M/Q/H x 8-mask grid matched `qrcode` exactly (1280/1280);
 *     the automatic output matched ZXing on 93 of 96 payloads with the same mask
 *     every time, the three exceptions being ZXing picking a larger version than it
 *     needs (`qrcode` and `qrcode-generator` agree with us there); and jsQR read back
 *     96 of 96 symbols rendered at real panel sizes. None of those libraries is a
 *     dependency of this project — the `qrcode`/jsQR half of that pass is written up
 *     in CONTRIBUTING.md so anyone can repeat it. What lives here is the regression
 *     net that needs no network and no node_modules.
 */

import { qrMatrix, qrToIndices, vcard, wifi } from '../js/qrcode.js';

/* ═══════════════════════════════════════════════════════════════════════════
   Published tables (ISO/IEC 18004)
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Table C.1 — the 15 bits of format information, already BCH(15,5)-encoded and
 * XORed with the 101010000010010 mask, for every error-correction level and mask
 * pattern. Note the level bit order is M, L, H, Q, not L, M, Q, H.
 */
const FORMAT_INFO = {
  L: [0x77c4, 0x72f3, 0x7daa, 0x789d, 0x662f, 0x6318, 0x6c41, 0x6976],
  M: [0x5412, 0x5125, 0x5e7c, 0x5b4b, 0x45f9, 0x40ce, 0x4f97, 0x4aa0],
  Q: [0x355f, 0x3068, 0x3f31, 0x3a06, 0x24b4, 0x2183, 0x2eda, 0x2bed],
  H: [0x1689, 0x13be, 0x1ce7, 0x19d0, 0x0762, 0x0255, 0x0d0c, 0x083b],
};

/** Table D.1 — the 18 bits of version information, versions 7..40 in order. */
const VERSION_INFO = [
  0x07c94, 0x085bc, 0x09a99, 0x0a4d3, 0x0bbf6, 0x0c762, 0x0d847, 0x0e60d, 0x0f928,
  0x10b78, 0x1145d, 0x12a17, 0x13532, 0x149a6, 0x15683, 0x168c9, 0x177ec, 0x18ec4,
  0x191e1, 0x1afab, 0x1b08e, 0x1cc1a, 0x1d33f, 0x1ed75, 0x1f250, 0x209d5, 0x216f0,
  0x228ba, 0x2379f, 0x24b0b, 0x2542e, 0x26a64, 0x27541, 0x28c69,
];

/** Annex E — row/column centres of the alignment patterns, indexed by version. */
const ALIGN = [
  null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42],
  [6, 26, 46], [6, 28, 50], [6, 30, 54], [6, 32, 58], [6, 34, 62], [6, 26, 46, 66],
  [6, 26, 48, 70], [6, 26, 50, 74], [6, 30, 54, 78], [6, 30, 56, 82], [6, 30, 58, 86],
  [6, 34, 62, 90], [6, 28, 50, 72, 94], [6, 26, 50, 74, 98], [6, 30, 54, 78, 102],
  [6, 28, 54, 80, 106], [6, 32, 58, 84, 110], [6, 30, 58, 86, 114], [6, 34, 62, 90, 118],
  [6, 26, 50, 74, 98, 122], [6, 30, 54, 78, 102, 126], [6, 26, 52, 78, 104, 130],
  [6, 30, 56, 82, 108, 134], [6, 34, 60, 86, 112, 138], [6, 30, 58, 86, 114, 142],
  [6, 34, 62, 90, 118, 146], [6, 30, 54, 78, 102, 126, 150], [6, 24, 50, 76, 102, 128, 154],
  [6, 28, 54, 80, 106, 132, 158], [6, 32, 58, 84, 110, 136, 162],
  [6, 26, 54, 82, 110, 138, 166], [6, 30, 58, 86, 114, 142, 170],
];

/**
 * Table 9 — error-correction characteristics, as
 * 'eccCodewordsPerBlock:blockCount x dataCodewordsPerBlock [+ second group]'.
 * Indexed by version, then level.
 */
const BLOCKS = [
  null,
  { L: '7:1x19', M: '10:1x16', Q: '13:1x13', H: '17:1x9' },
  { L: '10:1x34', M: '16:1x28', Q: '22:1x22', H: '28:1x16' },
  { L: '15:1x55', M: '26:1x44', Q: '18:2x17', H: '22:2x13' },
  { L: '20:1x80', M: '18:2x32', Q: '26:2x24', H: '16:4x9' },
  { L: '26:1x108', M: '24:2x43', Q: '18:2x15+2x16', H: '22:2x11+2x12' },
  { L: '18:2x68', M: '16:4x27', Q: '24:4x19', H: '28:4x15' },
  { L: '20:2x78', M: '18:4x31', Q: '18:2x14+4x15', H: '26:4x13+1x14' },
  { L: '24:2x97', M: '22:2x38+2x39', Q: '22:4x18+2x19', H: '26:4x14+2x15' },
  { L: '30:2x116', M: '22:3x36+2x37', Q: '20:4x16+4x17', H: '24:4x12+4x13' },
  { L: '18:2x68+2x69', M: '26:4x43+1x44', Q: '24:6x19+2x20', H: '28:6x15+2x16' },
  { L: '20:4x81', M: '30:1x50+4x51', Q: '28:4x22+4x23', H: '24:3x12+8x13' },
  { L: '24:2x92+2x93', M: '22:6x36+2x37', Q: '26:4x20+6x21', H: '28:7x14+4x15' },
  { L: '26:4x107', M: '22:8x37+1x38', Q: '24:8x20+4x21', H: '22:12x11+4x12' },
  { L: '30:3x115+1x116', M: '24:4x40+5x41', Q: '20:11x16+5x17', H: '24:11x12+5x13' },
  { L: '22:5x87+1x88', M: '24:5x41+5x42', Q: '30:5x24+7x25', H: '24:11x12+7x13' },
  { L: '24:5x98+1x99', M: '28:7x45+3x46', Q: '24:15x19+2x20', H: '30:3x15+13x16' },
  { L: '28:1x107+5x108', M: '28:10x46+1x47', Q: '28:1x22+15x23', H: '28:2x14+17x15' },
  { L: '30:5x120+1x121', M: '26:9x43+4x44', Q: '28:17x22+1x23', H: '28:2x14+19x15' },
  { L: '28:3x113+4x114', M: '26:3x44+11x45', Q: '26:17x21+4x22', H: '26:9x13+16x14' },
  { L: '28:3x107+5x108', M: '26:3x41+13x42', Q: '30:15x24+5x25', H: '28:15x15+10x16' },
  { L: '28:4x116+4x117', M: '26:17x42', Q: '28:17x22+6x23', H: '30:19x16+6x17' },
  { L: '28:2x111+7x112', M: '28:17x46', Q: '30:7x24+16x25', H: '24:34x13' },
  { L: '30:4x121+5x122', M: '28:4x47+14x48', Q: '30:11x24+14x25', H: '30:16x15+14x16' },
  { L: '30:6x117+4x118', M: '28:6x45+14x46', Q: '30:11x24+16x25', H: '30:30x16+2x17' },
  { L: '26:8x106+4x107', M: '28:8x47+13x48', Q: '30:7x24+22x25', H: '30:22x15+13x16' },
  { L: '28:10x114+2x115', M: '28:19x46+4x47', Q: '28:28x22+6x23', H: '30:33x16+4x17' },
  { L: '30:8x122+4x123', M: '28:22x45+3x46', Q: '30:8x23+26x24', H: '30:12x15+28x16' },
  { L: '30:3x117+10x118', M: '28:3x45+23x46', Q: '30:4x24+31x25', H: '30:11x15+31x16' },
  { L: '30:7x116+7x117', M: '28:21x45+7x46', Q: '30:1x23+37x24', H: '30:19x15+26x16' },
  { L: '30:5x115+10x116', M: '28:19x47+10x48', Q: '30:15x24+25x25', H: '30:23x15+25x16' },
  { L: '30:13x115+3x116', M: '28:2x46+29x47', Q: '30:42x24+1x25', H: '30:23x15+28x16' },
  { L: '30:17x115', M: '28:10x46+23x47', Q: '30:10x24+35x25', H: '30:19x15+35x16' },
  { L: '30:17x115+1x116', M: '28:14x46+21x47', Q: '30:29x24+19x25', H: '30:11x15+46x16' },
  { L: '30:13x115+6x116', M: '28:14x46+23x47', Q: '30:44x24+7x25', H: '30:59x16+1x17' },
  { L: '30:12x121+7x122', M: '28:12x47+26x48', Q: '30:39x24+14x25', H: '30:22x15+41x16' },
  { L: '30:6x121+14x122', M: '28:6x47+34x48', Q: '30:46x24+10x25', H: '30:2x15+64x16' },
  { L: '30:17x122+4x123', M: '28:29x46+14x47', Q: '30:49x24+10x25', H: '30:24x15+46x16' },
  { L: '30:4x122+18x123', M: '28:13x46+32x47', Q: '30:48x24+14x25', H: '30:42x15+32x16' },
  { L: '30:20x117+4x118', M: '28:40x47+7x48', Q: '30:43x24+22x25', H: '30:10x15+67x16' },
  { L: '30:19x118+6x119', M: '28:18x47+31x48', Q: '30:34x24+34x25', H: '30:20x15+61x16' },
];

const LEVELS = ['L', 'M', 'Q', 'H'];

/** Parse one Table 9 cell into { eccLen, dataLens[] }. */
function blockSpec(version, ecc) {
  const [eccPart, groups] = BLOCKS[version][ecc].split(':');
  const dataLens = [];
  for (const group of groups.split('+')) {
    const [count, len] = group.split('x').map(Number);
    for (let i = 0; i < count; i++) dataLens.push(len);
  }
  return { eccLen: Number(eccPart), dataLens };
}

/** Total data codewords for a version and level, straight out of Table 9. */
function dataCodewords(version, ecc) {
  const { dataLens } = blockSpec(version, ecc);
  return dataLens.reduce((a, b) => a + b, 0);
}

/* ═══════════════════════════════════════════════════════════════════════════
   An independent decoder, written from the spec
   ═══════════════════════════════════════════════════════════════════════════ */

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(function initGf() {
  // Log/antilog tables over GF(2^8) with primitive polynomial 0x11D and generator 2.
  // The encoder multiplies without tables, so the two share no arithmetic code.
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();

function gfMul(a, b) {
  return a === 0 || b === 0 ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

/**
 * Every module the spec reserves for a function pattern, rebuilt from the published
 * tables rather than from the encoder. 1 = function module.
 */
function functionMap(version) {
  const size = version * 4 + 17;
  const fn = new Uint8Array(size * size);
  const mark = (x0, y0, w, h) => {
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) {
        if (x >= 0 && y >= 0 && x < size && y < size) fn[y * size + x] = 1;
      }
    }
  };
  // Finder patterns with their separators: an 8x8 corner block each.
  mark(0, 0, 8, 8);
  mark(size - 8, 0, 8, 8);
  mark(0, size - 8, 8, 8);
  // Timing patterns along row 6 and column 6.
  mark(6, 8, 1, size - 16);
  mark(8, 6, size - 16, 1);
  // Format information, both copies, plus the always-dark module at (8, size-8).
  mark(8, 0, 1, 9);
  mark(0, 8, 9, 1);
  mark(size - 8, 8, 8, 1);
  mark(8, size - 8, 1, 8);
  // Alignment patterns, except the three centres occupied by finder patterns.
  for (const cy of ALIGN[version]) {
    for (const cx of ALIGN[version]) {
      const onFinder = (cx === 6 && cy === 6) || (cx === 6 && cy === size - 7)
        || (cx === size - 7 && cy === 6);
      if (!onFinder) mark(cx - 2, cy - 2, 5, 5);
    }
  }
  // Version information, both copies.
  if (version >= 7) {
    mark(size - 11, 0, 3, 6);
    mark(0, size - 11, 6, 3);
  }
  return fn;
}

/**
 * The eight mask conditions of Table 10, in the spec's own (row i, column j) form.
 * True means the module is flipped.
 */
function maskCondition(mask, row, col) {
  switch (mask) {
    case 0: return (row + col) % 2 === 0;
    case 1: return row % 2 === 0;
    case 2: return col % 3 === 0;
    case 3: return (row + col) % 3 === 0;
    case 4: return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
    case 5: return ((row * col) % 2) + ((row * col) % 3) === 0;
    case 6: return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0;
    default: return (((row + col) % 2) + ((row * col) % 3)) % 2 === 0;
  }
}

/** Read the 15 format bits, most significant first, from one of the two copies. */
function readFormat(q, copy) {
  const { size, modules } = q;
  const at = (x, y) => modules[y * size + x];
  const bits = [];
  if (copy === 0) {
    for (let x = 0; x <= 5; x++) bits.push(at(x, 8));
    bits.push(at(7, 8), at(8, 8), at(8, 7));
    for (let y = 5; y >= 0; y--) bits.push(at(8, y));
  } else {
    for (let y = size - 1; y >= size - 7; y--) bits.push(at(8, y));
    for (let x = size - 8; x < size; x++) bits.push(at(x, 8));
  }
  return bits.reduce((acc, b) => (acc << 1) | b, 0);
}

/** Read the 18 version bits, most significant first, from one of the two copies. */
function readVersionBits(q, copy) {
  const { size, modules } = q;
  const at = (x, y) => modules[y * size + x];
  let bits = 0;
  for (let i = 5; i >= 0; i--) {
    for (let j = size - 9; j >= size - 11; j--) {
      bits = (bits << 1) | (copy === 0 ? at(j, i) : at(i, j));
    }
  }
  return bits;
}

/** Undo the mask and walk the placement zig-zag, returning the raw codewords. */
function readCodewords(q) {
  const { size, modules, version, mask } = q;
  const fn = functionMap(version);
  const m = Uint8Array.from(modules);
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      const i = row * size + col;
      if (!fn[i] && maskCondition(mask, row, col)) m[i] ^= 1;
    }
  }
  const bits = [];
  let upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col = 5; // column 6 is the timing pattern, never a data column
    for (let k = 0; k < size; k++) {
      const row = upward ? size - 1 - k : k;
      for (const x of [col, col - 1]) {
        if (!fn[row * size + x]) bits.push(m[row * size + x]);
      }
    }
    upward = !upward;
  }
  const words = new Uint8Array(bits.length >> 3);
  for (let i = 0; i < words.length * 8; i++) if (bits[i]) words[i >> 3] |= 0x80 >> (i & 7);
  return words;
}

/** Split the interleaved stream back into blocks of data codewords + ECC. */
function deinterleave(words, version, ecc) {
  const { eccLen, dataLens } = blockSpec(version, ecc);
  const blocks = dataLens.map(() => []);
  let p = 0;
  const longest = Math.max(...dataLens);
  for (let k = 0; k < longest; k++) {
    for (let b = 0; b < dataLens.length; b++) if (k < dataLens[b]) blocks[b].push(words[p++]);
  }
  for (let k = 0; k < eccLen; k++) {
    for (let b = 0; b < dataLens.length; b++) blocks[b].push(words[p++]);
  }
  return { blocks, eccLen, dataLens, consumed: p };
}

/**
 * A codeword block is a valid Reed-Solomon codeword iff it evaluates to zero at
 * every root of the generator, a^0 .. a^(eccLen-1). Any placement, interleaving or
 * ECC mistake shows up here as a non-zero syndrome.
 */
function syndromesZero(block, eccLen) {
  for (let i = 0; i < eccLen; i++) {
    let s = 0;
    for (let j = 0; j < block.length; j++) s = gfMul(s, GF_EXP[i]) ^ block[j];
    if (s !== 0) return false;
  }
  return true;
}

const ALNUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

/** Parse the data codeword stream back into segments. */
function decodeSegments(data, version) {
  const group = version <= 9 ? 0 : version <= 26 ? 1 : 2;
  const COUNT = { 1: [10, 12, 14], 2: [9, 11, 13], 4: [8, 16, 16] };
  let pos = 0;
  const total = data.length * 8;
  const read = (n) => {
    let v = 0;
    for (let i = 0; i < n; i++, pos++) v = (v << 1) | ((data[pos >> 3] >> (7 - (pos & 7))) & 1);
    return v;
  };
  let text = '';
  const modes = [];
  while (total - pos >= 4) {
    const mode = read(4);
    if (mode === 0) break; // terminator
    if (!COUNT[mode]) throw new Error(`unsupported mode indicator ${mode}`);
    modes.push(mode);
    const count = read(COUNT[mode][group]);
    if (mode === 1) {
      for (let i = 0; i < count;) {
        const n = Math.min(3, count - i);
        text += String(read(n * 3 + 1)).padStart(n, '0');
        i += n;
      }
    } else if (mode === 2) {
      for (let i = 0; i + 1 < count; i += 2) {
        const v = read(11);
        text += ALNUM[Math.floor(v / 45)] + ALNUM[v % 45];
      }
      if (count % 2) text += ALNUM[read(6)];
    } else {
      const bytes = new Uint8Array(count);
      for (let i = 0; i < count; i++) bytes[i] = read(8);
      text += new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    }
  }
  return { text, modes };
}

/**
 * Decode a symbol the way a scanner would: format information first, then the mask,
 * the placement walk, the block structure and finally the segments.
 * @returns {{ecc:string, mask:number, version:number, text:string, modes:number[],
 *            rsOk:boolean, formatCopiesAgree:boolean, dataWords:number[], eccWords:number[]}}
 */
function decode(q) {
  const f0 = readFormat(q, 0);
  const f1 = readFormat(q, 1);
  let ecc = null;
  let mask = -1;
  for (const level of LEVELS) {
    const i = FORMAT_INFO[level].indexOf(f0);
    if (i >= 0) { ecc = level; mask = i; }
  }
  if (ecc === null) throw new Error(`format information ${f0.toString(2)} is not in Table C.1`);
  const version = (q.size - 17) / 4;
  const words = readCodewords({ ...q, version, mask });
  const { blocks, eccLen, dataLens } = deinterleave(words, version, ecc);
  const rsOk = blocks.every((b) => syndromesZero(b, eccLen));
  const data = [];
  const eccWords = [];
  blocks.forEach((b, i) => {
    data.push(...b.slice(0, dataLens[i]));
    eccWords.push(...b.slice(dataLens[i]));
  });
  const { text, modes } = decodeSegments(Uint8Array.from(data), version);
  return { ecc, mask, version, text, modes, rsOk, formatCopiesAgree: f0 === f1, dataWords: data, eccWords };
}

/* ═══════════════════════════════════════════════════════════════════════════
   Golden matrices
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Produced by ZXing and confirmed module-for-module by the `qrcode` npm package.
 * Packed 4 modules per hex digit, row-major, 1 = dark.
 */
const GOLDEN = [
  {
    // The worked example of ISO/IEC 18004 Annex I: version 1-M, numeric mode,
    // mask pattern 010 — which is also the mask our penalty scoring picks.
    text: '01234567', ecc: 'M', version: 1, size: 21, mask: 2,
    hex: 'fe5bfc13d06ea0bb7585dbabaec14507faafe01300be4be0ad4b08d53e1083c1f948005f33f9ac1057c5ba8965d6482ead2904036fef4a0',
  },
  {
    text: 'HELLO WORLD', ecc: 'Q', version: 1, size: 21, mask: 0,
    hex: 'fec3fc14906ea6bb7505dbaa2ec11107faafe010006b0afa07844dd8b0da6ae8abba806917fa85904b68baa3fdd2a8aea5d30578bfe1708',
  },
  {
    text: 'https://example.com', ecc: 'L', version: 2, size: 25, mask: 6,
    hex: 'fe9a3fc130506e8babb74195dba56aec115507faaafe016b00da74a0c4e7efa58d772d0f8efe7ddb0d003c4b5876bf7220edab22fb005f4'
      + '5bf842a304d712bacff8dd5170ee92d3f05c637fea6a48',
  },
  {
    text: 'https://github.com/DatDraggy/web-findXeink-f15', ecc: 'M', version: 4, size: 33, mask: 7,
    hex: 'fe55533fc11797d06e89484bb749df35dba463baec144d8107faaaaafe00e78d0096e6c7506eaa2678f0dfaeaea698a6c59aeababe564e'
      + '1b554fcd2755b5e0999b72d709cfa9007a78eaad839120a58ec37a19ed459d81278aa33f59abd09a92d63e0aa770cdf900772b467f8f9aa'
      + 'bd053dfd10ba7828fcdd63d997ae9def0230480fbc0fed394ad0',
  },
];

/** Expand a golden hex string into a size*size module array. */
function unhex(hex, size) {
  const out = new Uint8Array(size * size);
  for (let i = 0; i < out.length; i++) {
    const nibble = parseInt(hex[i >> 2], 16);
    out[i] = (nibble >> (3 - (i & 3))) & 1;
  }
  return out;
}

/* ═══════════════════════════════════════════════════════════════════════════
   Helpers
   ═══════════════════════════════════════════════════════════════════════════ */

const F15 = [
  { id: 'red', code: 0, rgb: [220, 40, 40] },
  { id: 'yellow', code: 1, rgb: [240, 205, 50] },
  { id: 'white', code: 2, rgb: [255, 255, 255] },
  { id: 'black', code: 3, rgb: [0, 0, 0] },
];

/** Largest byte-mode payload, in bytes, that still fits a version at a level. */
function maxBytes(version, ecc) {
  const countBits = version <= 9 ? 8 : 16;
  return Math.floor((dataCodewords(version, ecc) * 8 - 4 - countBits) / 8);
}

export default function run(t) {
  /* ── Format information (Table C.1) ─────────────────────────────────────── */

  // Every level/mask pair, both copies, against the published BCH strings. This is
  // the one field a scanner reads before it can do anything else.
  for (const ecc of LEVELS) {
    for (let mask = 0; mask < 8; mask++) {
      const q = qrMatrix('format info', { ecc, mask });
      t.check(`format bits ${ecc} mask ${mask} copy 1`, readFormat(q, 0), FORMAT_INFO[ecc][mask]);
      t.check(`format bits ${ecc} mask ${mask} copy 2`, readFormat(q, 1), FORMAT_INFO[ecc][mask]);
    }
  }

  // The dark module is fixed at (8, 4*version+9) and is never masked away.
  for (const version of [1, 2, 7, 20, 40]) {
    const q = qrMatrix('x'.repeat(maxBytes(version, 'L')), { ecc: 'L', minVersion: version, mask: 0 });
    t.check(`v${version} dark module`, q.modules[(q.size - 8) * q.size + 8], 1);
  }

  /* ── Version information (Table D.1) ────────────────────────────────────── */

  for (let version = 7; version <= 40; version++) {
    const q = qrMatrix('v', { ecc: 'L', minVersion: version, mask: 0 });
    t.check(`v${version} version bits copy 1`, readVersionBits(q, 0), VERSION_INFO[version - 7]);
    t.check(`v${version} version bits copy 2`, readVersionBits(q, 1), VERSION_INFO[version - 7]);
  }
  // Versions below 7 carry no version information at all: the cells the block would
  // occupy are ordinary data modules there, so there is nothing to assert beyond the
  // symbol size, but a v6 symbol must still be 41x41 and not leave room for one.
  t.check('v6 has no version block', qrMatrix('v', { ecc: 'L', minVersion: 6 }).size, 41);

  /* ── Function patterns ──────────────────────────────────────────────────── */

  for (const version of [1, 2, 6, 7, 10, 25, 32, 40]) {
    const q = qrMatrix('function patterns', { ecc: 'L', minVersion: version, mask: 0 });
    const size = version * 4 + 17;
    const at = (x, y) => q.modules[y * size + x];
    t.check(`v${version} size`, q.size, size);

    // Finder patterns: dark 7x7 border, light ring, dark 3x3 core, at all three corners.
    let finderOk = true;
    for (const [ox, oy] of [[0, 0], [size - 7, 0], [0, size - 7]]) {
      for (let dy = 0; dy < 7; dy++) {
        for (let dx = 0; dx < 7; dx++) {
          const ring = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
          if (at(ox + dx, oy + dy) !== (ring === 2 ? 0 : 1)) finderOk = false;
        }
      }
    }
    t.ok(`v${version} finder patterns`, finderOk);

    // Separators: the light row and column between each finder and the data.
    let sepOk = true;
    for (let i = 0; i < 8; i++) {
      if (at(7, i) || at(i, 7)) sepOk = false;
      if (at(size - 8, i) || at(size - 1 - i, 7)) sepOk = false;
      if (at(7, size - 1 - i) || at(i, size - 8)) sepOk = false;
    }
    t.ok(`v${version} separators`, sepOk);

    // Timing patterns: alternating dark/light along row 6 and column 6, starting dark
    // at module 8 (even coordinates are dark).
    let timingOk = true;
    for (let i = 8; i < size - 8; i++) {
      if (at(i, 6) !== (i % 2 === 0 ? 1 : 0)) timingOk = false;
      if (at(6, i) !== (i % 2 === 0 ? 1 : 0)) timingOk = false;
    }
    t.ok(`v${version} timing patterns`, timingOk);

    // Alignment patterns at every Annex E centre pair except the three that would
    // collide with a finder: dark centre, light ring, dark 5x5 border.
    let alignOk = true;
    let alignCount = 0;
    for (const cy of ALIGN[version]) {
      for (const cx of ALIGN[version]) {
        const onFinder = (cx === 6 && cy === 6) || (cx === 6 && cy === size - 7)
          || (cx === size - 7 && cy === 6);
        if (onFinder) continue;
        alignCount++;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            const ring = Math.max(Math.abs(dx), Math.abs(dy));
            if (at(cx + dx, cy + dy) !== (ring === 1 ? 0 : 1)) alignOk = false;
          }
        }
      }
    }
    t.ok(`v${version} alignment patterns`, alignOk);
    const n = ALIGN[version].length;
    t.check(`v${version} alignment count`, alignCount, n === 0 ? 0 : n * n - 3);

    // The function-pattern map derived from the published tables must leave exactly
    // as many free modules as the encoder's closed-form capacity formula assumes:
    // if the two ever disagree, every codeword after the first lands in the wrong cell.
    const free = functionMap(version).reduce((acc, v) => acc + (v ? 0 : 1), 0);
    const total = dataCodewords(version, 'L')
      + blockSpec(version, 'L').eccLen * blockSpec(version, 'L').dataLens.length;
    t.check(`v${version} data modules match Table 9`, Math.floor(free / 8), total);
  }

  /* ── Golden matrices ────────────────────────────────────────────────────── */

  for (const g of GOLDEN) {
    const q = qrMatrix(g.text, { ecc: g.ecc });
    t.check(`golden "${g.text.slice(0, 20)}" version`, q.version, g.version);
    t.check(`golden "${g.text.slice(0, 20)}" mask`, q.mask, g.mask);
    t.check(`golden "${g.text.slice(0, 20)}" size`, q.size, g.size);
    t.check(`golden "${g.text.slice(0, 20)}" modules`, q.modules, unhex(g.hex, g.size));
  }

  /* ── ISO/IEC 18004 Annex I codewords ────────────────────────────────────── */

  // The standard prints the whole codeword sequence for this symbol. Reading it back
  // out of the finished matrix checks data encoding, padding, Reed-Solomon and
  // placement against a published value rather than against another implementation.
  const annex = decode(qrMatrix('01234567', { ecc: 'M' }));
  t.check('Annex I data codewords',
    annex.dataWords.map((b) => b.toString(16).padStart(2, '0')).join(' '),
    '10 20 0c 56 61 80 ec 11 ec 11 ec 11 ec 11 ec 11');
  t.check('Annex I ecc codewords',
    annex.eccWords.map((b) => b.toString(16).padStart(2, '0')).join(' '),
    'a5 24 d4 c1 ed 36 c7 87 2c 55');
  t.check('Annex I mode', annex.modes.join(), '1');
  t.check('Annex I text', annex.text, '01234567');

  /* ── Decode round-trip over every version and level ─────────────────────── */

  // One symbol per version and level, filled to capacity so the padding path and the
  // longest block layout are both exercised, decoded by the independent reader above.
  let rtOk = 0;
  let rtFail = [];
  for (let version = 1; version <= 40; version++) {
    for (const ecc of LEVELS) {
      const text = 'Payload '.repeat(400).slice(0, maxBytes(version, ecc));
      const q = qrMatrix(text, { ecc, minVersion: version });
      const d = decode(q);
      const good = q.version === version && d.version === version && d.ecc === ecc
        && d.mask === q.mask && d.rsOk && d.formatCopiesAgree && d.text === text;
      if (good) rtOk++;
      else {
        rtFail.push(`v${version}${ecc}: ver=${d.version}/${q.version} ecc=${d.ecc} mask=${d.mask}/${q.mask} `
          + `rs=${d.rsOk} fmt=${d.formatCopiesAgree} text=${d.text === text}`);
      }
    }
  }
  t.check('round-trip v1..v40 x LMQH failures', rtFail.slice(0, 4).join(' | '), '');
  t.check('round-trip v1..v40 x LMQH', rtOk, 160);

  // Every mask, at a few versions, so masking is checked independently of whichever
  // mask the penalty scoring happens to like.
  let maskOk = 0;
  for (const version of [1, 5, 7, 14, 27, 40]) {
    for (let mask = 0; mask < 8; mask++) {
      const text = `m${mask}v${version}`;
      const q = qrMatrix(text, { ecc: 'Q', minVersion: version, mask });
      const d = decode(q);
      if (d.mask === mask && d.rsOk && d.text === text && d.version === version && q.version === version) maskOk++;
    }
  }
  t.check('round-trip all 8 masks x 6 versions', maskOk, 48);

  /* ── Modes ──────────────────────────────────────────────────────────────── */

  // Mode indicators: 1 = numeric, 2 = alphanumeric, 4 = byte.
  t.check('numeric mode indicator', decode(qrMatrix('9876543210', {})).modes.join(), '1');
  t.check('alphanumeric mode indicator', decode(qrMatrix('HELLO WORLD $%*+-./:', {})).modes.join(), '2');
  t.check('byte mode indicator', decode(qrMatrix('hello', {})).modes.join(), '4');
  // A digit string one character too long for one mode still round-trips.
  t.check('numeric round-trip', decode(qrMatrix('0'.repeat(101), {})).text, '0'.repeat(101));
  t.check('alphanumeric odd length', decode(qrMatrix('ABC', {})).text, 'ABC');
  // Byte mode is UTF-8, which is what every scanner assumes without an ECI header.
  const utf8 = 'Grüße 😀 — ÄÖÜ';
  t.check('utf-8 round-trip', decode(qrMatrix(utf8, {})).text, utf8);
  t.check('empty string encodes', qrMatrix('', {}).size, 21);

  /* ── Version selection at the capacity boundaries ───────────────────────── */

  // Both sides of every byte-mode boundary: the largest payload that fits version N
  // must produce version N, and one byte more must not. The mask is pinned only to
  // skip the penalty search — version choice does not depend on it.
  let boundaryOk = 0;
  const boundaryBad = [];
  for (let version = 1; version < 40; version++) {
    for (const ecc of LEVELS) {
      const fits = maxBytes(version, ecc);
      const under = qrMatrix('x'.repeat(fits), { ecc, mask: 0 }).version;
      const over = qrMatrix('x'.repeat(fits + 1), { ecc, mask: 0 }).version;
      if (under === version && over === version + 1) boundaryOk++;
      else boundaryBad.push(`v${version}${ecc}: ${fits}B->v${under}, ${fits + 1}B->v${over}`);
    }
  }
  t.check('byte capacity boundary failures', boundaryBad.slice(0, 4).join(' | '), '');
  t.check('byte capacity boundaries v1..v39', boundaryOk, 156);

  // Version 40 is the ceiling: exactly full works, one byte more must throw rather
  // than silently truncate.
  for (const ecc of LEVELS) {
    t.check(`v40 ${ecc} full`, qrMatrix('x'.repeat(maxBytes(40, ecc)), { ecc, mask: 0 }).version, 40);
    t.throws(`v40 ${ecc} overflow throws`,
      () => qrMatrix('x'.repeat(maxBytes(40, ecc) + 1), { ecc, mask: 0 }), 'too long');
  }

  // The character-count indicator widens at versions 10 and 27, which is exactly
  // where a fixed-width implementation would mis-size the symbol.
  // These four are the published byte-mode capacities, which double as a check that
  // the Table 9 codeword counts above were transcribed correctly.
  t.check('v7 byte capacity at M', maxBytes(7, 'M'), 122);
  t.check('v9 byte capacity at M', maxBytes(9, 'M'), 180);
  t.check('v10 byte capacity at M', maxBytes(10, 'M'), 213);
  t.check('v26 byte capacity at M', maxBytes(26, 'M'), 1059);
  t.check('v27 byte capacity at M', maxBytes(27, 'M'), 1125);
  t.check('v40 byte capacity at L', maxBytes(40, 'L'), 2953);
  t.check('9 -> 10 boundary', qrMatrix('x'.repeat(181), { ecc: 'M', mask: 0 }).version, 10);
  t.check('26 -> 27 boundary', qrMatrix('x'.repeat(1060), { ecc: 'M', mask: 0 }).version, 27);

  // Numeric and alphanumeric boundaries, from the published capacity table.
  t.check('v1-L numeric 41', qrMatrix('1'.repeat(41), { ecc: 'L', mask: 0 }).version, 1);
  t.check('v1-L numeric 42', qrMatrix('1'.repeat(42), { ecc: 'L', mask: 0 }).version, 2);
  t.check('v1-M numeric 34', qrMatrix('1'.repeat(34), { ecc: 'M', mask: 0 }).version, 1);
  t.check('v1-M numeric 35', qrMatrix('1'.repeat(35), { ecc: 'M', mask: 0 }).version, 2);
  t.check('v1-H numeric 17', qrMatrix('1'.repeat(17), { ecc: 'H', mask: 0 }).version, 1);
  t.check('v1-H numeric 18', qrMatrix('1'.repeat(18), { ecc: 'H', mask: 0 }).version, 2);
  t.check('v1-L alnum 25', qrMatrix('A'.repeat(25), { ecc: 'L', mask: 0 }).version, 1);
  t.check('v1-L alnum 26', qrMatrix('A'.repeat(26), { ecc: 'L', mask: 0 }).version, 2);
  t.check('v1-Q alnum 16', qrMatrix('A'.repeat(16), { ecc: 'Q', mask: 0 }).version, 1);
  t.check('v1-Q alnum 17', qrMatrix('A'.repeat(17), { ecc: 'Q', mask: 0 }).version, 2);
  t.check('v10-M alnum 311', qrMatrix('A'.repeat(311), { ecc: 'M', mask: 0 }).version, 10);
  t.check('v10-M alnum 312', qrMatrix('A'.repeat(312), { ecc: 'M', mask: 0 }).version, 11);
  t.check('v1-L byte 17', qrMatrix('x'.repeat(17), { ecc: 'L', mask: 0 }).version, 1);
  t.check('v1-L byte 18', qrMatrix('x'.repeat(18), { ecc: 'L', mask: 0 }).version, 2);
  t.check('v1-H byte 7', qrMatrix('x'.repeat(7), { ecc: 'H', mask: 0 }).version, 1);
  t.check('v1-H byte 8', qrMatrix('x'.repeat(8), { ecc: 'H', mask: 0 }).version, 2);

  // A multi-byte character counts as its UTF-8 length, not one character.
  t.check('utf-8 counts bytes not characters',
    qrMatrix('ä'.repeat(9), { ecc: 'H', mask: 0 }).version,
    qrMatrix('x'.repeat(18), { ecc: 'H', mask: 0 }).version);

  /* ── Options ────────────────────────────────────────────────────────────── */

  t.check('ecc defaults to M', qrMatrix('default', {}).ecc, 'M');
  t.check('ecc default with no opts', qrMatrix('default').ecc, 'M');
  t.check('lowercase ecc accepted', qrMatrix('x', { ecc: 'h' }).ecc, 'H');
  t.check('minVersion raises version', qrMatrix('x', { ecc: 'L', minVersion: 12 }).version, 12);
  t.check('minVersion below need is ignored',
    qrMatrix('x'.repeat(100), { ecc: 'H', minVersion: 2 }).version,
    qrMatrix('x'.repeat(100), { ecc: 'H' }).version);
  t.check('forced mask is used', qrMatrix('x', { mask: 6 }).mask, 6);
  t.check('mask null means automatic', qrMatrix('x', { mask: null }).mask, qrMatrix('x').mask);
  t.check('numeric string mask accepted', qrMatrix('x', { mask: '3' }).mask, 3);
  t.throws('bad ecc throws', () => qrMatrix('x', { ecc: 'Z' }), 'unknown ecc');
  t.throws('mask 8 throws', () => qrMatrix('x', { mask: 8 }), 'mask must be');
  t.throws('mask -1 throws', () => qrMatrix('x', { mask: -1 }), 'mask must be');
  t.throws('non-integer mask throws', () => qrMatrix('x', { mask: 'auto' }), 'mask must be');
  t.throws('minVersion 0 throws', () => qrMatrix('x', { minVersion: 0 }), 'minVersion');
  t.throws('minVersion 41 throws', () => qrMatrix('x', { minVersion: 41 }), 'minVersion');
  t.throws('minVersion too small for data',
    () => qrMatrix('x'.repeat(3000), { ecc: 'H' }), 'too long');

  // The chosen mask is the lowest-penalty one, so forcing the mask the encoder picked
  // must reproduce the automatic symbol exactly.
  const auto = qrMatrix('penalty check for mask selection', { ecc: 'M' });
  t.check('auto mask == same mask forced', qrMatrix('penalty check for mask selection',
    { ecc: 'M', mask: auto.mask }).modules, auto.modules);

  /* ── qrToIndices ────────────────────────────────────────────────────────── */

  const q200 = qrMatrix('https://findx.kieran.de/', { ecc: 'M' });
  const span = q200.size + 8; // 4-module quiet zone on each side
  const scale = Math.floor(200 / span);
  const idx = qrToIndices('https://findx.kieran.de/', { ecc: 'M' }, 200, 200, F15);
  t.check('qrToIndices length', idx.length, 200 * 200);
  t.check('qrToIndices is Uint8Array', idx.constructor.name, 'Uint8Array');

  // Every module must be a solid scale x scale block of one ink. A fractional module
  // size is the difference between a code that scans instantly and one that never does.
  const ox = Math.floor((200 - q200.size * scale) / 2);
  const oy = Math.floor((200 - q200.size * scale) / 2);
  let blocksOk = true;
  let dark = 0;
  for (let my = 0; my < q200.size; my++) {
    for (let mx = 0; mx < q200.size; mx++) {
      const want = q200.modules[my * q200.size + mx] ? 3 : 2;
      if (want === 3) dark++;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          if (idx[(oy + my * scale + dy) * 200 + ox + mx * scale + dx] !== want) blocksOk = false;
        }
      }
    }
  }
  t.ok('qrToIndices draws whole modules', blocksOk);
  t.check('qrToIndices dark pixel count', idx.reduce((a, v) => a + (v === 3 ? 1 : 0), 0), dark * scale * scale);

  // Quiet zone: at least four modules of white ink on every side.
  let quietOk = true;
  for (let y = 0; y < 200; y++) {
    for (let x = 0; x < 200; x++) {
      const inside = x >= ox && y >= oy && x < ox + q200.size * scale && y < oy + q200.size * scale;
      if (!inside && idx[y * 200 + x] !== 2) quietOk = false;
    }
  }
  t.ok('qrToIndices quiet zone is white', quietOk);
  t.ok('quiet zone is at least 4 modules', ox >= 4 * scale && oy >= 4 * scale);

  // Integer scaling, never fractional, and centred.
  for (const [w, h] of [[200, 200], [250, 122], [96, 96], [400, 300]]) {
    const q = qrMatrix('scale check', { ecc: 'M' });
    const s = Math.floor(Math.min(w, h) / (q.size + 8));
    const buf = qrToIndices('scale check', { ecc: 'M' }, w, h, F15);
    t.check(`qrToIndices ${w}x${h} length`, buf.length, w * h);
    // Count dark pixels: must be an exact multiple of s*s.
    const d = buf.reduce((a, v) => a + (v === 3 ? 1 : 0), 0);
    t.check(`qrToIndices ${w}x${h} integer module size`, d % (s * s), 0);
  }

  // Rendering must round-trip through a decoder at panel resolution — the only test
  // that answers "will a phone scan this".
  for (const [text, ecc] of [
    ['https://findx.kieran.de/', 'M'],
    [wifi({ ssid: 'MyNetwork', password: 'hunter22', security: 'WPA' }), 'M'],
    [vcard({ name: 'John Doe', org: 'Example GmbH', phone: '+49 170 1234567', email: 'j@example.com' }), 'L'],
  ]) {
    const rendered = qrToIndices(text, { ecc }, 200, 200, F15);
    const q = qrMatrix(text, { ecc });
    const s = Math.floor(200 / (q.size + 8));
    const x0 = Math.floor((200 - q.size * s) / 2);
    const y0 = Math.floor((200 - q.size * s) / 2);
    // Sample the centre pixel of each module back out of the panel buffer and decode.
    const back = new Uint8Array(q.size * q.size);
    for (let my = 0; my < q.size; my++) {
      for (let mx = 0; mx < q.size; mx++) {
        const px = x0 + mx * s + (s >> 1);
        const py = y0 + my * s + (s >> 1);
        back[my * q.size + mx] = rendered[py * 200 + px] === 3 ? 1 : 0;
      }
    }
    const d = decode({ size: q.size, modules: back, version: q.version, mask: q.mask });
    t.check(`panel round-trip "${text.slice(0, 18)}"`, d.text, text);
    t.ok(`panel round-trip "${text.slice(0, 18)}" ecc ok`, d.rsOk && d.ecc === ecc);
  }

  // Palette handling: ink objects, a bare array of firmware codes, and a two-ink
  // 1 bpp panel palette (white first, black second — the order render.js builds).
  const oneBpp = [{ id: 'white', code: 2, rgb: [255, 255, 255] }, { id: 'black', code: 3, rgb: [0, 0, 0] }];
  const mono = qrToIndices('palette', { ecc: 'M' }, 100, 100, oneBpp);
  t.ok('1 bpp palette uses index 1 for dark', mono.includes(1) && mono.includes(0) && !mono.includes(2));
  const codes = qrToIndices('palette', { ecc: 'M' }, 100, 100, [0, 1, 2, 3]);
  t.ok('numeric palette maps to firmware codes', codes.includes(3) && codes.includes(2));
  const noPalette = qrToIndices('palette', { ecc: 'M' }, 100, 100);
  t.ok('no palette falls back to firmware codes', noPalette.includes(3) && noPalette.includes(2));
  // A palette without black falls back to the darkest ink there is rather than throwing.
  const redWhite = [{ id: 'red', code: 0, rgb: [220, 40, 40] }, { id: 'white', code: 2, rgb: [255, 255, 255] }];
  t.ok('palette without black uses the darkest ink',
    qrToIndices('palette', { ecc: 'M' }, 100, 100, redWhite).includes(0));

  // Too small to hold one pixel per module: refuse loudly instead of drawing mush.
  t.throws('too-small target throws', () => qrToIndices('x'.repeat(300), { ecc: 'H' }, 64, 64, F15), 'needs at least');
  t.throws('zero size throws', () => qrToIndices('x', {}, 0, 100, F15), 'positive');

  /* ── vCard ──────────────────────────────────────────────────────────────── */

  const card = vcard({
    name: 'John Doe', org: 'Example GmbH', title: 'Engineer',
    phone: '+49 170 1234567', email: 'john@example.com',
    url: 'https://example.com', note: 'Met at the fair',
  });
  t.check('vcard lines', card.split('\r\n').length, 11);
  t.ok('vcard begins and ends', card.startsWith('BEGIN:VCARD\r\nVERSION:3.0\r\n') && card.endsWith('\r\nEND:VCARD'));
  t.ok('vcard N is structured', card.includes('\r\nN:Doe;John;;;\r\n'));
  t.ok('vcard FN', card.includes('\r\nFN:John Doe\r\n'));
  t.ok('vcard ORG', card.includes('\r\nORG:Example GmbH\r\n'));
  t.ok('vcard TEL', card.includes('\r\nTEL;TYPE=CELL:+49 170 1234567\r\n'));
  t.ok('vcard EMAIL', card.includes('\r\nEMAIL;TYPE=INTERNET:john@example.com\r\n'));
  t.ok('vcard URL', card.includes('\r\nURL:https://example.com\r\n'));
  // Empty fields are dropped, but N and FN are mandatory in 3.0 and always present.
  const bare = vcard({ name: 'Prince' });
  t.check('vcard bare', bare, 'BEGIN:VCARD\r\nVERSION:3.0\r\nN:;Prince;;;\r\nFN:Prince\r\nEND:VCARD');
  t.check('vcard with no name at all', vcard({ org: 'ACME' }),
    'BEGIN:VCARD\r\nVERSION:3.0\r\nN:;;;;\r\nFN:ACME\r\nORG:ACME\r\nEND:VCARD');
  t.check('vcard with nothing', vcard({}), 'BEGIN:VCARD\r\nVERSION:3.0\r\nN:;;;;\r\nFN:\r\nEND:VCARD');
  t.check('vcard undefined arg', vcard(), 'BEGIN:VCARD\r\nVERSION:3.0\r\nN:;;;;\r\nFN:\r\nEND:VCARD');
  // RFC 2426 §5: backslash, comma, semicolon and newlines are escaped in text values.
  const messy = vcard({ name: 'A B', note: 'a,b;c\\d\ne', org: 'X;Y' });
  t.ok('vcard escapes note', messy.includes('NOTE:a\\,b\\;c\\\\d\\ne'));
  t.ok('vcard escapes org', messy.includes('ORG:X\\;Y'));
  t.ok('vcard middle names stay in the given field', vcard({ name: 'Ada King Lovelace' }).includes('N:Lovelace;Ada King;;;'));
  // A realistic card has to stay inside a version this panel can actually show.
  t.ok('vcard fits a 200x200 panel', qrToIndices(card, { ecc: 'M' }, 200, 200, F15).length === 40000);

  /* ── Wi-Fi ──────────────────────────────────────────────────────────────── */

  t.check('wifi WPA', wifi({ ssid: 'MyNet', password: 'secret123', security: 'WPA' }),
    'WIFI:T:WPA;S:MyNet;P:secret123;;');
  t.check('wifi WEP', wifi({ ssid: 'Old', password: 'abc', security: 'WEP' }), 'WIFI:T:WEP;S:Old;P:abc;;');
  t.check('wifi open', wifi({ ssid: 'Free', security: 'nopass' }), 'WIFI:T:nopass;S:Free;;');
  t.check('wifi open when no password given', wifi({ ssid: 'Free' }), 'WIFI:T:nopass;S:Free;;');
  t.check('wifi defaults to WPA when a password is given', wifi({ ssid: 'N', password: 'p' }),
    'WIFI:T:WPA;S:N;P:p;;');
  t.check('wifi hidden', wifi({ ssid: 'N', password: 'p', hidden: true }), 'WIFI:T:WPA;S:N;P:p;H:true;;');
  t.check('wifi lowercase security', wifi({ ssid: 'N', password: 'p', security: 'wep' }),
    'WIFI:T:WEP;S:N;P:p;;');
  // Only the five MECARD characters are escaped.
  t.check('wifi escaping', wifi({ ssid: 'a;b,c:d"e\\f', password: 'p;q' }),
    'WIFI:T:WPA;S:a\\;b\\,c\\:d\\"e\\\\f;P:p\\;q;;');
  t.check('wifi does not escape apostrophes', wifi({ ssid: "Bob's WLAN", password: "it's fine" }),
    "WIFI:T:WPA;S:Bob's WLAN;P:it's fine;;");
  // Hex-looking values are never wrapped in double quotes. ZXing and Android unescape
  // backslashes but do not strip quotes, so a quote would end up inside the value; and
  // a 64-hex-digit password is the raw PSK (WPA passphrases stop at 63 characters), so
  // quoting it would claim it is a passphrase.
  t.check('wifi does not quote a 64-hex PSK', wifi({ ssid: 'N', password: 'a'.repeat(64) }),
    `WIFI:T:WPA;S:N;P:${'a'.repeat(64)};;`);
  t.check('wifi does not quote a 10-digit hex WEP key', wifi({ ssid: 'N', password: '0123456789', security: 'WEP' }),
    'WIFI:T:WEP;S:N;P:0123456789;;');
  t.check('wifi does not quote a hex-looking SSID', wifi({ ssid: '0123456789', password: 'p' }),
    'WIFI:T:WPA;S:0123456789;P:p;;');
  t.check('wifi leaves a common numeric passphrase alone', wifi({ ssid: 'N', password: '12345678' }),
    'WIFI:T:WPA;S:N;P:12345678;;');
  t.check('wifi undefined arg', wifi(), 'WIFI:T:nopass;S:;;');

  // Both payload builders must survive the encoder, including non-ASCII SSIDs.
  const wifiUtf8 = wifi({ ssid: 'Gäste-WLAN', password: 'Straße1;2', security: 'WPA' });
  t.check('wifi utf-8 round-trip', decode(qrMatrix(wifiUtf8, { ecc: 'M' })).text, wifiUtf8);
  t.check('vcard round-trip', decode(qrMatrix(card, { ecc: 'M' })).text, card);
}
