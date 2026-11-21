/*!
 * Cyber Rakshak error monitoring for Node.js, version 1.0.0
 * Docs: https://app.cyberrakshak.ai/sdk/README.md
 * Copyright Laabam One Business Solutions (OPC) Private Limited
 * Released under the MIT licence: https://app.cyberrakshak.ai/sdk/LICENSE
 *
 * One file, no dependencies, Node 18 or later. Sends what goes wrong in your server or script to your site's Errors page
 * in the Cyber Rakshak console: the error's text, its stack, the route or command, when and how often. Secrets are
 * scrubbed here before anything leaves (email addresses, tokens and keys, password=... values, query strings, card
 * numbers); request bodies, headers, cookies and environment variables are never read.
 *
 *   import * as monitor from './cyberrakshak-monitor.mjs';        // ES modules
 *   const monitor = require('./cyberrakshak-monitor.cjs');        // CommonJS: the same code
 *
 *   monitor.init({ key: process.env.CR_MONITOR_KEY, release: '2026.11.21', environment: 'production' });
 *   app.use(monitor.expressErrorHandler());                       // Express / Connect: after your routes
 *   monitor.captureException(err, { route: 'nightly-import', context: { batch: 42 } });
 *   monitor.captureMessage('Payment provider answered slowly', { level: 'warning' });
 *   await monitor.flush(2000);                                    // before calling process.exit() yourself
 *
 * Caught by itself: uncaught exceptions (reported, then Node's own behaviour: the error is printed and the process
 * exits with code 1, after at most 2 s of sending) and unhandled promise rejections (Node's own behaviour kept, as set
 * by --unhandled-rejections). Repeats of one problem are counted, not resent; at most 10 problems per request.
 *
 * Nothing in here may throw into your code or slow it: a monitor that fails must never become the app's second problem.
 */
import { spawnSync } from 'node:child_process';
import { inspect } from 'node:util';

const SDK_NAME = 'cyberrakshak-node';
const VERSION = '1.0.0';
const DEFAULT_ENDPOINT = 'https://app.cyberrakshak.ai/api/v1/app-reports';

const KEY_RE = /^crk_[A-Za-z0-9]{32}$/;
const RELEASE_RE = /^[A-Za-z0-9._+\-]{1,60}$/;
const ENVIRONMENT_RE = /^[a-z0-9_-]{1,30}$/;
const PLATFORMS = ['mobile', 'server', 'script', 'desktop', 'other'];
const KINDS = ['exception', 'crash', 'promise', 'log', 'http', 'script'];

const MAX_BATCH = 10;
const MAX_WAITING = 50;
const MAX_MESSAGE = 4000;
const MAX_STACK = 16000;
const MAX_ROUTE = 200;
const MAX_CONTEXT = 20;
const MAX_CONTEXT_KEY = 40;
const MAX_CONTEXT_VALUE = 300;
const MAX_COUNT = 100000;
const BODY_LIMIT = 60000;
const SEND_AFTER_MS = 2000;
const SEND_TIMEOUT_MS = 5000;
const EXIT_FLUSH_MS = 2000;
const BACKOFF_FIRST_MS = 2000;
const BACKOFF_MAX_MS = 300000;
const RETRY_AFTER_MAX_MS = 86400000;
const BLOCKED_MS = 3600000;

