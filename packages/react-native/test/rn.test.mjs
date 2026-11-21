// Tests for @cyberrakshak/react-native as it is published: the JavaScript tsc compiled into lib/ (npm run build first),
// found through the package's own "main". CR_RN_TEST_SOURCE=1 runs them on src/cyberrakshak-monitor.ts instead (Node
// strips the types). 'react-native' (test/react-native-stub.cjs), ErrorUtils and HermesInternal are stand-ins; the
// network is test/fake-server.mjs (127.0.0.1: never a real Cyber Rakshak host).
//   npm test -w @cyberrakshak/react-native
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startFakeServer } from '../../../test/fake-server.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const VECTORS = JSON.parse(readFileSync(join(here, '..', '..', '..', 'test', 'scrub-vectors.json'), 'utf8')).vectors;
const KEY = 'crk_' + '0'.repeat(32);

// 'react-native' is this stand-in: the Platform the tests set.
globalThis.__rnPlatform = { OS: 'android', Version: 34, constants: { Release: '14' } };
// A CommonJS file, so that both require('react-native') (lib/) and import (src/) get it.
const MOCK = pathToFileURL(join(here, 'react-native-stub.cjs')).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'react-native') return { url: MOCK, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

// React Native's globals.
const calls = [];
const previous = (error, isFatal) => calls.push({ message: error && error.message, isFatal, at: Date.now() });
globalThis.ErrorUtils = {
  handler: previous,
  getGlobalHandler() {
    return this.handler;
  },
  setGlobalHandler(h) {
    this.handler = h;
  },
};
globalThis.HermesInternal = {
  enablePromiseRejectionTracker(options) {
    globalThis.__tracker = options;
  },
};
globalThis.__DEV__ = false;

const target = process.env.CR_RN_TEST_SOURCE === '1' ? join(here, '..', 'src', 'cyberrakshak-monitor.ts') : createRequire(import.meta.url).resolve('@cyberrakshak/react-native');
const m = await import(pathToFileURL(target).href);

function memoryStorage() {
  const data = new Map();
  return {
    data,
    getItem: async (k) => (data.has(k) ? data.get(k) : null),
    setItem: async (k, v) => void data.set(k, v),
    removeItem: async (k) => void data.delete(k),
  };
}

let fake;
before(async () => {
  fake = await startFakeServer();
});
after(async () => {
  m.close();
  await fake.close();
});
beforeEach(() => {
  m.close();
  fake.reset();
  calls.length = 0;
  globalThis.__DEV__ = false;
  globalThis.__rnPlatform.OS = 'android';
  globalThis.__rnPlatform.Version = 34;
  globalThis.ErrorUtils.handler = previous;
});

const start = (extra = {}) => m.init({ key: KEY, endpoint: fake.endpoint, ...extra });
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const problems = () => fake.requests.flatMap((r) => r.body.errors);
const clean = () => {
  for (const r of fake.requests) assert.deepEqual(r.violations, [], 'request ' + r.n + ' broke the contract');
};

test('scrub: every shared vector', () => {
  for (const { in: input, out } of VECTORS) assert.equal(m.scrub(input), out, JSON.stringify(input));
});

test('a captured exception: mobile, the Android version, the screen, scrubbed', async () => {
  start({ release: '1.4.2+57', environment: 'Production', context: { build: 57 } });
  m.setRoute('Checkout?step=2');
  m.captureException(new Error('payment for asha@example.com failed'), { context: { step: 2 } });
  assert.equal(await m.flush(3000), true);
  clean();
  const r = fake.requests[0];
  assert.equal(r.body.sdk.name, 'cyberrakshak-react-native');
  assert.equal(r.body.platform, 'mobile');
  assert.equal(r.body.runtime, 'android 14');
  assert.equal(r.body.environment, 'production');
  const p = r.body.errors[0];
  assert.deepEqual([p.kind, p.message, p.route, p.level, p.count], ['exception', 'payment for [email] failed', 'Checkout', 'error', 1]);
  assert.deepEqual(p.context, { build: 57, step: 2 });
});

test('iOS: the runtime is ios and its version', async () => {
  globalThis.__rnPlatform.OS = 'ios';
  globalThis.__rnPlatform.Version = '18.1';
  start();
  m.captureMessage('hello');
  await m.flush(3000);
  assert.equal(fake.requests[0].body.runtime, 'ios 18.1');
});

test('an error boundary\'s component stack goes with the stack', async () => {
  start();
  m.captureException(new Error('render failed'), { componentStack: '\n    in Cart\n    in App' });
  await m.flush(3000);
  assert.match(problems()[0].stack, /Component stack:\n {4}in Cart/);
});

test('a non-fatal global error: reported, and the previous handler runs at once', async () => {
  start();
  globalThis.ErrorUtils.getGlobalHandler()(new Error('soft'), false);
  assert.equal(calls.length, 1);
  await m.flush(3000);
  assert.deepEqual(problems().map((p) => [p.kind, p.message]), [['exception', 'soft']]);
});

test('a fatal error in release: saved, sent, then the previous handler runs (within 1 s)', async () => {
  const storage = memoryStorage();
  start({ storage });
  const t = Date.now();
  globalThis.ErrorUtils.getGlobalHandler()(new Error('fatal-boom'), true);
  assert.equal(calls.length, 0, 'the previous handler waits for the report');
  await fake.wait(1, 3000);
  await pause(50);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].isFatal, true);
  assert.ok(calls[0].at - t <= 1100, 'previous handler after ' + (calls[0].at - t) + ' ms');
  clean();
  assert.deepEqual(problems().map((p) => [p.kind, p.message]), [['crash', 'fatal-boom']]);
});

