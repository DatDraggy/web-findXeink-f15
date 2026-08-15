/**
 * storage.js -- IndexedDB persistence for the image library, the automation
 * program and user settings.
 *
 * There is no server anywhere in this project. Everything the user creates lives
 * in this database on their own phone, which makes two things non-negotiable:
 *
 *   1. exportAll()/importAll() are the ONLY backup route. They must survive a
 *      schema change, so the export carries its own format version and every
 *      record is normalised on the way back in.
 *   2. We store the ORIGINAL image blob, never only the packed/dithered result.
 *      See putImage() for why.
 *
 * No DOM, no window, no import-time side effects: `indexedDB` is read lazily
 * inside openDb(), so this module imports cleanly in Node (where it is exercised
 * against a fake IndexedDB in test/storage.test.js).
 *
 * NOT here on purpose: navigator.storage.persist(). It shows a permission prompt
 * on some browsers, and a prompt the user did not ask for is a prompt they deny.
 * The UI offers persistence as an explicit opt-in; this module only ever *reads*
 * the quota, via estimateUsage().
 */

/** Database name. Changing it orphans every user's library -- don't. @type {string} */
export const DB_NAME = 'web-findxeink-f15';

/**
 * Schema version. Bump by exactly one per released schema change and add the
 * matching case to migrateSchema().
 * @type {number}
 */
export const DB_VERSION = 1;

/** Object store holding one record per saved picture. @type {string} */
export const STORE_IMAGES = 'images';

/** Object store holding settings and the automation program. @type {string} */
export const STORE_KV = 'kv';

/**
 * kv key under which saveProgram()/loadProgram() keep the automation program.
 * Namespaced so a plain putSetting() call cannot collide with it by accident.
 * @type {string}
 */
export const PROGRAM_KEY = 'automation.program';

/** Magic string on an exported backup, so we can refuse someone else's JSON. */
export const EXPORT_FORMAT = 'web-findxeink-f15-backup';

/** Version of the *export envelope* -- independent of DB_VERSION. @type {number} */
export const EXPORT_VERSION = 1;

/**
 * How long to wait for another tab to release a stale connection before giving
 * up on an upgrade. Well-behaved tabs (including ours) close within a frame of
 * receiving `versionchange`; a tab wedged in a breakpoint never will, and a UI
 * that hangs forever with no explanation is worse than an honest error.
 */
const BLOCKED_TIMEOUT_MS = 5000;

/* ── connection ───────────────────────────────────────────────────────────── */

/** Cached open promise, so concurrent callers share one connection. */
let dbPromise = null;

/** The connection that `dbPromise` resolved to, for identity checks in handlers. */
let cachedDb = null;

/** Drop the cached connection without closing it (it is already dead or closing). */
function forgetConnection() {
  dbPromise = null;
  cachedDb = null;
}

/**
 * Open (and if necessary upgrade) the database. Idempotent: repeated calls share
 * one connection, and the handle is cached until the connection dies.
 *
 * @returns {Promise<IDBDatabase>}
 */
export async function openDb() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const idb = globalThis.indexedDB;
    if (!idb || typeof idb.open !== 'function') {
      reject(new Error('IndexedDB is not available in this browser (private mode?)'));
      return;
    }

    let settled = false;
    let blockedTimer = null;
    const finish = () => {
      settled = true;
      if (blockedTimer !== null) clearTimeout(blockedTimer);
      blockedTimer = null;
    };

    let req;
    try {
      req = idb.open(DB_NAME, DB_VERSION);
    } catch (err) {
      // Firefox in private browsing throws right here rather than firing onerror.
      reject(err instanceof Error ? err : new Error('could not open the database'));
      return;
    }

    req.onupgradeneeded = (ev) => {
      // req.transaction is the versionchange transaction; every store and index
      // must be created through it, and it is the only place we may do so.
      // Not `oldVersion | 0`: IDB versions are 64-bit, and a bitwise-or would
      // silently wrap a large one into a version we would then "migrate" from.
      migrateSchema(req.result, req.transaction, Number(ev.oldVersion) || 0);
    };

    req.onblocked = () => {
      // Another tab is still holding a connection at the old version. Ours would
      // release it immediately (see the versionchange handler below), so this
      // means a tab that predates this code, or one that is frozen.
      console.warn('[storage] database upgrade blocked by another tab');
      blockedTimer = setTimeout(() => {
        if (settled) return;
        finish();
        reject(new Error(
          'Another tab is using an older version of this app. Close the other tabs and reload.'
        ));
      }, BLOCKED_TIMEOUT_MS);
      // Do not keep a Node test process alive on this timer.
      if (blockedTimer && typeof blockedTimer.unref === 'function') blockedTimer.unref();
    };

    req.onsuccess = () => {
      const db = req.result;
      if (settled) {
        // We already rejected on the blocked timeout. Close this late arrival or
        // it becomes the connection that blocks everybody else.
        db.close();
        return;
      }
      finish();

      // Another tab wants to upgrade: get out of its way at once. Without this,
      // its open() sits in `blocked` for as long as this tab lives -- exactly the
      // deadlock that makes users think the app is broken in the *other* tab.
      db.onversionchange = () => {
        db.close();
        if (cachedDb === db) forgetConnection();
      };
      // Fires when the connection dies without us closing it (storage evicted,
      // profile deleted). The cached handle is dead; drop it so the next call
      // re-opens rather than throwing InvalidStateError forever.
      db.onclose = () => {
        if (cachedDb === db) forgetConnection();
      };

      cachedDb = db;
      resolve(db);
    };

    req.onerror = () => {
      if (settled) return;
      finish();
      reject(req.error || new Error('could not open the database'));
    };
  });

  // A failed open must not poison every later call. Clear the cache only if it is
  // still THIS attempt: a retry may already have installed a working connection,
  // and nulling that one out would drop a live handle on the floor.
  const attempt = dbPromise;
  attempt.catch(() => { if (dbPromise === attempt) forgetConnection(); });
  return attempt;
}

