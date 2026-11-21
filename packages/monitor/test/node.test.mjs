// Tests for @cyberrakshak/monitor (both the ES module and its CommonJS twin, each found through the package's own
// "exports", as an app would find them), against test/fake-server.mjs only (127.0.0.1: never a real Cyber Rakshak host).
//   npm test -w @cyberrakshak/monitor
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startFakeServer } from '../../../test/fake-server.mjs';
import * as m from '@cyberrakshak/monitor';

const here = fileURLToPath(new URL('.', import.meta.url));
const ESM = fileURLToPath(import.meta.resolve('@cyberrakshak/monitor'));
const CJS = createRequire(import.meta.url).resolve('@cyberrakshak/monitor');
const cjs = createRequire(import.meta.url)(CJS);
const VECTORS = JSON.parse(readFileSync(join(here, '..', '..', '..', 'test', 'scrub-vectors.json'), 'utf8')).vectors;
const KEY = 'crk_' + '0'.repeat(32);

let fake;
let scratch;
before(async () => {
  fake = await startFakeServer();
  scratch = mkdtempSync(join(tmpdir(), 'cr-node-sdk-'));
});
after(async () => {
  m.close();
  await fake.close();
  rmSync(scratch, { recursive: true, force: true });
});
beforeEach(() => {
  m.close();
  fake.reset();
});

const start = (extra = {}) => m.init({ key: KEY, endpoint: fake.endpoint, captureUncaught: false, captureRejections: false, exitSend: false, ...extra });
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const problems = () => fake.requests.flatMap((r) => r.body.errors);
const clean = () => {
  for (const r of fake.requests) assert.deepEqual(r.violations, [], 'request ' + r.n + ' broke the contract');
};

/** Runs a small ES module script that uses the library; resolves to its exit code and output. */
function run(source, nodeArgs = [], timeoutMs = 15000) {
  const file = join(scratch, 'case-' + Math.random().toString(36).slice(2) + '.mjs');
  writeFileSync(file, `import * as monitor from ${JSON.stringify(pathToFileURL(ESM).href)};\nconst KEY = ${JSON.stringify(KEY)};\nconst ENDPOINT = ${JSON.stringify(fake.endpoint)};\n${source}\n`);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...nodeArgs, file], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

test('scrub: every shared vector, in the ES module and the CommonJS twin', () => {
  for (const { in: input, out } of VECTORS) {
    assert.equal(m.scrub(input), out, JSON.stringify(input));
    assert.equal(cjs.scrub(input), out, 'cjs ' + JSON.stringify(input));
  }
});

test('the CommonJS twin has the same API', () => {
  assert.deepEqual(Object.keys(cjs).filter((k) => k !== 'default').sort(), Object.keys(m).filter((k) => k !== 'default').sort());
});

test('a captured exception is sent in the contract\'s shape, scrubbed', async () => {
  start({ release: '2026.11.21+3', environment: 'Production', context: { region: 'blr1' } });
  m.captureException(new Error('boom for asha@example.com'), { route: '/orders/42?token=abc', context: { email: 'x@example.org', n: 3, ok: true, obj: { no: 1 } } });
  assert.equal(await m.flush(3000), true);
  assert.equal(fake.requests.length, 1);
  clean();
  const r = fake.requests[0];
  assert.equal(r.authorization, 'Bearer ' + KEY);
  assert.equal(r.body.sdk.name, 'cyberrakshak-node');
  assert.equal(r.body.sdk.version, '1.0.0');
  assert.equal(r.body.platform, 'server');
  assert.match(r.body.runtime, /^node \d+\.\d+$/);
  assert.equal(r.body.release, '2026.11.21+3');
  assert.equal(r.body.environment, 'production');
  const p = r.body.errors[0];
  assert.equal(p.kind, 'exception');
  assert.equal(p.message, 'boom for [email]');
  assert.equal(p.route, '/orders/42');
  assert.equal(p.level, 'error');
  assert.equal(p.count, 1);
  assert.match(p.stack, /node\.test\.mjs/);
  assert.deepEqual(p.context, { region: 'blr1', email: '[email]', n: 3, ok: true });
});

test('repeats of one problem are counted, not resent', async () => {
  start();
  for (let i = 0; i < 5; i++) m.captureException(new Error('same problem'));
  m.captureMessage('a message', { level: 'error' });
  await m.flush(3000);
  clean();
  assert.equal(fake.requests.length, 1);
  const [a, b] = fake.requests[0].body.errors;
  assert.equal(a.message, 'same problem');
  assert.equal(a.count, 5);
  assert.equal(b.kind, 'log');
  assert.equal(b.level, 'error');
});

test('at most 10 problems in one request', async () => {
  start();
  for (let i = 0; i < 25; i++) m.captureException(new Error('distinct ' + i));
  await m.flush(5000);
  clean();
  assert.deepEqual(fake.requests.map((r) => r.body.errors.length), [10, 10, 5]);
});

