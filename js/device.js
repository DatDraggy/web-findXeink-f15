/**
 * Web Bluetooth transport for FindXeink displays.
 *
 * Owns the whole connection lifecycle: chooser, GATT discovery, notification
 * subscription, transfers, disconnect and reconnect.
 *
 * Three failure modes found by auditing an earlier version are designed out here
 * rather than patched, because each produced a silent, confusing failure:
 *
 *   1. Notifications were handled from every subscribed characteristic at once. The
 *      F15 also exposes 0xFFF5 "Verify" as notifiable, so a stray frame from it
 *      could release the wait-for-READY latch and dump 50 chunks at a deaf
 *      firmware while the UI cheerfully said "Device ready". We now bind to
 *      exactly one RX characteristic and re-check the source on every event.
 *   2. GATT handles were kept across a disconnect. Chrome invalidates them, so the
 *      next write threw InvalidStateError. Everything is re-acquired on connect
 *      and nulled on disconnect.
 *   3. watchAdvertisements() was called unconditionally and rejects with
 *      InvalidStateError the second time. It is guarded — and it matters, because
 *      on Android it is the only route to the panel geometry.
 */

import {
  SVC_FFF0, CHR_FFF3, CHR_FFF4, FX_COMPANY_ID, FX_SCAN_UUID,
  buildFrame, parseFrame, buildTransfer, decodeManufacturer, modelForName,
  isReady, isStatus, OP, SEQ_MARK, startPayload,
} from './protocol.js';
import { dvBytes, hex, sleep } from './util.js';

/** Frame overhead is 10 bytes, so a 200-byte chunk is a 210-byte write. */
export const DEFAULT_CHUNK = 200;

/**
 * The vendor app drops to 10-byte chunks whenever it fails to get its requested
 * 247-byte MTU. Web Bluetooth gives no way to read the negotiated MTU, and an
 * oversized write-without-response is truncated *silently* — so this is the
 * automatic fallback when a transfer gets no acknowledgement.
 */
export const FALLBACK_CHUNK = 10;

const READY_TIMEOUT_MS = 6000;
const STATUS_TIMEOUT_MS = 20000;

export class Device extends EventTarget {
  constructor() {
    super();
    this.device = null;
    this.server = null;
    this.rxChar = null;
    this.txChar = null;
    this.panel = null;      // { width, height, type, bpp, model, source }
    this.chunkSize = DEFAULT_CHUNK;
    this.obfuscate = false;
    this.lastFrame = null;
    this.busy = false;

    this._waiters = new Set();
    this._onDisconnect = this._onDisconnect.bind(this);
    this._onNotify = this._onNotify.bind(this);
    this._onAdvertisement = this._onAdvertisement.bind(this);
  }

  get connected() {
    return !!(this.server && this.server.connected && this.txChar);
  }

  get name() {
    return this.device?.name || null;
  }

  _log(level, msg, extra) {
    this.dispatchEvent(new CustomEvent('log', { detail: { level, msg, extra } }));
  }

  _emitState() {
    this.dispatchEvent(new CustomEvent('state', { detail: { connected: this.connected } }));
  }

  // ─────────────────────────────────────────────────────────── discovery

  /**
   * Open the browser's device chooser.
   *
   * Filtering on the manufacturer company id is ordinary Web Bluetooth — no flags
   * — and narrows the list to FindXeink hardware. Note the filter must match
   * *advertised* data: the device advertises 0x1644 and company 0x1A46 but serves
   * 0xFFF0, so filtering on 0xFFF0 would never match anything.
   *
   * @param {{all?: boolean, namePrefix?: string}} [opts]
   */
  async request(opts = {}) {
    if (!navigator.bluetooth) throw new Error('This browser has no Web Bluetooth.');

    const base = {
      optionalServices: [SVC_FFF0],
      // Lets watchAdvertisements() surface the geometry record after selection.
      optionalManufacturerData: [FX_COMPANY_ID],
    };
    let options;
    if (opts.all) {
      options = { ...base, acceptAllDevices: true };
    } else if (opts.namePrefix) {
      options = { ...base, filters: [{ namePrefix: opts.namePrefix }] };
    } else {
      options = {
        ...base,
        filters: [
          { manufacturerData: [{ companyIdentifier: FX_COMPANY_ID }] },
          { services: [FX_SCAN_UUID] },
        ],
      };
    }

    let dev;
    try {
      dev = await navigator.bluetooth.requestDevice(options);
    } catch (e) {
      if (e?.name === 'TypeError' && !opts.all) {
        // Older Chrome builds reject the manufacturerData filter outright.
        this._log('warn', 'This browser rejected the manufacturer filter — showing all devices.');
        return this.request({ all: true });
      }
      throw e;
    }

    this.attach(dev);
    return dev;
  }

