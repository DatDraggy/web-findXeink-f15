/**
 * Protocol tests.
 *
 * Two kinds of fixture here, and the second kind is the valuable one:
 *
 *   - Frames produced by the vendor app's own builder, recovered from its
 *     bytecode. These prove we speak the same dialect it does.
 *   - Reply frames captured off a real FindXeink F15 during a successful image
 *     transfer. These prove the device agrees. Our CRC has to validate its CRCs,
 *     which is a much stronger claim than our encoder matching our decoder.
 */

import {
  crc16, buildFrame, parseFrame, startPayload, chunkData, buildTransfer,
  decodeManufacturer, modelForName, isReady, isStatus,
  OP, SEQ_MARK, TX_TRAILER, RX_TRAILER,
} from '../js/protocol.js';
import { hex, parseHex } from '../js/util.js';

export default function run(t) {
  // ── CRC ────────────────────────────────────────────────────────────────
  t.check('CRC-16/CCITT-FALSE check value',
    '0x' + crc16(new TextEncoder().encode('123456789'), 9).toString(16).toUpperCase(), '0x29B1');

  // The firmware implements the same CRC in an obfuscated byte-swapping form.
  // Re-implement that literally from the decompiled bytecode and prove equivalence.
  const appCrc = (bytes, len) => {
    let crc = 0xffff;
    for (let i = 0; i < len; i++) {
      const a = (((crc << 8) | (crc >>> 8)) & 0xffff) ^ (bytes[i] & 0xff);
      const b = a ^ ((a & 0xff) >> 4);
      const c = (b ^ ((b << 12) & 0xffff)) & 0xffff;
      crc = (c ^ (((c & 0xff) << 5) & 0xffff)) & 0xffff;
    }
    return crc & 0xffff;
  };
  let mismatches = 0;
  for (let n = 1; n <= 300; n++) {
    const buf = new Uint8Array(n);
    for (let i = 0; i < n; i++) buf[i] = (n * 31 + i * 17 + (i & 7)) & 0xff;
    if (crc16(buf, n) !== appCrc(buf, n)) mismatches++;
  }
  t.check('matches the firmware CRC over 300 vectors', mismatches, 0);

  // ── frames the vendor app builds ───────────────────────────────────────
  t.check('start A1, obfuscated (R0=00 R1=5A)',
    hex(buildFrame(OP.A1, SEQ_MARK, [0xc8, 0, 0, 0x75, 0x30], { obfuscate: true, r1: 0x5a, r0: 0x00 })),
    'BC A1 FF FF 00 5A 05 92 5A 5A 2F 6A 1C 0E AA');
  t.check('start A1, plaintext (R0=01 R1=5A)',
    hex(buildFrame(OP.A1, SEQ_MARK, [0xc8, 0, 0, 0x75, 0x30], { r1: 0x5a, r0: 0x01 })),
    'BC A1 FF FF 01 5A 05 C8 00 00 75 30 96 15 AA');
  t.check('data A2 seq=1, obfuscated (R0=02 R1=F0)',
    hex(buildFrame(OP.A2, 1, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], { obfuscate: true, r1: 0xf0, r0: 0x02 })),
    'BC A2 00 01 02 F0 0A F0 F1 F2 F3 F4 F5 F6 F7 F8 F9 42 62 AA');

  // ── invariants ─────────────────────────────────────────────────────────
  const f = buildFrame(OP.A2, 0x1234, new Uint8Array(200));
  t.check('frame length is payload + 10', f.length, 210);
  t.check('magic + opcode', hex(f.subarray(0, 2)), 'BC A2');
  t.check('seq is big-endian', hex(f.subarray(2, 4)), '12 34');
  t.check('length byte', f[6], 200);
  t.check('outbound trailer', f[f.length - 1], TX_TRAILER);
  t.check('CRC covers everything but the last three bytes',
    (f[f.length - 3] << 8) | f[f.length - 2], crc16(f, f.length - 3));
  t.check('plaintext default leaves R0 odd', f[4] & 1, 1);
  t.throws('rejects an oversized payload', () => buildFrame(OP.A2, 1, new Uint8Array(256)), 'max 255');

  // ── real device replies ────────────────────────────────────────────────
  const CAPTURED = [
    ['CC A1 FF FF 41 0C 05 C8 00 00 00 00 6E 38 55', 'A1 start-picture', [0xc8, 0, 0, 0, 0], false, null],
    ['CC A1 FF FF 9E 69 05 A1 69 69 69 69 19 60 55', 'A1 start-picture', [0xc8, 0, 0, 0, 0], true, null],
    ['CC C1 FF FF 7A 45 05 8D 45 45 45 45 1A 27 55', 'C1 start-card', [0xc8, 0, 0, 0, 0], true, null],
    ['CC C1 FF FF F5 BF 05 C8 00 00 00 00 1E 51 55', 'C1 start-card', [0xc8, 0, 0, 0, 0], false, null],
    ['CC A1 FF FF 16 E1 05 29 E1 E1 C6 F1 27 63 55', 'A1 start-picture', [0xc8, 0, 0, 0x27, 0x10], true, null],
    ['CC F1 FF FF F0 BA 01 BA 21 E2 55', 'F1 status', [0], true, 'success'],
    ['CC A1 FF FF 1B 0D 05 C8 00 00 27 10 01 01 55', 'A1 start-picture', [0xc8, 0, 0, 0x27, 0x10], false, null],
    ['CC F1 FF FF B1 A3 01 00 E2 A9 55', 'F1 status', [0], false, 'success'],
  ];
  CAPTURED.forEach(([bytes, opName, payload, obf, status], i) => {
    const p = parseFrame(parseHex(bytes));
    t.check(`captured #${i} opcode`, p && p.opName, opName);
    t.check(`captured #${i} payload de-obfuscated`, p.payload, payload);
    t.check(`captured #${i} obfuscation flag`, p.obfuscated, obf);
    t.check(`captured #${i} device CRC validates`, p.crcOk, true);
    t.check(`captured #${i} trailer is 0x55`, p.trailer, RX_TRAILER);
    if (status) t.check(`captured #${i} status`, p.statusName, status);
  });

  t.ok('READY is recognised', isReady(parseFrame(parseHex(CAPTURED[0][0]))));
  t.ok('status is recognised', isStatus(parseFrame(parseHex(CAPTURED[5][0]))));
  t.check('READY echoes chunk size and total length',
    parseFrame(parseHex('CC A1 FF FF 16 E1 05 29 E1 E1 C6 F1 27 63 55')).payload,
    [0xc8, 0, 0, 0x27, 0x10]);

  // ── robustness ─────────────────────────────────────────────────────────
  t.check('a phone-direction frame is not parsed as a reply', parseFrame(buildFrame(OP.A1, 1, [1])), 'null');
  t.check('empty input', parseFrame(new Uint8Array(0)), 'null');
  t.check('null input', parseFrame(null), 'null');
  t.check('a truncated notification is flagged, not thrown',
    parseFrame(parseHex('CC F1 FF FF 01 00 20 01 02')).truncated, true);
  t.check('wrong trailer is reported',
    parseFrame(parseHex('CC F1 FF FF B1 A3 01 00 E2 A9 AA')).trailerOk, false);

  // ── transfer assembly ──────────────────────────────────────────────────
  t.check('start payload for a 10000-byte image at 200-byte chunks',
    hex(startPayload(200, 10000)), 'C8 00 00 27 10');
  const packed = new Uint8Array(10000).fill(0xaa);
  const tr = buildTransfer(packed, { chunkSize: 200 });
  t.check('chunk count', tr.chunkCount, 50);
  t.check('first chunk seq is 1', hex(tr.data[0].subarray(2, 4)), '00 01');
  t.check('last chunk seq is the sentinel', hex(tr.data[49].subarray(2, 4)), 'FF FF');
  t.check('the exact start frame this hardware accepted',
    hex(buildFrame(OP.A1, SEQ_MARK, startPayload(200, 10000), { r0: 0x01, r1: 0x5a })),
    'BC A1 FF FF 01 5A 05 C8 00 00 27 10 DA AA AA');

  // The second screen — the one the firmware swaps to on a double-press of the
  // device button — is written with C1/C2 instead of A1/A2. Same transfer shape.
  const card = buildTransfer(packed, { family: 'card', chunkSize: 200 });
  t.check('card transfer starts with C1', card.start[1], 0xc1);
  t.check('card chunks use C2', card.data[0][1], 0xc2);
  t.check('card chunk count matches the picture path', card.chunkCount, tr.chunkCount);
  t.check('card start payload is identical',
    hex(card.start.subarray(7, 12)), hex(tr.start.subarray(7, 12)));
  t.check('picture transfer still starts with A1', tr.start[1], 0xa1);
  t.throws('an unknown family is rejected',
    () => buildTransfer(packed, { family: 'nonsense' }), 'unknown command family');

  // A ragged tail must carry its true length in N, not the nominal chunk size.
  const ragged = buildTransfer(new Uint8Array(10001), { chunkSize: 200 });
  t.check('ragged chunk count', ragged.chunkCount, 51);
  t.check('ragged final chunk length byte', ragged.data[50][6], 1);
  t.check('chunkData reassembles losslessly',
    hex(new Uint8Array(chunkData(packed, 199).flatMap((c) => Array.from(c))).subarray(0, 8)),
    hex(packed.subarray(0, 8)));
  t.throws('chunk size must be positive', () => chunkData(packed, 0), 'at least 1');

  // ── advertisement ──────────────────────────────────────────────────────
  const real = decodeManufacturer(parseHex('FF 25 06 05 00 42 65 01 00 C8 00 C8'));
  t.check('advertised type', real.type, 1);
  t.check('advertised width', real.width, 200);
  t.check('advertised height', real.height, 200);
  t.check('type >= 1 means 2 bpp', real.bpp, 2);
  t.check('undecoded prefix is preserved', real.unknownPrefix.length, 7);
  t.check('too-short record', decodeManufacturer(new Uint8Array(8)), 'null');
  const legacy = decodeManufacturer(new Uint8Array(11));
  t.check('11-byte record falls back to 200x200', `${legacy.width}x${legacy.height}`, '200x200');
  t.check('legacy type 0 means 1 bpp', legacy.bpp, 1);

  // ── models ─────────────────────────────────────────────────────────────
  t.check('F15 is row-major', modelForName('FindXeink F15'), 3);
  t.check('F20 is the column-major exception', modelForName('FindXeink F20'), 4);
  t.check('unknown names default to row-major', modelForName('Something Else'), 3);
}
