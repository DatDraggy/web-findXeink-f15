// Throwaway integration probe. Resolves every static import across the repo
// against the target module's real exports. A name imported but not exported is
// a hard break the moment the browser loads the graph.
import { readFileSync, globSync } from 'node:fs';
import path from 'node:path';

const ROOT = 'K:/Code/bledebug/web-findxeink-f15';
const all = globSync('**/*.js', { cwd: ROOT }).map((f) => f.split(path.sep).join('/'));
// Parse imports from the whole app graph...
const files = all.filter((f) => f.startsWith('js/') || f.startsWith('test/'));
// ...but only LOAD js/, since serve.js, tools/ and test/run.js are entry points
// that run (and exit) on import.
const loadable = all.filter((f) => f.startsWith('js/'));

const exportsOf = new Map();
for (const f of loadable) {
  const abs = ROOT + '/' + f;
  try {
    const ns = await import('file:///' + abs);
    exportsOf.set(abs, new Set(Object.keys(ns)));
  } catch (e) {
    exportsOf.set(abs, null);
  }
}

const re = /import\s+([^;]*?)\s+from\s+['"]([^'"]+)['"]/g;
let problems = 0;
for (const f of files) {
  const abs = ROOT + '/' + f;
  const src = readFileSync(abs, 'utf8');
  let m;
  while ((m = re.exec(src))) {
    const clause = m[1];
    const spec = m[2];
    if (!spec.startsWith('.')) continue;
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(abs), spec));
    const have = exportsOf.get(target);
    if (have === undefined) {
      console.log('MISSING FILE  ' + f + ' -> ' + spec);
      problems++;
      continue;
    }
    if (have === null) {
      console.log('UNLOADABLE    ' + f + ' -> ' + spec);
      problems++;
      continue;
    }
    const braces = clause.match(/\{([^}]*)\}/);
    if (!braces) continue;
    for (let part of braces[1].split(',')) {
      part = part.trim();
      if (!part) continue;
      const name = part.split(/\s+as\s+/)[0].trim();
      if (!have.has(name)) {
        console.log('NOT EXPORTED  ' + f + ' imports {' + name + '} from ' + spec);
        problems++;
      }
    }
  }
}
console.log(problems ? '\n' + problems + ' import problem(s)' : '\nAll static imports resolve.');
