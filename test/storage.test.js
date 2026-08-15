/**
 * Tests for js/storage.js -- IndexedDB persistence.
 *
 * Plain Node, no framework. The shared runner (test/run.js) imports the default
 * export and hands us { check(name, actual, expected), ok(name, cond) }.
 * check() compares String(actual) === String(expected), so structures are
 * compared as JSON strings here.
 *
 * >>> run(t) IS ASYNC. The runner must `await` it. <<<
 * Node has no IndexedDB, so everything below the pure-core section drives a
 * fake implementation (further down this file) through real promises. The pure
 * tests -- base64, record shaping, the migration switch -- deliberately run
 * BEFORE the first await, so they are still counted even by a runner that
 * forgets to await.
 *
 * The fake is minimal but honest about the behaviour storage.js depends on:
 *   - requests and transactions complete asynchronously, on the macrotask queue,
 *     so a transaction really does auto-commit once nothing is outstanding;
 *   - records are structured-cloned in and out, so a stored object cannot be
 *     mutated through the reference the caller kept;
 *   - a record missing an index's keyPath is absent from that index (this is why
 *     `order` must always be a number);
 *   - `versionchange` fires on every other open connection before an upgrade,
 *     and the upgrade stays `blocked` until they close.
 * It implements only what storage.js uses: no key ranges, no compound keys, no
 * auto-increment, no cursor.update().
 */

import {
  DB_NAME,
  DB_VERSION,
  STORE_IMAGES,
  STORE_KV,
  PROGRAM_KEY,
  EXPORT_FORMAT,
  openDb,
  closeDb,
  migrateSchema,
  shapeImageRecord,
  bytesToBase64,
  base64ToBytes,
  putImage,
  getImage,
  listImages,
  deleteImage,
  renameImage,
  reorderImages,
  getSetting,
  putSetting,
  saveProgram,
  loadProgram,
  exportAll,
  importAll,
  estimateUsage,
} from '../js/storage.js';

/* ══ the fake ═══════════════════════════════════════════════════════════════ */

class FakeDomError extends Error {
  constructor(name, message) {
    super(message);
    this.name = name;
  }
}