// ── Scrubbing: the same rules, in the same order, in every Cyber Rakshak library ────────────────────────────────
const SCRUB_RULES = [
  // A query string: ?name=... up to a space or quote. Where a request went is kept, never what it asked.
  [/\?[A-Za-z0-9_.%-]+[=&][^ \t\r\n#"'<>]*/g, () => ''],
  // Authorization values.
  [/(bearer|basic) +([A-Za-z0-9._~+/=-]{8,})/gi, (all, scheme, value) => (/[0-9A-Z._~+/=]/.test(value) ? scheme + ' [token]' : all)],
  // password=..., "client_secret": "...", x-api-key: ... (the name is kept, the value is not). The match starts at
  // the word (what comes before it is kept as it is) and allows 40 more name characters after it.
  [/((?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential|session[_-]?id)[A-Za-z0-9_-]{0,40}\\?["']?[ ]*[=:][ ]*\\?["']?)[^ \t\r\n&,;"'<>\\]+/gi, (all, name) => name + '[removed]'],
  // JSON Web Tokens (a header of at most 500 characters).
  [/eyJ[A-Za-z0-9_-]{1,500}\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?/g, () => '[token]'],
  // Keys that say what they are.
  [/(?<![A-Za-z0-9])(?:crk_|crw_|sk_live_|sk_test_|pk_live_|pk_test_|rk_live_|ghp_|gho_|ghs_|ghu_|github_pat_|glpat-|xoxb-|xoxp-|xoxa-|AKIA|ASIA|AIza)[A-Za-z0-9_-]{10,}/g, () => '[token]'],
  // Email addresses.
  [/[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, () => '[email]'],
  // Card numbers: 13 to 19 digits (single spaces or dashes between) that pass the Luhn check.
  [/(?<![0-9])[0-9](?:[ -]?[0-9]){12,18}/g, (all) => (luhn(all.replace(/[ -]/g, '')) ? '[card]' : all)],
  // Long hex runs: session ids, hashes, keys.
  [/[0-9a-fA-F]{32,}/g, () => '[token]'],
  // Long random-looking runs: a digit, an upper-case and a lower-case letter in 40 or more of A-Z a-z 0-9 + _ -.
  [/[A-Za-z0-9+_-]{40,}/g, (all) => (/[0-9]/.test(all) && /[A-Z]/.test(all) && /[a-z]/.test(all) ? '[token]' : all)],
];

function luhn(digits) {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (double) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    double = !double;
  }
  return sum % 10 === 0;
}

/** What a text looks like once scrubbed: what this library would send. */
function scrub(text) {
  try {
    let out = String(text ?? '');
    for (const [pattern, replace] of SCRUB_RULES) {
      out = out.replace(pattern, replace);
    }
    return out;
  } catch {
    return '';
  }
}

// ── State ─────────────────────────────────────────────────────────────────────────────────────────────────────────
let S = null;
const reported = new WeakSet();

function debug(state, message) {
  try {
    if (state && state.debug) {
      process.stderr.write('[cyberrakshak-monitor] ' + message + '\n');
    }
  } catch {
    // Never a second problem.
  }
}

function debugOnce(state, id, message) {
  if (state && !state.logged.has(id)) {
    state.logged.add(id);
    debug(state, message);
  }
}

/** A string at most `max` UTF-16 units long, never cut inside a surrogate pair, never holding a lone one. */
function clip(text, max) {
  let s = String(text);
  if (s.length > max) {
    s = s.slice(0, max);
    const last = s.charCodeAt(s.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) s = s.slice(0, -1);
  }
  return typeof s.toWellFormed === 'function' ? s.toWellFormed() : s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '�');
}

function cleanText(text, max) {
  return clip(scrub(clip(text, max * 2)), max);
}

function describe(error) {
  try {
    if (error instanceof Error || (error && typeof error === 'object' && typeof error.message === 'string')) {
      const name = typeof error.name === 'string' && error.name && error.name !== 'Error' ? error.name : '';
      const message = String(error.message || '');
      return name && message ? name + ': ' + message : name || message || 'Error';
    }
    if (typeof error === 'string') return error;
    if (error === undefined) return 'undefined';
    return inspect(error, { depth: 2, breakLength: Infinity });
  } catch {
    return 'Error';
  }
}

function stackOf(error) {
  try {
    if (!error || typeof error !== 'object' || typeof error.stack !== 'string') return undefined;
    let stack = error.stack;
    // Why it happened, when the error says (fetch's "fetch failed" holds the refused connection in its cause).
    let cause = error.cause;
    for (let depth = 0; depth < 3 && cause && typeof cause === 'object'; depth++) {
      stack += '\nCaused by: ' + (typeof cause.stack === 'string' ? cause.stack : describe(cause));
      cause = cause.cause;
    }
    return stack;
  } catch {
    return undefined;
  }
}

function topFrame(stack) {
  if (!stack) return '';
  const lines = stack.split('\n');
  for (let i = 1; i < lines.length; i++) {
    if (/^\s*at /.test(lines[i])) return lines[i].trim();
  }
  return (lines[1] || '').trim();
}

function cleanContext(...sources) {
  const out = {};
  let n = 0;
  for (const source of sources) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) continue;
    for (const name of Object.keys(source)) {
      const key = clip(name, MAX_CONTEXT_KEY);
      const value = source[name];
      let kept;
      if (value === null || typeof value === 'boolean') kept = value;
      else if (typeof value === 'number') kept = Number.isFinite(value) ? value : undefined;
      else if (typeof value === 'bigint') kept = String(value);
      else if (typeof value === 'string') kept = cleanText(value, MAX_CONTEXT_VALUE);
      if (kept === undefined) continue;
      if (!(key in out)) {
        if (n >= MAX_CONTEXT) continue;
        n++;
      }
      out[key] = kept;
    }
  }
  return n ? out : undefined;
}

