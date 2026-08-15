/**
 * Drives an automation program against a real device, in real time.
 *
 * automation.js is the pure model — it decides *what* comes next. This is the
 * part that deals with the messy world: wall-clock time, a tab that gets
 * throttled or suspended, a display that drops the connection between pictures,
 * and a page that might be reloaded mid-run.
 *
 * Three deliberate choices:
 *
 *   Absolute due times. Every wait is stored as "due at timestamp T", never as a
 *   countdown. A backgrounded tab has its timers throttled to roughly once a
 *   minute and a locked phone may not fire them at all, so a countdown would
 *   drift without bound. On wake we compare against Date.now() and act.
 *
 *   Skip, never replay. If the tab was asleep for an hour, the right behaviour is
 *   to show the picture that is due *now*, not to race through the twelve we
 *   missed. Each of those would cost a 20-second panel refresh and the user would
 *   watch their frame flicker through an hour of backlog.
 *
 *   A hard floor between sends. The program is validated against a 20-second
 *   minimum, but a corrupt saved program or a future edit should never be able to
 *   hammer the panel, so the runner enforces it independently.
 */

import { createCursor, serialize, restore, MIN_WAIT_SECONDS } from './automation.js';

/** Never send two images closer together than this, whatever the program says. */
const HARD_FLOOR_MS = MIN_WAIT_SECONDS * 1000;

/** How long a wake-lock-less tab is allowed to sleep before we stop trusting the schedule. */
const RESYNC_AFTER_MS = 5 * 60 * 1000;

export const RunnerState = {
  idle: 'idle',
  running: 'running',
  waiting: 'waiting',
  sending: 'sending',
  reconnecting: 'reconnecting',
  error: 'error',
};

export class Runner extends EventTarget {
  /**
   * @param {import('./device.js').Device} device
   * @param {{ sendStep: (step: {imageId: string}) => Promise<{ok: boolean}>,
   *           persist?: (state: object|null) => void }} hooks
   */
  constructor(device, hooks) {
    super();
    this.device = device;
    this.hooks = hooks;
    this.program = null;
    this.cursor = null;
    this.state = RunnerState.idle;
    this.dueAt = 0;
    this.lastSendAt = 0;
    this.stepCount = 0;
    this.lastError = null;
    this.wakeLock = null;
    this.wantWakeLock = false;

    this._timer = null;
    this._tickBound = () => this._tick();
    this._onVisibility = this._onVisibility.bind(this);
  }

  get running() {
    return this.state !== RunnerState.idle && this.state !== RunnerState.error;
  }

  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  _setState(state, detail = {}) {
    this.state = state;
    this._emit('state', { state, dueAt: this.dueAt, stepCount: this.stepCount, ...detail });
  }

  _log(level, msg) {
    this._emit('log', { level, msg });
  }

  // ───────────────────────────────────────────────────────── lifecycle

  /**
   * @param {object} program
   * @param {{ resumeState?: object, wakeLock?: boolean, images?: string[] }} [opts]
   *   `images` is the library's id list. A `random` block with `pool: 'all'` has
   *   nothing to draw from without it and would silently show nothing, so it is
   *   resolved at start time rather than baked into the saved program — the
   *   library changes, the program should not have to.
   */
  async start(program, opts = {}) {
    this.stop({ silent: true });
    this.program = program;
    const cursorOpts = { images: opts.images || [] };
    this.cursor = opts.resumeState
      ? restore(program, opts.resumeState, cursorOpts)
      : createCursor(program, cursorOpts);
    this.stepCount = opts.resumeState?.stepCount ?? 0;
    this.lastError = null;
    this.wantWakeLock = !!opts.wakeLock;

    document.addEventListener('visibilitychange', this._onVisibility);
    if (this.wantWakeLock) await this.acquireWakeLock();

    this._setState(RunnerState.running);
    this._log('ok', opts.resumeState ? 'Automation resumed' : 'Automation started');
    this._advance();
  }

  stop({ silent = false } = {}) {
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
    document.removeEventListener('visibilitychange', this._onVisibility);
    this.releaseWakeLock();
    this.cursor = null;
    this.dueAt = 0;
    this._setState(RunnerState.idle);
    this.hooks.persist?.(null);
    if (!silent) this._log('info', 'Automation stopped');
  }

  /** Persist enough to resume after a page reload. */
  _save() {
    if (!this.cursor) return;
    this.hooks.persist?.({
      cursor: serialize(this.cursor),
      dueAt: this.dueAt,
      stepCount: this.stepCount,
      savedAt: Date.now(),
    });
  }

  // ───────────────────────────────────────────────────────── scheduling

