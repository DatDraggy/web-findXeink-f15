/**
 * Web FindXeink F15 — application glue.
 *
 * Wires the views to device.js (transport), render.js (pixels), storage.js
 * (library) and runner.js (automation). Everything below is UI; the interesting
 * logic lives in those modules.
 */

import { Device, charProps } from './device.js';
import { Runner, RunnerState } from './runner.js';
import * as store from './storage.js';
import * as auto from './automation.js';
import { INKS, DITHERS } from './image.js';
import { vcard, wifi } from './qrcode.js';
import {
  render, renderIndices, paintPreview, makeThumb, decodeBlob,
  photoTarget, DEFAULT_SETTINGS, TEST_PATTERNS,
} from './render.js';
import { CropEditor } from './crop.js';
import { hex, parseHex, esc, uid, humanBytes, humanDuration, sleep } from './util.js';
import { OP, buildFrame, SEQ_MARK } from './protocol.js';

const VERSION = '1.0.0';
const $ = (id) => document.getElementById(id);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const dev = new Device();
let runner = null;

const app = {
  panel: { width: 200, height: 200, type: 1, bpp: 2, model: 3, source: 'default' },
  settings: { ...DEFAULT_SETTINGS },
  source: { kind: 'image', bitmap: null },
  sourceBlob: null,
  editingId: null,
  library: [],
  selectedId: null,
  program: { blocks: [] },
  lastRendered: null,
  logLines: [],
};

// ─────────────────────────────────────────────────────────────── chrome