function cleanRoute(route) {
  if (route === undefined || route === null || route === '') return undefined;
  const text = cleanText(String(route).split(/[?#]/)[0], MAX_ROUTE);
  return text || undefined;
}

/** A path with its ids taken out: /users/42/orders/9f1c... becomes /users/:id/orders/:id. */
function genericPath(path) {
  return String(path || '/')
    .split(/[?#]/)[0]
    .split('/')
    .map((part) => (/^\d+$/.test(part) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(part) || /^[0-9a-f]{12,}$/i.test(part) ? ':id' : part))
    .join('/');
}

/** The shape the console accepts, whatever beforeSend handed back; null when it is not a problem any more. */
function normalise(p, fallbackKind) {
  if (!p || typeof p !== 'object') return null;
  const message = typeof p.message === 'string' ? clip(p.message, MAX_MESSAGE) : '';
  if (!message.trim()) return null;
  const out = {
    kind: KINDS.includes(p.kind) ? p.kind : fallbackKind,
    message,
    level: p.level === 'warning' ? 'warning' : 'error',
    count: Number.isInteger(p.count) ? Math.min(MAX_COUNT, Math.max(1, p.count)) : 1,
    at: typeof p.at === 'string' && p.at.length <= 40 && !Number.isNaN(Date.parse(p.at)) ? p.at : new Date().toISOString(),
  };
  if (typeof p.stack === 'string' && p.stack) out.stack = clip(p.stack, MAX_STACK);
  if (typeof p.route === 'string' && p.route) out.route = clip(p.route, MAX_ROUTE);
  if (p.context && typeof p.context === 'object' && !Array.isArray(p.context)) {
    const context = {};
    let n = 0;
    for (const name of Object.keys(p.context)) {
      const value = p.context[name];
      if (n >= MAX_CONTEXT) break;
      if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) context[clip(name, MAX_CONTEXT_KEY)] = value;
      else if (typeof value === 'string') context[clip(name, MAX_CONTEXT_KEY)] = clip(value, MAX_CONTEXT_VALUE);
      else continue;
      n++;
    }
    if (n) out.context = context;
  }
  return out;
}

function capture(kind, error, extra) {
  const s = S;
  try {
    if (!s || !s.enabled) return;
    if (error && (typeof error === 'object' || typeof error === 'function')) {
      if (reported.has(error)) return;
      reported.add(error);
    }
    if (Date.now() < s.blockedUntil) return;
    if (s.sampleRate < 1 && !(Math.random() < s.sampleRate)) return;
    extra = extra && typeof extra === 'object' ? extra : {};
    const stack = extra.stack !== undefined ? extra.stack : stackOf(error);
    let problem = {
      kind,
      message: cleanText(extra.message !== undefined ? extra.message : describe(error), MAX_MESSAGE) || '(no message)',
      level: extra.level === 'warning' || extra.level === 'error' ? extra.level : kind === 'log' ? 'warning' : 'error',
      count: 1,
      at: new Date().toISOString(),
    };
    if (stack) problem.stack = cleanText(stack, MAX_STACK);
    const route = cleanRoute(extra.route);
    if (route) problem.route = route;
    const context = cleanContext(s.context, extra.context);
    if (context) problem.context = context;
    if (s.beforeSend) {
      let out;
      try {
        out = s.beforeSend(problem);
      } catch (e) {
        debug(s, 'beforeSend threw, so the problem was not sent: ' + describe(e));
        return;
      }
      if (out && typeof out.then === 'function') {
        debug(s, 'beforeSend must return the problem or null, not a promise: the problem was not sent');
        return;
      }
      problem = normalise(out, kind);
    } else {
      problem = normalise(problem, kind);
    }
    if (!problem) return;
    enqueue(s, problem);
  } catch (e) {
    debug(s, 'could not capture: ' + describe(e));
  }
}

function fingerprint(p) {
  return p.kind + '\n' + p.message + '\n' + topFrame(p.stack);
}

function enqueue(s, problem) {
  const id = fingerprint(problem);
  const have = s.queue.get(id);
  if (have) {
    have.count = Math.min(MAX_COUNT, have.count + problem.count);
    have.at = problem.at;
  } else {
    s.queue.set(id, problem);
    while (s.queue.size > MAX_WAITING) {
      s.queue.delete(s.queue.keys().next().value);
    }
  }
  schedule(s, SEND_AFTER_MS);
}

/** Puts problems back in front of the queue (a send that will be tried again), counting any that came in since. */
function requeue(s, entries) {
  if (!entries.length) return;
  const merged = new Map(entries);
  for (const [id, p] of s.queue) {
    const have = merged.get(id);
    if (have) {
      have.count = Math.min(MAX_COUNT, have.count + p.count);
      have.at = p.at;
    } else {
      merged.set(id, p);
    }
  }
  while (merged.size > MAX_WAITING) {
    merged.delete(merged.keys().next().value);
  }
  s.queue = merged;
}

function schedule(s, delay) {
  try {
    if (s.timer || s.sending || s !== S || !s.queue.size) return;
    const wait = Math.max(delay, s.notBefore - Date.now());
    s.timer = setTimeout(() => {
      s.timer = null;
      // Timers run on a monotonic clock, notBefore is Date.now() time: a timer can wake a few ms before it. Then
      // only the rest is waited out (not a whole SEND_AFTER_MS more).
      if (Date.now() < s.notBefore) schedule(s, 0);
      else send(s).catch(() => {});
    }, wait);
    if (typeof s.timer.unref === 'function') s.timer.unref();
  } catch {
    // Never a second problem.
  }
}

function envelope(s, problems) {
  const body = { sdk: { name: SDK_NAME, version: VERSION }, platform: s.platform, runtime: s.runtime };
  if (s.release) body.release = s.release;
  if (s.environment) body.environment = s.environment;
  body.errors = problems;
  return body;
}

/** The JSON for a batch, cut to fit under 64 KB: long stacks are halved first, then fewer problems go in one request. */
function fit(s, entries) {
  const rest = [];
  for (let round = 0; round < 200; round++) {
    const body = JSON.stringify(envelope(s, entries.map((e) => e[1])));
    if (Buffer.byteLength(body, 'utf8') <= BODY_LIMIT) return { body, entries, rest };
    let longest = null;
    for (const e of entries) {
      if (e[1].stack && e[1].stack.length > 1000 && (!longest || e[1].stack.length > longest[1].stack.length)) longest = e;
    }
    if (longest) {
      longest[1].stack = clip(longest[1].stack, Math.floor(longest[1].stack.length / 2)) + '\n[cut]';
      continue;
    }
    if (entries.length > 1) {
      rest.unshift(entries.pop());
      continue;
    }
    const p = entries[0][1];
    if (p.message.length > 1000) p.message = clip(p.message, Math.floor(p.message.length / 2));
    else if (p.context) delete p.context;
    else if (p.stack) delete p.stack;
    else return { body, entries, rest };
  }
  return { body: JSON.stringify(envelope(s, entries.map((e) => e[1]))), entries, rest };
}

function retryAfterMs(value) {
  if (!value) return null;
  const text = String(value).trim();
  if (/^\d+$/.test(text)) return Math.min(RETRY_AFTER_MAX_MS, Number(text) * 1000);
  const when = Date.parse(text);
  return Number.isNaN(when) ? null : Math.min(RETRY_AFTER_MAX_MS, Math.max(0, when - Date.now()));
}

async function post(s, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  if (typeof timer.unref === 'function') timer.unref();
  try {
    const response = await fetch(s.endpoint, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + s.key, 'Content-Type': 'application/json', 'User-Agent': SDK_NAME + '/' + VERSION },
      body,
      redirect: 'manual',
      signal: controller.signal,
    });
    try {
      await response.arrayBuffer();
    } catch {
      // The answer's body is not needed.
    }
    return { status: response.status, retryAfter: retryAfterMs(response.headers.get('retry-after')) };
  } catch (e) {
    debug(s, 'could not reach ' + s.endpoint + ': ' + describe(e));
    return { status: 0, retryAfter: null };
  } finally {
    clearTimeout(timer);
  }
}

/** One request with up to 10 waiting problems. Resolves to 'sent', 'empty', 'later' (kept for a retry) or 'dropped'. */
function send(s) {
  if (s.sending) return s.sending;
  // ⚠️ What follows can end before its first await ('empty', 'later'): its clean-up is chained after it (.finally), so
  // that it always runs after s.sending is set. Inside the async function, a finally that ran at once cleared
  // s.sending before it was set, which then stayed set: nothing was sent again.
  s.sending = (async () => {
    try {
      if (!s.queue.size) return 'empty';
      if (Date.now() < s.blockedUntil) {
        s.queue.clear();
        return 'dropped';
      }
      if (Date.now() < s.notBefore) return 'later';
      const taken = [...s.queue.entries()].slice(0, MAX_BATCH);
      for (const [id] of taken) s.queue.delete(id);
      const { body, entries, rest } = fit(s, taken);
      requeue(s, rest);
      s.inflight = entries;
      const { status, retryAfter } = await post(s, body);
      s.inflight = null;
      if (status >= 200 && status < 300) {
        s.backoff = 0;
        return 'sent';
      }
      if (status === 0 || status === 429 || status >= 500) {
        requeue(s, entries);
        let wait = retryAfter;
        if (wait === null) {
          s.backoff = s.backoff ? Math.min(BACKOFF_MAX_MS, s.backoff * 2) : BACKOFF_FIRST_MS;
          wait = s.backoff;
        }
        s.notBefore = Date.now() + wait;
        debug(s, 'the console answered ' + (status || 'nothing') + '; trying again in ' + Math.round(wait / 1000) + ' s');
        return 'later';
      }
      if (status === 401 || status === 403) {
        s.blockedUntil = Date.now() + BLOCKED_MS;
        s.queue.clear();
        debugOnce(s, status, 'the console answered ' + status + ' (' + (status === 401 ? 'the key is not known' : 'the site is not verified or its monitoring is off') + '): nothing is sent for an hour');
        return 'dropped';
      }
      debugOnce(s, status, 'the console answered ' + status + ': those problems were dropped');
      return 'dropped';
    } catch (e) {
      debug(s, 'could not send: ' + describe(e));
      return 'dropped';
    }
  })().finally(() => {
    s.inflight = null;
    s.sending = null;
    schedule(s, SEND_AFTER_MS);
  });
  return s.sending;
}

/** Sends what is waiting now. Resolves to true when nothing is left waiting, within `timeoutMs` (default 2000). */
function flush(timeoutMs) {
  const s = S;
  if (!s) return Promise.resolve(true);
  const limit = Number.isFinite(timeoutMs) && timeoutMs >= 0 ? timeoutMs : EXIT_FLUSH_MS;
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        resolve(s.queue.size === 0 && !s.sending);
      }
    };
    const timer = setTimeout(finish, limit);
    (async () => {
      try {
        if (s.timer) {
          clearTimeout(s.timer);
          s.timer = null;
        }
        for (let i = 0; i < 20 && !done; i++) {
          if (s.sending) await s.sending;
          if (!s.queue.size) break;
          if ((await send(s)) !== 'sent') break;
        }
      } catch {
        // Never a second problem.
      }
      finish();
    })();
  });
}

