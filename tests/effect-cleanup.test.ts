import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

/**
 * React treats whatever an effect returns as its cleanup and calls it on the
 * next run. An expression-bodied effect returns its expression, and browser
 * APIs that used to return undefined can start returning values (Chrome now
 * returns a Promise from scrollIntoView), which crashed /start in production.
 * Effects must use a block body so they only ever return a cleanup on purpose.
 */
const ROOTS = ['app', 'lib', 'components'];
const EXPRESSION_EFFECT = /use(?:Layout)?Effect\(\s*(?:async\s*)?\([^)]*\)\s*=>[ \t]*(?![ \t{]|$)/;

function sourceFiles(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of entries) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(tsx|ts)$/.test(name)) out.push(path);
  }
  return out;
}

test('no effect returns an expression as its cleanup', () => {
  const offenders: string[] = [];
  for (const root of ROOTS) {
    for (const file of sourceFiles(root)) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (EXPRESSION_EFFECT.test(line)) offenders.push(`${file}:${i + 1}`);
        });
    }
  }
  assert.deepEqual(offenders, [], `use a block body in these effects: ${offenders.join(', ')}`);
});

test('the guard catches the pattern that broke /start', () => {
  assert.ok(EXPRESSION_EFFECT.test("useEffect(() => ref.current?.scrollIntoView({ block: 'end' }), [items]);"));
  assert.ok(!EXPRESSION_EFFECT.test("useEffect(() => {"));
  assert.ok(!EXPRESSION_EFFECT.test('useEffect(() => { ref.current?.focus(); }, []);'));
  assert.ok(!EXPRESSION_EFFECT.test('useEffect(() =>'));
});