/** IndexedDB key order, cut down to the key types this app uses. */
function cmpKeys(a, b) {
  const rank = (v) => (typeof v === 'number' ? 0 : 1);
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  if (typeof a === 'number') return a - b;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

/** DOMStringList stand-in: only `contains`/`length`/`item` are ever used. */
function stringList(names) {
  const list = names.slice();
  return {
    length: list.length,
    contains: (n) => list.includes(n),
    item: (i) => (i >= 0 && i < list.length ? list[i] : null),
  };
}

const clone = (v) => (v === undefined ? undefined : structuredClone(v));

function makeRequest(tx) {
  return {
    result: undefined,
    error: null,
    transaction: tx || null,
    onsuccess: null,
    onerror: null,
    onupgradeneeded: null,
    onblocked: null,
  };
}

function fire(target, prop, event) {
  const handler = target[prop];
  if (typeof handler === 'function') handler(Object.assign({ target }, event));
  return typeof handler === 'function';
}

function createFakeIndexedDB() {
  /** name -> { name, version, stores: Map, connections: Set, upgrading, upgradeTx } */
  const dbs = new Map();

  /* ── transactions ─────────────────────────────────────────────────────── */

  function finishTx(tx, how) {
    if (tx._finished) return;
    tx._finished = true;
    if (how === 'complete') {
      fire(tx, 'oncomplete', { type: 'complete' });
      return;
    }
    // Roll back to the snapshot taken when the transaction opened.
    if (tx._snapshot) {
      for (const [name, records] of tx._snapshot) {
        const sd = tx._data.stores.get(name);
        if (sd) sd.records = records;
      }
    }
    fire(tx, 'onerror', { type: 'error' });
    fire(tx, 'onabort', { type: 'abort' });
  }

  // A transaction commits when control returns to the event loop with no request
  // outstanding -- modelled here with a macrotask, which is what gives awaited
  // requests (microtasks) room to queue the next one.
  function scheduleFinish(tx) {
    if (tx._finished || tx._finishScheduled || tx._manual) return;
    tx._finishScheduled = true;
    setTimeout(() => {
      tx._finishScheduled = false;
      if (tx._finished || tx._pending > 0) return;
      finishTx(tx, 'complete');
    }, 0);
  }

  // Requests are delivered on the MICROTASK queue and the commit check on the
  // macrotask queue -- the same split as the real thing (a request handler runs
  // long before the transaction can commit), and it keeps the suite off Node's
  // ~1 ms setTimeout floor, which a few thousand requests would otherwise turn
  // into seconds of wall clock.
  function enqueue(tx, work) {
    if (tx._finished) {
      throw new FakeDomError('TransactionInactiveError', 'the transaction has finished');
    }
    const req = makeRequest(tx);
    tx._pending++;
    queueMicrotask(() => {
      tx._pending--;
      if (tx._finished) return;
      let result;
      try {
        result = work();
      } catch (err) {
        req.error = err;
        tx.error = err;
        fire(req, 'onerror', { type: 'error' });
        finishTx(tx, 'abort');
        return;
      }
      req.result = result;
      fire(req, 'onsuccess', { type: 'success' });
      scheduleFinish(tx);
    });
    return req;
  }

  function makeTransaction(data, names, mode, conn) {
    const tx = {
      mode,
      db: conn,
      error: null,
      oncomplete: null,
      onerror: null,
      onabort: null,
      objectStore(name) {
        if (tx._finished) throw new FakeDomError('InvalidStateError', 'the transaction has finished');
        if (names && !names.includes(name)) {
          throw new FakeDomError('NotFoundError', `${name} is not in this transaction`);
        }
        const sd = data.stores.get(name);
        if (!sd) throw new FakeDomError('NotFoundError', `no object store ${name}`);
        return makeStore(tx, data, sd);
      },
      abort() {
        finishTx(tx, 'abort');
      },
    };
    tx._data = data;
    tx._pending = 0;
    tx._finished = false;
    tx._finishScheduled = false;
    // __upgradeContext() sets this, so a hand-driven upgrade transaction stays
    // open for as long as the test needs it.
    tx._manual = false;
    // Readonly transactions have nothing to roll back.
    tx._snapshot = mode === 'readonly' || !names
      ? null
      : new Map(names.map((n) => [n, new Map(data.stores.get(n).records)]));
    scheduleFinish(tx);
    return tx;
  }

  /* ── stores and indexes ───────────────────────────────────────────────── */

  function indexRows(sd, idx) {
    const rows = [];
    for (const [primaryKey, value] of sd.records) {
      const key = value ? value[idx.keyPath] : undefined;
      // Real IndexedDB leaves a record out of an index when the key is missing.
      if (key === undefined || key === null) continue;
      rows.push({ key, primaryKey, value });
    }
    rows.sort((a, b) => cmpKeys(a.key, b.key) || cmpKeys(a.primaryKey, b.primaryKey));
    return rows;
  }

  function storeRows(sd) {
    return [...sd.records.entries()]
      .map(([primaryKey, value]) => ({ key: primaryKey, primaryKey, value }))
      .sort((a, b) => cmpKeys(a.primaryKey, b.primaryKey));
  }

  function cursorRequest(tx, rows, direction, keyOnly) {
    const list = direction === 'prev' ? rows.slice().reverse() : rows.slice();
    const req = makeRequest(tx);
    let i = 0;
    const step = () => {
      tx._pending++;
      queueMicrotask(() => {
        tx._pending--;
        if (tx._finished) return;
        if (i >= list.length) {
          req.result = null;
          fire(req, 'onsuccess', { type: 'success' });
          scheduleFinish(tx);
          return;
        }
        const row = list[i++];
        req.result = {
          key: row.key,
          primaryKey: row.primaryKey,
          value: keyOnly ? undefined : clone(row.value),
          continue: step,
        };
        fire(req, 'onsuccess', { type: 'success' });
        scheduleFinish(tx);
      });
    };
    step();
    return req;
  }

  function noRange(range) {
    if (range !== undefined && range !== null) {
      throw new FakeDomError('NotSupportedError', 'the fake does not implement key ranges');
    }
  }

  function makeIndex(tx, sd, idx) {
    return {
      name: idx.name,
      keyPath: idx.keyPath,
      getAll(range) { noRange(range); return enqueue(tx, () => indexRows(sd, idx).map((r) => clone(r.value))); },
      getAllKeys(range) { noRange(range); return enqueue(tx, () => indexRows(sd, idx).map((r) => r.primaryKey)); },
      count(range) { noRange(range); return enqueue(tx, () => indexRows(sd, idx).length); },
      openCursor(range, direction) { noRange(range); return cursorRequest(tx, indexRows(sd, idx), direction, false); },
      openKeyCursor(range, direction) { noRange(range); return cursorRequest(tx, indexRows(sd, idx), direction, true); },
    };
  }

  function makeStore(tx, data, sd) {
    const writable = () => {
      if (tx.mode === 'readonly') {
        throw new FakeDomError('ReadOnlyError', 'the transaction is read-only');
      }
    };
    const write = (value, mustBeNew) => {
      writable();
      const stored = clone(value);
      const key = stored ? stored[sd.keyPath] : undefined;
      if (key === undefined || key === null) {
        throw new FakeDomError('DataError', `record has no ${sd.keyPath}`);
      }
      if (mustBeNew && sd.records.has(key)) {
        throw new FakeDomError('ConstraintError', `key ${key} already exists`);
      }
      sd.records.set(key, stored);
      return key;
    };
    return {
      name: sd.name,
      keyPath: sd.keyPath,
      get indexNames() { return stringList([...sd.indexes.keys()]); },
      createIndex(name, keyPath, options) {
        if (tx.mode !== 'versionchange') {
          throw new FakeDomError('InvalidStateError', 'createIndex outside an upgrade');
        }
        if (sd.indexes.has(name)) throw new FakeDomError('ConstraintError', `index ${name} exists`);
        sd.indexes.set(name, { name, keyPath, unique: Boolean(options && options.unique) });
        return makeIndex(tx, sd, sd.indexes.get(name));
      },
      deleteIndex(name) { sd.indexes.delete(name); },
      index(name) {
        const idx = sd.indexes.get(name);
        if (!idx) throw new FakeDomError('NotFoundError', `no index ${name} on ${sd.name}`);
        return makeIndex(tx, sd, idx);
      },
      add(value) { return enqueue(tx, () => write(value, true)); },
      put(value) { return enqueue(tx, () => write(value, false)); },
      get(key) { return enqueue(tx, () => clone(sd.records.get(key))); },
      getAll(range) { noRange(range); return enqueue(tx, () => storeRows(sd).map((r) => clone(r.value))); },
      getAllKeys(range) { noRange(range); return enqueue(tx, () => storeRows(sd).map((r) => r.primaryKey)); },
      delete(key) { return enqueue(tx, () => { writable(); sd.records.delete(key); return undefined; }); },
      clear() { return enqueue(tx, () => { writable(); sd.records.clear(); return undefined; }); },
      count(key) {
        return enqueue(tx, () => (key === undefined ? sd.records.size : (sd.records.has(key) ? 1 : 0)));
      },
      openCursor(range, direction) { noRange(range); return cursorRequest(tx, storeRows(sd), direction, false); },
    };
  }

  /* ── connections ──────────────────────────────────────────────────────── */

  function makeConnection(data) {
    let closed = false;
    const conn = {
      name: data.name,
      onversionchange: null,
      onclose: null,
      get version() { return data.version; },
      get objectStoreNames() { return stringList([...data.stores.keys()]); },
      createObjectStore(name, options) {
        if (!data.upgrading) {
          throw new FakeDomError('InvalidStateError', 'createObjectStore outside an upgrade');
        }
        if (data.stores.has(name)) throw new FakeDomError('ConstraintError', `store ${name} exists`);
        const sd = {
          name,
          keyPath: (options && options.keyPath) || null,
          records: new Map(),
          indexes: new Map(),
        };
        data.stores.set(name, sd);
        return makeStore(data.upgradeTx, data, sd);
      },
      deleteObjectStore(name) {
        if (!data.upgrading) {
          throw new FakeDomError('InvalidStateError', 'deleteObjectStore outside an upgrade');
        }
        data.stores.delete(name);
      },
      transaction(names, mode = 'readonly') {
        if (closed) throw new FakeDomError('InvalidStateError', 'the database connection is closing');
        const list = Array.isArray(names) ? names.slice() : [names];
        for (const n of list) {
          if (!data.stores.has(n)) throw new FakeDomError('NotFoundError', `no object store ${n}`);
        }
        return makeTransaction(data, list, mode, conn);
      },
      close() {
        if (closed) return;
        closed = true;
        data.connections.delete(conn);
      },
      get closed() { return closed; },
    };
    return conn;
  }

  function dbData(name) {
    let data = dbs.get(name);
    if (!data) {
      data = { name, version: 0, stores: new Map(), connections: new Set(), upgrading: false, upgradeTx: null };
      dbs.set(name, data);
    }
    return data;
  }

  function open(name, version) {
    const req = makeRequest(null);
    let blockedFired = false;

    const step = () => {
      const data = dbData(name);
      const target = version === undefined ? Math.max(1, data.version) : version;

      if (target < data.version) {
        req.error = new FakeDomError('VersionError',
          `the requested version (${target}) is less than the existing version (${data.version})`);
        fire(req, 'onerror', { type: 'error' });
        return;
      }

      if (target > data.version) {
        // Real IndexedDB asks every other connection to get out of the way first.
        for (const conn of [...data.connections]) {
          fire(conn, 'onversionchange', {
            type: 'versionchange', oldVersion: data.version, newVersion: target,
          });
        }
        if (data.connections.size > 0) {
          if (!blockedFired) {
            blockedFired = true;
            fire(req, 'onblocked', {
              type: 'blocked', oldVersion: data.version, newVersion: target,
            });
          }
          setTimeout(step, 0);   // keep waiting, exactly as a real deadlock would
          return;
        }

        const oldVersion = data.version;
        data.version = target;
        const conn = makeConnection(data);
        data.connections.add(conn);
        const tx = makeTransaction(data, null, 'versionchange', conn);
        data.upgrading = true;
        data.upgradeTx = tx;
        req.result = conn;
        req.transaction = tx;
        tx.oncomplete = () => {
          data.upgrading = false;
          data.upgradeTx = null;
          req.transaction = null;
          fire(req, 'onsuccess', { type: 'success' });
        };
        try {
          fire(req, 'onupgradeneeded', { type: 'upgradeneeded', oldVersion, newVersion: target });
        } catch (err) {
          data.upgrading = false;
          data.upgradeTx = null;
          data.version = oldVersion;
          tx.oncomplete = null;
          tx.abort();
          conn.close();
          req.error = err;
          fire(req, 'onerror', { type: 'error' });
        }
        return;
      }

      const conn = makeConnection(data);
      data.connections.add(conn);
      req.result = conn;
      fire(req, 'onsuccess', { type: 'success' });
    };

    setTimeout(step, 0);
    return req;
  }

  return {
    open,
    /** Wipe every database. Test-only. */
    __reset() { dbs.clear(); },
    /** Raw record map for a store, for assertions the public API cannot make. */
    __records(dbName, storeName) {
      const data = dbs.get(dbName);
      const sd = data && data.stores.get(storeName);
      return sd ? sd.records : null;
    },
    __version(dbName) {
      const data = dbs.get(dbName);
      return data ? data.version : 0;
    },
    __connections(dbName) {
      const data = dbs.get(dbName);
      return data ? data.connections.size : 0;
    },
    /**
     * A live versionchange transaction plus its connection, so migrateSchema()
     * can be driven directly and synchronously.
     */
    __upgradeContext(dbName) {
      const data = dbData(dbName);
      const conn = makeConnection(data);
      const tx = makeTransaction(data, null, 'versionchange', conn);
      tx._manual = true;
      data.upgrading = true;
      data.upgradeTx = tx;
      return { db: conn, tx, data };
    },
  };
}

/* ══ helpers ════════════════════════════════════════════════════════════════ */

const bytes = (...values) => new Uint8Array(values);
const blobOf = (values, type = 'image/png') => new Blob([bytes(...values)], { type });

/** Read a Blob (or a Uint8Array) back as a comma-separated byte list. */
async function blobBytes(blob) {
  if (!blob) return 'null';
  const buf = blob instanceof Uint8Array ? blob : new Uint8Array(await blob.arrayBuffer());
  return Array.from(buf).join(',');
}

const names = (list) => list.map((r) => r.name).join(',');
const ids = (list) => list.map((r) => r.id).join(',');

/* ══ the tests ══════════════════════════════════════════════════════════════ */

/**
 * @param {{check: (name: string, actual: unknown, expected: unknown) => void,
 *          ok: (name: string, cond: unknown) => void}} t
 * @returns {Promise<void>}
 */
export default async function run(t) {
  /* ── pure core: base64 ─────────────────────────────────────────────────
     Everything down to the first `await` runs synchronously, so these are
     counted even if the runner forgets to await run(). */

  t.check('base64 of nothing', bytesToBase64(bytes()), '');
  t.check('base64 pads one byte', bytesToBase64(bytes(0x41)), 'QQ==');
  t.check('base64 pads two bytes', bytesToBase64(bytes(0x41, 0x42)), 'QUI=');
  t.check('base64 of a whole triplet', bytesToBase64(bytes(0x41, 0x42, 0x43)), 'QUJD');
  t.check('base64 of the high bytes', bytesToBase64(bytes(0xff, 0xfe, 0xfd)), '//79');
  t.check('base64 decodes back', Array.from(base64ToBytes('QUJD')).join(','), '65,66,67');
  t.check('base64 decode ignores padding and newlines',
    Array.from(base64ToBytes('QQ=\n=')).join(','), '65');
  t.check('base64 decode accepts the url-safe alphabet',
    Array.from(base64ToBytes('__79')).join(','), Array.from(base64ToBytes('//79')).join(','));

  const all256 = new Uint8Array(256);
  for (let i = 0; i < 256; i++) all256[i] = i;
  t.check('base64 round-trips every byte value',
    Array.from(base64ToBytes(bytesToBase64(all256))).join(','), Array.from(all256).join(','));
  let lengthsOk = true;
  for (let n = 0; n <= 64; n++) {
    const buf = new Uint8Array(n);
    for (let i = 0; i < n; i++) buf[i] = (i * 37 + 11) & 0xff;
    const back = base64ToBytes(bytesToBase64(buf));
    if (back.length !== n || Array.from(back).join(',') !== Array.from(buf).join(',')) lengthsOk = false;
  }
  t.ok('base64 round-trips every length 0..64 (padding maths)', lengthsOk);

  // The shipped encoder batches its output and encodes through a 12-bit lookup
  // table. That is a real speed win on a whole-library backup and exactly the kind
  // of optimisation that goes subtly wrong at a batch boundary, so check it against
  // an obviously-correct byte-at-a-time reference rather than against itself.
  const naiveBase64 = (buf) => {
    const C = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let out = '';
    for (let i = 0; i < buf.length; i += 3) {
      const b0 = buf[i];
      const b1 = i + 1 < buf.length ? buf[i + 1] : -1;
      const b2 = i + 2 < buf.length ? buf[i + 2] : -1;
      out += C[b0 >> 2];
      out += C[((b0 & 3) << 4) | (b1 < 0 ? 0 : b1 >> 4)];
      out += b1 < 0 ? '=' : C[((b1 & 15) << 2) | (b2 < 0 ? 0 : b2 >> 6)];
      out += b2 < 0 ? '=' : C[b2 & 63];
    }
    return out;
  };
  // 12288 bytes is exactly one output batch (8192 chars), so these straddle the
  // flush on both sides and in the middle, at all three padding remainders.
  let batchOk = true;
  let batchFail = '';
  for (const n of [12285, 12286, 12287, 12288, 12289, 12290, 12291, 24576, 24577, 40000]) {
    const buf = new Uint8Array(n);
    for (let i = 0; i < n; i++) buf[i] = (i * 97 + 13) & 0xff;
    const encoded = bytesToBase64(buf);
    if (encoded !== naiveBase64(buf)) { batchOk = false; batchFail = `encode@${n}`; break; }
    const back = base64ToBytes(encoded);
    if (Array.from(back).join(',') !== Array.from(buf).join(',')) {
      batchOk = false; batchFail = `roundtrip@${n}`; break;
    }
  }
  t.check('the batched encoder matches a naive one across every flush boundary',
    batchOk ? 'ok' : batchFail, 'ok');

  /* ── pure core: record shaping ─────────────────────────────────────────── */

  const png = blobOf([0x89, 0x50, 0x4e, 0x47]);
  const shaped = shapeImageRecord(
    { name: '  Sunset  ', blob: png, settings: { dither: 'fs' }, width: '200', height: 200.4 },
    { now: 1000, order: -3 }
  );
  t.check('shaping trims the name', shaped.name, 'Sunset');
  t.check('shaping keeps the original blob', shaped.blob === png, true);
  t.check('shaping records the blob size', shaped.size, 4);
  t.check('shaping coerces a string width', shaped.width, 200);
  t.check('shaping rounds a fractional height', shaped.height, 200);
  t.check('shaping stamps createdAt from the clock', shaped.createdAt, 1000);
  t.check('shaping stamps updatedAt from the clock', shaped.updatedAt, 1000);
  t.check('shaping takes the supplied order', shaped.order, -3);
  t.ok('shaping generates an id', typeof shaped.id === 'string' && shaped.id.length > 0);
  t.check('two new records get different ids',
    shapeImageRecord({}, {}).id === shapeImageRecord({}, {}).id, false);
  t.check('a nameless record is Untitled', shapeImageRecord({}, {}).name, 'Untitled');
  t.check('settings default to an object', JSON.stringify(shapeImageRecord({}, {}).settings), '{}');
  t.check('order defaults to a number, never undefined', shapeImageRecord({}, {}).order, 0);
  t.check('a supplied id is honoured', shapeImageRecord({ id: 'keep-me' }, {}).id, 'keep-me');

  const existing = shapeImageRecord(
    { id: 'a', name: 'First', blob: png, settings: { dither: 'fs' }, width: 10, height: 20 },
    { now: 1000, order: 7 }
  );
  const updated = shapeImageRecord({ id: 'a', settings: { dither: 'none' } }, { existing, now: 2000 });
  t.check('an update keeps the id', updated.id, 'a');
  t.check('an update keeps createdAt', updated.createdAt, 1000);
  t.check('an update moves updatedAt', updated.updatedAt, 2000);
  t.check('an update keeps its place in the library', updated.order, 7);
  t.check('an update keeps the untouched blob', updated.blob === png, true);
  t.check('an update keeps the untouched name', updated.name, 'First');
  t.check('an update applies the new settings', JSON.stringify(updated.settings), '{"dither":"none"}');
  t.check('a blob-less record can still carry a size',
    shapeImageRecord({ size: 1234 }, {}).size, 1234);

  /* ── pure core: the migration switch ───────────────────────────────────── */

  const idb = createFakeIndexedDB();
  const up = idb.__upgradeContext('migration-probe');

  migrateSchema(up.db, up.tx, 0);
  t.check('v0 creates the images store', up.db.objectStoreNames.contains(STORE_IMAGES), true);
  t.check('v0 creates the kv store', up.db.objectStoreNames.contains(STORE_KV), true);
  t.check('images is keyed by id', up.tx.objectStore(STORE_IMAGES).keyPath, 'id');
  t.check('kv is keyed by key', up.tx.objectStore(STORE_KV).keyPath, 'key');
  t.check('images has a createdAt index',
    up.tx.objectStore(STORE_IMAGES).indexNames.contains('createdAt'), true);
  t.check('images has an order index',
    up.tx.objectStore(STORE_IMAGES).indexNames.contains('order'), true);

  // A versionchange transaction can abort and replay, so every step has to
  // tolerate running twice -- and must never wipe what is already there.
  up.data.stores.get(STORE_IMAGES).records.set('survivor', { id: 'survivor', order: 0 });
  let replayError = null;
  try {
    migrateSchema(up.db, up.tx, 0);
  } catch (err) {
    replayError = err;
  }
  t.check('replaying the v0 migration does not throw', String(replayError), 'null');
  t.check('replaying the v0 migration keeps existing records',
    up.data.stores.get(STORE_IMAGES).records.has('survivor'), true);
  t.check('replaying the v0 migration does not duplicate the index',
    up.tx.objectStore(STORE_IMAGES).indexNames.length, 2);

  // The current version falls straight out of the switch: nothing to do.
  let currentError = null;
  try {
    migrateSchema(up.db, up.tx, DB_VERSION);
  } catch (err) {
    currentError = err;
  }
  t.check(`migrating from the current version (${DB_VERSION}) is a no-op`, String(currentError), 'null');

  let futureError = null;
  try {
    migrateSchema(up.db, up.tx, 99);
  } catch (err) {
    futureError = err;
  }
  t.ok('a database from the future is refused, not silently accepted',
    futureError instanceof Error && /unsupported database version 99/.test(futureError.message));

  /* ── everything past here needs the fake installed ─────────────────────── */

  globalThis.indexedDB = idb;
  const reset = async () => {
    await closeDb();
    idb.__reset();
  };
  await reset();

  /* ── opening ───────────────────────────────────────────────────────────── */

  const db = await openDb();
  t.check('openDb creates the database at the current version', db.version, DB_VERSION);
  t.check('openDb built the images store', db.objectStoreNames.contains(STORE_IMAGES), true);
  t.check('openDb built the kv store', db.objectStoreNames.contains(STORE_KV), true);
  t.check('openDb is idempotent (same connection)', (await openDb()) === db, true);
  t.check('openDb opened exactly one connection', idb.__connections(DB_NAME), 1);

  /* ── images ────────────────────────────────────────────────────────────── */

  const original = blobOf([1, 2, 3, 4, 5]);
  const id1 = await putImage({
    name: 'Cat',
    blob: original,
    settings: { dither: 'fs', fit: 'cover' },
    width: 640,
    height: 480,
    thumb: 'data:image/png;base64,AAA',
  });
  t.ok('putImage returns an id', typeof id1 === 'string' && id1.length > 0);

  const back = await getImage(id1);
  t.check('getImage returns the record', back.name, 'Cat');
  t.check('the ORIGINAL blob is what came back', await blobBytes(back.blob), '1,2,3,4,5');
  t.check('the blob keeps its mime type', back.blob.type, 'image/png');
  t.check('the processing settings came back with it',
    JSON.stringify(back.settings), '{"dither":"fs","fit":"cover"}');
  t.check('the source dimensions came back', `${back.width}x${back.height}`, '640x480');
  t.check('the thumbnail came back', back.thumb, 'data:image/png;base64,AAA');
  t.ok('createdAt was stamped', back.createdAt > 0);
  t.check('getImage on an unknown id is null', await getImage('nope'), 'null');

  const id2 = await putImage({ name: 'Dog', blob: blobOf([9]), width: 10, height: 10 });
  const id3 = await putImage({ name: 'Bird', blob: blobOf([8]), width: 10, height: 10 });

  let list = await listImages();
  t.check('listImages returns everything', list.length, 3);
  t.check('listImages is newest first', names(list), 'Bird,Dog,Cat');
  t.check('listImages hides the blob', 'blob' in list[0], false);
  t.check('listImages returns exactly the agreed fields',
    Object.keys(list[0]).sort().join(','),
    'createdAt,height,id,name,settings,thumb,updatedAt,width');

  // An update must not reorder the library or lose the stored original.
  await putImage({ id: id1, settings: { dither: 'atkinson' } });
  const afterUpdate = await getImage(id1);
  t.check('an update keeps the original blob', await blobBytes(afterUpdate.blob), '1,2,3,4,5');
  t.check('an update applied the new settings', afterUpdate.settings.dither, 'atkinson');
  t.check('an update did not move the picture', names(await listImages()), 'Bird,Dog,Cat');
  t.check('an update did not add a record', (await listImages()).length, 3);

  // Stored records must be copies: mutating what we passed in cannot reach the db.
  const mutable = { name: 'Mutable', blob: blobOf([7]), settings: { dither: 'fs' }, width: 1, height: 1 };
  const idM = await putImage(mutable);
  mutable.settings.dither = 'tampered';
  t.check('the store holds a copy, not the caller\'s object',
    (await getImage(idM)).settings.dither, 'fs');
  await deleteImage(idM);

  t.check('renameImage returns the trimmed name', await renameImage(id2, '  Good dog  '), 'Good dog');
  t.check('the rename stuck', (await getImage(id2)).name, 'Good dog');
  let renameError = null;
  try {
    await renameImage('ghost', 'x');
  } catch (err) {
    renameError = err;
  }
  t.ok('renaming a missing image throws', renameError instanceof Error);

  t.check('deleteImage reports the delete', await deleteImage(id3), true);
  t.check('deleteImage on a missing id reports false', await deleteImage(id3), false);
  t.check('the library shrank', names(await listImages()), 'Good dog,Cat');

  /* ── ordering ──────────────────────────────────────────────────────────── */

  const id4 = await putImage({ name: 'Fox', blob: blobOf([4]), width: 1, height: 1 });
  t.check('a new picture lands at the top', names(await listImages()), 'Fox,Good dog,Cat');

  await reorderImages([id1, id4, id2]);
  t.check('reorderImages sets the order', names(await listImages()), 'Cat,Fox,Good dog');
  t.check('reorderImages returns the library size', await reorderImages([id2]), 3);
  t.check('ids the caller omitted keep their relative order',
    names(await listImages()), 'Good dog,Cat,Fox');
  await reorderImages([id1, 'not-a-real-id', id2, id4]);
  t.check('unknown ids are ignored', names(await listImages()), 'Cat,Good dog,Fox');

  // A record with no `order` is missing from the index, and therefore invisible.
  // reorderImages is the repair path.
  const records = idb.__records(DB_NAME, STORE_IMAGES);
  const damaged = structuredClone(records.get(id2));
  delete damaged.order;
  records.set(id2, damaged);
  t.check('a record with no order key drops out of the library',
    names(await listImages()), 'Cat,Fox');
  await reorderImages([]);
  t.check('reorderImages heals it back into the library',
    (await listImages()).length, 3);

  /* ── settings and the automation program ───────────────────────────────── */

  t.check('an unset setting returns the fallback', await getSetting('chunkSize', 200), 200);
  t.check('an unset setting with no fallback is undefined',
    String(await getSetting('nothing')), 'undefined');
  await putSetting('chunkSize', 20);
  t.check('a setting round-trips', await getSetting('chunkSize', 200), 20);
  await putSetting('chunkSize', 0);
  t.check('a falsy setting is not mistaken for missing', await getSetting('chunkSize', 200), 0);
  await putSetting('panel', { width: 200, height: 200, type: 1, model: 3 });
  t.check('an object setting round-trips',
    JSON.stringify(await getSetting('panel', null)), '{"width":200,"height":200,"type":1,"model":3}');

  t.check('no program saved yet', String(await loadProgram()), 'null');
  const program = {
    version: 1,
    blocks: [
      { type: 'picture', imageId: id1 },
      { type: 'wait', seconds: 3600 },
      { type: 'random', pool: 'all', avoidRepeat: true },
      { type: 'gotoStart' },
    ],
  };
  await saveProgram(program);
  t.check('the program round-trips',
    JSON.stringify(await loadProgram()), JSON.stringify(program));
  t.check('the program lives under its own kv key',
    JSON.stringify(await getSetting(PROGRAM_KEY, null)), JSON.stringify(program));

  /* ── export / import ───────────────────────────────────────────────────── */

  const dump = await exportAll();
  t.check('the export is stamped with the format', dump.format, EXPORT_FORMAT);
  t.check('the export records the schema version it came from', dump.dbVersion, DB_VERSION);
  t.check('the export carries every image', dump.images.length, 3);
  t.check('the export carries the program',
    JSON.stringify(dump.program), JSON.stringify(program));
  t.check('the export carries the settings', dump.settings.chunkSize, 0);
  t.check('the program is not duplicated into settings',
    PROGRAM_KEY in dump.settings, false);

  const dumpedCat = dump.images.find((r) => r.id === id1);
  t.check('a blob is exported as tagged base64', dumpedCat.blob.__type, 'blob');
  t.check('the exported blob keeps its mime type', dumpedCat.blob.mime, 'image/png');
  t.check('the exported blob holds the original bytes',
    Array.from(base64ToBytes(dumpedCat.blob.data)).join(','), '1,2,3,4,5');
  t.check('the export is real JSON (survives a file round trip)',
    typeof JSON.stringify(dump), 'string');
  t.check('the export is in library order', dump.images.map((r) => r.name).join(','), 'Cat,Fox,Good dog');

  // The file the user actually gets is text: go through it, not around it.
  const onDisk = JSON.parse(JSON.stringify(dump));

  await reset();
  const restored = await importAll(onDisk);
  t.check('import reports what it wrote', restored.images, 3);
  t.check('import reports the program', restored.program, true);
  // The program lives in the kv store but is reported on its own, so the counts
  // match exportAll's {settings, program} split (chunkSize + panel here).
  t.check('the program is not counted as a setting', restored.settings, 2);
  t.check('the library came back in order', names(await listImages()), 'Cat,Fox,Good dog');
  t.check('the ids survived (the program addresses pictures by id)',
    ids(await listImages()).split(',').includes(id1), true);
  t.check('the original blob survived the round trip',
    await blobBytes((await getImage(id1)).blob), '1,2,3,4,5');
  t.check('the blob is a Blob again, not base64',
    (await getImage(id1)).blob instanceof Blob, true);
  t.check('the mime type survived', (await getImage(id1)).blob.type, 'image/png');
  t.check('the settings survived', (await getImage(id1)).settings.dither, 'atkinson');
  t.check('the program survived', JSON.stringify(await loadProgram()), JSON.stringify(program));
  t.check('the settings survived too', await getSetting('chunkSize', 200), 0);

  // Re-importing the same backup must not clone the library.
  const again = await importAll(onDisk, { merge: true });
  t.check('a merge skips ids that are already here', again.imagesSkipped, 3);
  t.check('a merge wrote nothing new', again.images, 0);
  t.check('the library did not double', (await listImages()).length, 3);

  // Merging a *different* library appends to the current one.
  const otherBackup = {
    format: EXPORT_FORMAT,
    version: 1,
    images: [{
      id: 'from-other-phone',
      name: 'Imported',
      blob: { __type: 'blob', mime: 'image/jpeg', data: bytesToBase64(bytes(200, 201)) },
      settings: { dither: 'none' },
      width: 5,
      height: 5,
      createdAt: 1,
      updatedAt: 1,
      order: 0,
    }],
    settings: { chunkSize: 10 },
    program: null,
  };
  const merged = await importAll(otherBackup, { merge: true });
  t.check('a merge adds the new picture', merged.images, 1);
  t.check('merged pictures go after the existing ones',
    names(await listImages()), 'Cat,Fox,Good dog,Imported');
  t.check('the merged blob decoded',
    await blobBytes((await getImage('from-other-phone')).blob), '200,201');
  t.check('a merge overwrites a colliding setting', await getSetting('chunkSize', 200), 10);

  // An old or hand-edited backup, missing fields a later schema added.
  await reset();
  const sparse = {
    format: EXPORT_FORMAT,
    version: 1,
    images: [
      { id: 'x', name: 'No order', blob: { __type: 'blob', mime: '', data: bytesToBase64(bytes(1)) } },
      { id: 'y' },
    ],
    settings: {},
    program: null,
  };
  const sparseResult = await importAll(sparse);
  t.check('a sparse backup still imports', sparseResult.images, 2);
  t.check('a sparse backup reports no damaged rows', sparseResult.imagesInvalid, 0);
  const sparseList = await listImages();
  t.check('records missing order are still visible in the library', sparseList.length, 2);
  t.check('a record with no name gets one', sparseList.map((r) => r.name).join(','), 'No order,Untitled');
  t.ok('createdAt was backfilled', sparseList.every((r) => Number.isFinite(r.createdAt)));

  // One corrupt row must not cost the user the rest of the backup.
  await reset();
  const damagedBackup = await importAll({
    format: EXPORT_FORMAT,
    version: 1,
    images: [
      null,
      'this row was mangled by a text editor',
      { id: 'good', name: 'Survivor', blob: { __type: 'blob', mime: '', data: bytesToBase64(bytes(2)) } },
    ],
    settings: {},
    program: null,
  });
  t.check('a damaged row is counted', damagedBackup.imagesInvalid, 2);
  t.check('the readable rows still import', damagedBackup.images, 1);
  t.check('the survivor is in the library', names(await listImages()), 'Survivor');

  await reset();
  await importAll(sparse);

  // Import must be all-or-nothing about the format.
  let badFormat = null;
  try {
    await importAll({ format: 'someone-elses-app', images: [] });
  } catch (err) {
    badFormat = err;
  }
  t.ok('a foreign file is refused', badFormat instanceof Error);
  let badVersion = null;
  try {
    await importAll({ format: EXPORT_FORMAT, version: 99, images: [] });
  } catch (err) {
    badVersion = err;
  }
  t.ok('a backup from a newer app is refused', badVersion instanceof Error);
  t.check('the refused imports changed nothing', (await listImages()).length, 2);

  // A replace-import wipes what was there.
  await importAll({ format: EXPORT_FORMAT, version: 1, images: [], settings: {}, program: null });
  t.check('a replace-import of an empty backup empties the library',
    (await listImages()).length, 0);

  /* ── quota ─────────────────────────────────────────────────────────────── */

  // Node 22 defines globalThis.navigator as a getter-only accessor, so a plain
  // assignment throws -- swap the whole property descriptor instead.
  const savedNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const setNavigator = (value) => {
    Object.defineProperty(globalThis, 'navigator', { value, configurable: true, writable: true });
  };

  t.check('estimateUsage is null when the API is missing',
    String(await estimateUsage()), 'null');
  let persistCalls = 0;
  setNavigator({
    storage: {
      estimate: async () => ({ usage: 1234, quota: 5678 }),
      persist: async () => { persistCalls++; return true; },
    },
  });
  t.check('estimateUsage reads the quota',
    JSON.stringify(await estimateUsage()), '{"usage":1234,"quota":5678}');
  t.check('estimateUsage never asks for persistence (that is a prompt)', persistCalls, 0);
  setNavigator({ storage: { estimate: async () => { throw new Error('private mode'); } } });
  t.check('a throwing estimate() is null, not an exception',
    String(await estimateUsage()), 'null');
  setNavigator({});
  t.check('a navigator without storage is null too', String(await estimateUsage()), 'null');
  if (savedNavigator) Object.defineProperty(globalThis, 'navigator', savedNavigator);
  else delete globalThis.navigator;

  /* ── connection lifecycle ──────────────────────────────────────────────── */

  await reset();
  await putImage({ name: 'Before', blob: blobOf([1]), width: 1, height: 1 });

  // A connection killed behind the module's back (another tab upgraded, or the
  // browser evicted the storage) must not wedge every later call -- the same
  // stale-handle failure that bites BLE characteristics after a disconnect.
  const live = await openDb();
  live.close();
  t.check('the killed connection is gone', idb.__connections(DB_NAME), 0);
  const afterKill = await listImages();
  t.check('storage re-opens transparently after a dead connection', names(afterKill), 'Before');
  t.check('and it really is a new connection', (await openDb()) === live, false);

  // versionchange: a second tab upgrading must not be blocked by our connection.
  await openDb();
  t.check('we hold a connection again', idb.__connections(DB_NAME), 1);
  const upgraded = await new Promise((resolve, reject) => {
    const deadline = setTimeout(
      () => reject(new Error('the second tab deadlocked on our connection')), 500);
    const done = (fn) => (value) => { clearTimeout(deadline); fn(value); };
    const settle = done(resolve);
    const fail = done(reject);
    const req = idb.open(DB_NAME, DB_VERSION + 1);
    let sawBlocked = false;
    req.onblocked = () => { sawBlocked = true; };
    req.onupgradeneeded = () => { /* the other tab's schema change */ };
    req.onsuccess = () => settle({ conn: req.result, sawBlocked });
    req.onerror = () => fail(req.error);
  });
  t.check('a second tab can upgrade without deadlocking', upgraded.conn.version, DB_VERSION + 1);
  t.check('it was never blocked, because we closed on versionchange', upgraded.sawBlocked, false);
  upgraded.conn.close();

  // Proof the fake really can deadlock: a connection that ignores versionchange
  // does block the upgrade, until it goes away.
  const stubborn = await new Promise((resolve, reject) => {
    const req = idb.open(DB_NAME);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  stubborn.onversionchange = null;   // the tab that never listened
  const blockedRun = await new Promise((resolve, reject) => {
    const deadline = setTimeout(
      () => reject(new Error('the blocked upgrade never recovered')), 500);
    const done = (fn) => (value) => { clearTimeout(deadline); fn(value); };
    const settle = done(resolve);
    const fail = done(reject);
    const req = idb.open(DB_NAME, DB_VERSION + 2);
    let sawBlocked = false;
    req.onblocked = () => {
      sawBlocked = true;
      // Simulate the user closing the other tab.
      setTimeout(() => stubborn.close(), 0);
    };
    req.onupgradeneeded = () => {};
    req.onsuccess = () => settle({ conn: req.result, sawBlocked });
    req.onerror = () => fail(req.error);
  });
  t.check('a tab that ignores versionchange does block the upgrade', blockedRun.sawBlocked, true);
  t.check('and the upgrade completes as soon as it closes',
    blockedRun.conn.version, DB_VERSION + 2);
  blockedRun.conn.close();

  await reset();
  delete globalThis.indexedDB;
}