test('a fatal error the console cannot take now is kept in storage and sent at the next launch', async () => {
  const storage = memoryStorage();
  fake.plan({ status: 500 });
  start({ storage });
  globalThis.ErrorUtils.getGlobalHandler()(new Error('crash-kept'), true);
  await pause(1200);
  assert.equal(calls.length, 1);
  assert.match(storage.data.get('cyberrakshak-monitor:v1') || '', /crash-kept/);
  // The next launch.
  m.close();
  start({ storage });
  await fake.wait(2, 5000);
  clean();
  assert.equal(fake.requests[1].body.errors[0].message, 'crash-kept');
  assert.equal(fake.requests[1].body.errors[0].kind, 'crash');
  await pause(100);
  assert.equal(storage.data.has('cyberrakshak-monitor:v1'), false, 'storage is emptied once sent');
});

test('a timer that wakes a few ms before the backoff ends: it waits out the rest and sends (it never stops sending)', async () => {
  // Timers run on a monotonic clock, the backoff ends at a Date.now() time: a retry timer can wake a few ms "early"
  // (the Node.js library's did on CI runners), and the library then stopped sending for good.
  fake.plan({ status: 500 });
  start();
  m.captureException(new Error('server down'));
  await m.flush(3000);
  assert.equal(fake.requests.length, 1);
  const realNow = Date.now;
  Date.now = () => realNow() - 25; // the wall clock now reads 25 ms behind the timers
  try {
    await fake.wait(2, 8000);
  } finally {
    Date.now = realNow;
  }
  assert.equal(fake.requests.length, 2, 'the retry never came');
  assert.equal(fake.requests[1].body.errors[0].message, 'server down');
  const gap = fake.requests[1].at - fake.requests[0].at;
  assert.ok(gap < 3000, 'retried after ' + gap + ' ms: an early wake cost a whole extra wait');
});

test('in development the previous handler (the red screen) runs at once, fatal or not', () => {
  globalThis.__DEV__ = true;
  start();
  globalThis.ErrorUtils.getGlobalHandler()(new Error('dev-fatal'), true);
  assert.equal(calls.length, 1);
});