  /** Adopt a device object (from the chooser, or from getDevices()). */
  attach(dev) {
    if (this.device === dev) return;
    if (this.device) this.device.removeEventListener('gattserverdisconnected', this._onDisconnect);

    this.device = dev;
    dev.addEventListener('gattserverdisconnected', this._onDisconnect);
    this.panel = null;
    this._log('ok', `Selected "${dev.name || '(unnamed)'}"`);
    this._watchAdvertisements();
    this._emitState();
  }

  /**
   * Advertisement data is the only source of the panel size. On Android this is
   * also the only route that works at all — requestLEScan() throws
   * "Bluetooth adapter not available" until requestDevice() has bootstrapped the
   * permission, and even then it is unreliable.
   */
  async _watchAdvertisements() {
    const dev = this.device;
    if (!dev || typeof dev.watchAdvertisements !== 'function') return;
    // Calling it twice rejects with InvalidStateError.
    if (dev.watchingAdvertisements) return;
    try {
      dev.addEventListener('advertisementreceived', this._onAdvertisement);
      await dev.watchAdvertisements();
      this._log('info', 'Listening for advertisements (reads the panel size)');
    } catch (e) {
      this._log('warn', `Could not watch advertisements: ${e.message}`);
    }
  }

  _onAdvertisement(ev) {
    let record = null;
    ev.manufacturerData?.forEach((v, k) => {
      if (Number(k) === FX_COMPANY_ID) record = decodeManufacturer(dvBytes(v));
    });
    this.dispatchEvent(new CustomEvent('advertisement', {
      detail: {
        rssi: ev.rssi,
        txPower: ev.txPower,
        uuids: Array.from(ev.uuids || []),
        record,
      },
    }));
    if (record && record.width && record.height) this.setPanel(record, 'advertisement');
  }

  /**
   * Adopt panel geometry. Getting this wrong ruins every picture, and the device
   * broadcasts the answer, so an advertisement always wins over a stale manual value.
   */
  setPanel(record, source = 'manual') {
    const model = modelForName(this.name);
    const next = {
      width: record.width,
      height: record.height,
      type: record.type ?? 1,
      bpp: record.bpp ?? (record.type >= 1 ? 2 : 1),
      model,
      source,
    };
    const same = this.panel
      && this.panel.width === next.width
      && this.panel.height === next.height
      && this.panel.bpp === next.bpp;
    this.panel = next;
    if (!same) {
      this._log('ok', `Panel: ${next.width}×${next.height}, type ${next.type} → ${next.bpp} bpp (${source})`);
      this.dispatchEvent(new CustomEvent('panel', { detail: next }));
    }
  }

  // ─────────────────────────────────────────────────────────── connection

  async connect() {
    if (!this.device) throw new Error('No device selected.');
    if (this.connected) return;

    this.server = await this.device.gatt.connect();

    const service = await this.server.getPrimaryService(SVC_FFF0);
    this.txChar = await service.getCharacteristic(CHR_FFF3);

    // FFF4 is the notify channel. The vendor app falls back to FFF3 if it is
    // absent, so mirror that rather than failing outright.
    try {
      this.rxChar = await service.getCharacteristic(CHR_FFF4);
    } catch {
      this.rxChar = this.txChar;
      this._log('warn', 'No 0xFFF4 — listening on 0xFFF3 instead.');
    }

    await this.rxChar.startNotifications();
    this.rxChar.addEventListener('characteristicvaluechanged', this._onNotify);

    this._log('ok', `Connected — TX 0xFFF3, RX 0x${this.rxChar.uuid.slice(4, 8).toUpperCase()}`);
    this._emitState();
  }

