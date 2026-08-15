/**
 * Small shared helpers. No DOM access at import time.
 */

/** @param {ArrayLike<number>} bytes */
export function hex(bytes, sep = ' ') {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0').toUpperCase()).join(sep);
}

/**
 * Parse a loose hex string: spaces, commas, newlines and 0x prefixes are all ignored.
 * @returns {Uint8Array}
 */
export function parseHex(str) {
  const clean = String(str).replace(/0x/gi, '').replace(/[^0-9a-fA-F]/g, '');
  if (clean.length % 2) throw new Error('hex string has an odd number of digits');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

/** Printable-ASCII rendering for hex dumps; non-printable bytes become dots. */
export function ascii(bytes) {
  return Array.from(bytes, (b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('');
}

/**
 * readValue() and characteristic notifications hand back a DataView, which is not
 * guaranteed to start at offset 0 of its backing buffer. Respect the offset and
 * length instead of grabbing the whole ArrayBuffer.
 *
 * Returns an empty array for null/undefined: this runs inside event handlers where
 * a throw would be swallowed and the failure would be invisible.
 */
export function dvBytes(dv) {
  if (!dv || typeof dv.byteLength !== 'number') return new Uint8Array(0);
  return new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function clamp(n, lo, hi) {
  return n < lo ? lo : n > hi ? hi : n;
}

/** Escape for interpolation into innerHTML. */
export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/**
 * Short unique id. crypto.randomUUID is not available on every browser we target
 * (and not in older WebViews), so fall back to getRandomValues.
 */
export function uid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const b = new Uint8Array(16);
  globalThis.crypto.getRandomValues(b);
  return hex(b, '').toLowerCase();
}

/** "1.4 MB" etc. for storage figures. */
export function humanBytes(n) {
  if (n == null) return '—';
  const units = ['B', 'kB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

/** "4 min 20 s" for cycle estimates and countdowns. */
export function humanDuration(seconds) {
  seconds = Math.max(0, Math.round(seconds));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h) return `${h} h ${m} min`;
  if (m) return s ? `${m} min ${s} s` : `${m} min`;
  return `${s} s`;
}

/** Classic offset + hex + ascii dump, 16 bytes per line. */
export function hexdump(bytes) {
  const lines = [];
  for (let i = 0; i < bytes.length; i += 16) {
    const slice = bytes.subarray(i, i + 16);
    lines.push(
      `${i.toString(16).padStart(4, '0')}  ${hex(slice).padEnd(47)}  |${ascii(slice)}|`
    );
  }
  return lines.join('\n');
}
