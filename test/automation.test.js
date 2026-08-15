/**
 * Tests for js/automation.js -- the block-program engine.
 *
 * Plain Node, no framework. The shared runner (test/run.js) imports the default
 * export and hands us { check(name, actual, expected), ok(name, cond) }.
 * check() compares String(actual) === String(expected), so structures are
 * compared as JSON strings here.
 */

import {
  MIN_WAIT_SECONDS,
  validate,
  estimateCycle,
  createCursor,
  serialize,
  restore,
} from '../js/automation.js';

/** Compact one step into something readable in a failure message. */
const s = (step) => (step.kind === 'show' ? `show:${step.imageId}`
  : step.kind === 'wait' ? `wait:${step.ms}`
    : step.kind);

/** Pull n steps off a cursor as a compact string. */
const walk = (cursor, n) => {
  const out = [];
  for (let i = 0; i < n; i++) out.push(s(cursor.next()));
  return out.join(' ');
};

/** True if some error/warning sits at `path` and its message matches `re`. */
const has = (list, path, re) => list.some((e) => e.path === path && re.test(e.message));

/** A stubbed random that replays a fixed sequence, then repeats it. */
const stubRandom = (values) => {
  let i = 0;
  return () => values[i++ % values.length];
};

const pic = (imageId) => ({ type: 'picture', imageId });
const wait = (seconds) => ({ type: 'wait', seconds });
const GOTO = { type: 'gotoStart' };

/** The representative program used by the walk / serialize tests. */
const demo = () => ({
  version: 1,
  blocks: [
    pic('a'),
    wait(20),
    { type: 'repeat', times: 2, blocks: [pic('b'), wait(30)] },
    pic('c'),
    wait(45.4), // fractional seconds must round to whole ms
    GOTO,
  ],
});