  _onDisconnect() {
    // Chrome invalidates every handle on disconnect; keeping them would make the
    // next write throw InvalidStateError from somewhere far away.
    this.server = null;
    this.txChar = null;
    this.rxChar = null;
    this.busy = false;
    for (const w of this._waiters) w.reject(new Error('Device disconnected'));
    this._waiters.clear();
    this._log('warn', 'Device disconnected');
    this._emitState();
  }

  async disconnect() {
    try {
      if (this.server?.connected) this.server.disconnect();
    } catch { /* already gone */ }
  }

  /** Reconnect with backoff. Used by the automation runner between steps. */
  async ensureConnected({ attempts = 3 } = {}) {
    if (this.connected) return true;
    for (let i = 0; i < attempts; i++) {
      try {
        await this.connect();
        return true;
      } catch (e) {
        this._log('warn', `Reconnect attempt ${i + 1}/${attempts} failed: ${e.message}`);
        // The peripheral needs a moment after a refresh before it accepts a link.
        await sleep(1200 * (i + 1));
      }
    }
    return false;
  }

  // ─────────────────────────────────────────────────────────── frames

  _onNotify(ev) {
    // Only ever trust the characteristic we designated as RX.
    if (!this.rxChar || ev.target !== this.rxChar) return;

    const bytes = dvBytes(ev.target.value);
    if (!bytes.length) return;

    const frame = parseFrame(bytes);
    this.lastFrame = frame;
    this.dispatchEvent(new CustomEvent('frame', { detail: { bytes, frame } }));

    if (frame) {
      this._log('rx', `${frame.opName}${frame.statusName ? ` — ${frame.statusName}` : ''}`
        + (frame.crcOk === false ? ' [CRC BAD]' : ''), hex(bytes));
      for (const w of Array.from(this._waiters)) {
        if (w.match(frame)) {
          this._waiters.delete(w);
          w.resolve(frame);
        }
      }
    } else {
      this._log('rx', `${bytes.length} bytes (not a device frame)`, hex(bytes));
    }
  }

  /** Resolve when a frame matching `match` arrives, or reject on timeout. */
  waitForFrame(match, timeoutMs) {
    return new Promise((resolve, reject) => {
      const w = { match, resolve, reject };
      this._waiters.add(w);
      setTimeout(() => {
        if (this._waiters.delete(w)) reject(new Error(`timed out after ${timeoutMs} ms`));
      }, timeoutMs);
    });
  }

  async writeFrame(bytes) {
    if (!this.txChar) throw new Error('Not connected.');
    // The vendor app uses WRITE_TYPE_NO_RESPONSE; it is also far faster.
    if (this.txChar.writeValueWithoutResponse) {
      await this.txChar.writeValueWithoutResponse(bytes);
    } else {
      await this.txChar.writeValue(bytes);
    }
  }

  // ─────────────────────────────────────────────────────────── transfer

  /**
   * Send a packed image and wait for the device to confirm it.
   *
   * @param {Uint8Array} packed
   * @param {{family?: string, chunkSize?: number, obfuscate?: boolean,
   *          onProgress?: (done:number,total:number)=>void, signal?: AbortSignal,
   *          allowFallback?: boolean}} [opts]
   * @returns {Promise<{ok: boolean, status?: number, statusName?: string, ms: number, chunkSize: number}>}
   */
  async send(packed, opts = {}) {
    const {
      family = 'picture',
      obfuscate = this.obfuscate,
      onProgress,
      signal,
      allowFallback = true,
    } = opts;
    let chunkSize = opts.chunkSize ?? this.chunkSize;

    if (this.busy) throw new Error('A transfer is already running.');
    if (!this.connected) throw new Error('Not connected.');

    this.busy = true;
    const started = Date.now();
    try {
      let result = await this._sendOnce(packed, { family, chunkSize, obfuscate, onProgress, signal });

      // A silently truncated write leaves the firmware with a bad CRC and it
      // simply ignores us — indistinguishable from a dead link. Retrying small is
      // the only recovery available, since Chrome will not tell us the MTU.
      if (!result.ok && allowFallback && chunkSize > FALLBACK_CHUNK && !signal?.aborted) {
        this._log('warn',
          `No acknowledgement at ${chunkSize}-byte chunks — retrying at ${FALLBACK_CHUNK}.`,
          'This is what the vendor app does when it cannot get a 247-byte MTU.');
        chunkSize = FALLBACK_CHUNK;
        result = await this._sendOnce(packed, { family, chunkSize, obfuscate, onProgress, signal });
        if (result.ok) this.chunkSize = FALLBACK_CHUNK;
      }
      return { ...result, ms: Date.now() - started, chunkSize };
    } finally {
      this.busy = false;
    }
  }