let toastTimer = 0;
function toast(msg, kind = '') {
  const el = $('toast');
  el.textContent = msg;
  el.className = `show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ''; }, 3200);
}

function showView(name) {
  $$('#nav button').forEach((b) => b.classList.toggle('on', b.dataset.view === name));
  $$('main > section').forEach((s) => s.classList.toggle('on', s.id === `view-${name}`));
  window.scrollTo(0, 0);
  if (name === 'library') refreshLibrary();
  if (name === 'automate') renderProgram();
}

$$('#nav button').forEach((b) => { b.onclick = () => showView(b.dataset.view); });

function runLog(level, msg) {
  const t = new Date().toTimeString().slice(0, 8);
  const mark = { err: '!', warn: '~', ok: '+', rx: '<', tx: '>' }[level] || '.';
  app.logLines.push(`${t} ${mark} ${msg}`);
  if (app.logLines.length > 400) app.logLines.shift();
  const el = $('run-log');
  el.textContent = app.logLines.join('\n');
  el.scrollTop = el.scrollHeight;
}

// ─────────────────────────────────────────────────────────────── device

function updateConnUI() {
  const on = dev.connected;
  $('conn-dot').className = `dot${on ? ' on' : ''}`;
  $('conn-text').textContent = on ? (dev.name || 'Connected') : (dev.device ? 'Disconnected' : 'Not connected');
  $('btn-disconnect').hidden = !on;
  $('btn-reconnect').hidden = on || !dev.device;
  $('btn-connect').textContent = dev.device && !on ? 'Connect' : 'Find my display';

  $('dev-table').innerHTML = dev.device ? `
    <tr><th>Name</th><td class="mono">${esc(dev.name || '(unnamed)')}</td></tr>
    <tr><th>Status</th><td>${on ? '<span class="pill ok">connected</span>' : '<span class="pill idle">idle</span>'}</td></tr>
    <tr><th>Panel</th><td class="mono">${app.panel.width}×${app.panel.height} · ${app.panel.bpp} bpp</td></tr>` : '';
}

dev.addEventListener('state', updateConnUI);
dev.addEventListener('log', (e) => {
  const { level, msg } = e.detail;
  runLog(level, msg);
  if (level === 'err') toast(msg, 'bad');
});
dev.addEventListener('panel', (e) => {
  applyPanel(e.detail);
  toast(`Panel detected: ${e.detail.width}×${e.detail.height}`, 'ok');
});
dev.addEventListener('frame', (e) => {
  const { bytes, frame } = e.detail;
  const el = $('con-log');
  const line = `${new Date().toTimeString().slice(0, 8)}  ${hex(bytes)}\n   ${
    frame ? `${frame.opName}${frame.statusName ? ` — ${frame.statusName}` : ''}${frame.crcOk === false ? '  [CRC BAD]' : ''}` : '(unparsed)'}`;
  el.textContent = (el.textContent.startsWith('No frames') ? '' : `${el.textContent}\n`) + line;
  el.scrollTop = el.scrollHeight;
});

function applyPanel(p) {
  app.panel = { ...app.panel, ...p };
  $('panel-w').value = app.panel.width;
  $('panel-h').value = app.panel.height;
  $('panel-bpp').value = String(app.panel.bpp);
  $('panel-model').value = String(app.panel.model);
  $('panel-source').textContent = app.panel.source === 'advertisement' ? 'read from the device' : '';
  store.putSetting('panel', app.panel).catch(() => {});
  updateConnUI();
  syncCropAspect();
  schedulePreview();
}

$('btn-connect').onclick = async () => {
  try {
    if (!dev.device) await dev.request();
    await dev.connect();
    toast('Connected', 'ok');
  } catch (e) {
    if (e?.name !== 'NotFoundError') toast(e.message, 'bad');
    else toast('No device chosen');
  }
};
$('btn-pick-all').onclick = async () => {
  try { await dev.request({ all: true }); await dev.connect(); toast('Connected', 'ok'); }
  catch (e) { if (e?.name !== 'NotFoundError') toast(e.message, 'bad'); }
};
$('btn-reconnect').onclick = async () => {
  const ok = await dev.ensureConnected();
  toast(ok ? 'Connected' : 'Could not reconnect', ok ? 'ok' : 'bad');
};
$('btn-disconnect').onclick = () => dev.disconnect();

for (const id of ['panel-w', 'panel-h', 'panel-bpp', 'panel-model']) {
  $(id).onchange = () => {
    app.panel = {
      ...app.panel,
      width: Math.max(1, +$('panel-w').value | 0),
      height: Math.max(1, +$('panel-h').value | 0),
      bpp: +$('panel-bpp').value,
      model: +$('panel-model').value,
      source: 'manual',
    };
    applyPanel(app.panel);
  };
}

// ─────────────────────────────────────────────────────────────── studio

function buildInkToggles() {
  $('ink-toggles').innerHTML = INKS.map((ink) => `
    <label class="ink-toggle" data-ink="${ink.id}">
      <input type="checkbox" value="${ink.id}" checked>
      <span class="sw"></span>${esc(ink.label || ink.id)}
    </label>`).join('');
  // Via CSSOM, not a style="" attribute: the Content-Security-Policy blocks
  // inline style attributes, so the swatches would render transparent.
  $$('#ink-toggles .ink-toggle').forEach((label) => {
    const ink = INKS.find((i) => i.id === label.dataset.ink);
    if (ink) label.querySelector('.sw').style.background = `rgb(${ink.rgb.join(',')})`;
  });
  $$('#ink-toggles input').forEach((cb) => {
    cb.onchange = () => {
      cb.closest('.ink-toggle').classList.toggle('off', !cb.checked);
      app.settings.inks = $$('#ink-toggles input').filter((c) => c.checked).map((c) => c.value);
      if (!app.settings.inks.length) { cb.checked = true; cb.closest('.ink-toggle').classList.remove('off'); app.settings.inks = [cb.value]; }
      schedulePreview();
    };
  });
}

function buildTestPatterns() {
  $('test-pattern').innerHTML = TEST_PATTERNS.map((p) => `<option value="${p.id}">${esc(p.label)}</option>`).join('');
}

function buildDitherOptions() {
  if (!DITHERS?.length) return;
  $('set-dither').innerHTML = DITHERS.map((d) => `<option value="${d.id}">${esc(d.label)}</option>`).join('');
  $('set-dither').value = app.settings.dither;
}

const SLIDERS = ['brightness', 'contrast', 'saturation', 'gamma', 'strength'];
function wireSettings() {
  for (const k of SLIDERS) {
    const el = $(`set-${k}`);
    el.oninput = () => {
      $(`lbl-${k}`).textContent = el.value;
      app.settings[k] = k === 'strength' ? +el.value / 100 : +el.value;
      schedulePreview();
    };
  }
  for (const k of ['fit', 'rotate', 'dither']) {
    $(`set-${k}`).onchange = () => {
      app.settings[k] = k === 'rotate' ? +$(`set-${k}`).value : $(`set-${k}`).value;
      // A quarter turn swaps the target's shape, so the crop window has to follow.
      if (k === 'rotate') syncCropAspect();
      schedulePreview();
    };
  }
  $('set-circle').onchange = () => { app.settings.circleMask = $('set-circle').checked; schedulePreview(); };
  $('btn-reset-settings').onclick = () => {
    app.settings = { ...DEFAULT_SETTINGS };
    syncSettingsUI();
    syncCropAspect();
    if (app.source.bitmap) cropper.reset();   // also republishes settings.crop
    schedulePreview();
  };
}

function syncSettingsUI() {
  for (const k of SLIDERS) {
    const v = k === 'strength' ? Math.round(app.settings.strength * 100) : app.settings[k];
    $(`set-${k}`).value = v;
    $(`lbl-${k}`).textContent = v;
  }
  $('set-fit').value = app.settings.fit;
  $('set-rotate').value = String(app.settings.rotate);
  $('set-dither').value = app.settings.dither;
  $('set-circle').checked = !!app.settings.circleMask;
  $$('#ink-toggles input').forEach((cb) => {
    cb.checked = app.settings.inks.includes(cb.value);
    cb.closest('.ink-toggle').classList.toggle('off', !cb.checked);
  });
}

/**
 * "Editing" means the user opened an existing library item — only then does Save
 * overwrite it. Changing the *source* (a different photo, a different pattern,
 * new text) always makes a new item, because silently replacing the picture the
 * user just saved is the kind of data loss nobody forgives.
 *
 * Adjusting settings (dither, brightness…) deliberately does NOT clear it: that
 * is iterating on the same picture, and each tweak spawning a duplicate would be
 * just as annoying in the other direction.
 */
function setEditing(id) {
  app.editingId = id || null;
  const item = id ? app.library.find((i) => i.id === id) : null;
  $('btn-save').textContent = item ? `Update “${item.name}”` : 'Save to library';
  $('btn-save-send').textContent = item ? 'Update and send' : 'Save and send';
}

function currentSourceKind() { return $('src-kind').value; }

function showSourceFields() {
  const kind = currentSourceKind();
  $$('[data-src]').forEach((el) => { el.hidden = el.dataset.src !== kind; });
  // Photo-only controls make no sense for synthetic sources, which are drawn
  // directly in palette colours and never dithered.
  $('adjust-card').hidden = kind !== 'image';
}

function qrPayload() {
  const kind = $('qr-kind').value;
  if (kind === 'vcard') {
    return vcard({
      name: $('qr-name').value, org: $('qr-org').value,
      phone: $('qr-phone').value, email: $('qr-email').value, url: $('qr-url').value,
    });
  }
  if (kind === 'wifi') {
    return wifi({ ssid: $('qr-ssid').value, password: $('qr-pass').value, security: $('qr-sec').value });
  }
  return $('qr-text').value;
}

function buildSource() {
  const kind = currentSourceKind();
  switch (kind) {
    case 'text':
      return {
        kind: 'text', text: $('src-text').value,
        align: $('src-text-align').value, fg: $('src-text-fg').value,
        bg: $('src-text-bg').value, bold: $('src-text-bold').checked,
      };
    case 'qr':
      return { kind: 'qr', text: qrPayload(), ecc: $('qr-ecc').value };
    case 'clock':
      return { kind: 'clock', format: $('clock-format').value, fg: 'black', bg: 'white', bold: true };
    case 'test':
      return { kind: 'test', pattern: $('test-pattern').value };
    default:
      return { kind: 'image', bitmap: app.source.bitmap };
  }
}

/** A JSON-safe description of the source, for the library. */
function serializeSource(src) {
  const { bitmap, ...rest } = src;
  return rest;
}

/**
 * Fit the preview to the width available AND to a slice of the viewport height,
 * so the pinned card cannot grow tall enough to push the sliders off screen.
 * Sized in JS because a canvas has an intrinsic size, and letting CSS clamp only
 * one axis would either distort it or refuse to scale it up.
 */
function sizePreview(w, h) {
  const canvas = $('preview');
  const wrap = canvas.parentElement;
  const availW = Math.max(80, wrap.clientWidth - 28);
  const availH = Math.max(120, window.innerHeight * 0.30);
  const scale = Math.max(1, Math.min(availW / w, availH / h, 4));
  canvas.style.width = `${Math.round(w * scale)}px`;
  canvas.style.height = `${Math.round(h * scale)}px`;
}

/**
 * The sticky preview has to clear whatever is pinned above it: the header always,
 * plus the nav bar on wide screens where it sits below the header rather than at
 * the bottom of the screen.
 */
function updateStickyOffset() {
  const header = document.querySelector('header');
  const nav = $('nav');
  const headerH = header?.offsetHeight || 52;
  const navIsTop = getComputedStyle(nav).position === 'sticky';
  document.documentElement.style.setProperty('--nav-top', `${headerH}px`);
  const top = headerH + (navIsTop ? nav.offsetHeight : 0);
  document.documentElement.style.setProperty('--stick-top', `${top}px`);
}

let previewTimer = 0;
function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(doPreview, 90);
}

function doPreview() {
  const src = buildSource();
  app.source = src;
  if (src.kind === 'image' && !src.bitmap) {
    $('preview-meta').textContent = 'no picture chosen';
    return;
  }
  try {
    const out = render(src, app.panel, app.settings);
    app.lastRendered = out;
    paintPreview($('preview'), out.indices, out.palette, out.width, out.height);
    sizePreview(out.width, out.height);
    $('preview-meta').textContent = `${out.width}×${out.height} · ${out.packed.length} bytes`;
  } catch (e) {
    $('preview-meta').textContent = `error: ${e.message}`;
  }
}

$('src-kind').onchange = () => { setEditing(null); showSourceFields(); schedulePreview(); };
$('qr-kind').onchange = () => {
  $$('[data-qr]').forEach((el) => { el.hidden = el.dataset.qr !== $('qr-kind').value; });
  setEditing(null);
  schedulePreview();
};
for (const id of ['src-text', 'src-text-align', 'src-text-fg', 'src-text-bg', 'src-text-bold',
  'qr-text', 'qr-name', 'qr-org', 'qr-phone', 'qr-email', 'qr-url', 'qr-ssid', 'qr-pass',
  'qr-sec', 'qr-ecc', 'clock-format', 'test-pattern']) {
  $(id).addEventListener('input', () => { setEditing(null); schedulePreview(); });
}

// ─────────────────────────────────────────────────────────────── cropping

let cropper = null;

/** The crop window must match the shape the photo will actually be drawn into. */
function syncCropAspect() {
  const { dw, dh } = photoTarget(app.panel.width, app.panel.height, app.settings.rotate);
  document.documentElement.style.setProperty('--crop-aspect', `${dw} / ${dh}`);
  // Let the element take its new size before the editor measures it.
  requestAnimationFrame(() => cropper?.refit());
}

function initCropper() {
  cropper = new CropEditor($('crop-canvas'), {
    onChange: () => {
      app.settings.crop = cropper.getCrop();
      $('lbl-zoom').textContent = `${cropper.zoomPercent}%`;
      $('crop-zoom').value = String(Math.min(400, cropper.zoomPercent));
      schedulePreview();
    },
  });
  $('crop-zoom').oninput = () => cropper.setZoomPercent(+$('crop-zoom').value);
  $('btn-crop-reset').onclick = () => {
    cropper.reset();
    toast('Crop reset');
  };
}

async function loadPhoto(blob, { crop = null } = {}) {
  app.sourceBlob = blob;
  app.source.bitmap = await decodeBlob(blob);
  $('crop-box').hidden = false;
  syncCropAspect();
  cropper.setImage(app.source.bitmap);
  if (crop) {
    cropper.setCrop(crop);
    app.settings.crop = crop;
  } else {
    app.settings.crop = cropper.getCrop();
  }
  $('lbl-zoom').textContent = `${cropper.zoomPercent}%`;
  $('crop-zoom').value = String(Math.min(400, cropper.zoomPercent));
}

$('src-file').onchange = async (e) => {
  const f = e.target.files?.[0];
  if (!f) return;
  try {
    setEditing(null);
    await loadPhoto(f);
    schedulePreview();
  } catch (err) { toast(err.message, 'bad'); }
};

// ─────────────────────────────────────────────────────────────── sending

/**
 * The display holds two screens. The main one is what you normally see; the
 * "contact" screen is a second stored image that the firmware swaps to when you
 * double-press the device's single button. They are written with different
 * opcodes — A1/A2 and C1/C2 — and are otherwise identical transfers.
 */
async function sendPacked(packed, family = 'picture') {
  if (!dev.connected) {
    const ok = await dev.ensureConnected({ attempts: 1 });
    if (!ok) { toast('Not connected', 'bad'); return null; }
  }
  $('send-bar').style.width = '0%';
  const res = await dev.send(packed, {
    family,
    chunkSize: Math.max(1, +$('opt-chunk').value | 0),
    obfuscate: $('opt-obfuscate').checked,
    onProgress: (done, total) => {
      $('send-bar').style.width = `${((done / total) * 100).toFixed(1)}%`;
      $('send-status').textContent = `chunk ${done} / ${total}`;
    },
  });
  $('send-status').innerHTML = res.ok
    ? `<span class="pill ok">accepted</span> ${(res.ms / 1000).toFixed(1)} s`
    : `<span class="pill bad">${esc(res.statusName || res.reason || 'no reply')}</span>`;
  return res;
}

$('btn-send').onclick = async () => {
  if (!app.lastRendered) { toast('Nothing to send yet'); return; }
  $('btn-send').disabled = true;
  const family = $('send-family').value;
  try {
    const res = await sendPacked(app.lastRendered.packed, family);
    if (res) {
      toast(res.ok
        ? (family === 'card' ? 'Sent — double-press the button to see it' : 'Sent — the panel takes a few seconds')
        : 'Not confirmed', res.ok ? 'ok' : 'bad');
    }
  } catch (e) { toast(e.message, 'bad'); }
  finally { $('btn-send').disabled = false; }
};

// ────────────────────────────────────────────────────────────── library

async function saveCurrent() {
  if (!app.lastRendered) { toast('Nothing to save'); return null; }
  const src = serializeSource(app.source);
  const thumb = await makeThumb(app.lastRendered.indices, app.lastRendered.palette,
    app.lastRendered.width, app.lastRendered.height);
  const name = defaultName(src);
  const id = await store.putImage({
    id: app.editingId || undefined,
    name,
    blob: app.sourceBlob || null,
    // The destination screen travels with the picture, so sending it again from
    // the library — or from an automation — lands where the user meant it to.
    settings: { ...app.settings, source: src, family: $('send-family').value },
    width: app.panel.width,
    height: app.panel.height,
    thumb,
  });
  // Claim the id straight away. refreshLibrary() below is slow enough (it reads
  // every record and mints thumbnail URLs) that a quick user can change the
  // picture in the gap — and if the id landed after that, their next save would
  // silently overwrite the one they just made.
  const wasUpdate = !!app.editingId;
  app.editingId = id;
  toast(wasUpdate ? 'Updated' : 'Saved to library', 'ok');
  await refreshLibrary();
  // Only relabel if the user has not moved on in the meantime.
  if (app.editingId === id) setEditing(id);
  return id;
}

function defaultName(src) {
  switch (src.kind) {
    case 'text': return (src.text || 'Text').split('\n')[0].slice(0, 28) || 'Text';
    case 'qr': return 'QR code';
    case 'clock': return 'Clock';
    case 'test': return `Test — ${src.pattern}`;
    default: return app.sourceBlob?.name?.replace(/\.[^.]+$/, '') || 'Picture';
  }
}

$('btn-save').onclick = () => saveCurrent();
$('btn-save-send').onclick = async () => {
  await saveCurrent();
  $('btn-send').click();
};

async function refreshLibrary() {
  app.library = await store.listImages();
  const grid = $('lib-grid');
  $('lib-count').textContent = app.library.length ? `${app.library.length} item(s)` : '';
  $('lib-empty').hidden = app.library.length > 0;
  grid.innerHTML = app.library.map((it) => `
    <div class="tile${it.id === app.selectedId ? ' sel' : ''}" data-id="${esc(it.id)}">
      ${it.thumbUrl ? `<img src="${it.thumbUrl}" alt="">` : '<img alt="">'}
      <div class="nm">${esc(it.name)}</div>
    </div>`).join('');

  // Object URLs for the thumbnails are created here and revoked on the next pass.
  for (const it of app.library) {
    if (it.thumb instanceof Blob) {
      const el = grid.querySelector(`.tile[data-id="${CSS.escape(it.id)}"] img`);
      if (el) el.src = URL.createObjectURL(it.thumb);
    }
  }
  $$('#lib-grid .tile').forEach((t) => {
    t.onclick = () => { app.selectedId = t.dataset.id; refreshLibrary(); };
  });
  const sel = app.library.find((i) => i.id === app.selectedId);
  $('lib-actions').hidden = !sel;
  if (sel) {
    $('lib-selected-meta').textContent = `${sel.name} · ${sel.width}×${sel.height}`;
  }
  updateStorageUsage();
  renderProgram();
}

async function renderLibraryItem(id) {
  const rec = await store.getImage(id);
  if (!rec) throw new Error('That picture is no longer in the library');
  const src = { ...(rec.settings?.source || { kind: 'image' }) };
  if (src.kind === 'image') {
    if (!rec.blob) throw new Error('That picture has no image data');
    src.bitmap = await decodeBlob(rec.blob);
  }
  // Always re-render at the CURRENT panel size: the original is kept precisely so
  // a library made on one display still works on another.
  const out = render(src, app.panel, { ...DEFAULT_SETTINGS, ...rec.settings });
  return { ...out, family: rec.settings?.family === 'card' ? 'card' : 'picture' };
}

$('btn-lib-send').onclick = async () => {
  if (!app.selectedId) return;
  try {
    const out = await renderLibraryItem(app.selectedId);
    const res = await sendPacked(out.packed, out.family);
    if (res) {
      toast(res.ok
        ? (out.family === 'card' ? 'Sent to the contact screen' : 'Sent')
        : 'Not confirmed', res.ok ? 'ok' : 'bad');
    }
  } catch (e) { toast(e.message, 'bad'); }
};

$('btn-lib-edit').onclick = async () => {
  const rec = await store.getImage(app.selectedId);
  if (!rec) return;
  app.settings = { ...DEFAULT_SETTINGS, ...rec.settings };
  delete app.settings.source;
  const src = rec.settings?.source || { kind: 'image' };
  $('src-kind').value = src.kind;
  if (src.kind === 'text') {
    $('src-text').value = src.text || '';
    $('src-text-align').value = src.align || 'center';
    $('src-text-fg').value = src.fg || 'black';
    $('src-text-bg').value = src.bg || 'white';
    $('src-text-bold').checked = !!src.bold;
  } else if (src.kind === 'qr') {
    $('qr-kind').value = 'text';
    $('qr-text').value = src.text || '';
    $('qr-ecc').value = src.ecc || 'M';
  } else if (src.kind === 'test') {
    $('test-pattern').value = src.pattern || 'bars';
  } else if (src.kind === 'clock') {
    $('clock-format').value = src.format || 'both';
  }
  $('send-family').value = rec.settings?.family === 'card' ? 'card' : 'picture';
  if (src.kind === 'image' && rec.blob) {
    app.source = { ...src };
    await loadPhoto(rec.blob, { crop: rec.settings?.crop || null });
  } else {
    app.sourceBlob = null;
    app.source = { ...src, bitmap: null };
    $('crop-box').hidden = true;
  }
  setEditing(rec.id);
  showSourceFields();
  syncSettingsUI();
  showView('studio');
  schedulePreview();
};

$('btn-lib-rename').onclick = async () => {
  const sel = app.library.find((i) => i.id === app.selectedId);
  if (!sel) return;
  const name = prompt('Name', sel.name);
  if (name == null) return;
  await store.renameImage(sel.id, name.trim() || sel.name);
  refreshLibrary();
};

$('btn-lib-delete').onclick = async () => {
  const sel = app.library.find((i) => i.id === app.selectedId);
  if (!sel) return;
  if (!confirm(`Delete "${sel.name}"? Any automation block using it will need updating.`)) return;
  await store.deleteImage(sel.id);
  app.selectedId = null;
  refreshLibrary();
};

$('btn-export').onclick = async () => {
  const data = await store.exportAll();
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `findxeink-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
};