/**
 * Close the cached connection. Safe to call when nothing is open. Useful on
 * `pagehide`, and required between tests.
 * @returns {Promise<void>}
 */
export async function closeDb() {
  const db = cachedDb;
  forgetConnection();
  if (db) {
    try { db.close(); } catch { /* already gone */ }
  }
}

/* ── schema ───────────────────────────────────────────────────────────────── */

/**
 * Create the store if it is missing, and return a handle to it either way.
 * Idempotent: an upgrade that was aborted half-way re-runs from the same
 * oldVersion, so every migration step has to tolerate being replayed.
 *
 * @param {IDBDatabase} db
 * @param {IDBTransaction} tx  the versionchange transaction
 * @param {string} name
 * @param {string} keyPath
 * @returns {IDBObjectStore}
 */
function ensureStore(db, tx, name, keyPath) {
  if (db.objectStoreNames.contains(name)) return tx.objectStore(name);
  return db.createObjectStore(name, { keyPath });
}

/**
 * Create an index if it is missing. Same idempotence rule as ensureStore().
 * @param {IDBObjectStore} store
 * @param {string} name
 * @param {string|string[]} keyPath
 * @param {IDBIndexParameters} [options]
 * @returns {IDBObjectStore} the store, for chaining
 */
function ensureIndex(store, name, keyPath, options) {
  if (!store.indexNames.contains(name)) store.createIndex(name, keyPath, options);
  return store;
}

/**
 * Bring a database at `oldVersion` up to DB_VERSION.
 *
 * The switch deliberately FALLS THROUGH: each case upgrades from its own version
 * to the next, so a database at any age catches up by running exactly the steps
 * it missed, in order. A user who skips three releases takes the same path as
 * three users who took them one at a time -- which is the only version of this
 * code that can be reasoned about once the app is out in the world.
 *
 * Rules for every case added here:
 *   - never deleteObjectStore() a store that holds user data; migrate it;
 *   - keep each step idempotent (a versionchange transaction can abort and replay);
 *   - backfill new record fields for existing rows, because a missing index key
 *     makes a record vanish from the index it should be in (an image with no
 *     `order` would silently disappear from the library).
 *
 * Exported for the tests, which drive it directly rather than through open().
 *
 * @param {IDBDatabase} db
 * @param {IDBTransaction} tx  the versionchange transaction
 * @param {number} oldVersion  0 for a fresh database
 * @returns {void}
 */
export function migrateSchema(db, tx, oldVersion) {
  switch (oldVersion) {
    case 0: {
      // v0 -> v1: the schema this app shipped with.
      const images = ensureStore(db, tx, STORE_IMAGES, 'id');
      // createdAt: "newest first" and date grouping without reading records.
      ensureIndex(images, 'createdAt', 'createdAt');
      // order: the user's manual library order. Ascending == top of the list first.
      ensureIndex(images, 'order', 'order');
      ensureStore(db, tx, STORE_KV, 'key');
    }
    /* falls through */
    case 1:
      // v1 -> v2 goes HERE, then DB_VERSION becomes 2. Nothing to do yet: a
      // database already at v1 never reaches this function.
      break;

    default:
      // open() rejects with VersionError long before we could be called with a
      // future version, so this only catches a direct/misused call -- but a
      // silent no-op there would quietly hand back a database missing stores.
      throw new Error(`unsupported database version ${oldVersion}`);
  }
}