// ── Handlers ──────────────────────────────────────────────────────────────────────────────────────────────────────
function rejectionMode() {
  let mode = 'throw';
  try {
    const flags = [...process.execArgv, ...String(process.env.NODE_OPTIONS || '').split(/\s+/)];
    for (const flag of flags) {
      const m = /^--unhandled-rejections=(.+)$/.exec(flag);
      if (m) mode = m[1];
    }
  } catch {
    // The default, then.
  }
  return mode;
}

function onUncaught(error, origin) {
  capture(origin === 'unhandledRejection' ? 'promise' : 'crash', error);
  let others = 0;
  try {
    others = process.listenerCount('uncaughtException') - 1;
  } catch {
    others = 0;
  }
  if (others > 0) {
    // The app handles its own uncaught exceptions: what happens next is its decision, and the report goes soon.
    return;
  }
  // Node's own behaviour, as if this library were not here: the error is printed and the process exits with code 1.
  try {
    process.removeListener('uncaughtException', onUncaught);
  } catch {
    // Never a second problem.
  }
  const rethrow = () => {
    process.nextTick(() => {
      throw error;
    });
  };
  flush(EXIT_FLUSH_MS).then(rethrow, rethrow);
}

function onRejection(reason) {
  capture('promise', reason);
  let others = 0;
  try {
    others = process.listenerCount('unhandledRejection') - 1;
  } catch {
    others = 0;
  }
  if (others > 0) return;
  const mode = rejectionMode();
  if (mode === 'throw') {
    // Node raises an unhandled rejection as an uncaught exception when nothing else listens: so do we.
    let error = reason;
    if (!(reason instanceof Error)) {
      let shown = '';
      try {
        shown = inspect(reason);
      } catch {
        shown = String(reason);
      }
      error = new Error(
        'This error originated either by throwing inside of an async function without a catch block, or by rejecting a promise which was not handled with .catch(). The promise rejected with the reason "' + shown + '".',
      );
      error.code = 'ERR_UNHANDLED_REJECTION';
    }
    try {
      reported.add(error);
    } catch {
      // Never a second problem.
    }
    const raise = () => {
      process.nextTick(() => {
        throw error;
      });
    };
    flush(EXIT_FLUSH_MS).then(raise, raise);
  } else if (mode === 'warn-with-error-code') {
    try {
      process.emitWarning(describe(reason), 'UnhandledPromiseRejectionWarning');
      process.exitCode = 1;
    } catch {
      // Never a second problem.
    }
  }
  // 'warn': Node prints its warning itself. 'strict' raised it already. 'none': nothing.
}