$('btn-import').onclick = () => $('import-file').click();
$('import-file').onchange = async (e) => {
  const f = e.target.files?.[0];
  if (!f) return;
  try {
    await store.importAll(JSON.parse(await f.text()), { merge: true });
    toast('Backup imported', 'ok');
    refreshLibrary();
  } catch (err) { toast(`Import failed: ${err.message}`, 'bad'); }
};

async function updateStorageUsage() {
  const est = await store.estimateUsage();
  $('storage-usage').textContent = est
    ? `Using ${humanBytes(est.usage)} of about ${humanBytes(est.quota)} available.`
    : '';
}

$('opt-persist').onchange = async (e) => {
  if (!e.target.checked || !navigator.storage?.persist) return;
  const ok = await navigator.storage.persist();
  toast(ok ? 'Storage marked persistent' : 'The browser declined', ok ? 'ok' : '');
  e.target.checked = ok;
};

// ───────────────────────────────────────────────────────────── automate

function blockLabel(b) {
  switch (b.type) {
    case 'picture': {
      const it = app.library.find((i) => i.id === b.imageId);
      return { icon: '▣', title: it ? it.name : 'Missing picture', sub: it ? '' : 'deleted from the library', cls: '' };
    }
    case 'random':
      return { icon: '🎲', title: 'Random picture', sub: b.pool === 'all' ? 'from the whole library' : `${b.pool.length} chosen`, cls: 'random' };
    case 'wait':
      return { icon: '⏱', title: `Wait ${humanDuration(b.seconds)}`, sub: '', cls: 'wait' };
    case 'gotoStart':
      return { icon: '↻', title: 'Go to start', sub: 'loops forever', cls: 'goto' };
    default:
      return { icon: '?', title: b.type, sub: '', cls: '' };
  }
}

