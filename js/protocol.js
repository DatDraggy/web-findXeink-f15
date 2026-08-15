/**
 * FindXeink BLE wire protocol.
 *
 * Recovered by decompiling the vendor Android app (com.findn.findxeink) with jadx,
 * then verified against real hardware: a FindXeink F15 accepted a full image and
 * answered `F1 status 0 = success`, and this module's CRC validates the device's
 * own reply frames.
 *
 *   service  0xFFF0
 *   write    0xFFF3   write-without-response
 *   notify   0xFFF4
 *   (0xFFF5 "Verify" also exists — never write to it, see README)
 *
 *   frame:   BC op seqHi seqLo R0 R1 N payload[N] crcHi crcLo AA
 *
 * Everything here is pure: no DOM, no BLE. device.js owns the transport.
 */

export const SVC_FFF0 = '0000fff0-0000-1000-8000-00805f9b34fb';
export const CHR_FFF3 = '0000fff3-0000-1000-8000-00805f9b34fb';
export const CHR_FFF4 = '0000fff4-0000-1000-8000-00805f9b34fb';
export const CHR_FFF5 = '0000fff5-0000-1000-8000-00805f9b34fb';

/** The 16-bit service UUID the device advertises (and the vendor app filters on). */
export const FX_SCAN_UUID = '00001644-0000-1000-8000-00805f9b34fb';

/** Manufacturer company id carrying the panel geometry. 6726 = 0x1A46. */
export const FX_COMPANY_ID = 0x1a46;

export const TX_MAGIC = 0xbc;
export const RX_MAGIC = 0xcc;

/**
 * The trailer differs by direction — the phone sends 0xAA, the device answers
 * 0x55 (the bit-complement). Confirmed on hardware; the vendor app never checks it.
 */
export const TX_TRAILER = 0xaa;
export const RX_TRAILER = 0x55;

/** Sentinel sequence number: used for headers AND for the final data chunk. */
export const SEQ_MARK = 0xffff;

export const OP = { A1: 0xa1, A2: 0xa2, C1: 0xc1, C2: 0xc2, F1: 0xf1 };

export const OP_NAME = {
  0xa1: 'A1 start-picture',
  0xa2: 'A2 picture-data',
  0xc1: 'C1 start-card',
  0xc2: 'C2 card-data',
  0xf1: 'F1 status',
};

/** Status codes carried in the first payload byte of an F1 frame. */
export const STATUS = {
  0: 'success',
  2: 'aborted / error',
  5: 'low battery',
  6: 'busy (refreshing)',
};

/** The two command families. 'picture' is the photo path; 'card' is the QR/contact path. */
export const FAMILY = {
  picture: { start: OP.A1, data: OP.A2, label: 'Picture (A1/A2)' },
  card: { start: OP.C1, data: OP.C2, label: 'Card (C1/C2)' },
};

/**
 * CRC-16/CCITT-FALSE — poly 0x1021, init 0xFFFF, no reflection, no final XOR.
 * Check value for "123456789" is 0x29B1.
 *
 * The firmware implements this in an obfuscated byte-swapping form; this plain
 * version was proven equivalent across 500 random vectors and validates every
 * reply frame captured from a real device.
 *
 * @param {Uint8Array} bytes
 * @param {number} [len] number of leading bytes to cover (defaults to all)
 */