function onBeforeExit() {
  const s = S;
  if (s && !s.exitFlushed && s.queue.size && Date.now() >= s.notBefore) {
    s.exitFlushed = true;
    flush(EXIT_FLUSH_MS);
  }
}

// What a child process does with the last batch when the app calls process.exit(): read it from stdin (so the key is
// never on a command line), post it, and give up after the exit flush time.
const EXIT_SENDER =
  "let d='';process.stdin.setEncoding('utf8');process.stdin.on('data',(c)=>{d+=c}).on('end',async()=>{try{const j=JSON.parse(d);" +
  "const r=await fetch(j.endpoint,{method:'POST',headers:{Authorization:'Bearer '+j.key,'Content-Type':'application/json','User-Agent':j.agent}," +
  "body:j.body,redirect:'manual',signal:AbortSignal.timeout(j.timeout)});process.exitCode=r.status>=200&&r.status<300?0:1}catch(e){process.exitCode=2}})";

/**
 * process.exit() leaves no time for a request: what is still waiting (an uncaught exception the app's own handler
 * answered with process.exit(1), say) goes from a short-lived child process, which this process waits for (2 s at most).
 */
function onExit() {
  const s = S;
  try {
    if (!s || !s.exitSend || Date.now() < s.notBefore || Date.now() < s.blockedUntil) return;
    const entries = [...(s.inflight || []), ...s.queue.entries()].slice(0, MAX_BATCH);
    if (!entries.length) return;
    s.queue.clear();
    s.inflight = null;
    if (!/(^|[\\/])node(\.exe)?$/i.test(process.execPath)) return;
    const { body } = fit(s, entries);
    spawnSync(process.execPath, ['-e', EXIT_SENDER], {
      input: JSON.stringify({ endpoint: s.endpoint, key: s.key, body, agent: SDK_NAME + '/' + VERSION, timeout: EXIT_FLUSH_MS - 300 }),
      timeout: EXIT_FLUSH_MS,
      stdio: ['pipe', 'ignore', 'ignore'],
      env: { ...process.env, NODE_OPTIONS: '' },
      windowsHide: true,
    });
  } catch {
    // Never a second problem.
  }
}