function renderProgram() {
  const list = $('block-list');
  const blocks = app.program.blocks || [];
  $('prog-empty').hidden = blocks.length > 0;
  list.innerHTML = blocks.map((b, i) => {
    const l = blockLabel(b);
    return `<div class="block ${l.cls}" data-i="${i}">
      <span class="icon">${l.icon}</span>
      <div class="body"><div class="t">${esc(l.title)}</div>${l.sub ? `<div class="s">${esc(l.sub)}</div>` : ''}</div>
      <div class="acts">
        <button data-act="up" title="Move up">↑</button>
        <button data-act="down" title="Move down">↓</button>
        <button data-act="edit" title="Edit">✎</button>
        <button data-act="del" title="Delete">✕</button>
      </div>
    </div>`;
  }).join('');

  $$('#block-list .acts button').forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const i = +btn.closest('.block').dataset.i;
      const act = btn.dataset.act;
      const bs = app.program.blocks;
      if (act === 'del') bs.splice(i, 1);
      if (act === 'up' && i > 0) bs.splice(i - 1, 0, bs.splice(i, 1)[0]);
      if (act === 'down' && i < bs.length - 1) bs.splice(i + 1, 0, bs.splice(i, 1)[0]);
      if (act === 'edit') return editBlock(i);
      saveProgram();
    };
  });

  const v = auto.validate(app.program);
  const est = auto.estimateCycle(app.program);
  $('prog-issues').innerHTML = [
    ...v.errors.map((x) => `<div class="banner bad"><b>Cannot run</b>${esc(x.message)}</div>`),
    ...v.warnings.map((x) => `<div class="banner warn"><b>Heads up</b>${esc(x.message)}</div>`),
  ].join('');
  $('prog-estimate').textContent = est.pictureCount
    ? `${est.pictureCount} picture(s) · one lap ${humanDuration(est.totalSeconds)}${est.looping ? ', repeating' : ', then stops'}`
    : '';
  $('btn-run').disabled = !v.ok;
}

