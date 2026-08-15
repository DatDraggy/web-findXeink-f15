/**
 * automation.js -- the block-program engine that cycles pictures on the panel.
 *
 * A program is a list of JSON-serialisable blocks (see BLOCK SHAPES below). This
 * module is pure logic: it validates a program, estimates how long one lap takes,
 * and turns the program into a *step function* (the cursor). It owns no timers,
 * performs no I/O and never touches the DOM -- it imports cleanly in Node.
 *
 * ── SCHEDULER CONTRACT (read this before wiring the UI) ────────────────────
 * The cursor is a pure step machine. `next()` returns the NEXT thing to do and
 * nothing else; it never sleeps, never resolves a promise, never fires a
 * callback. The caller owns the clock. That split exists because the scheduler
 * lives in a mobile browser tab that WILL be throttled, backgrounded or frozen
 * outright (screen off, phone locked, app switched). Timer callbacks in that
 * state arrive late by minutes, or not at all until the tab is foregrounded
 * again, and a run may be interrupted by a full page reload.
 *
 * So the scheduler must:
 *   1. Compute due times from ABSOLUTE timestamps, never from elapsed-timer
 *      arithmetic:
 *          const step = cursor.next();
 *          if (step.kind === 'wait') dueAt = Date.now() + step.ms;
 *      then on every wake-up (timer, visibilitychange, page load) compare
 *      Date.now() against dueAt.
 *   2. SKIP missed waits rather than replay them. If the tab was suspended for
 *      an hour, `Date.now() >= dueAt` is simply true: run the next step
 *      immediately. Do not sleep the remainder, and do not re-issue the waits
 *      that elapsed while the tab was dead -- the user wants the picture that is
 *      due now, not a catch-up burst of ten refreshes.
 *   3. Never issue a picture write while a previous one is still in flight, and
 *      leave at least MIN_WAIT_SECONDS between two panel refreshes even if a
 *      skip made two shows land back to back. The panel needs roughly that long
 *      for a full 4-colour refresh and answers F1 status 6 (busy) if you push it
 *      sooner; the automation engine enforces the minimum in `validate()`, but
 *      the transport is the last line of defence.
 *   4. Persist across reloads with serialize()/restore(): save the returned
 *      state (plus your own absolute `dueAt`) whenever it changes, and on load
 *      restore the cursor, then apply rule 2 to the saved `dueAt`.
 *
 * ── BLOCK SHAPES (this is the on-disk format; keep it stable) ──────────────
 *   { type: 'picture',   imageId }
 *   { type: 'random',    pool: 'all' | [imageId, ...], avoidRepeat: true }
 *   { type: 'wait',      seconds }                 // seconds >= MIN_WAIT_SECONDS
 *   { type: 'gotoStart' }                          // last block only; loops forever
 *   { type: 'repeat',    times, blocks: [ ... ] }  // bounded loop, may nest
 *
 * A program is either a bare array of blocks or `{ version: 1, blocks: [...] }`.
 * Both are accepted everywhere; the object form is what the UI should write to
 * disk so the file has somewhere to grow a version number.
 */

/**
 * Minimum seconds a `wait` block may specify.
 *
 * A full 4-colour refresh of the e-ink panel takes on the order of 20 seconds,
 * during which the firmware rejects further picture writes (F1 status 6, busy)
 * and the panel visibly flashes through its colour passes. Anything shorter is
 * not "fast", it is broken output, so it is a hard validation error rather than
 * a warning.
 * @type {number}
 */
export const MIN_WAIT_SECONDS = 20;

/** Deepest `repeat` nesting accepted. Also stops a self-referencing block object
 *  (easy to produce by hand-editing a saved program) from recursing forever. */
const MAX_NESTING_DEPTH = 8;

/** Internal steps a single `next()` may burn before it gives up. Blocks that
 *  produce no output (an empty repeat, a skipped invalid block, gotoStart) are
 *  consumed inside one `next()` call, so a malformed program could otherwise
 *  spin here forever and hang the tab. */