// ── API ───────────────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * Starts monitoring. Options: key (required, crk_...), endpoint, release, environment, enabled (default true),
 * sampleRate (0..1, default 1), beforeSend(problem) => problem | null, debug, context (sent with every problem),
 * platform ('server' unless you say 'script', 'desktop' or 'other'), captureUncaught and captureRejections (default true),
 * exitSend (default true: on process.exit(), what is still waiting goes from a short-lived child process, 2 s at most).
 */
function init(options) {
  try {
    close();
    const o = options && typeof options === 'object' ? options : {};
    const probe = { debug: !!o.debug, logged: new Set() };
    if (o.enabled === false) return;
    if (typeof o.key !== 'string' || !KEY_RE.test(o.key.trim())) {
      debug(probe, 'not started: key must be the crk_ key from your site\'s Errors page');
      return;
    }
    if (typeof fetch !== 'function') {
      debug(probe, 'not started: Node 18 or later is needed (fetch)');
      return;
    }
    const endpoint = typeof o.endpoint === 'string' && /^https?:\/\/[^\s]+$/i.test(o.endpoint) ? o.endpoint : DEFAULT_ENDPOINT;
    let release = o.release === undefined || o.release === null ? undefined : String(o.release);
    if (release !== undefined && !RELEASE_RE.test(release)) {
      debug(probe, 'release left out: it may hold only A-Z a-z 0-9 . _ + - (at most 60)');
      release = undefined;
    }
    let environment = o.environment === undefined || o.environment === null ? undefined : String(o.environment).toLowerCase();
    if (environment !== undefined && !ENVIRONMENT_RE.test(environment)) {
      debug(probe, 'environment left out: it may hold only a-z 0-9 _ - (at most 30)');
      environment = undefined;
    }
    const rate = Number(o.sampleRate);
    let runtime = 'node';
    try {
      runtime = clip('node ' + process.versions.node.split('.').slice(0, 2).join('.'), 60);
    } catch {
      // 'node', then.
    }
    S = {
      key: o.key.trim(),
      endpoint,
      release,
      environment,
      enabled: true,
      sampleRate: o.sampleRate === undefined ? 1 : Number.isFinite(rate) ? Math.min(1, Math.max(0, rate)) : 1,
      beforeSend: typeof o.beforeSend === 'function' ? o.beforeSend : null,
      debug: !!o.debug,
      context: o.context && typeof o.context === 'object' ? o.context : null,
      platform: PLATFORMS.includes(o.platform) ? o.platform : 'server',
      runtime,
      queue: new Map(),
      timer: null,
      sending: null,
      notBefore: 0,
      backoff: 0,
      blockedUntil: 0,
      exitFlushed: false,
      exitSend: o.exitSend !== false,
      inflight: null,
      logged: new Set(),
      listeners: [],
    };
    const listen = (event, handler) => {
      process.on(event, handler);
      S.listeners.push([event, handler]);
    };
    if (o.captureUncaught !== false) listen('uncaughtException', onUncaught);
    if (o.captureRejections !== false) listen('unhandledRejection', onRejection);
    listen('beforeExit', onBeforeExit);
    listen('exit', onExit);
    debug(S, 'started: ' + SDK_NAME + ' ' + VERSION + ' reporting to ' + endpoint);
  } catch (e) {
    S = null;
    try {
      if (options && options.debug) process.stderr.write('[cyberrakshak-monitor] not started: ' + describe(e) + '\n');
    } catch {
      // Never a second problem.
    }
  }
}