function editBlock(i) {
  const b = app.program.blocks[i];
  if (b.type === 'wait') {
    const s = prompt(`Seconds to wait (minimum ${auto.MIN_WAIT_SECONDS})`, b.seconds);
    if (s == null) return;
    b.seconds = Math.max(auto.MIN_WAIT_SECONDS, +s || auto.MIN_WAIT_SECONDS);
  } else if (b.type === 'picture') {
    const id = pickImagePrompt(b.imageId);
    if (id) b.imageId = id;
  }
  saveProgram();
}

function pickImagePrompt(current) {
  if (!app.library.length) { toast('Save a picture to the library first'); return null; }
  const list = app.library.map((it, n) => `${n + 1}. ${it.name}`).join('\n');
  const cur = app.library.findIndex((i) => i.id === current);
  const ans = prompt(`Which picture?\n\n${list}`, String(cur >= 0 ? cur + 1 : 1));
  if (ans == null) return null;
  const idx = (+ans | 0) - 1;
  return app.library[idx]?.id || null;
}

$$('[data-add]').forEach((btn) => {
  btn.onclick = () => {
    const type = btn.dataset.add;
    const bs = app.program.blocks;
    if (type === 'picture') {
      const id = pickImagePrompt();
      if (!id) return;
      bs.push({ type: 'picture', imageId: id });
    } else if (type === 'random') {
      bs.push({ type: 'random', pool: 'all', avoidRepeat: true });
    } else if (type === 'wait') {
      bs.push({ type: 'wait', seconds: 60 });
    } else if (type === 'gotoStart') {
      if (bs.some((b) => b.type === 'gotoStart')) { toast('There is already a loop block'); return; }
      bs.push({ type: 'gotoStart' });
    }
    saveProgram();
  };
});

