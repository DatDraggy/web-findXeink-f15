/**
 * Test runner. No framework, no dependencies.
 *
 * Discovers every *.test.js in this directory and calls its default export with
 * a tiny assertion object. Run with: npm test
 */

import { readdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

let pass = 0;
let fail = 0;
const failures = [];

function makeT(suite) {
  return {
    check(name, actual, expected) {
      const a = format(actual);
      const e = format(expected);
      if (a === e) {
        pass++;
      } else {
        fail++;
        failures.push({ suite, name, expected: e, actual: a });
        console.log(`  FAIL  ${name}\n          expected: ${e}\n          actual:   ${a}`);
      }
    },
    ok(name, cond) {
      if (cond) {
        pass++;
      } else {
        fail++;
        failures.push({ suite, name, expected: 'truthy', actual: String(cond) });
        console.log(`  FAIL  ${name}`);
      }
    },
    /** Assert that fn throws, optionally matching a substring of the message. */
    throws(name, fn, match) {
      try {
        fn();
        fail++;
        failures.push({ suite, name, expected: 'throw', actual: 'no throw' });
        console.log(`  FAIL  ${name} — expected a throw`);
      } catch (e) {
        if (match && !String(e.message).includes(match)) {
          fail++;
          failures.push({ suite, name, expected: `message containing "${match}"`, actual: e.message });
          console.log(`  FAIL  ${name} — wrong message: ${e.message}`);
        } else {
          pass++;
        }
      }
    },
  };
}

function format(v) {
  if (v instanceof Uint8Array || Array.isArray(v)) return `[${Array.from(v).join(',')}]`;
  if (v && typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

const files = (await readdir(here))
  .filter((f) => f.endsWith('.test.js'))
  .sort();

if (!files.length) {
  console.log('No test files found.');
  process.exit(1);
}

for (const file of files) {
  const suite = file.replace('.test.js', '');
  console.log(`\n── ${suite} ──`);
  const before = fail;
  try {
    const mod = await import(pathToFileURL(join(here, file)).href);
    if (typeof mod.default !== 'function') {
      console.log('  (no default export — skipped)');
      continue;
    }
    await mod.default(makeT(suite));
  } catch (e) {
    fail++;
    failures.push({ suite, name: 'module threw', expected: '-', actual: e.stack });
    console.log(`  FAIL  suite threw: ${e.message}`);
  }
  if (fail === before) console.log(`  ${pass} assertions so far, all passing`);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  ${f.suite} › ${f.name}`);
}
process.exit(fail ? 1 : 0);