/** Stops monitoring: the handlers are removed and anything still waiting is forgotten (call flush() first to send it). */
function close() {
  const s = S;
  S = null;
  if (!s) return;
  try {
    if (s.timer) clearTimeout(s.timer);
    for (const [event, handler] of s.listeners) process.removeListener(event, handler);
  } catch {
    // Never a second problem.
  }
}

/** Reports an error you caught. extra: { route, context, level }. */
function captureException(error, extra) {
  capture('exception', error, extra);
}

/** Reports a message. extra: { level: 'warning' (the default) | 'error', route, context }. */
function captureMessage(text, extra) {
  try {
    const e = extra && typeof extra === 'object' ? extra : {};
    capture('log', null, { route: e.route, context: e.context, level: e.level, message: typeof text === 'string' ? text : describe(text), stack: undefined });
  } catch {
    // Never a second problem.
  }
}

/** Express / Connect error middleware: reports errors that end a request with a 5xx, then passes them on unchanged. */
function expressErrorHandler() {
  // Four parameters: that is how Express knows an error handler.
  // eslint-disable-next-line no-unused-vars
  return function cyberRakshakErrorHandler(error, req, res, next) {
    try {
      const status = error && (error.status || error.statusCode);
      if (!(Number(status) >= 400 && Number(status) < 500)) {
        let path = '';
        try {
          path = req.route && typeof req.route.path === 'string' ? (req.baseUrl || '') + req.route.path : genericPath(req.originalUrl || req.url);
        } catch {
          path = '';
        }
        capture('http', error, { route: (req && req.method ? req.method + ' ' : '') + path });
      }
    } catch {
      // Never a second problem.
    }
    next(error);
  };
}

// --- exports (scripts/sdk-index.mjs writes the CommonJS twin from everything above this line) ---
export { init, close, captureException, captureMessage, expressErrorHandler, flush, scrub };
export default { init, close, captureException, captureMessage, expressErrorHandler, flush, scrub };