test('close() gives ErrorUtils its previous handler back', () => {
  start();
  assert.notEqual(globalThis.ErrorUtils.getGlobalHandler(), previous);
  m.close();
  assert.equal(globalThis.ErrorUtils.getGlobalHandler(), previous);
});

test('an unhandled promise rejection (Hermes, release) is reported', async () => {
  start();
  globalThis.__tracker.onUnhandled(7, new Error('rejected'));
  await m.flush(3000);
  assert.deepEqual(problems().map((p) => [p.kind, p.message]), [['promise', 'rejected']]);
});

test('repeats of one problem are counted, not resent', async () => {
  start();
  for (let i = 0; i < 4; i++) m.captureException(new Error('again'));
  await m.flush(3000);
  assert.equal(fake.requests.length, 1);
  assert.equal(problems()[0].count, 4);
});

test('at most 10 problems in one request, at most 50 waiting', async () => {
  start();
  for (let i = 0; i < 60; i++) m.captureException(new Error('distinct ' + i));
  await m.flush(5000);
  clean();
  assert.deepEqual(fake.requests.map((r) => r.body.errors.length), [10, 10, 10, 10, 10]);
  assert.equal(problems()[0].message, 'distinct 10');
});

test('429: kept, and sent again once Retry-After has passed', async () => {
  fake.plan({ status: 429, retryAfter: '1' });
  start();
  m.captureException(new Error('slow down'));
  assert.equal(await m.flush(3000), false);
  await fake.wait(2, 5000);
  assert.equal(fake.requests.length, 2);
  assert.ok(fake.requests[1].at - fake.requests[0].at >= 950);
  assert.equal(fake.requests[1].body.errors[0].message, 'slow down');
});

test('422: dropped, never retried', async () => {
  fake.plan({ status: 422 });
  start();
  m.captureException(new Error('first'));
  await m.flush(3000);
  m.captureException(new Error('second'));
  await m.flush(3000);
  await pause(200);
  assert.deepEqual(fake.requests.map((r) => r.body.errors.map((e) => e.message)), [['first'], ['second']]);
});

test('beforeSend null drops; sampleRate 0 and enabled: false send nothing', async () => {
  start({ beforeSend: () => null });
  m.captureException(new Error('a'));
  await m.flush(500);
  start({ sampleRate: 0 });
  for (let i = 0; i < 10; i++) m.captureException(new Error('b' + i));
  await m.flush(500);
  start({ enabled: false });
  m.captureException(new Error('c'));
  await m.flush(500);
  await pause(200);
  assert.equal(fake.requests.length, 0);
});

test('a huge stack still goes in a body under 64 KB', async () => {
  start();
  for (let i = 0; i < 10; i++) {
    const e = new Error('huge ' + i + ' ' + '😀'.repeat(1500));
    e.stack = 'Error: huge\n' + ('    at frame' + i + ' (index.bundle:1:1) ✓\n').repeat(8000);
    m.captureException(e);
  }
  await m.flush(5000);
  clean();
  assert.equal(problems().length, 10);
  for (const r of fake.requests) assert.ok(r.bytes <= 65536, r.bytes + ' bytes');
});

test('nothing it is given makes it throw, before or after init', async () => {
  const circular = {};
  circular.self = circular;
  const odd = [undefined, null, 0, '', Symbol('s'), circular, Object.create(null), { message: 42 }, () => 1, 10n];
  for (const x of odd) {
    assert.doesNotThrow(() => m.captureException(x));
    assert.doesNotThrow(() => m.captureMessage(x));
  }
  start();
  for (const x of odd) {
    assert.doesNotThrow(() => m.captureException(x, { context: circular, route: x }));
    assert.doesNotThrow(() => m.captureMessage(x, x));
    assert.doesNotThrow(() => m.setRoute(x));
  }
  await m.flush(3000);
  clean();
});