function saveProgram() {
  store.saveProgram(app.program).catch(() => {});
  renderProgram();
}

// ─────────────────────────────────────────────────────────────── runner

function makeRunner() {
  const r = new Runner(dev, {
    sendStep: async (step) => {
      const out = await renderLibraryItem(step.imageId);
      paintPreview($('kiosk-canvas'), out.indices, out.palette, out.width, out.height);
      return dev.send(out.packed, {
        family: out.family,
        chunkSize: Math.max(1, +$('opt-chunk').value | 0),
        obfuscate: $('opt-obfuscate').checked,
      });
    },
    persist: (state) => { store.putSetting('runState', state).catch(() => {}); },
  });
  r.addEventListener('log', (e) => runLog(e.detail.level, e.detail.msg));
  r.addEventListener('state', () => updateRunUI());
  r.addEventListener('tick', () => updateRunUI());
  r.addEventListener('finished', () => { toast('Program finished', 'ok'); updateRunUI(); });
  return r;
}

function updateRunUI() {
  const on = runner?.running;
  $('btn-run').hidden = !!on;
  $('btn-stop').hidden = !on;
  $('btn-kiosk').hidden = !on;
  $('conn-dot').classList.toggle('busy', !!on && dev.connected);

  if (!runner || !on) { $('run-status').textContent = ''; $('kiosk-meta').textContent = ''; return; }
  const remaining = Math.max(0, runner.dueAt - Date.now()) / 1000;
  const label = {
    [RunnerState.waiting]: `next in ${humanDuration(remaining)}`,
    [RunnerState.sending]: 'sending…',
    [RunnerState.reconnecting]: 'reconnecting…',
  }[runner.state] || runner.state;
  const text = `${runner.stepCount} sent · ${label}`;
  $('run-status').textContent = text;
  $('kiosk-meta').textContent = text;
}
setInterval(() => { if (runner?.running) updateRunUI(); }, 1000);

