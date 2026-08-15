/**
 * Interactive crop editor.
 *
 * The window is fixed to the panel's aspect ratio and the *photo* moves behind
 * it — pan with a finger, pinch or scroll to zoom. That is the interaction people
 * already know from every phone photo app, and it has a useful property: the
 * window can never contain empty space, because the image is clamped to always
 * cover it. A drag-a-rectangle-over-the-photo design has no such guarantee and
 * invites crops that render with white bars.
 *
 * Output is a plain {sx, sy, sw, sh} rectangle in source-image pixels, which is
 * exactly what drawImage() wants, so the renderer needs no knowledge of any of
 * this.
 */

export class CropEditor {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{ onChange?: () => void }} [opts]
   */
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onChange = opts.onChange || (() => {});
    this.image = null;
    this.scale = 1;
    this.minScale = 1;
    this.tx = 0;
    this.ty = 0;
    this.pointers = new Map();
    this.pinchStart = null;
    this.enabled = false;

    this._onDown = this._onDown.bind(this);
    this._onMove = this._onMove.bind(this);
    this._onUp = this._onUp.bind(this);
    this._onWheel = this._onWheel.bind(this);

    canvas.addEventListener('pointerdown', this._onDown);
    canvas.addEventListener('pointermove', this._onMove);
    canvas.addEventListener('pointerup', this._onUp);
    canvas.addEventListener('pointercancel', this._onUp);
    canvas.addEventListener('wheel', this._onWheel, { passive: false });
  }

  get imgW() { return this.image ? (this.image.width ?? this.image.naturalWidth) : 0; }
  get imgH() { return this.image ? (this.image.height ?? this.image.naturalHeight) : 0; }

  /** Logical (CSS-pixel) size of the crop window. */
  get viewW() { return this.canvas.clientWidth || 1; }
  get viewH() { return this.canvas.clientHeight || 1; }

  setImage(bitmap) {
    this.image = bitmap;
    this.enabled = !!bitmap;
    this.reset();
  }

  /** Re-fit after the window's aspect ratio changes (a different panel, or rotation). */
  refit() {
    if (!this.image) return;
    const prev = this.getCrop();
    this._recomputeMin();
    if (prev) this.setCrop(prev); else this.reset();
    this.draw();
  }

  _recomputeMin() {
    // "Cover": the smallest zoom at which the photo still fills the window.
    this.minScale = Math.max(this.viewW / this.imgW, this.viewH / this.imgH);
  }

  reset() {
    if (!this.image) { this.draw(); return; }
    this._recomputeMin();
    this.scale = this.minScale;
    this.tx = (this.viewW - this.imgW * this.scale) / 2;
    this.ty = (this.viewH - this.imgH * this.scale) / 2;
    this._clamp();
    this.draw();
    this.onChange();
  }

  /** Keep the photo covering the window at all times. */
  _clamp() {
    const w = this.imgW * this.scale;
    const h = this.imgH * this.scale;
    this.tx = w <= this.viewW ? (this.viewW - w) / 2 : Math.min(0, Math.max(this.viewW - w, this.tx));
    this.ty = h <= this.viewH ? (this.viewH - h) / 2 : Math.min(0, Math.max(this.viewH - h, this.ty));
  }

  /** Zoom about a fixed point in window space, so content under it stays put. */
  zoomAbout(factor, px, py) {
    if (!this.image) return;
    const next = Math.min(Math.max(this.scale * factor, this.minScale), this.minScale * 12);
    const k = next / this.scale;
    this.tx = px - (px - this.tx) * k;
    this.ty = py - (py - this.ty) * k;
    this.scale = next;
    this._clamp();
    this.draw();
    this.onChange();
  }

  /** 100 = fully zoomed out (cover). */
  get zoomPercent() { return Math.round((this.scale / this.minScale) * 100); }

  setZoomPercent(pct) {
    if (!this.image) return;
    const target = this.minScale * (pct / 100);
    this.zoomAbout(target / this.scale, this.viewW / 2, this.viewH / 2);
  }

  /** @returns {{sx:number,sy:number,sw:number,sh:number}|null} in source pixels */
  getCrop() {
    if (!this.image) return null;
    const sx = -this.tx / this.scale;
    const sy = -this.ty / this.scale;
    const sw = this.viewW / this.scale;
    const sh = this.viewH / this.scale;
    return {
      sx: Math.max(0, Math.round(sx)),
      sy: Math.max(0, Math.round(sy)),
      sw: Math.max(1, Math.round(Math.min(sw, this.imgW))),
      sh: Math.max(1, Math.round(Math.min(sh, this.imgH))),
    };
  }

  setCrop(crop) {
    if (!this.image || !crop?.sw || !crop?.sh) return;
    this._recomputeMin();
    this.scale = Math.max(this.minScale, this.viewW / crop.sw);
    this.tx = -crop.sx * this.scale;
    this.ty = -crop.sy * this.scale;
    this._clamp();
    this.draw();
  }

  draw() {
    const dpr = globalThis.devicePixelRatio || 1;
    const cw = Math.max(1, Math.round(this.viewW * dpr));
    const ch = Math.max(1, Math.round(this.viewH * dpr));
    if (this.canvas.width !== cw || this.canvas.height !== ch) {
      this.canvas.width = cw;
      this.canvas.height = ch;
    }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.viewW, this.viewH);
    ctx.fillStyle = '#0a0e13';
    ctx.fillRect(0, 0, this.viewW, this.viewH);
    if (!this.image) return;

    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.image, this.tx, this.ty, this.imgW * this.scale, this.imgH * this.scale);

    // Rule-of-thirds guides, faint enough not to fight the photo.
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 1; i < 3; i++) {
      const x = Math.round((this.viewW * i) / 3) + 0.5;
      const y = Math.round((this.viewH * i) / 3) + 0.5;
      ctx.moveTo(x, 0); ctx.lineTo(x, this.viewH);
      ctx.moveTo(0, y); ctx.lineTo(this.viewW, y);
    }
    ctx.stroke();
  }

  // ─────────────────────────────────────────────────────────── pointers

  _local(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  _onDown(e) {
    if (!this.enabled) return;
    this.canvas.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, this._local(e));
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.pinchStart = { dist: Math.hypot(a.x - b.x, a.y - b.y), scale: this.scale };
    }
    e.preventDefault();
  }

  _onMove(e) {
    if (!this.enabled || !this.pointers.has(e.pointerId)) return;
    const prev = this.pointers.get(e.pointerId);
    const cur = this._local(e);
    this.pointers.set(e.pointerId, cur);

    if (this.pointers.size === 2 && this.pinchStart) {
      const [a, b] = [...this.pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (this.pinchStart.dist > 0) {
        const want = this.pinchStart.scale * (dist / this.pinchStart.dist);
        this.zoomAbout(want / this.scale, (a.x + b.x) / 2, (a.y + b.y) / 2);
      }
    } else if (this.pointers.size === 1) {
      this.tx += cur.x - prev.x;
      this.ty += cur.y - prev.y;
      this._clamp();
      this.draw();
      this.onChange();
    }
    e.preventDefault();
  }

  _onUp(e) {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinchStart = null;
    try { this.canvas.releasePointerCapture(e.pointerId); } catch { /* already released */ }
  }

  _onWheel(e) {
    if (!this.enabled) return;
    e.preventDefault();
    const p = this._local(e);
    this.zoomAbout(e.deltaY < 0 ? 1.12 : 1 / 1.12, p.x, p.y);
  }

  destroy() {
    const c = this.canvas;
    c.removeEventListener('pointerdown', this._onDown);
    c.removeEventListener('pointermove', this._onMove);
    c.removeEventListener('pointerup', this._onUp);
    c.removeEventListener('pointercancel', this._onUp);
    c.removeEventListener('wheel', this._onWheel);
  }
}