const MAX_STEPS_PER_NEXT = 4096;

/** Version stamp on serialize() output, so restore() can reject foreign state. */
const STATE_VERSION = 1;

/** Cursor -> private state. Keeps the public cursor surface to exactly
 *  { next, reset, position } while still letting serialize() reach inside. */
const INTERNALS = new WeakMap();

/**
 * Accept both program spellings and return the block list, or null if the value
 * is not a program at all.
 * @param {unknown} program
 * @returns {Array<object>|null}
 */
function blocksOf(program) {
  if (Array.isArray(program)) return program;
  if (program && typeof program === 'object' && Array.isArray(program.blocks)) return program.blocks;
  return null;
}

/**
 * A block's `times`, floored to an integer. Returns 0 for anything unusable, so
 * callers can treat "invalid" and "runs zero times" identically.
 * @param {object} block
 * @returns {number}
 */
function repeatTimes(block) {
  const t = Math.floor(Number(block && block.times));
  return Number.isFinite(t) && t > 0 ? t : 0;
}

/**
 * True for an imageId the cursor is willing to show. imageIds are opaque to this
 * module (storage decides whether they are strings or numbers); only empty and
 * nullish values are rejected.
 * @param {unknown} id
 * @returns {boolean}
 */
function usableId(id) {
  return id !== undefined && id !== null && id !== '';
}

/**
 * Walk a block list and total up one lap.
 *
 * Stops at a top-level `gotoStart`: that block is the lap boundary, and anything
 * after it can never run, so it must not inflate the estimate.
 * @param {Array<object>} blocks
 * @param {number} depth
 * @returns {{ seconds: number, pictures: number, waits: number, repeats: number }}
 */
function measure(blocks, depth) {
  const total = { seconds: 0, pictures: 0, waits: 0, repeats: 0 };
  if (!Array.isArray(blocks) || depth >= MAX_NESTING_DEPTH) return total;
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'picture' || block.type === 'random') {
      total.pictures += 1;
    } else if (block.type === 'wait') {
      const s = Number(block.seconds);
      if (Number.isFinite(s) && s > 0) {
        total.seconds += s;
        total.waits += 1;
      }
    } else if (block.type === 'repeat') {
      const times = repeatTimes(block);
      if (times < 1) continue; // a repeat that never runs contributes nothing
      const inner = measure(block.blocks, depth + 1);
      total.seconds += inner.seconds * times;
      total.pictures += inner.pictures * times;
      total.waits += inner.waits * times;
      total.repeats += 1 + inner.repeats * times;
    } else if (block.type === 'gotoStart' && depth === 0) {
      break;
    }
  }
  return total;
}

/**
 * Index of the first top-level `gotoStart`, or -1.
 * @param {Array<object>} blocks
 * @returns {number}
 */
function gotoStartIndex(blocks) {
  return blocks.findIndex((b) => b && typeof b === 'object' && b.type === 'gotoStart');
}

/**
 * Check a program before it is saved or run.
 *
 * Errors are conditions that would damage the panel or that the engine cannot
 * execute; warnings are legal programs that probably do not do what the user
 * meant. `path` is a JS-ish accessor into the program, e.g. `blocks[2].blocks[0]`.
 *
 * @param {object|Array<object>} program program object or bare block array
 * @returns {{ ok: boolean, errors: Array<{path: string, message: string}>,
 *             warnings: Array<{path: string, message: string}> }}
 */