  async _sendOnce(packed, { family, chunkSize, obfuscate, onProgress, signal }) {
    const { start, data, chunkCount } = buildTransfer(packed, { family, chunkSize, obfuscate });

    // Arm the latch before writing: on a fast link the reply can beat our await.
    const ready = this.waitForFrame(isReady, READY_TIMEOUT_MS);
    await this.writeFrame(start);
    try {
      await ready;
    } catch {
      this._log('warn', 'Device did not answer the start frame.');
      return { ok: false, reason: 'no-ready' };
    }

    const status = this.waitForFrame(isStatus, STATUS_TIMEOUT_MS);
    for (let i = 0; i < data.length; i++) {
      if (signal?.aborted) throw new Error('Cancelled');
      await this.writeFrame(data[i]);
      onProgress?.(i + 1, chunkCount);
    }

    try {
      const f = await status;
      return { ok: f.ok === true, status: f.status, statusName: f.statusName };
    } catch {
      this._log('warn', 'No status frame — the image may not have been accepted.');
      return { ok: false, reason: 'no-status' };
    }
  }

  /**
   * Walk the whole GATT table. Diagnostics only — the app never needs this to
   * work, but it is what turns "it does not work" into a fixable bug report.
   */
  async explore() {
    if (!this.server?.connected) throw new Error('Not connected.');
    const services = await this.server.getPrimaryServices();
    const out = [];
    for (const svc of services) {
      const rec = { uuid: svc.uuid, characteristics: [] };
      let chars = [];
      try { chars = await svc.getCharacteristics(); } catch (e) { rec.error = e.message; }
      for (const ch of chars) {
        const c = { uuid: ch.uuid, properties: charProps(ch) };
        if (ch.properties.read) {
          try { c.value = hex(dvBytes(await ch.readValue())); } catch (e) { c.error = e.message; }
        }
        try {
          const ds = await ch.getDescriptors();
          c.descriptors = [];
          for (const d of ds) {
            const dr = { uuid: d.uuid };
            try {
              const b = dvBytes(await d.readValue());
              dr.value = hex(b);
              // 0x2901 is the human-readable name — the F15 labels its
              // characteristics "WRITE", "NOTIFY" and "Verify".
              if (d.uuid.startsWith('00002901')) dr.text = new TextDecoder().decode(b);
            } catch { /* not readable */ }
            c.descriptors.push(dr);
          }
        } catch { /* none */ }
        rec.characteristics.push(c);
      }
      out.push(rec);
    }
    return out;
  }
}

/**
 * BluetoothCharacteristicProperties exposes its flags as getters on the prototype,
 * so Object.keys() on it returns an EMPTY array. Enumerate the spec's names.
 */
const PROP_NAMES = [
  'broadcast', 'read', 'writeWithoutResponse', 'write', 'notify', 'indicate',
  'authenticatedSignedWrites', 'reliableWrite', 'writableAuxiliaries',
];

export function charProps(ch) {
  const p = ch?.properties;
  if (!p) return [];
  return PROP_NAMES.filter((n) => {
    try { return !!p[n]; } catch { return false; }
  });
}

/** A single frame, for the protocol console. */
export function debugFrame(op, seq, payload, obfuscate) {
  return buildFrame(op, seq, payload, { obfuscate });
}

export { OP, SEQ_MARK, startPayload };