/* ── request plumbing ─────────────────────────────────────────────────────── */

/**
 * Promise wrapper for a single IDBRequest.
 * @template T
 * @param {IDBRequest<T>} req
 * @returns {Promise<T>}
 */
function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB request failed'));
  });
}

/**
 * Promise for the whole transaction. Attach this BEFORE awaiting anything, or a
 * transaction that completes immediately (an empty read) fires `complete` before
 * we are listening.
 *
 * Writes must await this and not just the individual put(): quota-exceeded and
 * constraint failures surface at commit time, and a caller that only awaited the
 * request would report success on data that never landed.
 *
 * @param {IDBTransaction} tx
 * @returns {Promise<void>}
 */
function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('transaction failed'));
    tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
  });
}

/**
 * Run `fn` inside one transaction and resolve once that transaction has actually
 * committed.
 *
 * `fn` may await, but only on IndexedDB requests: an IDB transaction commits as
 * soon as control returns to the event loop with no request outstanding, so
 * awaiting a timer or a fetch inside it kills it. (Awaiting a request is fine --
 * the continuation runs as a microtask, before the commit check.)
 *
 * @template T
 * @param {string[]} names
 * @param {IDBTransactionMode} mode
 * @param {(tx: IDBTransaction) => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withTx(names, mode, fn) {
  let db = await openDb();
  let tx;
  try {
    tx = db.transaction(names, mode);
  } catch (err) {
    if (!err || err.name !== 'InvalidStateError') throw err;
    // The cached connection died under us -- another tab upgraded the schema, or
    // the browser evicted our storage. Same failure family as a stale GATT handle
    // after a BLE disconnect: re-acquire the handle instead of handing the user
    // an InvalidStateError they can do nothing with.
    //
    // Drop it only if it is STILL the cached one. Two calls racing on the same
    // dead handle both land here; if the second also cleared the cache it would
    // orphan the connection the first has just opened -- and an open connection
    // nobody holds a reference to can never be closed, so it blocks the next
    // tab's upgrade forever. That is the deadlock this module exists to avoid.
    if (cachedDb === db) forgetConnection();
    db = await openDb();
    tx = db.transaction(names, mode);
  }

  const done = txDone(tx);
  let result;
  try {
    result = await fn(tx);
  } catch (err) {
    try { tx.abort(); } catch { /* already finished */ }
    done.catch(() => { /* the caller gets fn's error, which is the useful one */ });
    throw err;
  }
  await done;
  return result;
}

/**
 * Walk a cursor request to exhaustion, calling `fn` on each cursor position.
 * @param {IDBRequest<IDBCursorWithValue|null>} req
 * @param {(cursor: IDBCursorWithValue) => void} fn
 * @returns {Promise<void>}
 */
function eachCursor(req, fn) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) { resolve(); return; }
      try {
        fn(cursor);
      } catch (err) {
        reject(err);
        return;
      }
      cursor.continue();
    };
    req.onerror = () => reject(req.error || new Error('cursor failed'));
  });
}

/* ── record shaping ───────────────────────────────────────────────────────── */