export function validate(program) {
  const errors = [];
  const warnings = [];
  const blocks = blocksOf(program);

  if (!blocks) {
    errors.push({ path: '', message: 'a program must be an array of blocks, or an object with a "blocks" array' });
    return { ok: false, errors, warnings };
  }
  if (blocks.length === 0) {
    errors.push({ path: 'blocks', message: 'the program is empty -- add at least one picture block' });
    return { ok: false, errors, warnings };
  }

  walk(blocks, 'blocks', 0, true);

  const gotoAt = gotoStartIndex(blocks);
  if (gotoAt >= 0 && gotoAt < blocks.length - 1) {
    // The "must be last" error is raised in walk(); flag the orphaned tail too so
    // the user can see exactly which blocks stopped running.
    for (let i = gotoAt + 1; i < blocks.length; i++) {
      warnings.push({
        path: `blocks[${i}]`,
        message: `unreachable -- execution jumps back to the start at blocks[${gotoAt}]`,
      });
    }
  }

  const lap = measure(blocks, 0);

  if (gotoAt >= 0) {
    if (lap.waits === 0) {
      // The single most damaging mistake available: an endless loop with no wait
      // redraws the panel as fast as BLE will carry the bytes. The panel cannot
      // keep up, the firmware answers busy, and the display is left flashing.
      errors.push({
        path: `blocks[${gotoAt}]`,
        message: 'endless loop with no wait block -- add a wait of at least '
          + `${MIN_WAIT_SECONDS} s, or the panel will be redrawn continuously`,
      });
    }
  } else {
    warnings.push({ path: 'blocks', message: 'no gotoStart block -- the program runs once and then stops' });
  }

  if (lap.pictures === 0) {
    warnings.push({ path: 'blocks', message: 'no picture blocks -- this program never shows anything' });
  } else {
    // How many refresh-to-refresh gaps this program actually has: a looping
    // program wraps around, so every picture is followed by another one. A
    // one-shot program's last picture has nothing after it to collide with,
    // which is why a single picture with no wait is not worth warning about.
    const gaps = gotoAt >= 0 ? lap.pictures : lap.pictures - 1;
    const needed = gaps * MIN_WAIT_SECONDS;
    if (gaps > 0 && lap.seconds < needed) {
      warnings.push({
        path: 'blocks',
        message: `one lap waits ${lap.seconds} s in total but shows ${lap.pictures} picture(s); `
          + `allow at least ${needed} s or a refresh will still be running when the next picture arrives`,
      });
    }
  }

  return { ok: errors.length === 0, errors, warnings };

  /**
   * Recursively check one block list.
   * @param {Array<object>} list
   * @param {string} prefix path prefix for this list
   * @param {number} depth current nesting depth
   * @param {boolean} isRoot true for the top-level list
   */
  function walk(list, prefix, depth, isRoot) {
    for (let i = 0; i < list.length; i++) {
      const block = list[i];
      const path = `${prefix}[${i}]`;

      if (!block || typeof block !== 'object' || Array.isArray(block)) {
        errors.push({ path, message: 'not a block object' });
        continue;
      }

      switch (block.type) {
        case 'picture':
          if (!usableId(block.imageId)) {
            errors.push({ path, message: 'picture block has no imageId -- pick an image or delete the block' });
          }
          break;

        case 'random':
          if (Array.isArray(block.pool)) {
            if (block.pool.length === 0) {
              errors.push({ path, message: 'random block has an empty pool -- use pool:"all" or list at least one image' });
            } else if (!block.pool.every(usableId)) {
              errors.push({ path, message: 'random block pool contains an empty imageId' });
            }
          } else if (block.pool !== 'all' && block.pool !== undefined) {
            errors.push({ path, message: 'random block pool must be "all" or an array of imageIds' });
          }
          break;

        case 'wait': {
          const s = Number(block.seconds);
          if (!Number.isFinite(s)) {
            errors.push({ path, message: 'wait block has no numeric seconds' });
          } else if (s < MIN_WAIT_SECONDS) {
            errors.push({
              path,
              message: `wait of ${s} s is below the ${MIN_WAIT_SECONDS} s minimum -- `
                + 'the e-ink panel needs about that long to finish a refresh',
            });
          }
          break;
        }

        case 'gotoStart':
          if (!isRoot) {
            errors.push({
              path,
              message: 'gotoStart cannot be used inside a repeat -- it belongs at the end of the program',
            });
          } else if (i !== list.length - 1) {
            errors.push({ path, message: 'gotoStart must be the last block in the program' });
          }
          break;

        case 'repeat': {
          const times = Math.floor(Number(block.times));
          if (!Number.isFinite(times) || times < 1) {
            errors.push({ path, message: 'repeat needs a whole "times" of 1 or more' });
          }
          if (!Array.isArray(block.blocks)) {
            errors.push({ path, message: 'repeat needs a "blocks" array' });
          } else if (block.blocks.length === 0) {
            warnings.push({ path, message: 'empty repeat -- it does nothing' });
          } else if (depth + 1 >= MAX_NESTING_DEPTH) {
            errors.push({ path, message: `repeat blocks are nested more than ${MAX_NESTING_DEPTH} deep` });
          } else {
            walk(block.blocks, `${path}.blocks`, depth + 1, false);
          }
          break;
        }

        default:
          errors.push({ path, message: `unknown block type ${JSON.stringify(block.type)}` });
      }
    }
  }
}