$('btn-run').onclick = async () => {
  const v = auto.validate(app.program);
  if (!v.ok) { toast('Fix the program first', 'bad'); return; }
  if (!dev.connected) {
    const ok = await dev.ensureConnected({ attempts: 1 });
    if (!ok) { toast('Connect to the display first', 'bad'); return; }
  }
  runner = runner || makeRunner();
  app.logLines = [];
  await runner.start(app.program, {
    wakeLock: $('opt-wakelock').checked,
    images: app.library.map((i) => i.id),
  });
  updateRunUI();
};
$('btn-stop').onclick = () => { runner?.stop(); updateRunUI(); };
$('btn-kiosk').onclick = () => $('kiosk').classList.add('on');
$('btn-kiosk-exit').onclick = () => $('kiosk').classList.remove('on');

// ───────────────────────────────────────────────────────────── advanced

function conPreview() {
  try {
    const op = OP[$('con-op').value.toUpperCase()];
    const seq = parseInt($('con-seq').value.trim() || 'FFFF', 16) & 0xffff;
    const f = buildFrame(op, seq, parseHex($('con-payload').value), { obfuscate: $('opt-obfuscate').checked });
    $('con-preview').textContent = `${hex(f)}   (${f.length} bytes)`;
    return f;
  } catch (e) {
    $('con-preview').textContent = `error: ${e.message}`;
    return null;
  }
}
['con-op', 'con-seq', 'con-payload', 'opt-obfuscate'].forEach((id) => $(id).addEventListener('input', conPreview));

