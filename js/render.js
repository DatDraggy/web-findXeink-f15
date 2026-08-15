/**
 * Turns a "source" into the exact index buffer the panel wants.
 *
 * A source is anything the user can put on the display: a photo, some text, a QR
 * code, a live clock, or a test pattern. Each is composed onto a canvas at the
 * panel's native resolution, then quantised to the firmware's fixed palette and
 * bit-packed.
 *
 * One rule worth stating: synthetic sources (text, QR, test patterns) are drawn
 * *in palette colours already*, so they are quantised with nearest-colour and no
 * dithering. Dithering a QR code destroys it, and dithering text turns 4-pixel
 * strokes into speckle. Only photographs get the error-diffusion path.
 */

import {
  INKS, inksFor, adjust, quantize, applyCircleMask, pack, indicesToRGBA,
} from './image.js';
import { qrToIndices } from './qrcode.js';

export const DEFAULT_SETTINGS = {
  fit: 'cover',          // cover | contain | stretch
  rotate: 0,             // 0 | 90 | 180 | 270
  brightness: 0,         // -100..100
  contrast: 0,           // -100..100
  saturation: 100,       // 0..300
  gamma: 100,            // 10..300
  dither: 'fs',          // fs | atkinson | ordered | none
  strength: 1,           // 0..1
  serpentine: true,
  inks: ['red', 'yellow', 'white', 'black'],
  circleMask: false,
  /** {sx, sy, sw, sh} in source-image pixels, or null to use `fit` instead. */
  crop: null,
};

export const TEST_PATTERNS = [
  { id: 'black', label: 'Solid black' },
  { id: 'white', label: 'Solid white' },
  { id: 'red', label: 'Solid red' },
  { id: 'yellow', label: 'Solid yellow' },
  { id: 'bars', label: 'Colour bars' },
  { id: 'quadrants', label: 'Quadrants' },
  { id: 'grid', label: 'Alignment grid' },
  { id: 'gradient', label: 'Dither ramp' },
  { id: 'checker', label: 'Pixel checkerboard' },
];

/** Sources that are already in-palette and must not be dithered. */
const SYNTHETIC = new Set(['text', 'qr', 'clock', 'test']);

let scratch = null;
function canvasOf(w, h) {
  if (!scratch) scratch = document.createElement('canvas');
  scratch.width = w;
  scratch.height = h;
  return scratch;
}

