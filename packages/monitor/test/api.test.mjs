// The package's shape: what an app gets from `import` and from `require`, and that the hand-written types say the same.
//   npm test -w @cyberrakshak/monitor
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esm from '@cyberrakshak/monitor';
import esmDefault from '@cyberrakshak/monitor';

const here = fileURLToPath(new URL('.', import.meta.url));
const pkgDir = join(here, '..');
const require = createRequire(import.meta.url);
const cjs = require('@cyberrakshak/monitor');
const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
const dts = readFileSync(join(pkgDir, 'index.d.ts'), 'utf8');

const named = (mod) => Object.keys(mod).filter((k) => k !== 'default').sort();

test('import gets the ES module and require the CommonJS twin, through "exports"', () => {
  assert.equal(fileURLToPath(import.meta.resolve('@cyberrakshak/monitor')), join(pkgDir, 'cyberrakshak-monitor.mjs'));
  assert.equal(require.resolve('@cyberrakshak/monitor'), join(pkgDir, 'cyberrakshak-monitor.cjs'));
});

test('both have the same functions, by name and as the default export', () => {
  assert.deepEqual(named(esm), ['captureException', 'captureMessage', 'captureRequestError', 'close', 'expressErrorHandler', 'flush', 'init', 'scrub']);
  assert.deepEqual(named(cjs), named(esm));
  assert.deepEqual(Object.keys(esmDefault).sort(), named(esm));
  for (const name of named(esm)) {
    assert.equal(typeof esm[name], 'function', name);
    assert.equal(typeof cjs[name], 'function', 'cjs ' + name);
    assert.equal(esmDefault[name], esm[name], 'default.' + name);
  }
  assert.equal(cjs.default, cjs);
});

test('index.d.ts declares every exported function, and nothing that is not there', () => {
  const declared = [...dts.matchAll(/^export declare function (\w+)\(/gm)].map((m) => m[1]).sort();
  assert.deepEqual(declared, named(esm));
  const inDefault = [...dts.slice(dts.indexOf('declare const monitor')).matchAll(/^\s+(\w+): typeof (\w+);$/gm)].map((m) => {
    assert.equal(m[1], m[2]);
    return m[1];
  });
  assert.deepEqual(inDefault.sort(), named(esm));
});

test('index.d.mts (for import) is index.d.ts (for require)', () => {
  assert.equal(readFileSync(join(pkgDir, 'index.d.mts'), 'utf8'), dts);
});

test('package.json states what the library itself says', () => {
  const source = readFileSync(join(pkgDir, 'cyberrakshak-monitor.mjs'), 'utf8');
  assert.equal(pkg.version, /const VERSION = '([^']+)';/.exec(source)[1]);
  assert.equal(pkg.license, 'MIT');
  assert.match(source, /Released under the MIT licence/);
  for (const file of ['cyberrakshak-monitor.mjs', 'cyberrakshak-monitor.cjs', 'index.d.ts', 'index.d.mts']) assert.ok(pkg.files.includes(file), file);
});

test('importing it does nothing by itself (sideEffects: false is true)', () => {
  assert.equal(pkg.sideEffects, false);
  for (const event of ['uncaughtException', 'unhandledRejection', 'beforeExit', 'exit']) {
    const listeners = process.listeners(event).filter((l) => /cyberRakshak|onUncaught|onRejection|onBeforeExit|onExit/.test(l.name));
    assert.deepEqual(listeners, [], event);
  }
});