$('btn-con-send').onclick = async () => {
  const f = conPreview();
  if (!f) return;
  try { await dev.writeFrame(f); toast('Frame sent'); }
  catch (e) { toast(e.message, 'bad'); }
};

$('btn-explore').onclick = async () => {
  try {
    const table = await dev.explore();
    $('gatt-dump').innerHTML = table.map((s) => `
      <details open><summary>${esc(s.uuid)}</summary>
        <table>${s.characteristics.map((c) => `<tr>
          <th class="mono">${esc(c.uuid.slice(4, 8).toUpperCase())}</th>
          <td>${esc(c.properties.join(', ') || '—')}
            ${(c.descriptors || []).filter((d) => d.text).map((d) => `<br><span class="dim">“${esc(d.text)}”</span>`).join('')}
            ${c.value ? `<br><span class="mono">${esc(c.value)}</span>` : ''}</td></tr>`).join('')}
        </table></details>`).join('');
  } catch (e) { toast(e.message, 'bad'); }
};

$('btn-report').onclick = () => {
  const report = {
    tool: 'web-findxeink-f15', version: VERSION, generated: new Date().toISOString(),
    userAgent: navigator.userAgent,
    secureContext: window.isSecureContext,
    hasBluetooth: !!navigator.bluetooth,
    device: dev.device ? { name: dev.name, id: dev.device.id } : null,
    panel: app.panel,
    program: app.program,
    log: app.logLines,
  };
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
  a.download = 'findxeink-report.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
};

// ───────────────────────────────────────────────────────────── startup

function checkEnvironment() {
  const el = $('env-banner');
  if (!window.isSecureContext) {
    el.className = 'banner bad';
    el.innerHTML = '<b>This page is not on a secure origin</b>Web Bluetooth only exists on '
      + '<code>https://</code> or <code>localhost</code>, so the browser has switched it off entirely.';
    return;
  }
  if (!navigator.bluetooth) {
    el.className = 'banner bad';
    el.innerHTML = '<b>This browser has no Web Bluetooth</b>Use <b>Chrome</b> on Android, Windows, '
      + 'macOS or Linux. Firefox and Safari do not implement it, and neither do in-app browsers. '
      + 'On iOS you would need the <b>Bluefy</b> app.';
    return;
  }
  el.className = 'banner info';
  el.innerHTML = '<b>Ready</b>Tap <b>Find my display</b>, then pick your device in the browser\'s '
    + 'chooser. Turn Location Services on first — Android silently returns no results without it.';
}

async function boot() {
  buildInkToggles();
  buildTestPatterns();
  buildDitherOptions();
  initCropper();
  wireSettings();
  showSourceFields();
  syncSettingsUI();
  conPreview();
  checkEnvironment();
  updateStickyOffset();
  $('about-version').textContent = `v${VERSION}`;

  window.addEventListener('resize', () => {
    updateStickyOffset();
    if (app.lastRendered) sizePreview(app.lastRendered.width, app.lastRendered.height);
  });

  try {
    const savedPanel = await store.getSetting('panel', null);
    if (savedPanel) applyPanel(savedPanel);
    const savedProgram = await store.loadProgram();
    if (savedProgram?.blocks) app.program = savedProgram;
    $('opt-wakelock').checked = await store.getSetting('wakeLock', false);
  } catch (e) {
    toast(`Storage unavailable: ${e.message}`, 'bad');
  }

  $('opt-wakelock').onchange = () => store.putSetting('wakeLock', $('opt-wakelock').checked);

  await refreshLibrary();
  updateConnUI();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => { /* offline is optional */ });
  }
}

boot();

// Expose a little of the internals for the protocol console and for debugging in
// devtools. Deliberately read-only-ish: nothing here is required by the UI.
globalThis.wfx = { app, dev, store, auto, get runner() { return runner; } };