test('at most 50 distinct problems wait; the oldest go first', async () => {
  start();
  for (let i = 0; i < 60; i++) m.captureException(new Error('waiting ' + i));
  await m.flush(5000);
  const all = problems();
  assert.equal(all.length, 50);
  assert.equal(all[0].message, 'waiting 10');
  assert.equal(all[49].message, 'waiting 59');
});

test('429: kept, and sent again once Retry-After has passed', async () => {
  fake.plan({ status: 429, retryAfter: '1' });
  start();
  const slow = () => new Error('slow down');
  m.captureException(slow());
  assert.equal(await m.flush(3000), false);
  m.captureException(slow());
  await fake.wait(2, 5000);
  clean();
  assert.equal(fake.requests.length, 2);
  assert.ok(fake.requests[1].at - fake.requests[0].at >= 950, 'waited ' + (fake.requests[1].at - fake.requests[0].at) + ' ms');
  assert.equal(fake.requests[1].body.errors[0].message, 'slow down');
  assert.equal(fake.requests[1].body.errors[0].count, 2);
});

test('500: kept and tried again after a backoff', async () => {
  fake.plan({ status: 500 });
  start();
  m.captureException(new Error('server down'));
  await m.flush(3000);
  await fake.wait(2, 5000);
  assert.equal(fake.requests.length, 2);
  assert.equal(fake.requests[1].body.errors[0].message, 'server down');
});

test('a network failure keeps the problem', async () => {
  start({ endpoint: 'http://127.0.0.1:9/api/v1/app-reports' });
  m.captureException(new Error('nobody listening'));
  assert.equal(await m.flush(3000), false);
});

test('422: the batch is dropped, never retried', async () => {
  fake.plan({ status: 422 });
  start();
  m.captureException(new Error('first'));
  await m.flush(3000);
  m.captureException(new Error('second'));
  await m.flush(3000);
  await pause(300);
  assert.equal(fake.requests.length, 2);
  assert.deepEqual(fake.requests[1].body.errors.map((e) => e.message), ['second']);
});

test('401: dropped, and nothing more is sent for a while', async () => {
  fake.plan({ status: 401 });
  start();
  m.captureException(new Error('first'));
  await m.flush(3000);
  m.captureException(new Error('second'));
  await m.flush(1000);
  await pause(300);
  assert.equal(fake.requests.length, 1);
});

test('beforeSend returning null drops the problem', async () => {
  start({ beforeSend: () => null });
  m.captureException(new Error('dropped'));
  await m.flush(1000);
  await pause(200);
  assert.equal(fake.requests.length, 0);
});

test('beforeSend can change and remove things', async () => {
  start({ context: { tenant: 't1' }, beforeSend: (p) => ({ ...p, message: 'changed', context: undefined }) });
  m.captureException(new Error('original'));
  await m.flush(3000);
  clean();
  assert.equal(fake.requests[0].body.errors[0].message, 'changed');
  assert.equal(fake.requests[0].body.errors[0].context, undefined);
});

test('a beforeSend that throws drops the problem and throws nothing', async () => {
  start({
    beforeSend: () => {
      throw new Error('bad filter');
    },
  });
  assert.doesNotThrow(() => m.captureException(new Error('x')));
  await m.flush(1000);
  assert.equal(fake.requests.length, 0);
});

test('sampleRate 0 sends nothing', async () => {
  start({ sampleRate: 0 });
  for (let i = 0; i < 20; i++) m.captureException(new Error('sampled ' + i));
  await m.flush(1000);
  await pause(200);
  assert.equal(fake.requests.length, 0);
});

test('enabled: false sends nothing', async () => {
  start({ enabled: false });
  m.captureException(new Error('off'));
  await m.flush(1000);
  await pause(200);
  assert.equal(fake.requests.length, 0);
});

test('a key that is not a crk_ key starts nothing and throws nothing', async () => {
  assert.doesNotThrow(() => m.init({ key: 'crw_' + '0'.repeat(32), endpoint: fake.endpoint, captureUncaught: false, captureRejections: false }));
  m.captureException(new Error('x'));
  await m.flush(500);
  assert.equal(fake.requests.length, 0);
});

test('a huge stack still goes in a body under 64 KB', async () => {
  start();
  for (let i = 0; i < 10; i++) {
    const e = new Error('huge ' + i + ' ' + 'é'.repeat(3000));
    e.stack = 'Error: huge\n' + ('    at frame' + i + ' (/srv/app/x.js:1:1) ✓\n').repeat(8000);
    m.captureException(e);
  }
  await m.flush(5000);
  clean();
  assert.equal(problems().length, 10);
  for (const r of fake.requests) assert.ok(r.bytes <= 65536, r.bytes + ' bytes');
  for (const p of problems()) assert.ok(p.stack.length <= 16000);
});