/**
 * Total up one lap of a program, for the "one lap is about 4 min" readout.
 *
 * `totalSeconds` is the sum of the wait blocks only -- the time a picture takes
 * to transfer and render is a property of the hardware and the image, not of the
 * program, so the UI should present this as a floor ("about"), not a promise.
 * Repeats are expanded by their `times`; blocks after a top-level gotoStart are
 * ignored because they never run.
 *
 * @param {object|Array<object>} program
 * @returns {{ totalSeconds: number, pictureCount: number, loops: number,
 *             looping: boolean, waitCount: number }}
 *   `loops` is Infinity when the program ends in gotoStart (it laps forever),
 *   otherwise 1. `looping` is the same fact as a boolean, for convenience.
 */
export function estimateCycle(program) {
  const blocks = blocksOf(program) || [];
  const lap = measure(blocks, 0);
  const looping = gotoStartIndex(blocks) >= 0;
  return {
    totalSeconds: lap.seconds,
    pictureCount: lap.pictures,
    loops: looping ? Infinity : 1,
    looping,
    waitCount: lap.waits,
  };
}

/**
 * Build a cursor: a pure step function over a program.
 *
 * The cursor holds only its own position -- no timers, no promises, no clock. It
 * is the caller's job to obey the waits (see the SCHEDULER CONTRACT at the top).
 *
 * @param {object|Array<object>} program
 * @param {{ random?: () => number, images?: Array<*> }} [opts]
 *   `random` is injectable for tests, defaulting to Math.random.
 *   `images` is the library's full imageId list, used to resolve `pool: 'all'`;
 *   pass it fresh on every run, because the library changes while the cursor's
 *   saved state does not.
 * @returns {{ next: () => ({kind:'show', imageId:*, path:number[]}
 *                        | {kind:'wait', ms:number, path:number[]}
 *                        | {kind:'end'}),
 *             reset: () => void,
 *             position: {path:number[], done:boolean, steps:number, lastImageId:*} }}
 */