export function crc16(bytes, len) {
  let crc = 0xffff;
  const n = len === undefined ? bytes.length : len;
  for (let i = 0; i < n; i++) {
    crc ^= bytes[i] << 8;
    for (let j = 0; j < 8; j++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc & 0xffff;
}

/**
 * Build one outbound frame.
 *
 * The vendor app picks R0/R1 at random and XOR-obfuscates the payload whenever R0
 * is even. That is decoration, not security: an odd R0 disables it, the firmware's
 * decoder is symmetric, and the device accepts both. We default to plaintext
 * because it is vastly easier to read in a log — and because the CRC is computed
 * *after* the XOR, plaintext also makes a captured frame reproducible by hand.
 *
 * @param {number} op
 * @param {number} seq big-endian uint16; SEQ_MARK for headers and the last chunk
 * @param {ArrayLike<number>} payload  max 255 bytes
 * @param {{obfuscate?: boolean, r1?: number, r0?: number|null}} [opts]
 * @returns {Uint8Array}
 */
export function buildFrame(op, seq, payload, opts = {}) {
  const { obfuscate = false, r1 = 0x5a, r0 = null } = opts;
  const p = payload instanceof Uint8Array ? payload : Uint8Array.from(payload || []);
  if (p.length > 255) throw new Error(`payload is ${p.length} bytes, max 255`);

  const f = new Uint8Array(p.length + 10);
  f[0] = TX_MAGIC;
  f[1] = op & 0xff;
  f[2] = (seq >> 8) & 0xff;
  f[3] = seq & 0xff;
  // R0's parity alone decides whether the payload is XORed — that is what the
  // firmware tests — so derive the behaviour from R0, not from the flag.
  f[4] = r0 !== null ? r0 & 0xff : obfuscate ? 0x00 : 0x01;
  f[5] = r1 & 0xff;
  f[6] = p.length;
  f.set(p, 7);
  if ((f[4] & 1) === 0) {
    for (let i = 7; i < 7 + p.length; i++) f[i] ^= f[5];
  }
  f[f.length - 1] = TX_TRAILER;

  // The vendor app skips the CRC entirely on frames shorter than 11 bytes, i.e.
  // an empty payload. Match it exactly rather than being "more correct".
  if (f.length >= 11) {
    const c = crc16(f, f.length - 3);
    f[f.length - 3] = (c >> 8) & 0xff;
    f[f.length - 2] = c & 0xff;
  }
  return f;
}

/**
 * Parse an inbound frame. Returns null if it does not look like one, so callers
 * can safely feed it anything a characteristic emits.
 *
 * @param {Uint8Array} b
 */
export function parseFrame(b) {
  if (!b || b.length < 8 || b[0] !== RX_MAGIC) return null;

  const n = b[6];
  // Guard against a truncated notification claiming a longer payload than arrived.
  const avail = Math.max(0, Math.min(n, b.length - 10));
  const payload = b.slice(7, 7 + avail);
  if (b[4] % 2 === 0) {
    for (let i = 0; i < payload.length; i++) payload[i] ^= b[5];
  }

  const out = {
    dir: 'device',
    op: b[1],
    opName: OP_NAME[b[1]] || `0x${b[1].toString(16).toUpperCase()}`,
    seq: (b[2] << 8) | b[3],
    obfuscated: b[4] % 2 === 0,
    len: n,
    truncated: avail !== n,
    payload: Array.from(payload),
    trailer: b[b.length - 1],
    trailerOk: b[b.length - 1] === RX_TRAILER,
  };

  if (b[1] === OP.F1 && payload.length) {
    out.status = payload[0];
    out.statusName = STATUS[payload[0]] ?? `unknown (${payload[0]})`;
    out.ok = payload[0] === 0;
  }

  if (b.length >= 11) {
    out.crcOk = crc16(b, b.length - 3) === ((b[b.length - 3] << 8) | b[b.length - 2]);
  }
  return out;
}

/** True for the READY reply that follows a start frame. */
export function isReady(frame) {
  return !!frame && (frame.op === OP.A1 || frame.op === OP.C1);
}

/** True for a terminal status frame. */
export function isStatus(frame) {
  return !!frame && frame.op === OP.F1;
}

/**
 * Payload of a start frame: the chunk size the sender will use, then the total
 * image length as a big-endian uint32.
 *
 * @param {number} chunkSize
 * @param {number} totalLen
 */
export function startPayload(chunkSize, totalLen) {
  return Uint8Array.from([
    chunkSize & 0xff,
    (totalLen >>> 24) & 0xff,
    (totalLen >>> 16) & 0xff,
    (totalLen >>> 8) & 0xff,
    totalLen & 0xff,
  ]);
}

/**
 * Split a packed image into chunks. The final chunk may be short; its real length
 * travels in the frame's N byte.
 *
 * @param {Uint8Array} bytes
 * @param {number} size
 * @returns {Uint8Array[]}
 */
export function chunkData(bytes, size) {
  if (size < 1) throw new Error('chunk size must be at least 1');
  const out = [];
  for (let i = 0; i < bytes.length; i += size) {
    out.push(bytes.subarray(i, Math.min(bytes.length, i + size)));
  }
  return out;
}

/**
 * Build every frame of a transfer, in order. Exposed separately from the sender so
 * it can be inspected, unit-tested and dry-run without a device.
 *
 * The last chunk carries SEQ_MARK instead of its index — that is how the firmware
 * knows the image is complete, and getting it wrong means the panel never refreshes.
 *
 * @param {Uint8Array} packed
 * @param {{family?: 'picture'|'card', chunkSize?: number, obfuscate?: boolean}} [opts]
 */
export function buildTransfer(packed, opts = {}) {
  const { family = 'picture', chunkSize = 200, obfuscate = false } = opts;
  const ops = FAMILY[family];
  if (!ops) throw new Error(`unknown command family: ${family}`);

  const chunks = chunkData(packed, chunkSize);
  const start = buildFrame(ops.start, SEQ_MARK, startPayload(chunkSize, packed.length), { obfuscate });
  const data = chunks.map((c, i) =>
    buildFrame(ops.data, i === chunks.length - 1 ? SEQ_MARK : i + 1, c, { obfuscate })
  );
  return { start, data, chunkCount: chunks.length, totalBytes: packed.length };
}

/**
 * Decode the manufacturer record advertised under company id 0x1A46.
 *
 * This is the ONLY place the panel geometry is published — it is not in the app,
 * not in a GATT characteristic, and not on the box. Offsets are relative to the
 * payload *after* the two company-id bytes, which is what both Android and Web
 * Bluetooth hand us.
 *
 * Bytes 0..6 are not read by the vendor app; they are most likely a marker plus
 * the 6-byte BD_ADDR (iOS hides the MAC from apps, Android does not), so they are
 * returned raw rather than guessed at.
 *
 * @param {Uint8Array} bytes
 */
export function decodeManufacturer(bytes) {
  if (!bytes || bytes.length <= 10) return null;
  const out = {
    type: bytes[7],
    unknownPrefix: Array.from(bytes.slice(0, 7)),
    raw: Array.from(bytes),
  };
  if (bytes.length > 11) {
    out.width = (bytes[8] << 8) | bytes[9];
    out.height = (bytes[10] << 8) | bytes[11];
  } else {
    // Short record: the vendor app falls back to a fixed 200x200 here.
    out.width = 200;
    out.height = 200;
    out.legacy = true;
  }
  out.bpp = out.type >= 1 ? 2 : 1;
  return out;
}

/**
 * Pixel scan order is chosen by "model", which the vendor app derives from the
 * advertised device name. Only the F20 differs.
 */
export const MODELS = {
  'Air Wallet Pro': 1,
  'FindXeink Wallet': 2,
  'FindXeink F15': 3,
  'FindXeink F20': 4,
};

/** @returns {3|4|number} the model number for a device name, defaulting to row-major. */
export function modelForName(name) {
  return MODELS[name] ?? 3;
}