test('nothing it is given makes it throw, before or after init', async () => {
  const circular = {};
  circular.self = circular;
  const odd = [undefined, null, 0, '', 'text', Symbol('s'), circular, Object.create(null), { message: 42 }, () => 1, 10n];
  for (const x of odd) {
    assert.doesNotThrow(() => m.captureException(x));
    assert.doesNotThrow(() => m.captureMessage(x));
  }
  assert.equal(await m.flush(), true);
  start();
  for (const x of odd) {
    assert.doesNotThrow(() => m.captureException(x, { context: circular, route: x }));
    assert.doesNotThrow(() => m.captureMessage(x, x));
  }
  await m.flush(3000);
  clean();
});

test('Express error middleware: reports 5xx errors with the route, passes every error on', async () => {
  start();
  const handler = m.expressErrorHandler();
  assert.equal(handler.length, 4);
  const passed = [];
  const err = new Error('db down');
  handler(err, { method: 'GET', baseUrl: '/api', route: { path: '/users/:id' }, originalUrl: '/api/users/42?x=1' }, {}, (e) => passed.push(e));
  const notFound = Object.assign(new Error('no such user'), { status: 404 });
  handler(notFound, { method: 'GET', originalUrl: '/api/users/7' }, {}, (e) => passed.push(e));
  handler(new Error('no route'), { method: 'POST', originalUrl: '/api/orders/123e4567-e89b-12d3-a456-426614174000/pay?card=1' }, {}, (e) => passed.push(e));
  assert.deepEqual(passed.map((e) => e.message), ['db down', 'no such user', 'no route']);
  await m.flush(3000);
  clean();
  assert.deepEqual(problems().map((p) => [p.kind, p.route]), [['http', 'GET /api/users/:id'], ['http', 'POST /api/orders/:id/pay']]);
});

test('an uncaught exception is reported, then Node prints it and exits with code 1, as it would', async () => {
  const r = await run(`monitor.init({ key: KEY, endpoint: ENDPOINT });\nsetTimeout(() => { throw new Error('crash-boom'); }, 10);`);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Error: crash-boom/);
  clean();
  assert.deepEqual(problems().map((p) => [p.kind, p.message]), [['crash', 'crash-boom']]);
});

test('the app\'s own uncaughtException handler still runs, and its process.exit() still sends the report', async () => {
  const r = await run(
    `monitor.init({ key: KEY, endpoint: ENDPOINT });\n` +
      `process.on('uncaughtException', (e) => { console.log('host saw ' + e.message); setTimeout(() => { console.log('still running'); process.exit(3); }, 200); });\n` +
      `setTimeout(() => { throw new Error('handled-boom'); }, 10);`,
  );
  assert.equal(r.code, 3);
  assert.match(r.stdout, /host saw handled-boom/);
  assert.match(r.stdout, /still running/);
  await fake.wait(1, 3000);
  clean();
  assert.deepEqual(problems().map((p) => [p.kind, p.message]), [['crash', 'handled-boom']]);
});

test('an unhandled rejection is reported, and Node\'s default (exit with code 1) is kept', async () => {
  const r = await run(`monitor.init({ key: KEY, endpoint: ENDPOINT });\nPromise.reject(new Error('rejected-boom'));`);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /rejected-boom/);
  clean();
  assert.deepEqual(problems().map((p) => [p.kind, p.message]), [['promise', 'rejected-boom']]);
});

test('with --unhandled-rejections=warn the process carries on, as Node would', async () => {
  const r = await run(`monitor.init({ key: KEY, endpoint: ENDPOINT });\nPromise.reject('just a string');\nsetTimeout(() => console.log('carried on'), 100);`, ['--unhandled-rejections=warn']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /carried on/);
  await fake.wait(1, 3000);
  assert.deepEqual(problems().map((p) => [p.kind, p.message]), [['promise', 'just a string']]);
});

test('a script that ends by itself still sends what is waiting', async () => {
  const r = await run(`monitor.init({ key: KEY, endpoint: ENDPOINT, platform: 'script' });\nmonitor.captureMessage('import finished with 3 skipped rows');`);
  assert.equal(r.code, 0);
  clean();
  assert.equal(fake.requests[0].body.platform, 'script');
  assert.deepEqual(problems().map((p) => [p.kind, p.level, p.message]), [['log', 'warning', 'import finished with 3 skipped rows']]);
});

test('the key is never printed, even with debug on', async () => {
  fake.plan({ status: 401 });
  const r = await run(`monitor.init({ key: KEY, endpoint: ENDPOINT, debug: true });\nmonitor.captureException(new Error('x'));\nawait monitor.flush(2000);`);
  assert.equal(r.code, 0);
  assert.match(r.stderr, /401/);
  assert.doesNotMatch(r.stdout + r.stderr, /crk_0/);
});