export function createCursor(program, opts = {}) {
  const options = opts || {};
  const random = typeof options.random === 'function' ? options.random : Math.random;
  const images = Array.isArray(options.images) ? options.images.slice() : [];
  const rootBlocks = blocksOf(program) || [];

  /** Frame stack. stack[0] indexes rootBlocks; each deeper frame indexes the
   *  `blocks` of the repeat its parent frame is currently sitting on. A parent's
   *  index stays parked ON the repeat block until that repeat is finished, which
   *  is what makes the whole position expressible as a list of integers -- and
   *  therefore serialisable. */
  let stack;
  let lastImageId;
  let steps;
  let done;

  reset();

  /**
   * Resolve the block list that frame `d` indexes into, or null if the saved
   * position no longer matches the program.
   * @param {number} d
   * @returns {Array<object>|null}
   */
  function frameBlocks(d) {
    let list = rootBlocks;
    for (let k = 0; k < d; k++) {
      const block = list[stack[k].i];
      if (!block || block.type !== 'repeat' || !Array.isArray(block.blocks)) return null;
      list = block.blocks;
    }
    return list;
  }

  /**
   * Pick an id for a random block.
   * @param {object} block
   * @returns {*} an imageId, or null when the pool is empty
   */
  function pickRandom(block) {
    const raw = Array.isArray(block.pool) ? block.pool : images; // pool:'all' (or missing) = whole library
    const ids = raw.filter(usableId);
    if (ids.length === 0) return null;

    let candidates = ids;
    // avoidRepeat defaults to on: showing the same picture twice in a row costs a
    // 20 s refresh and looks like the automation has stalled.
    if (block.avoidRepeat !== false && ids.length > 1 && usableId(lastImageId)) {
      const others = ids.filter((id) => id !== lastImageId);
      if (others.length > 0) candidates = others;
    }

    const r = Number(random());
    let idx = Math.floor((Number.isFinite(r) ? r : 0) * candidates.length);
    if (!(idx >= 0)) idx = 0;
    if (idx >= candidates.length) idx = candidates.length - 1; // random() === 1 is legal in some stubs
    return candidates[idx];
  }

  /** @returns {number[]} indices of the block about to run */
  function currentPath() {
    return stack.map((f) => f.i);
  }

  /**
   * Advance one step.
   * @returns {{kind:'show', imageId:*, path:number[]}|{kind:'wait', ms:number, path:number[]}|{kind:'end'}}
   */
  function next() {
    if (done) return { kind: 'end' };

    for (let guard = 0; guard < MAX_STEPS_PER_NEXT; guard++) {
      const d = stack.length - 1;
      const list = frameBlocks(d);
      if (!list) { done = true; return { kind: 'end' }; } // position no longer fits the program

      const frame = stack[d];

      if (frame.i >= list.length) {
        if (d === 0) { done = true; return { kind: 'end' }; }
        // End of one pass through a repeat body.
        const parentList = frameBlocks(d - 1);
        const repeatBlock = parentList ? parentList[stack[d - 1].i] : null;
        frame.iter += 1;
        if (repeatBlock && frame.iter < repeatTimes(repeatBlock)) {
          frame.i = 0;
          continue;
        }
        stack.pop();
        stack[d - 1].i += 1;
        continue;
      }

      const block = list[frame.i];
      const path = currentPath();

      switch (block && block.type) {
        case 'picture': {
          frame.i += 1;
          if (!usableId(block.imageId)) continue; // validate() rejects these; skip rather than stall
          lastImageId = block.imageId;
          steps += 1;
          return { kind: 'show', imageId: block.imageId, path };
        }

        case 'random': {
          frame.i += 1;
          const id = pickRandom(block);
          if (!usableId(id)) continue; // empty library: nothing to show, move on
          lastImageId = id;
          steps += 1;
          return { kind: 'show', imageId: id, path };
        }

        case 'wait': {
          frame.i += 1;
          const s = Number(block.seconds);
          if (!Number.isFinite(s) || s <= 0) continue;
          steps += 1;
          return { kind: 'wait', ms: Math.round(s * 1000), path };
        }

        case 'gotoStart':
          // Jump back to block 0 and keep stepping: gotoStart is not itself an
          // action, so a lap boundary must never cost the caller a next() call.
          stack = [{ i: 0, iter: 0 }];
          continue;

        case 'repeat': {
          if (repeatTimes(block) < 1 || !Array.isArray(block.blocks) || block.blocks.length === 0
              || stack.length >= MAX_NESTING_DEPTH) {
            frame.i += 1;
            continue;
          }
          stack.push({ i: 0, iter: 0 });
          continue;
        }

        default:
          frame.i += 1; // unknown block type: ignore it rather than abort the run
          continue;
      }
    }

    // Only reachable from a program that emits nothing at all (an invalid one --
    // validate() rejects every shape that can do this). Treat it as finished; a
    // hung tab would be far worse than a run that stops.
    done = true;
    return { kind: 'end' };
  }

  /** Return to block 0 and forget the run's history. @returns {void} */
  function reset() {
    stack = [{ i: 0, iter: 0 }];
    lastImageId = null;
    steps = 0;
    done = false;
  }

  const cursor = {
    next,
    reset,
    get position() {
      return { path: currentPath(), done, steps, lastImageId: lastImageId === undefined ? null : lastImageId };
    },
  };

  INTERNALS.set(cursor, {
    /** @returns {object} JSON-safe snapshot */
    save() {
      return {
        v: STATE_VERSION,
        stack: stack.map((f) => ({ i: f.i, iter: f.iter })),
        lastImageId: lastImageId === undefined ? null : lastImageId,
        steps,
        done,
      };
    },
    /**
     * Apply a saved snapshot.
     * @param {object} state
     * @returns {boolean} false if the state does not fit this program
     */
    load(state) {
      if (!state || typeof state !== 'object' || state.v !== STATE_VERSION) return false;
      if (!Array.isArray(state.stack) || state.stack.length === 0
          || state.stack.length > MAX_NESTING_DEPTH) return false;

      const frames = [];
      let list = rootBlocks;
      for (let k = 0; k < state.stack.length; k++) {
        const f = state.stack[k];
        if (!f || typeof f !== 'object') return false;
        const i = Math.floor(Number(f.i));
        const iter = Math.floor(Number(f.iter));
        // i === list.length is legal: it means "this list is finished", which is
        // exactly where a cursor sits after emitting the last block of a body.
        if (!Number.isFinite(i) || i < 0 || i > list.length) return false;
        if (!Number.isFinite(iter) || iter < 0) return false;
        frames.push({ i, iter });
        if (k < state.stack.length - 1) {
          const block = list[i];
          if (!block || block.type !== 'repeat' || !Array.isArray(block.blocks)) return false;
          list = block.blocks;
        }
      }

      stack = frames;
      lastImageId = usableId(state.lastImageId) ? state.lastImageId : null;
      steps = Number.isFinite(Number(state.steps)) ? Math.floor(Number(state.steps)) : 0;
      done = state.done === true;
      return true;
    },
  });

  return cursor;
}