/** Random id. crypto.randomUUID is missing in older WebViews and some in-app browsers. */
function newId() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  if (c && typeof c.getRandomValues === 'function') {
    const b = new Uint8Array(16);
    c.getRandomValues(b);
    return Array.from(b, (n) => n.toString(16).padStart(2, '0')).join('');
  }
  return `img-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Finite number or the fallback. Guards against '' and NaN arriving from inputs. */
function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Non-empty trimmed name, or 'Untitled'. */
function cleanName(name) {
  const s = name === undefined || name === null ? '' : String(name).trim();
  return s || 'Untitled';
}

/**
 * @typedef {object} ImageRecord
 * @property {string} id
 * @property {string} name
 * @property {Blob|null} blob      the ORIGINAL upload, not the dithered result
 * @property {object} settings     crop/rotate/dither/palette choices, re-applied on render
 * @property {number} width        natural pixel width of `blob` (0 if unknown)
 * @property {number} height       natural pixel height of `blob`
 * @property {Blob|string|null} thumb  small preview for the library grid
 * @property {number} size         bytes of `blob`, for the storage readout
 * @property {number} createdAt    epoch ms
 * @property {number} updatedAt    epoch ms
 * @property {number} order        library position; ascending, lowest shown first
 */

/**
 * Build the record that actually goes into the store. Pure -- no IndexedDB, no
 * clock of its own -- so the tests can pin every field.
 *
 * On update (`existing` given) the input is merged over the stored record: only
 * fields the caller actually supplied are replaced. That lets a caller re-save
 * new settings without having to hand back the original blob it never loaded.
 *
 * @param {Partial<ImageRecord>} input
 * @param {{existing?: ImageRecord|null, now?: number, order?: number}} [ctx]
 * @returns {ImageRecord}
 */
export function shapeImageRecord(input, ctx = {}) {
  if (!input || typeof input !== 'object') {
    throw new TypeError('image record must be an object');
  }
  const existing = ctx.existing || null;
  const now = num(ctx.now, Date.now());
  const has = (key) => Object.prototype.hasOwnProperty.call(input, key) && input[key] !== undefined;
  const pick = (key, fallback) => (has(key) ? input[key] : (existing ? existing[key] : fallback));

  const blob = pick('blob', null) ?? null;
  const rec = {
    id: (existing && existing.id) || (input.id !== undefined && input.id !== null && input.id !== ''
      ? String(input.id) : newId()),
    name: cleanName(has('name') ? input.name : (existing ? existing.name : '')),
    blob,
    settings: pick('settings', null) ?? {},
    width: Math.max(0, Math.round(num(pick('width', 0), 0))),
    height: Math.max(0, Math.round(num(pick('height', 0), 0))),
    thumb: pick('thumb', null) ?? null,
    // Number(null) is 0, so the blob has to be checked before falling back to a
    // supplied size -- otherwise a blob-less record always reports 0 bytes.
    size: blob ? Math.max(0, num(blob.size, 0)) : Math.max(0, num(pick('size', 0), 0)),
    createdAt: num(existing ? existing.createdAt : input.createdAt, now),
    updatedAt: now,
    // `order` must always be a finite number: a record whose key is missing is
    // absent from the index entirely, and would vanish out of listImages().
    order: num(existing ? existing.order : (has('order') ? input.order : ctx.order), num(ctx.order, 0)),
  };
  return rec;
}

/**
 * The light projection listImages() hands back: metadata only, no blob.
 * @param {ImageRecord} rec
 * @returns {{id: string, name: string, createdAt: number, updatedAt: number,
 *            width: number, height: number, settings: object, thumb: Blob|string|null}}
 */
function imageSummary(rec) {
  return {
    id: rec.id,
    name: rec.name,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
    width: rec.width,
    height: rec.height,
    settings: rec.settings,
    thumb: rec.thumb,
  };
}

/* ── images ───────────────────────────────────────────────────────────────── */

/**
 * `order` value that puts a new image at the head of the library.
 * openKeyCursor reads the index only -- it never deserialises a record, so this
 * costs nothing even with a library full of photos.
 *
 * @param {IDBObjectStore} store
 * @returns {Promise<number>}
 */
async function headOrder(store) {
  const cursor = await request(store.index('order').openKeyCursor(null, 'next'));
  return cursor ? num(cursor.key, 0) - 1 : 0;
}

/**
 * Insert or update an image. Returns the id (generated when the record is new).
 *
 * We keep `blob` -- the file the user picked -- alongside `settings`, and NEVER
 * only the packed 1/2-bpp result. The packed bytes are a lossy dead end: they are
 * tied to one panel geometry, one palette and one dither, so re-cropping, undoing
 * a dither, or sending the same picture to a different panel would all be
 * impossible from them. Keeping the original costs storage and buys the whole
 * feature set; the render pipeline re-derives the panel bytes on demand.
 *
 * @param {Partial<ImageRecord>} rec
 * @returns {Promise<string>} the record id
 */
export async function putImage(rec) {
  if (!rec || typeof rec !== 'object') throw new TypeError('putImage(rec): rec must be an object');
  const now = Date.now();
  return withTx([STORE_IMAGES], 'readwrite', async (tx) => {
    const store = tx.objectStore(STORE_IMAGES);
    const existing = rec.id !== undefined && rec.id !== null && rec.id !== ''
      ? (await request(store.get(String(rec.id)))) || null
      : null;
    const order = existing ? existing.order : await headOrder(store);
    const shaped = shapeImageRecord(rec, { existing, now, order });
    await request(store.put(shaped));
    return shaped.id;
  });
}

/**
 * Load one image record in full, blob included.
 * @param {string} id
 * @returns {Promise<ImageRecord|null>} null when there is no such image
 */
export async function getImage(id) {
  const rec = await withTx([STORE_IMAGES], 'readonly', (tx) => (
    request(tx.objectStore(STORE_IMAGES).get(String(id)))
  ));
  return rec || null;
}

/**
 * List the library in display order: the user's manual order (see
 * reorderImages), which for a library nobody has reordered is newest first,
 * because putImage() files each new picture ahead of the existing head.
 *
 * Deliberately does NOT return blobs. A cursor hands us one record at a time and
 * we keep only the metadata, so the full-size originals never pile up in memory
 * -- a 60-picture library is tens of megabytes, and the library grid needs none
 * of it. (In IndexedDB a stored Blob deserialises as a lazy handle, so dropping
 * it here means those bytes are never read at all.)
 *
 * @returns {Promise<Array<ReturnType<typeof imageSummary>>>}
 */
export async function listImages() {
  return withTx([STORE_IMAGES], 'readonly', async (tx) => {
    const out = [];
    await eachCursor(
      tx.objectStore(STORE_IMAGES).index('order').openCursor(null, 'next'),
      (cursor) => { out.push(imageSummary(cursor.value)); }
    );
    return out;
  });
}

/**
 * Delete one image.
 * @param {string} id
 * @returns {Promise<boolean>} true if a record was actually removed
 */
export async function deleteImage(id) {
  const key = String(id);
  return withTx([STORE_IMAGES], 'readwrite', async (tx) => {
    const store = tx.objectStore(STORE_IMAGES);
    // count(key) answers from the key alone; get() would deserialise the whole
    // record, blob and all, just to find out whether it exists.
    const existed = (await request(store.count(key))) > 0;
    await request(store.delete(key));
    return existed;
  });
}

/**
 * Rename an image. Read and write happen in one transaction so a rename cannot
 * lose a concurrent settings save.
 * @param {string} id
 * @param {string} name
 * @returns {Promise<string>} the stored (trimmed) name
 * @throws if there is no such image
 */
export async function renameImage(id, name) {
  const key = String(id);
  return withTx([STORE_IMAGES], 'readwrite', async (tx) => {
    const store = tx.objectStore(STORE_IMAGES);
    const rec = await request(store.get(key));
    if (!rec) throw new Error(`renameImage: no image with id ${key}`);
    rec.name = cleanName(name);
    rec.updatedAt = Date.now();
    await request(store.put(rec));
    return rec.name;
  });
}

/**
 * Rewrite the library order.
 *
 * `idsInOrder` need not be complete: ids it omits keep their current relative
 * order and follow the ones it names. Unknown ids are ignored. Records that
 * somehow lost their `order` key (a hand-edited backup, an interrupted upgrade)
 * are healed here -- they are invisible to listImages() until they have one.
 *
 * Does not touch `updatedAt`: dragging a tile around is not an edit of the
 * picture, and bumping it would reshuffle any date-sorted view.
 *
 * @param {string[]} idsInOrder
 * @returns {Promise<number>} how many records the library now holds
 */
export async function reorderImages(idsInOrder) {
  if (!Array.isArray(idsInOrder)) {
    throw new TypeError('reorderImages(idsInOrder): expected an array of ids');
  }
  return withTx([STORE_IMAGES], 'readwrite', async (tx) => {
    const store = tx.objectStore(STORE_IMAGES);
    // Keys only: current order, and then every key at all, both without reading a
    // single record body.
    const ordered = await request(store.index('order').getAllKeys());
    const allKeys = await request(store.getAllKeys());
    const known = new Set(allKeys.map(String));

    const wanted = [];
    const placed = new Set();
    const place = (id) => {
      const key = String(id);
      if (placed.has(key) || !known.has(key)) return;
      placed.add(key);
      wanted.push(key);
    };
    idsInOrder.forEach(place);
    ordered.forEach(place);
    // Anything still unplaced is missing from the `order` index; appending it
    // here gives it an order and brings it back into the library.
    allKeys.forEach(place);

    // Only the records that actually moved get rewritten: each put() re-stores a
    // record that carries a full-size photo, and a drag of one tile must not
    // rewrite the whole library to change one number.
    for (let i = 0; i < wanted.length; i++) {
      const rec = await request(store.get(wanted[i]));
      if (!rec || rec.order === i) continue;
      rec.order = i;
      await request(store.put(rec));
    }
    return wanted.length;
  });
}

/* ── settings and the automation program ──────────────────────────────────── */

/**
 * Read one setting.
 * @param {string} key
 * @param {*} [fallback] returned when the key has never been written
 * @returns {Promise<*>}
 */
export async function getSetting(key, fallback = undefined) {
  const rec = await withTx([STORE_KV], 'readonly', (tx) => (
    request(tx.objectStore(STORE_KV).get(String(key)))
  ));
  // A stored `undefined` means the same thing to a caller as no row at all, and
  // it is easy to write one (putSetting(key, form.value) on an empty field). Only
  // `null` is a real stored value here, so it must still beat the fallback.
  return rec && rec.value !== undefined ? rec.value : fallback;
}

/**
 * Write one setting. `value` must be structured-cloneable (plain JSON, typed
 * arrays and Blobs are all fine; functions and DOM nodes are not).
 * @param {string} key
 * @param {*} value
 * @returns {Promise<void>}
 */
export async function putSetting(key, value) {
  const rec = { key: String(key), value, updatedAt: Date.now() };
  await withTx([STORE_KV], 'readwrite', (tx) => request(tx.objectStore(STORE_KV).put(rec)));
}

/**
 * Save the automation program (see js/automation.js for the block shapes). Stored
 * whole, under one kv key, because it is edited and read as one document.
 * @param {object|Array} program
 * @returns {Promise<void>}
 */
export async function saveProgram(program) {
  await putSetting(PROGRAM_KEY, program === undefined ? null : program);
}

/**
 * Load the automation program.
 * @returns {Promise<object|Array|null>} null when nothing has been saved
 */
export async function loadProgram() {
  const program = await getSetting(PROGRAM_KEY, null);
  return program === undefined ? null : program;
}

/* ── base64 (for the backup file) ─────────────────────────────────────────── */

const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Reverse lookup, including the URL-safe aliases so a hand-edited backup still loads. */
const B64_VALUES = (() => {
  const table = new Int16Array(256).fill(-1);
  for (let i = 0; i < B64_CHARS.length; i++) table[B64_CHARS.charCodeAt(i)] = i;
  table['-'.charCodeAt(0)] = 62;
  table['_'.charCodeAt(0)] = 63;
  return table;
})();

/**
 * Every 12-bit group as the two base64 characters it encodes. 4096 short strings
 * built once at import (pure data -- no globals touched), which turns the inner
 * loop into two array reads per three bytes instead of four shifts and masks.
 */
const B64_PAIRS = (() => {
  const table = new Array(4096);
  for (let i = 0; i < 4096; i++) table[i] = B64_CHARS[i >> 6] + B64_CHARS[i & 63];
  return table;
})();

/** Characters buffered before a join(). Sized to stay well inside the young heap. */
const B64_FLUSH = 8192;

/**
 * Bytes -> base64.
 *
 * Hand-rolled rather than btoa(): btoa needs a binary *string*, and building one
 * from a 10 MB photo via String.fromCharCode(...bytes) blows the argument limit
 * and throws.
 *
 * The batching is not premature: a whole-library backup is tens of megabytes, it
 * runs on the main thread from a button press, and `out += c` builds a rope that
 * V8 has to flatten. Emitting fixed-size batches and joining once measured ~7x
 * faster on a 10 MB buffer (1215 ms -> 158 ms) -- the difference between a phone
 * that looks busy and one that looks hung.
 *
 * @param {Uint8Array} bytes
 * @returns {string} standard base64, '=' padded
 */
export function bytesToBase64(bytes) {
  const len = bytes.length;
  const whole = len - (len % 3);   // the triplets; 1 or 2 trailing bytes are padded below
  const parts = [];
  let chunk = [];
  for (let i = 0; i < whole; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    chunk.push(B64_PAIRS[n >>> 12], B64_PAIRS[n & 0xfff]);
    if (chunk.length >= B64_FLUSH) {
      parts.push(chunk.join(''));
      chunk = [];
    }
  }
  if (chunk.length) parts.push(chunk.join(''));

  const rest = len - whole;
  if (rest === 1) {
    // 8 bits -> one full char plus 4 zero-padded bits, then '=='.
    parts.push(B64_PAIRS[(bytes[whole] << 16) >>> 12] + '==');
  } else if (rest === 2) {
    const n = (bytes[whole] << 16) | (bytes[whole + 1] << 8);
    parts.push(B64_PAIRS[n >>> 12] + B64_PAIRS[n & 0xfff][0] + '=');
  }
  return parts.join('');
}

/**
 * base64 -> bytes. Ignores whitespace, newlines and padding, so a backup that
 * went through an editor or an email client still decodes.
 * @param {string} text
 * @returns {Uint8Array}
 */
export function base64ToBytes(text) {
  const s = String(text);
  const out = new Uint8Array((s.length * 3) >> 2);
  let n = 0;
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < s.length; i++) {
    const v = B64_VALUES[s.charCodeAt(i) & 0xff];
    if (v < 0) continue;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[n++] = (acc >> bits) & 0xff;
    }
  }
  return n === out.length ? out : out.slice(0, n);
}

/* ── export / import ──────────────────────────────────────────────────────── */

/** Deepest object nesting encode/decode will follow. Also stops a cyclic value. */
const MAX_ENCODE_DEPTH = 8;

function isPlainObject(value) {
  if (!value || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Make one stored value JSON-safe. Blobs and typed arrays become tagged objects
 * carrying base64; everything else is walked and copied.
 * @param {*} value
 * @param {number} [depth]
 * @returns {Promise<*>}
 */
async function encodeValue(value, depth = 0) {
  if (value === null || typeof value !== 'object') return value;
  if (depth > MAX_ENCODE_DEPTH) return null;

  const B = globalThis.Blob;
  if (B && value instanceof B) {
    const bytes = new Uint8Array(await value.arrayBuffer());
    return { __type: 'blob', mime: value.type || '', data: bytesToBase64(bytes) };
  }
  if (value instanceof ArrayBuffer) {
    return { __type: 'bytes', data: bytesToBase64(new Uint8Array(value)) };
  }
  if (ArrayBuffer.isView(value)) {
    const view = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return { __type: 'bytes', data: bytesToBase64(view) };
  }
  if (value instanceof Date) return { __type: 'date', iso: value.toISOString() };
  if (Array.isArray(value)) {
    const out = [];
    for (const item of value) out.push(await encodeValue(item, depth + 1));
    return out;
  }
  if (isPlainObject(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = await encodeValue(v, depth + 1);
    return out;
  }
  // Anything else (Map, Set, a class instance) is not part of our on-disk format.
  return null;
}

/**
 * Inverse of encodeValue. Values that are already live (a real Blob handed
 * straight back in an in-memory round trip) pass through untouched.
 * @param {*} value
 * @param {number} [depth]
 * @returns {*}
 */
function decodeValue(value, depth = 0) {
  if (value === null || typeof value !== 'object') return value;
  if (depth > MAX_ENCODE_DEPTH) return null;

  const B = globalThis.Blob;
  if (B && value instanceof B) return value;
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return value;
  // A live Date reaches here only from a hand-built object (exportAll tags its
  // own). Without this it falls through to the plain-object test, fails it, and
  // becomes null -- a silent data loss for one line of passthrough.
  if (value instanceof Date) return value;

  if (typeof value.__type === 'string') {
    if (value.__type === 'blob') {
      const bytes = base64ToBytes(value.data || '');
      // Blob is global in browsers and in Node 18+. If some exotic runtime lacks
      // it, keep the bytes rather than dropping the picture on the floor.
      return B ? new B([bytes], { type: value.mime || '' }) : bytes;
    }
    if (value.__type === 'bytes') return base64ToBytes(value.data || '');
    if (value.__type === 'date') return new Date(value.iso);
    return null;
  }

  if (Array.isArray(value)) return value.map((item) => decodeValue(item, depth + 1));
  if (isPlainObject(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = decodeValue(v, depth + 1);
    return out;
  }
  return null;
}

/**
 * Everything the user owns, as one JSON-serialisable object with blobs base64
 * encoded. This is the entire backup story for an app with no server: whatever
 * is missing here is data the user can never get off the phone.
 *
 * @returns {Promise<object>}
 */
export async function exportAll() {
  const { images, kv } = await withTx([STORE_IMAGES, STORE_KV], 'readonly', async (tx) => {
    // getAll() on the store, not on the `order` index: an index skips records
    // whose key is missing, and a backup that quietly drops a damaged record is
    // worse than useless. Sorting happens below, in JS.
    const imgs = await request(tx.objectStore(STORE_IMAGES).getAll());
    const kvs = await request(tx.objectStore(STORE_KV).getAll());
    return { images: imgs, kv: kvs };
  });

  images.sort((a, b) => (
    num(a.order, Number.MAX_SAFE_INTEGER) - num(b.order, Number.MAX_SAFE_INTEGER)
    || num(b.createdAt, 0) - num(a.createdAt, 0)
  ));

  const settings = {};
  let program = null;
  for (const rec of kv) {
    if (!rec || rec.key === undefined) continue;
    if (rec.key === PROGRAM_KEY) program = await encodeValue(rec.value);
    else settings[rec.key] = await encodeValue(rec.value);
  }

  const out = [];
  for (const rec of images) out.push(await encodeValue(rec));

  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    dbVersion: DB_VERSION,
    exportedAt: new Date().toISOString(),
    images: out,
    settings,
    program,
  };
}

/**
 * Restore a backup produced by exportAll().
 *
 * `opts.merge` false (the default) REPLACES everything: both stores are cleared
 * and the backup is written back verbatim, ids included. Ids have to survive,
 * because the automation program addresses pictures by id -- renumbering them on
 * restore would turn every saved program into a list of dangling references.
 *
 * `opts.merge` true adds the backup to the current library and keeps the local
 * copy of any id that already exists. That makes re-importing the same file a
 * no-op instead of a duplicate library, and it is the reason ids are not
 * reissued on collision.
 *
 * Everything is decoded before the transaction opens: an IDB transaction dies if
 * you await anything that is not one of its own requests.
 *
 * @param {object} obj  the parsed backup
 * @param {{merge?: boolean}} [opts]
 * @returns {Promise<{images: number, imagesSkipped: number, imagesInvalid: number,
 *                    settings: number, program: boolean}>}
 *   images written, ids already present (merge only), rows too damaged to read,
 *   settings written (the program is not counted among them), and whether a
 *   program came with it
 */
export async function importAll(obj, opts = {}) {
  if (!obj || typeof obj !== 'object') {
    throw new TypeError('importAll(obj): expected the parsed contents of a backup file');
  }
  if (obj.format !== undefined && obj.format !== EXPORT_FORMAT) {
    throw new Error('that file is not a Web FindXeink F15 backup');
  }
  if (num(obj.version, 0) > EXPORT_VERSION) {
    throw new Error('that backup was written by a newer version of this app');
  }

  const merge = Boolean(opts && opts.merge);
  const now = Date.now();

  // Decode and re-shape first. Re-shaping is what makes an OLD backup importable
  // into a NEW schema: missing fields (a record from before `order` existed) get
  // filled in here rather than silently disappearing from the library later.
  const rawImages = Array.isArray(obj.images) ? obj.images : [];
  const images = [];
  let invalid = 0;
  rawImages.forEach((raw, i) => {
    const decoded = decodeValue(raw);
    // One corrupt row in a hand-edited file must not cost the user the other
    // ninety-nine pictures, so count it and carry on rather than throwing.
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
      invalid++;
      return;
    }
    images.push(shapeImageRecord(decoded, {
      existing: null,
      now: num(decoded.updatedAt, now),
      order: num(decoded.order, i),
    }));
  });

  const settings = [];
  if (obj.settings && typeof obj.settings === 'object') {
    for (const [key, value] of Object.entries(obj.settings)) {
      if (key === PROGRAM_KEY) continue;  // the program has its own slot
      settings.push({ key: String(key), value: decodeValue(value), updatedAt: now });
    }
  }
  // Counted before the program is appended. The program shares the kv store but is
  // reported on its own, so the counts line up with exportAll's {settings, program}
  // split rather than quietly reporting one more setting than the file contains.
  const settingCount = settings.length;
  const hasProgram = obj.program !== undefined && obj.program !== null;
  if (hasProgram) {
    settings.push({ key: PROGRAM_KEY, value: decodeValue(obj.program), updatedAt: now });
  }

  return withTx([STORE_IMAGES, STORE_KV], 'readwrite', async (tx) => {
    const imageStore = tx.objectStore(STORE_IMAGES);
    const kvStore = tx.objectStore(STORE_KV);

    if (!merge) {
      await request(imageStore.clear());
      await request(kvStore.clear());
    }

    // Merging appends: shift the incoming records past whatever is already there
    // so the existing library keeps its order.
    const base = merge ? await request(imageStore.count()) : 0;

    let written = 0;
    let skipped = 0;
    for (let i = 0; i < images.length; i++) {
      const rec = images[i];
      if (merge) {
        if ((await request(imageStore.count(rec.id))) > 0) { skipped++; continue; }
        rec.order = base + i;
      }
      await request(imageStore.put(rec));
      written++;
    }
    for (const rec of settings) await request(kvStore.put(rec));

    return {
      images: written,
      imagesSkipped: skipped,
      imagesInvalid: invalid,
      settings: settingCount,
      program: hasProgram,
    };
  });
}

/* ── quota ────────────────────────────────────────────────────────────────── */

/**
 * How much storage this origin is using, and how much it may use.
 *
 * Read-only by design: navigator.storage.persist() is NOT called here. Asking for
 * persistence can raise a permission prompt, and one that appears while the user
 * is doing something else gets denied -- permanently, on some browsers. The UI
 * asks for it deliberately, from a button, or not at all.
 *
 * @returns {Promise<{usage: number|null, quota: number|null}|null>} null where the
 *   API does not exist (Node, older WebViews, non-secure contexts)
 */
export async function estimateUsage() {
  const nav = globalThis.navigator;
  const storage = nav && nav.storage;
  if (!storage || typeof storage.estimate !== 'function') return null;
  try {
    const est = await storage.estimate();
    return {
      usage: num(est && est.usage, null),
      quota: num(est && est.quota, null),
    };
  } catch {
    // Firefox in private mode throws here rather than returning zeroes.
    return null;
  }
}