/** Decode a Blob/File into something drawImage accepts. */
export async function decodeBlob(blob) {
  if (globalThis.createImageBitmap) {
    try { return await createImageBitmap(blob); } catch { /* fall through */ }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = () => rej(new Error('Could not decode that image'));
      img.src = url;
    });
    return img;
  } finally {
    // Revoking immediately is safe: the decode is complete.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

function inkRgb(id) {
  const ink = INKS.find((i) => i.id === id) || INKS.find((i) => i.id === 'black');
  return `rgb(${ink.rgb.join(',')})`;
}

// ───────────────────────────────────────────────────────────── composition

/**
 * The target rectangle a photo is drawn into, in panel space. For a quarter turn
 * the panel's width and height swap, because the rotation happens after.
 */
export function photoTarget(W, H, rotate) {
  const rot = ((rotate % 360) + 360) % 360;
  const swap = rot === 90 || rot === 270;
  return { rot, dw: swap ? H : W, dh: swap ? W : H };
}

function drawPhoto(ctx, bitmap, W, H, s) {
  const { rot, dw, dh } = photoTarget(W, H, s.rotate);
  const sw = bitmap.width ?? bitmap.naturalWidth;
  const sh = bitmap.height ?? bitmap.naturalHeight;

  ctx.save();
  ctx.translate(W / 2, H / 2);
  ctx.rotate((rot * Math.PI) / 180);

  // An explicit crop rectangle beats the fit mode: the user has said exactly
  // which part of the photo they want, so honour it literally.
  const c = s.crop;
  if (c && c.sw > 0 && c.sh > 0) {
    ctx.drawImage(bitmap, c.sx, c.sy, c.sw, c.sh, -dw / 2, -dh / 2, dw, dh);
  } else if (s.fit === 'stretch') {
    ctx.drawImage(bitmap, -dw / 2, -dh / 2, dw, dh);
  } else {
    const scale = s.fit === 'cover' ? Math.max(dw / sw, dh / sh) : Math.min(dw / sw, dh / sh);
    ctx.drawImage(bitmap, (-sw * scale) / 2, (-sh * scale) / 2, sw * scale, sh * scale);
  }
  ctx.restore();
}

/**
 * Lay out text to fill the panel. Font size auto-shrinks until every line fits,
 * because a name badge that overflows is useless and the user cannot see the
 * panel while typing.
 */
function drawText(ctx, src, W, H) {
  const pad = Math.round(Math.min(W, H) * 0.06);
  const lines = String(src.text ?? '').split('\n');
  const family = src.family || 'system-ui, sans-serif';
  const weight = src.bold ? '700' : '400';
  const maxW = W - pad * 2;
  const maxH = H - pad * 2;

  let size = src.size || Math.floor(H / Math.max(1, lines.length) * 0.8);
  for (; size > 6; size--) {
    ctx.font = `${weight} ${size}px ${family}`;
    const lineH = size * 1.2;
    if (lineH * lines.length > maxH) continue;
    if (lines.every((l) => ctx.measureText(l).width <= maxW)) break;
  }

  ctx.fillStyle = inkRgb(src.fg || 'black');
  ctx.textBaseline = 'middle';
  ctx.textAlign = src.align || 'center';
  const x = src.align === 'left' ? pad : src.align === 'right' ? W - pad : W / 2;
  const lineH = size * 1.2;
  const y0 = H / 2 - ((lines.length - 1) * lineH) / 2;
  lines.forEach((line, i) => ctx.fillText(line, x, y0 + i * lineH));
}

function drawTestPattern(ctx, id, W, H) {
  const solid = { black: 'black', white: 'white', red: 'red', yellow: 'yellow' }[id];
  if (solid) {
    ctx.fillStyle = inkRgb(solid);
    ctx.fillRect(0, 0, W, H);
    return;
  }
  if (id === 'bars') {
    const order = ['black', 'white', 'red', 'yellow'];
    order.forEach((ink, i) => {
      ctx.fillStyle = inkRgb(ink);
      ctx.fillRect(Math.round((i * W) / order.length), 0, Math.ceil(W / order.length), H);
    });
    return;
  }
  if (id === 'quadrants') {
    const q = [['black', 0, 0], ['white', 1, 0], ['red', 0, 1], ['yellow', 1, 1]];
    for (const [ink, cx, cy] of q) {
      ctx.fillStyle = inkRgb(ink);
      ctx.fillRect(cx * (W / 2), cy * (H / 2), W / 2, H / 2);
    }
    return;
  }
  if (id === 'grid') {
    // Every 10th pixel, plus a border and diagonals — makes an off-by-one in the
    // pixel order or a row-padding mistake obvious at a glance.
    ctx.fillStyle = inkRgb('white');
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = inkRgb('black');
    for (let x = 0; x < W; x += 10) ctx.fillRect(x, 0, 1, H);
    for (let y = 0; y < H; y += 10) ctx.fillRect(0, y, W, 1);
    ctx.fillStyle = inkRgb('red');
    ctx.fillRect(0, 0, W, 1);
    ctx.fillRect(0, H - 1, W, 1);
    ctx.fillRect(0, 0, 1, H);
    ctx.fillRect(W - 1, 0, 1, H);
    ctx.fillStyle = inkRgb('yellow');
    ctx.fillRect(0, 0, 8, 8);
    return;
  }
  if (id === 'gradient') {
    const g = ctx.createLinearGradient(0, 0, W, 0);
    g.addColorStop(0, '#000');
    g.addColorStop(1, '#fff');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, Math.floor(H / 2));
    const g2 = ctx.createLinearGradient(0, 0, W, 0);
    g2.addColorStop(0, '#dc2828');
    g2.addColorStop(0.5, '#f0cd32');
    g2.addColorStop(1, '#fff');
    ctx.fillStyle = g2;
    ctx.fillRect(0, Math.floor(H / 2), W, Math.ceil(H / 2));
    return;
  }
  if (id === 'checker') {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        ctx.fillStyle = inkRgb((x + y) % 2 ? 'white' : 'black');
        ctx.fillRect(x, y, 1, 1);
      }
    }
  }
}