/**
 * Snapshot a cursor's position so a run can survive a page reload.
 *
 * The result is plain JSON (safe for localStorage/IndexedDB) and holds only the
 * position -- not the program and not the image library. Store your own absolute
 * `dueAt` alongside it; the cursor has no idea what time it is.
 *
 * @param {object} cursor a cursor from createCursor() or restore()
 * @returns {{v:number, stack:Array<{i:number, iter:number}>, lastImageId:*, steps:number, done:boolean}}
 */
export function serialize(cursor) {
  const inner = INTERNALS.get(cursor);
  if (!inner) throw new TypeError('serialize() expects a cursor from createCursor() or restore()');
  return inner.save();
}

/**
 * Rebuild a cursor from a serialize() snapshot.
 *
 * If the state does not fit the program -- the user edited the program between
 * runs, the file was hand-edited, the format is from a future version -- restore
 * silently returns a cursor parked at block 0 instead of throwing. A stale saved
 * run must never be able to brick the app on load; starting the lap over is a
 * cheap, obvious recovery. Compare `cursor.position.path` against the state you
 * passed in if you want to tell the user it happened.
 *
 * @param {object|Array<object>} program
 * @param {object} state a value previously returned by serialize()
 * @param {{ random?: () => number, images?: Array<*> }} [opts] same options as createCursor()
 * @returns {ReturnType<typeof createCursor>}
 */
export function restore(program, state, opts = {}) {
  const cursor = createCursor(program, opts);
  const inner = INTERNALS.get(cursor);
  if (!inner.load(state)) cursor.reset();
  return cursor;
}