  _advance() {
    if (!this.cursor) return;

    let step;
    try {
      step = this.cursor.next();
    } catch (e) {
      this._fail(`Program error: ${e.message}`);
      return;
    }

    if (!step || step.kind === 'end') {
      this._log('ok', 'Program finished');
      this.stop({ silent: true });
      this._emit('finished', {});
      return;
    }

    if (step.kind === 'wait') {
      // Respect the floor even if the program somehow asks for less.
      const ms = Math.max(step.ms, HARD_FLOOR_MS);
      this.dueAt = Date.now() + ms;
      this._setState(RunnerState.waiting, { waitMs: ms });
      this._save();
      this._arm();
      return;
    }

    if (step.kind === 'show') {
      this._send(step);
    }
  }

  /**
   * Timers in a background tab are throttled, so never sleep for the full
   * remaining time in one go — wake up periodically and re-check the clock. That
   * also means a suspended tab resumes correctly the moment it is shown again.
   */
  _arm() {
    if (this._timer) clearTimeout(this._timer);
    const remaining = this.dueAt - Date.now();
    const slice = Math.min(Math.max(remaining, 0), 15000);
    this._timer = setTimeout(this._tickBound, slice);
    this._emit('tick', { dueAt: this.dueAt, remaining });
  }

  _tick() {
    if (!this.cursor) return;
    const remaining = this.dueAt - Date.now();
    if (remaining > 250) {
      this._arm();
      return;
    }
    this._advance();
  }

  _onVisibility() {
    if (document.visibilityState !== 'visible' || !this.cursor) return;

    // Re-acquire the wake lock: the browser drops it whenever the page is hidden.
    if (this.wantWakeLock && !this.wakeLock) this.acquireWakeLock();

    const late = Date.now() - this.dueAt;
    if (late > RESYNC_AFTER_MS) {
      this._log('warn',
        `Tab was suspended for ${Math.round(late / 60000)} min — skipping ahead rather than replaying.`);
    }
    this._tick();
  }

  // ───────────────────────────────────────────────────────── sending

  async _send(step) {
    // Independent of the program, never refresh the panel faster than the floor.
    const since = Date.now() - this.lastSendAt;
    if (this.lastSendAt && since < HARD_FLOOR_MS) {
      this.dueAt = this.lastSendAt + HARD_FLOOR_MS;
      this._setState(RunnerState.waiting, { waitMs: HARD_FLOOR_MS - since });
      this._arm();
      return;
    }

    this._setState(RunnerState.sending, { imageId: step.imageId });

    if (!this.device.connected) {
      this._setState(RunnerState.reconnecting);
      const ok = await this.device.ensureConnected({ attempts: 3 });
      if (!ok) {
        // Do not give up on the whole program for one lost link — the display
        // sleeps and drops the connection routinely. Wait and try the step again.
        this._log('warn', 'Could not reconnect — retrying in 60 s');
        this.dueAt = Date.now() + 60000;
        this._setState(RunnerState.waiting, { waitMs: 60000 });
        this._arm();
        return;
      }
    }

    try {
      const res = await this.hooks.sendStep(step);
      this.lastSendAt = Date.now();
      this.stepCount++;
      if (res?.ok) {
        this._log('ok', `Sent (${this.stepCount} total)`);
      } else {
        this._log('warn', `Device did not confirm: ${res?.statusName || res?.reason || 'no status'}`);
      }
      this._emit('sent', { step, result: res });
    } catch (e) {
      this._log('err', `Send failed: ${e.message}`);
      this._emit('sendError', { step, error: e });
    }

    this._save();
    if (this.cursor) this._advance();
  }

  _fail(msg) {
    this.lastError = msg;
    this._log('err', msg);
    this._setState(RunnerState.error, { error: msg });
    this.releaseWakeLock();
  }

  // ───────────────────────────────────────────────────────── wake lock

  /**
   * Screen Wake Lock needs no permission prompt — it only requires the page to be
   * visible. It is the difference between a frame that updates all evening and
   * one that stops the moment the screen dims.
   */
  async acquireWakeLock() {
    if (!navigator.wakeLock || this.wakeLock) return false;
    try {
      this.wakeLock = await navigator.wakeLock.request('screen');
      this.wakeLock.addEventListener('release', () => { this.wakeLock = null; });
      this._log('info', 'Screen will stay awake while the program runs');
      return true;
    } catch (e) {
      this._log('warn', `Could not keep the screen awake: ${e.message}`);
      return false;
    }
  }

  releaseWakeLock() {
    try { this.wakeLock?.release(); } catch { /* already gone */ }
    this.wakeLock = null;
  }
}