function clockText(src) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  if (src.format === 'time') return time;
  const date = now.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  if (src.format === 'date') return date;
  return `${time}\n${date}`;
}

// ───────────────────────────────────────────────────────────── pipeline

/**
 * Render a source to palette indices.
 *
 * @param {object} source  { kind, ... }
 * @param {{width:number,height:number,bpp:number,model:number}} panel
 * @param {object} settings
 * @returns {{indices: Uint8Array, palette: object[], width: number, height: number}}
 */
export function renderIndices(source, panel, settings) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const W = panel.width;
  const H = panel.height;

  // 1 bpp panels only have two inks, whatever the user ticked.
  const palette = panel.bpp === 1
    ? inksFor(['white', 'black'])
    : inksFor(s.inks?.length ? s.inks : DEFAULT_SETTINGS.inks);

  // QR codes are generated straight into index space: scaling or dithering them
  // through the canvas would cost us the integer module alignment they need.
  if (source.kind === 'qr') {
    const indices = qrToIndices(source.text || '', { ecc: source.ecc || 'M' }, W, H, palette);
    if (s.circleMask) applyCircleMask(indices, W, H, palette);
    return { indices, palette, width: W, height: H };
  }

  const canvas = canvasOf(W, H);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = inkRgb(source.bg || 'white');
  ctx.fillRect(0, 0, W, H);

  switch (source.kind) {
    case 'image':
      if (source.bitmap) drawPhoto(ctx, source.bitmap, W, H, s);
      break;
    case 'text':
      drawText(ctx, source, W, H);
      break;
    case 'clock':
      drawText(ctx, { ...source, text: clockText(source) }, W, H);
      break;
    case 'test':
      drawTestPattern(ctx, source.pattern || 'bars', W, H);
      break;
    default:
      break;
  }

  const img = ctx.getImageData(0, 0, W, H);
  const synthetic = SYNTHETIC.has(source.kind);
  if (!synthetic) {
    adjust(img.data, {
      brightness: s.brightness, contrast: s.contrast,
      saturation: s.saturation, gamma: s.gamma,
    });
  }
  const indices = quantize(img.data, W, H, palette, {
    dither: synthetic ? 'none' : s.dither,
    strength: synthetic ? 0 : s.strength,
    serpentine: s.serpentine,
  });
  if (s.circleMask) applyCircleMask(indices, W, H, palette);
  return { indices, palette, width: W, height: H };
}

/**
 * Full pipeline: indices, a preview bitmap, and the bytes to put on the wire.
 */
export function render(source, panel, settings) {
  const { indices, palette, width, height } = renderIndices(source, panel, settings);
  const packed = pack(indices, width, height, palette, { bpp: panel.bpp, model: panel.model });
  return { indices, palette, width, height, packed };
}

/** Paint an index buffer into a canvas at 1:1, for the on-screen preview. */
export function paintPreview(canvas, indices, palette, width, height) {
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(width, height);
  img.data.set(indicesToRGBA(indices, width, height, palette));
  ctx.putImageData(img, 0, 0);
}

/**
 * A small PNG of the rendered result, stored alongside each library item so the
 * grid does not have to re-run the whole pipeline to draw a thumbnail.
 */
export async function makeThumb(indices, palette, width, height, max = 160) {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(width, height);
  img.data.set(indicesToRGBA(indices, width, height, palette));
  ctx.putImageData(img, 0, 0);

  const scale = Math.min(1, max / Math.max(width, height));
  if (scale < 1) {
    const t = document.createElement('canvas');
    t.width = Math.max(1, Math.round(width * scale));
    t.height = Math.max(1, Math.round(height * scale));
    const tctx = t.getContext('2d');
    tctx.imageSmoothingEnabled = false;
    tctx.drawImage(c, 0, 0, t.width, t.height);
    return blobOf(t);
  }
  return blobOf(c);
}

function blobOf(canvas) {
  return new Promise((res) => canvas.toBlob((b) => res(b), 'image/png'));
}