export default function run(t) {
  /* ── constants ────────────────────────────────────────────────────────── */
  t.check('MIN_WAIT_SECONDS is 20', MIN_WAIT_SECONDS, 20);

  /* ── validate: a clean program ────────────────────────────────────────── */
  const good = validate({ blocks: [pic('a'), wait(30), pic('b'), wait(30), GOTO] });
  t.ok('a well-formed looping program is ok', good.ok === true);
  t.check('...with no errors', good.errors.length, 0);
  t.check('...and no warnings', JSON.stringify(good.warnings), '[]');

  // The program the cursor tests walk must itself be legal, or those tests are
  // asserting the behaviour of something the UI would refuse to run.
  const demoCheck = validate(demo());
  t.ok('the representative program validates clean', demoCheck.ok === true);
  t.check('...with no warnings either', JSON.stringify(demoCheck.warnings), '[]');

  t.ok('a bare block array is accepted as a program',
    validate([pic('a'), wait(20), GOTO]).ok === true);
  t.ok(`a wait of exactly ${MIN_WAIT_SECONDS} s is allowed`,
    validate([pic('a'), wait(MIN_WAIT_SECONDS), GOTO]).ok === true);

  /* ── validate: errors ─────────────────────────────────────────────────── */
  const notAProgram = validate(null);
  t.ok('null is not a program', notAProgram.ok === false);
  t.ok('...reported at the root path', has(notAProgram.errors, '', /array of blocks/));
  t.ok('a string is not a program', validate('nope').ok === false);

  const empty = validate({ blocks: [] });
  t.ok('an empty program is an error', empty.ok === false);
  t.ok('...with a helpful message', has(empty.errors, 'blocks', /empty/));
  t.ok('an empty bare array is an error too', validate([]).ok === false);

  const short = validate([pic('a'), wait(19), GOTO]);
  t.ok('a wait below the minimum is an error', short.ok === false);
  t.ok('...pointed at the offending block', has(short.errors, 'blocks[1]', /below the 20 s minimum/));
  t.ok('a wait of 0.5 s is an error', validate([pic('a'), wait(0.5), GOTO]).ok === false);
  t.ok('a wait with no seconds is an error',
    has(validate([pic('a'), { type: 'wait' }, GOTO]).errors, 'blocks[1]', /numeric seconds/));

  const noImage = validate([pic(''), wait(30), GOTO]);
  t.ok('a picture block with no imageId is an error', noImage.ok === false);
  t.ok('...pointed at the block', has(noImage.errors, 'blocks[0]', /no imageId/));
  t.ok('imageId undefined is an error too',
    has(validate([{ type: 'picture' }, wait(30), GOTO]).errors, 'blocks[0]', /no imageId/));

  const lateGoto = validate([pic('a'), GOTO, wait(30)]);
  t.ok('gotoStart that is not last is an error', lateGoto.ok === false);
  t.ok('...with the reason', has(lateGoto.errors, 'blocks[1]', /must be the last block/));

  const nestedGoto = validate([{ type: 'repeat', times: 2, blocks: [pic('a'), wait(30), GOTO] }]);
  t.ok('gotoStart inside a repeat is an error', nestedGoto.ok === false);
  t.ok('...reported on the nested path',
    has(nestedGoto.errors, 'blocks[0].blocks[2]', /cannot be used inside a repeat/));

  const tight = validate([pic('a'), pic('b'), GOTO]);
  t.ok('an endless loop with no wait is an error', tight.ok === false);
  t.ok('...pointed at the gotoStart', has(tight.errors, 'blocks[2]', /endless loop with no wait/));
  t.ok('a wait inside a repeat satisfies the endless-loop rule',
    validate([{ type: 'repeat', times: 2, blocks: [pic('a'), wait(30)] }, GOTO]).ok === true);
  t.ok('a wait inside a repeat that never runs does not',
    has(validate([pic('a'), { type: 'repeat', times: 0, blocks: [wait(30)] }, GOTO]).errors,
      'blocks[2]', /endless loop with no wait/));

  const badTimes = validate([{ type: 'repeat', times: 0, blocks: [pic('a'), wait(30)] }, GOTO]);
  t.ok('repeat with times < 1 is an error', badTimes.ok === false);
  t.ok('...with the reason', has(badTimes.errors, 'blocks[0]', /times/));
  t.ok('repeat with a negative times is an error',
    has(validate([{ type: 'repeat', times: -3, blocks: [pic('a')] }]).errors, 'blocks[0]', /times/));
  t.ok('repeat with no blocks array is an error',
    has(validate([{ type: 'repeat', times: 2 }]).errors, 'blocks[0]', /"blocks" array/));

  t.ok('an unknown block type is an error',
    has(validate([{ type: 'clearScreen' }]).errors, 'blocks[0]', /unknown block type/));
  t.ok('a non-object in the block list is an error',
    has(validate([pic('a'), null, wait(30), GOTO]).errors, 'blocks[1]', /not a block object/));

  t.ok('a random block with an empty pool is an error',
    has(validate([{ type: 'random', pool: [] }, wait(30), GOTO]).errors, 'blocks[0]', /empty pool/));
  t.ok('a random block with a nonsense pool is an error',
    has(validate([{ type: 'random', pool: 'some' }, wait(30), GOTO]).errors, 'blocks[0]', /must be "all"/));
  t.ok('random with pool:"all" is fine',
    validate([{ type: 'random', pool: 'all', avoidRepeat: true }, wait(30), GOTO]).ok === true);

  // 9 nested repeats: deeper than the engine will execute, so it must be refused
  // rather than silently ignored at run time.
  let deep = { type: 'repeat', times: 2, blocks: [pic('a'), wait(30)] };
  for (let i = 0; i < 8; i++) deep = { type: 'repeat', times: 2, blocks: [deep] };
  t.ok('absurdly nested repeats are an error',
    validate([deep, GOTO]).errors.some((e) => /nested more than/.test(e.message)));

  /* ── validate: warnings ───────────────────────────────────────────────── */
  const once = validate([pic('a'), wait(30), pic('b'), wait(30)]);
  t.ok('a program with no gotoStart is still valid', once.ok === true);
  t.ok('...but warns that it runs once', has(once.warnings, 'blocks', /runs once/));

  const rushed = validate([pic('a'), wait(20), pic('b'), wait(20), pic('c'), GOTO]);
  t.ok('a too-short cycle is valid', rushed.ok === true);
  t.ok('...but warns about the refresh budget', has(rushed.warnings, 'blocks', /at least 60 s/));
  t.ok('a lap with enough slack does not warn about the budget',
    validate([pic('a'), wait(30), pic('b'), wait(30), GOTO]).warnings.length === 0);
  t.ok('a single one-shot picture does not warn about the budget',
    validate([pic('a')]).warnings.every((w) => !/refresh/.test(w.message)));

  const orphan = validate([pic('a'), wait(30), GOTO, pic('b'), wait(30)]);
  t.ok('blocks after gotoStart warn as unreachable',
    has(orphan.warnings, 'blocks[3]', /unreachable/) && has(orphan.warnings, 'blocks[4]', /unreachable/));
  t.check('...one warning per orphaned block', orphan.warnings.filter((w) => /unreachable/.test(w.message)).length, 2);

  t.ok('a program that shows nothing warns',
    has(validate([wait(30), GOTO]).warnings, 'blocks', /never shows anything/));
  t.ok('an empty repeat warns',
    has(validate([pic('a'), { type: 'repeat', times: 2, blocks: [] }, wait(30), GOTO]).warnings,
      'blocks[1]', /empty repeat/));

  /* ── estimateCycle ────────────────────────────────────────────────────── */
  const est = estimateCycle({
    blocks: [pic('a'), wait(20), { type: 'repeat', times: 3, blocks: [{ type: 'random', pool: 'all' }, wait(25)] }, GOTO],
  });
  t.check('estimateCycle totalSeconds = 20 + 3*25', est.totalSeconds, 95);
  t.check('estimateCycle counts pictures through repeats', est.pictureCount, 4);
  t.check('estimateCycle counts waits through repeats', est.waitCount, 4);
  t.check('estimateCycle loops forever with gotoStart', est.loops, Infinity);
  t.ok('...and says so as a boolean', est.looping === true);

  const estOnce = estimateCycle([pic('a'), wait(60)]);
  t.check('a program without gotoStart runs one lap', estOnce.loops, 1);
  t.check('...totalling its waits', estOnce.totalSeconds, 60);
  t.ok('...and looping is false', estOnce.looping === false);

  t.check('nested repeats multiply',
    estimateCycle([{ type: 'repeat', times: 2, blocks: [{ type: 'repeat', times: 3, blocks: [wait(20)] }] }]).totalSeconds,
    120);
  t.check('a repeat with times 0 contributes nothing',
    estimateCycle([{ type: 'repeat', times: 0, blocks: [pic('a'), wait(30)] }]).totalSeconds, 0);
  t.check('blocks after gotoStart are not part of a lap',
    estimateCycle([pic('a'), wait(30), GOTO, wait(999)]).totalSeconds, 30);
  t.check('an empty program estimates to zero',
    JSON.stringify(estimateCycle([])), JSON.stringify({ totalSeconds: 0, pictureCount: 0, loops: 1, looping: false, waitCount: 0 }));

  /* ── cursor: a full walk of the representative program ────────────────── */
  const cur = createCursor(demo());
  t.check('full walk of the demo program, including the loop back to the start',
    walk(cur, 12),
    'show:a wait:20000 show:b wait:30000 show:b wait:30000 show:c wait:45400 show:a wait:20000 show:b wait:30000');

  t.check('a fractional wait rounds to whole milliseconds',
    createCursor([wait(45.4)]).next().ms, 45400);

  /* ── cursor: gotoStart really is endless ──────────────────────────────── */
  const looper = createCursor([pic('a'), wait(30), pic('b'), wait(30), GOTO]);
  const lap1 = walk(looper, 4);
  const lap2 = walk(looper, 4);
  const lap3 = walk(looper, 4);
  t.check('lap 1', lap1, 'show:a wait:30000 show:b wait:30000');
  t.ok('every lap is identical', lap1 === lap2 && lap2 === lap3);
  let sawEnd = false;
  for (let i = 0; i < 200; i++) if (looper.next().kind === 'end') sawEnd = true;
  t.ok('a looping program never reports end', sawEnd === false);

  /* ── cursor: end is terminal and idempotent ───────────────────────────── */
  const finite = createCursor([pic('a'), wait(30)]);
  t.check('a one-shot program ends after its last block',
    walk(finite, 4), 'show:a wait:30000 end end');
  t.ok('position reports done', finite.position.done === true);

  /* ── cursor: reset ────────────────────────────────────────────────────── */
  const resettable = createCursor(demo());
  walk(resettable, 5);
  resettable.reset();
  t.check('reset returns to the first block', walk(resettable, 3), 'show:a wait:20000 show:b');
  t.check('reset zeroes the step count', createCursor(demo()).position.steps, 0);

  /* ── cursor: nested repeat ────────────────────────────────────────────── */
  const nested = createCursor([
    {
      type: 'repeat',
      times: 2,
      blocks: [
        pic('x'),
        { type: 'repeat', times: 2, blocks: [pic('y'), wait(20)] },
        wait(20),
      ],
    },
  ]);
  t.check('nested repeats expand inner-first and restart cleanly',
    walk(nested, 12),
    'show:x show:y wait:20000 show:y wait:20000 wait:20000 '
    + 'show:x show:y wait:20000 show:y wait:20000 wait:20000');
  t.check('...then the program ends', nested.next().kind, 'end');

  /* ── cursor: position ─────────────────────────────────────────────────── */
  const pos = createCursor(demo());
  t.check('position starts at block 0', JSON.stringify(pos.position.path), '[0]');
  walk(pos, 3); // show a, wait, show b -- now inside the repeat
  t.check('position inside a repeat is a path', JSON.stringify(pos.position.path), '[2,1]');
  t.check('position tracks the last shown image', pos.position.lastImageId, 'b');
  t.check('position counts emitted steps', pos.position.steps, 3);

  /* ── cursor: random ───────────────────────────────────────────────────── */
  // A stub that always picks index 0 proves avoidRepeat is doing the work: with
  // the previous id filtered out of the pool, index 0 is a different picture.
  const alt = createCursor([{ type: 'random', pool: ['a', 'b', 'c'], avoidRepeat: true }, wait(30), GOTO],
    { random: () => 0 });
  const picks = [];
  for (let i = 0; i < 20; i++) {
    const step = alt.next();
    if (step.kind === 'show') picks.push(step.imageId);
  }
  t.check('avoidRepeat gives 10 pictures over 20 steps', picks.length, 10);
  t.ok('avoidRepeat never shows the same picture twice in a row',
    picks.every((id, i) => i === 0 || id !== picks[i - 1]));
  t.check('...and with a fixed random it alternates', picks.slice(0, 4).join(','), 'a,b,a,b');

  const repeaty = createCursor([{ type: 'random', pool: ['a', 'b', 'c'], avoidRepeat: false }, wait(30), GOTO],
    { random: () => 0 });
  t.check('avoidRepeat:false is allowed to repeat',
    [repeaty.next(), repeaty.next(), repeaty.next()].map(s).join(' '), 'show:a wait:30000 show:a');

  const solo = createCursor([{ type: 'random', pool: ['only'], avoidRepeat: true }, wait(30), GOTO],
    { random: () => 0 });
  t.check('a one-image pool still shows that image every lap',
    walk(solo, 4), 'show:only wait:30000 show:only wait:30000');

  const all = createCursor([{ type: 'random', pool: 'all', avoidRepeat: true }, wait(30), GOTO],
    { random: stubRandom([0.9, 0.1, 0.5]), images: ['i1', 'i2', 'i3'] });
  t.check('pool:"all" draws from opts.images',
    walk(all, 6), 'show:i3 wait:30000 show:i1 wait:30000 show:i3 wait:30000');

  const emptyLib = createCursor([{ type: 'random', pool: 'all' }, pic('a'), wait(30)], { images: [] });
  t.check('a random block with an empty library is skipped, not stalled',
    walk(emptyLib, 3), 'show:a wait:30000 end');

  t.check('random() returning exactly 1 does not fall off the end of the pool',
    createCursor([{ type: 'random', pool: ['a', 'b'] }], { random: () => 1 }).next().imageId, 'b');

  /* ── serialize / restore ──────────────────────────────────────────────── */
  const live = createCursor(demo());
  t.check('five steps before saving', walk(live, 5),
    'show:a wait:20000 show:b wait:30000 show:b');
  const saved = serialize(live);
  t.check('the saved state is plain JSON',
    JSON.stringify(JSON.parse(JSON.stringify(saved))), JSON.stringify(saved));
  t.check('the saved state records the position inside the repeat',
    JSON.stringify(saved.stack), JSON.stringify([{ i: 2, iter: 0 }, { i: 1, iter: 1 }]));
  t.check('the saved state remembers the last picture', saved.lastImageId, 'b');

  const resumed = restore(demo(), JSON.parse(JSON.stringify(saved)));
  t.check('a restored cursor is at the same position',
    JSON.stringify(resumed.position), JSON.stringify(live.position));
  const tailLive = walk(live, 8);
  const tailResumed = walk(resumed, 8);
  t.check('a restored run continues exactly where it left off',
    tailResumed, 'wait:30000 show:c wait:45400 show:a wait:20000 show:b wait:30000 show:b');
  t.ok('...matching the cursor it was copied from', tailLive === tailResumed);

  // avoidRepeat must survive a reload, or the first picture after a page refresh
  // can be the one already on the panel.
  const randProg = [{ type: 'random', pool: ['a', 'b'], avoidRepeat: true }, wait(30), GOTO];
  const randCur = createCursor(randProg, { random: () => 0 });
  t.check('random cursor shows a first', s(randCur.next()), 'show:a');
  const randResumed = restore(randProg, serialize(randCur), { random: () => 0 });
  t.check('avoidRepeat state survives a reload', walk(randResumed, 2), 'wait:30000 show:b');

  const doneCur = createCursor([pic('a')]);
  walk(doneCur, 2);
  t.check('a finished run restores as finished', restore([pic('a')], serialize(doneCur)).next().kind, 'end');

  t.ok('serialize rejects anything that is not a cursor', (() => {
    try { serialize({ next() {} }); return false; } catch (e) { return e instanceof TypeError; }
  })());

  // A saved run must never brick the app when the program it belongs to has been
  // edited underneath it -- restore falls back to the start of the program.
  t.check('restore ignores state that no longer fits the program',
    JSON.stringify(restore([pic('a'), wait(30), GOTO], saved).position.path), '[0]');
  t.check('restore ignores a garbage state',
    JSON.stringify(restore(demo(), { v: 99, stack: [{ i: 0 }] }).position.path), '[0]');
  t.check('restore ignores a null state',
    JSON.stringify(restore(demo(), null).position.path), '[0]');
  t.check('restore ignores an out-of-range index',
    JSON.stringify(restore(demo(), { v: 1, stack: [{ i: 99, iter: 0 }], lastImageId: null, steps: 0, done: false }).position.path),
    '[0]');
  t.check('a cursor restored from garbage still runs from the top',
    walk(restore(demo(), null), 2), 'show:a wait:20000');

  // Editing a "repeat 3" down to "repeat 1" strands the saved iteration counter
  // past the end of the loop; resuming it would run an extra pass of the body.
  const shrunk = [pic('a'), wait(20), { type: 'repeat', times: 1, blocks: [pic('b'), wait(30)] }, GOTO];
  const inRepeat = (iter) => ({ v: 1, stack: [{ i: 2, iter: 0 }, { i: 0, iter }], lastImageId: 'a', steps: 3, done: false });
  t.check('restore rejects an iteration the repeat no longer reaches',
    JSON.stringify(restore(shrunk, inRepeat(2)).position.path), '[0]');
  t.check('...but keeps one that still fits',
    JSON.stringify(restore(shrunk, inRepeat(0)).position.path), '[2,0]');

  /* ── the engine must never hang the tab ───────────────────────────────── */
  // validate() rejects this, but a hand-edited program must still terminate.
  const pathological = createCursor([GOTO]);
  t.check('a program that emits nothing terminates instead of spinning',
    pathological.next().kind, 'end');
  t.check('an empty program ends immediately', createCursor([]).next().kind, 'end');
  t.check('a program of unknown blocks ends',
    createCursor([{ type: 'nope' }, { type: 'alsoNope' }]).next().kind, 'end');
}
