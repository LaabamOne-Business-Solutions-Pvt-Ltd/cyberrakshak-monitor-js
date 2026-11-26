/*!
 * Cyber Rakshak error monitoring for React Native and Expo, version 1.1.1
 * Docs: https://app.cyberrakshak.ai/sdk/README.md
 * Copyright Laabam One Business Solutions (OPC) Private Limited
 * Released under the MIT licence: https://app.cyberrakshak.ai/sdk/LICENSE
 *
 * One TypeScript file, no native modules and no dependencies: put it in your app's source and import it. Sends what
 * goes wrong in your app to its own Errors page in the Cyber Rakshak console: the error's text, its stack, the
 * screen, when and how often, and the OS version. Secrets are scrubbed on the phone before anything leaves (email
 * addresses, tokens and keys, password=... values, query strings, card numbers). Nothing the user types, no device id,
 * no location, no contacts.
 *
 *   import * as monitor from './cyberrakshak-monitor';
 *   import AsyncStorage from '@react-native-async-storage/async-storage';   // optional: keeps a crash for the next launch
 *
 *   monitor.init({ key: 'crk_…', release: '1.4.2+57', environment: 'production', storage: AsyncStorage });
 *   monitor.setRoute('Checkout');                                   // the screen now shown (from your navigation)
 *   monitor.captureException(error, { context: { orderStep: 2 } });
 *   // In an error boundary: componentDidCatch(error, info) { monitor.captureException(error, { componentStack: info.componentStack }); }
 *
 * Caught by itself: every error that reaches React Native's global handler (ErrorUtils), fatal ones as crashes (the
 * app's previous handler still runs: after at most 1 s of saving and sending in a release build, at once in
 * development), and unhandled promise rejections in release builds on Hermes (in development React Native's own
 * warning keeps that hook). Repeats of one problem are counted, not resent; at most 10 problems per request.
 *
 * Nothing in here may throw into your app or slow it: a monitor that fails must never become the app's second problem.
 */
import { Platform } from 'react-native';

export type Kind = 'exception' | 'crash' | 'promise' | 'log' | 'http' | 'script';
export type Level = 'error' | 'warning';
export type ContextValue = string | number | boolean | null;

/** One problem as it is sent (beforeSend gets it scrubbed, and may change it or return null to drop it). */
export interface Problem {
  kind: Kind;
  message: string;
  stack?: string;
  route?: string;
  level: Level;
  count: number;
  at: string;
  context?: Record<string, ContextValue>;
}

/** Where waiting problems are kept between launches: AsyncStorage fits, as does anything with these three methods. */
export interface Storage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export interface Options {
  /** Its crk_ app key: the console's Apps & websites, Add, then its Set up page. */
  key: string;
  endpoint?: string;
  release?: string;
  environment?: string;
  enabled?: boolean;
  /** 0..1: the share of problems sent (default 1, all). */
  sampleRate?: number;
  beforeSend?: (problem: Problem) => Problem | null | undefined;
  debug?: boolean;
  /** Sent with every problem (at most 20 values: strings, numbers, true/false). */
  context?: Record<string, unknown>;
  /** Names of your own whose values are removed, like password= (whole words, A-Z a-z 0-9 _ . -, at most 50). Only adds to the built-in rules. */
  scrubNames?: string[];
  /** Regular expressions of your own: what they match is removed (at most 20). Only adds to the built-in rules. */
  scrubPatterns?: Array<RegExp | string>;
  storage?: Storage;
  /** Unhandled promise rejections, in release builds on Hermes (default true). */
  capturePromiseRejections?: boolean;
}

export interface CaptureExtra {
  route?: string;
  context?: Record<string, unknown>;
  level?: Level;
  /** From an error boundary's componentDidCatch(error, info): info.componentStack. */
  componentStack?: string;
}

type Entry = [string, Problem];
type Handler = (error: unknown, isFatal?: boolean) => void;

interface State {
  key: string;
  endpoint: string;
  release?: string;
  environment?: string;
  sampleRate: number;
  beforeSend: Options['beforeSend'] | null;
  debug: boolean;
  context: Record<string, unknown> | null;
  extraNames: Rule | null;
  extraKeys: RegExp | null;
  extraPatterns: RegExp[] | null;
  platform: 'mobile' | 'desktop' | 'other';
  runtime: string;
  storage: Storage | null;
  route?: string;
  queue: Map<string, Problem>;
  timer: ReturnType<typeof setTimeout> | null;
  saveTimer: ReturnType<typeof setTimeout> | null;
  sending: Promise<string> | null;
  notBefore: number;
  backoff: number;
  blockedUntil: number;
  logged: Set<string>;
  previousHandler: Handler | null;
  ownHandler: Handler | null;
}

const SDK_NAME = 'cyberrakshak-react-native';
const VERSION = '1.1.1';
const DEFAULT_ENDPOINT = 'https://app.cyberrakshak.ai/api/v1/app-reports';
const STORAGE_KEY = 'cyberrakshak-monitor:v1';

const KEY_RE = /^crk_[A-Za-z0-9]{32}$/;
const RELEASE_RE = /^[A-Za-z0-9._+\-]{1,60}$/;
const ENVIRONMENT_RE = /^[a-z0-9_-]{1,30}$/;
const KINDS: Kind[] = ['exception', 'crash', 'promise', 'log', 'http', 'script'];

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
const FLUSH_MS = 2000;
const FATAL_WAIT_MS = 1000;
const SAVE_AFTER_MS = 500;
const BACKOFF_FIRST_MS = 2000;
const BACKOFF_MAX_MS = 300000;
const RETRY_AFTER_MAX_MS = 86400000;
const BLOCKED_MS = 3600000;

// ── Scrubbing: the same rules, in the same order, in every Cyber Rakshak library ────────────────────────────────
// (No lookbehind here: older JavaScriptCore cannot parse it. "Not preceded by" is checked by hand instead.)
type Rule = { re: RegExp; notAfter?: RegExp; replace: (m: RegExpExecArray) => string | null };

const SCRUB_RULES: Rule[] = [
  // A query string: ?name=... up to a space or quote. Where a request went is kept, never what it asked.
  { re: /\?[A-Za-z0-9_.%-]+[=&][^ \t\r\n#"'<>]*/g, replace: () => '' },
  // Authorization values.
  { re: /(bearer|basic) +([A-Za-z0-9._~+/=-]{8,})/gi, replace: (m) => (/[0-9A-Z._~+/=]/.test(m[2]) ? m[1] + ' [token]' : null) },
  // password=..., "client_secret": "...", x-api-key: ... (the name is kept, the value is not). The match starts at
  // the word (what comes before it is kept as it is) and allows 40 more name characters after it.
  {
    re: /((?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential|session[_-]?id)[A-Za-z0-9_-]{0,40}\\?["']?[ ]*[=:][ ]*\\?["']?)[^ \t\r\n&,;"'<>\\]+/gi,
    replace: (m) => m[1] + '[removed]',
  },
  // JSON Web Tokens (a header of at most 500 characters).
  { re: /eyJ[A-Za-z0-9_-]{1,500}\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?/g, replace: () => '[token]' },
  // Keys that say what they are.
  {
    re: /(?:crk_|crw_|sk_live_|sk_test_|pk_live_|pk_test_|rk_live_|ghp_|gho_|ghs_|ghu_|github_pat_|glpat-|xoxb-|xoxp-|xoxa-|AKIA|ASIA|AIza)[A-Za-z0-9_-]{10,}/g,
    notAfter: /[A-Za-z0-9]/,
    replace: () => '[token]',
  },
  // Email addresses.
  { re: /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, replace: () => '[email]' },
  // IBANs: two capital letters, two digits, then 11 to 30 capitals or digits (or the same in groups of four, single
  // spaces between), 15 to 34 in all, passing the ISO 13616 mod-97 check. Before cards: an IBAN holds a digit run.
  {
    re: /[A-Z]{2}[0-9]{2}(?:[A-Z0-9]{11,30}|(?: [A-Z0-9]{4}){2,7}(?: [A-Z0-9]{1,4})?)(?![A-Za-z0-9])/g,
    notAfter: /[A-Za-z0-9]/,
    replace: (m) => (ibanOk(m[0]) ? '[iban]' : null),
  },
  // Card numbers: 13 to 19 digits (single spaces or dashes between) that pass the Luhn check.
  { re: /[0-9](?:[ -]?[0-9]){12,18}/g, notAfter: /[0-9]/, replace: (m) => (luhn(m[0].replace(/[ -]/g, '')) ? '[card]' : null) },
  // pin: 1234, "iban": "...", set-cookie: ..., x-tink-signature=...: these names only as whole words (not right after a
  // letter or digit, the separator right after the name), so company:, spinning: and japan: stay; the value goes as in
  // the password rule. After IBANs and cards, so a value with spaces in it has gone whole already. A value that is
  // Bearer or Basic and a space was handled above.
  {
    re: /((?:authorization|cookie|signature|otp|pin|cvv|cvc|iban|bban|pan|account[_-]?(?:no|number|num)|sort[_-]?code|card[_-]?number|bank[_-]?auth[_-]?id)\\?["']?[ ]*[=:][ ]*\\?["']?)(?!(?:bearer|basic) )[^ \t\r\n&,;"'<>\\]+/gi,
    notAfter: /[A-Za-z0-9]/,
    replace: (m) => m[1] + '[removed]',
  },
  // Long hex runs: session ids, hashes, keys.
  { re: /[0-9a-fA-F]{32,}/g, replace: () => '[token]' },
  // Long random-looking runs: a digit, an upper-case and a lower-case letter in 40 or more of A-Z a-z 0-9 + _ -.
  { re: /[A-Za-z0-9+_-]{40,}/g, replace: (m) => (/[0-9]/.test(m[0]) && /[A-Z]/.test(m[0]) && /[a-z]/.test(m[0]) ? '[token]' : null) },
];

function luhn(digits: string): boolean {
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

function applyRule(text: string, rule: Rule): string {
  const re = rule.re;
  re.lastIndex = 0;
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const start = m.index;
    if (rule.notAfter && start > 0 && rule.notAfter.test(text.charAt(start - 1))) {
      re.lastIndex = start + 1;
      continue;
    }
    const replaced = rule.replace(m);
    if (replaced !== null) {
      out += text.slice(last, start) + replaced;
      last = start + m[0].length;
    }
    re.lastIndex = start + Math.max(1, m[0].length);
  }
  return out + text.slice(last);
}

/** ISO 13616: the first four characters moved to the end, letters as 10..35, the whole number mod 97 is 1. */
function ibanOk(text: string): boolean {
  const s = text.replace(/ /g, '');
  if (s.length < 15 || s.length > 34) return false;
  const moved = s.slice(4) + s.slice(0, 4);
  let rest = 0;
  for (let i = 0; i < moved.length; i++) {
    const c = moved.charCodeAt(i);
    const v = c >= 65 ? c - 55 : c - 48;
    rest = v > 9 ? (rest * 100 + v) % 97 : (rest * 10 + v) % 97;
  }
  return rest === 1;
}

// A context entry's name that says its value is a secret: the words of the password rule anywhere in it, or one of the
// whole-word names (at the end, not right after a letter or digit: user_pin, x-tink-signature, not spinning).
const SECRET_NAME_RE = /password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential|session[_-]?id/i;
const WHOLE_NAME_RE = /(?:^|[^A-Za-z0-9])(?:authorization|cookie|signature|otp|pin|cvv|cvc|iban|bban|pan|account[_-]?(?:no|number|num)|sort[_-]?code|card[_-]?number|bank[_-]?auth[_-]?id)$/i;
const EXTRA_NAME_RE = /^[A-Za-z0-9_.-]{1,40}$/;
const MAX_EXTRA_NAMES = 50;
const MAX_EXTRA_PATTERNS = 20;

function secretName(name: string): boolean {
  const s = S;
  return SECRET_NAME_RE.test(name) || WHOLE_NAME_RE.test(name) || !!(s && s.extraKeys && s.extraKeys.test(name));
}

/**
 * What a text looks like once scrubbed: what this library would send. The built-in rules always run, first; then the
 * names and patterns given to init() as scrubNames and scrubPatterns, which can only add to them.
 */
export function scrub(text: unknown): string {
  try {
    let out = typeof text === 'string' ? text : text === undefined || text === null ? '' : String(text);
    for (const rule of SCRUB_RULES) out = applyRule(out, rule);
    const s = S;
    if (s && s.extraNames) out = applyRule(out, s.extraNames);
    if (s && s.extraPatterns) {
      for (const pattern of s.extraPatterns) {
        try {
          pattern.lastIndex = 0;
          out = out.replace(pattern, '[removed]');
        } catch {
          // A pattern of yours that fails is skipped; the built-in rules have run.
        }
      }
    }
    return out;
  } catch {
    return '';
  }
}

/** scrubNames: names of your own, as whole words, their values removed like the built-in ones; at most 50. */
function extraNames(list: unknown, probe: { debug: boolean }): string[] {
  const names: string[] = [];
  if (list === undefined || list === null) return names;
  if (!Array.isArray(list)) {
    debug(probe, 'scrubNames left out: it must be a list of names');
    return names;
  }
  for (const name of list) {
    if (typeof name !== 'string' || !EXTRA_NAME_RE.test(name)) {
      debug(probe, 'scrubNames: a name was left out: only A-Z a-z 0-9 _ . - (1 to 40)');
      continue;
    }
    if (names.length >= MAX_EXTRA_NAMES) {
      debug(probe, 'scrubNames: only the first ' + MAX_EXTRA_NAMES + ' are used');
      break;
    }
    if (names.indexOf(name.toLowerCase()) < 0) names.push(name.toLowerCase());
  }
  return names;
}

/** scrubPatterns: regular expressions of your own (RegExp, or a string compiled with the g flag); what they match goes. */
function extraPatterns(list: unknown, probe: { debug: boolean }): RegExp[] {
  const patterns: RegExp[] = [];
  if (list === undefined || list === null) return patterns;
  if (!Array.isArray(list)) {
    debug(probe, 'scrubPatterns left out: it must be a list of patterns');
    return patterns;
  }
  for (const p of list) {
    if (patterns.length >= MAX_EXTRA_PATTERNS) {
      debug(probe, 'scrubPatterns: only the first ' + MAX_EXTRA_PATTERNS + ' are used');
      break;
    }
    try {
      const re = p instanceof RegExp ? new RegExp(p.source, p.flags.indexOf('g') >= 0 ? p.flags : p.flags + 'g') : new RegExp(String(p), 'g');
      if (re.test('')) {
        debug(probe, 'scrubPatterns: a pattern that matches an empty text was left out');
        continue;
      }
      re.lastIndex = 0;
      patterns.push(re);
    } catch (e) {
      debug(probe, 'scrubPatterns: a pattern was left out: ' + describe(e));
    }
  }
  return patterns;
}

// ── State ─────────────────────────────────────────────────────────────────────────────────────────────────────────
let S: State | null = null;
const reported: WeakSet<object> = new WeakSet();

function debug(state: { debug: boolean } | null, message: string): void {
  try {
    if (state && state.debug) console.log('[cyberrakshak-monitor] ' + message);
  } catch {
    // Never a second problem.
  }
}

function debugOnce(state: State, id: string, message: string): void {
  if (!state.logged.has(id)) {
    state.logged.add(id);
    debug(state, message);
  }
}

/** At most `max` UTF-16 units, never cut inside a surrogate pair, never holding a lone one. */
function clip(text: unknown, max: number): string {
  let s = typeof text === 'string' ? text : String(text);
  if (s.length > max) {
    s = s.slice(0, max);
    const last = s.charCodeAt(s.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) s = s.slice(0, -1);
  }
  let out = '';
  let from = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i++;
        continue;
      }
    } else if (!(c >= 0xdc00 && c <= 0xdfff)) {
      continue;
    }
    out += s.slice(from, i) + '�';
    from = i + 1;
  }
  return from ? out + s.slice(from) : s;
}

function cleanText(text: unknown, max: number): string {
  return clip(scrub(clip(text, max * 2)), max);
}

function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

function describe(error: unknown): string {
  try {
    if (error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string') {
      const e = error as { name?: unknown; message: string };
      const name = typeof e.name === 'string' && e.name && e.name !== 'Error' ? e.name : '';
      return name && e.message ? name + ': ' + e.message : name || e.message || 'Error';
    }
    if (typeof error === 'string') return error;
    if (error === undefined) return 'undefined';
    if (typeof error === 'symbol') return error.toString();
    try {
      const json = JSON.stringify(error);
      if (typeof json === 'string') return json;
    } catch {
      // Not JSON: as a string, then.
    }
    return String(error);
  } catch {
    return 'Error';
  }
}

function stackOf(error: unknown): string | undefined {
  try {
    if (!error || typeof error !== 'object') return undefined;
    const e = error as { stack?: unknown; cause?: unknown };
    if (typeof e.stack !== 'string') return undefined;
    let stack = e.stack;
    let cause = e.cause as { stack?: unknown; cause?: unknown } | undefined;
    for (let depth = 0; depth < 3 && cause && typeof cause === 'object'; depth++) {
      stack += '\nCaused by: ' + (typeof cause.stack === 'string' ? cause.stack : describe(cause));
      cause = cause.cause as { stack?: unknown; cause?: unknown } | undefined;
    }
    return stack;
  } catch {
    return undefined;
  }
}

function topFrame(stack: string | undefined): string {
  if (!stack) return '';
  const lines = stack.split('\n');
  for (let i = 1; i < lines.length; i++) {
    if (/^\s*at /.test(lines[i])) return lines[i].trim();
  }
  return (lines[1] || '').trim();
}

function cleanContext(...sources: unknown[]): Record<string, ContextValue> | undefined {
  const out: Record<string, ContextValue> = {};
  let n = 0;
  for (const source of sources) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) continue;
    const record = source as Record<string, unknown>;
    for (const name of Object.keys(record)) {
      const key = clip(name, MAX_CONTEXT_KEY);
      const value = record[name];
      let kept: ContextValue | undefined;
      if (secretName(name)) kept = '[removed]';
      else if (value === null || typeof value === 'boolean') kept = value;
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

function cleanRoute(route: unknown): string | undefined {
  if (route === undefined || route === null || route === '') return undefined;
  const text = cleanText(String(route).split(/[?#]/)[0], MAX_ROUTE);
  return text || undefined;
}

/** The shape the console accepts, whatever beforeSend handed back; null when it is not a problem any more. */
function normalise(p: unknown, fallbackKind: Kind): Problem | null {
  if (!p || typeof p !== 'object') return null;
  const q = p as Record<string, unknown>;
  const message = typeof q.message === 'string' ? clip(q.message, MAX_MESSAGE) : '';
  if (!message.trim()) return null;
  const at = q.at;
  const out: Problem = {
    kind: KINDS.indexOf(q.kind as Kind) >= 0 ? (q.kind as Kind) : fallbackKind,
    message,
    level: q.level === 'warning' ? 'warning' : 'error',
    count: typeof q.count === 'number' && Number.isInteger(q.count) ? Math.min(MAX_COUNT, Math.max(1, q.count)) : 1,
    at: typeof at === 'string' && at.length <= 40 && !Number.isNaN(Date.parse(at)) ? at : new Date().toISOString(),
  };
  if (typeof q.stack === 'string' && q.stack) out.stack = clip(q.stack, MAX_STACK);
  if (typeof q.route === 'string' && q.route) out.route = clip(q.route, MAX_ROUTE);
  if (q.context && typeof q.context === 'object' && !Array.isArray(q.context)) {
    const source = q.context as Record<string, unknown>;
    const context: Record<string, ContextValue> = {};
    let n = 0;
    for (const name of Object.keys(source)) {
      if (n >= MAX_CONTEXT) break;
      const value = source[name];
      if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) context[clip(name, MAX_CONTEXT_KEY)] = value;
      else if (typeof value === 'string') context[clip(name, MAX_CONTEXT_KEY)] = clip(value, MAX_CONTEXT_VALUE);
      else continue;
      n++;
    }
    if (n) out.context = context;
  }
  return out;
}

function capture(kind: Kind, error: unknown, extra?: CaptureExtra & { message?: unknown; stack?: unknown }): void {
  const s = S;
  try {
    if (!s) return;
    if (error && (typeof error === 'object' || typeof error === 'function')) {
      if (reported.has(error as object)) return;
      reported.add(error as object);
    }
    if (Date.now() < s.blockedUntil) return;
    if (s.sampleRate < 1 && !(Math.random() < s.sampleRate)) return;
    const x = extra && typeof extra === 'object' ? extra : {};
    let stack = x.stack !== undefined ? (typeof x.stack === 'string' ? x.stack : undefined) : stackOf(error);
    if (typeof x.componentStack === 'string' && x.componentStack) stack = (stack ? stack + '\n\n' : '') + 'Component stack:' + x.componentStack;
    const draft: Problem = {
      kind,
      message: cleanText(x.message !== undefined ? x.message : describe(error), MAX_MESSAGE) || '(no message)',
      level: x.level === 'warning' || x.level === 'error' ? x.level : kind === 'log' ? 'warning' : 'error',
      count: 1,
      at: new Date().toISOString(),
    };
    if (stack) draft.stack = cleanText(stack, MAX_STACK);
    const route = cleanRoute(x.route !== undefined ? x.route : s.route);
    if (route) draft.route = route;
    const context = cleanContext(s.context, x.context);
    if (context) draft.context = context;
    let problem: Problem | null;
    if (s.beforeSend) {
      let out: unknown;
      try {
        out = s.beforeSend(draft);
      } catch (e) {
        debug(s, 'beforeSend threw, so the problem was not sent: ' + describe(e));
        return;
      }
      if (out && typeof (out as { then?: unknown }).then === 'function') {
        debug(s, 'beforeSend must return the problem or null, not a promise: the problem was not sent');
        return;
      }
      problem = normalise(out, kind);
    } else {
      problem = normalise(draft, kind);
    }
    if (!problem) return;
    enqueue(s, problem);
  } catch (e) {
    debug(s, 'could not capture: ' + describe(e));
  }
}

function fingerprint(p: Problem): string {
  return p.kind + '\n' + p.message + '\n' + topFrame(p.stack);
}

function enqueue(s: State, problem: Problem): void {
  const id = fingerprint(problem);
  const have = s.queue.get(id);
  if (have) {
    have.count = Math.min(MAX_COUNT, have.count + problem.count);
    have.at = problem.at;
  } else {
    s.queue.set(id, problem);
    while (s.queue.size > MAX_WAITING) s.queue.delete(s.queue.keys().next().value as string);
  }
  saveSoon(s);
  schedule(s, SEND_AFTER_MS);
}

function requeue(s: State, entries: Entry[]): void {
  if (!entries.length) return;
  const merged = new Map<string, Problem>(entries);
  s.queue.forEach((p, id) => {
    const have = merged.get(id);
    if (have) {
      have.count = Math.min(MAX_COUNT, have.count + p.count);
      have.at = p.at;
    } else {
      merged.set(id, p);
    }
  });
  while (merged.size > MAX_WAITING) merged.delete(merged.keys().next().value as string);
  s.queue = merged;
}

function schedule(s: State, delay: number): void {
  try {
    if (s.timer || s.sending || s !== S || !s.queue.size) return;
    const wait = Math.max(delay, s.notBefore - Date.now());
    s.timer = setTimeout(() => {
      s.timer = null;
      // Timers run on a monotonic clock, notBefore is Date.now() time: a timer can wake a few ms before it. Then
      // only the rest is waited out (not a whole SEND_AFTER_MS more).
      if (Date.now() < s.notBefore) schedule(s, 0);
      else send(s).catch(() => undefined);
    }, wait);
  } catch {
    // Never a second problem.
  }
}

// ── Keeping problems across launches (only with the storage option) ───────────────────────────────────────────────
function save(s: State): Promise<void> {
  try {
    if (!s.storage) return Promise.resolve();
    if (s.saveTimer) {
      clearTimeout(s.saveTimer);
      s.saveTimer = null;
    }
    const list: Problem[] = [];
    s.queue.forEach((p) => list.push(p));
    const done = list.length ? s.storage.setItem(STORAGE_KEY, JSON.stringify(list)) : s.storage.removeItem(STORAGE_KEY);
    return Promise.resolve(done).then(
      () => undefined,
      () => undefined,
    );
  } catch {
    return Promise.resolve();
  }
}

function saveSoon(s: State): void {
  try {
    if (!s.storage || s.saveTimer) return;
    s.saveTimer = setTimeout(() => {
      s.saveTimer = null;
      save(s);
    }, SAVE_AFTER_MS);
  } catch {
    // Never a second problem.
  }
}

async function restore(s: State): Promise<void> {
  try {
    if (!s.storage) return;
    const text = await s.storage.getItem(STORAGE_KEY);
    if (!text || s !== S) return;
    const list: unknown = JSON.parse(text);
    if (!Array.isArray(list)) return;
    const entries: Entry[] = [];
    for (const item of list.slice(-MAX_WAITING)) {
      const p = normalise(item, 'exception');
      if (p) entries.push([fingerprint(p), p]);
    }
    requeue(s, entries);
    schedule(s, 0);
  } catch {
    // Never a second problem.
  }
}

// ── Sending ───────────────────────────────────────────────────────────────────────────────────────────────────────
function envelope(s: State, problems: Problem[]): Record<string, unknown> {
  const body: Record<string, unknown> = { sdk: { name: SDK_NAME, version: VERSION }, platform: s.platform, runtime: s.runtime };
  if (s.release) body.release = s.release;
  if (s.environment) body.environment = s.environment;
  body.errors = problems;
  return body;
}

function fit(s: State, entries: Entry[]): { body: string; entries: Entry[]; rest: Entry[] } {
  const rest: Entry[] = [];
  for (let round = 0; round < 200; round++) {
    const body = JSON.stringify(envelope(s, entries.map((e) => e[1])));
    if (utf8Length(body) <= BODY_LIMIT) return { body, entries, rest };
    let longest: Entry | null = null;
    for (const e of entries) {
      const stack = e[1].stack;
      if (stack && stack.length > 1000 && (!longest || stack.length > (longest[1].stack || '').length)) longest = e;
    }
    if (longest && longest[1].stack) {
      longest[1].stack = clip(longest[1].stack, Math.floor(longest[1].stack.length / 2)) + '\n[cut]';
      continue;
    }
    if (entries.length > 1) {
      rest.unshift(entries.pop() as Entry);
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

function retryAfterMs(value: string | null): number | null {
  if (!value) return null;
  const text = value.trim();
  if (/^\d+$/.test(text)) return Math.min(RETRY_AFTER_MAX_MS, Number(text) * 1000);
  const when = Date.parse(text);
  return Number.isNaN(when) ? null : Math.min(RETRY_AFTER_MAX_MS, Math.max(0, when - Date.now()));
}

async function post(s: State, body: string): Promise<{ status: number; retryAfter: number | null }> {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = setTimeout(() => {
    try {
      if (controller) controller.abort();
    } catch {
      // Never a second problem.
    }
  }, SEND_TIMEOUT_MS);
  try {
    const request = fetch(s.endpoint, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + s.key, 'Content-Type': 'application/json' },
      body,
      signal: controller ? controller.signal : undefined,
    });
    request.catch(() => undefined);
    // Without AbortController, a request that never answers still counts as failed after the timeout.
    const response = await Promise.race([
      request,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), SEND_TIMEOUT_MS + 100)),
    ]);
    if (!response) return { status: 0, retryAfter: null };
    return { status: response.status, retryAfter: retryAfterMs(response.headers.get('retry-after')) };
  } catch (e) {
    debug(s, 'could not reach the console: ' + describe(e));
    return { status: 0, retryAfter: null };
  } finally {
    clearTimeout(timer);
  }
}

function send(s: State): Promise<string> {
  if (s.sending) return s.sending;
  const run = async (): Promise<string> => {
    try {
      if (!s.queue.size) return 'empty';
      if (Date.now() < s.blockedUntil) {
        s.queue.clear();
        await save(s);
        return 'dropped';
      }
      if (Date.now() < s.notBefore) return 'later';
      const taken: Entry[] = [];
      s.queue.forEach((p, id) => {
        if (taken.length < MAX_BATCH) taken.push([id, p]);
      });
      for (const [id] of taken) s.queue.delete(id);
      const { body, entries, rest } = fit(s, taken);
      requeue(s, rest);
      const { status, retryAfter } = await post(s, body);
      if (status >= 200 && status < 300) {
        s.backoff = 0;
        await save(s);
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
        await save(s);
        return 'later';
      }
      if (status === 401 || status === 403) {
        s.blockedUntil = Date.now() + BLOCKED_MS;
        s.queue.clear();
        debugOnce(s, String(status), 'the console answered ' + status + ' (' + (status === 401 ? 'the key is not known' : 'the site is not verified or its monitoring is off') + '): nothing is sent for an hour');
      } else {
        debugOnce(s, String(status), 'the console answered ' + status + ': those problems were dropped');
      }
      await save(s);
      return 'dropped';
    } catch (e) {
      debug(s, 'could not send: ' + describe(e));
      return 'dropped';
    }
  };
  // ⚠️ run() can end before its first await ('empty', 'later'): its clean-up is chained after it (.finally), so that it
  // always runs after s.sending is set. Inside run(), a finally that ran at once cleared s.sending before it was set,
  // which then stayed set: nothing was sent again.
  s.sending = run().finally(() => {
    s.sending = null;
    schedule(s, SEND_AFTER_MS);
  });
  return s.sending;
}

/** Sends what is waiting now. Resolves to true when nothing is left waiting, within `timeoutMs` (default 2000). */
export function flush(timeoutMs?: number): Promise<boolean> {
  const s = S;
  if (!s) return Promise.resolve(true);
  const limit = typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs >= 0 ? timeoutMs : FLUSH_MS;
  return new Promise<boolean>((resolve) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = () => {
      if (!done) {
        done = true;
        if (timer) clearTimeout(timer);
        resolve(s.queue.size === 0 && !s.sending);
      }
    };
    timer = setTimeout(finish, limit);
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
function isDev(): boolean {
  try {
    return (globalThis as { __DEV__?: unknown }).__DEV__ === true;
  } catch {
    return false;
  }
}

function errorUtils(): { getGlobalHandler?: () => Handler; setGlobalHandler?: (handler: Handler) => void } | null {
  try {
    const utils = (globalThis as { ErrorUtils?: unknown }).ErrorUtils;
    return utils && typeof utils === 'object' ? (utils as { getGlobalHandler?: () => Handler; setGlobalHandler?: (handler: Handler) => void }) : null;
  } catch {
    return null;
  }
}

function makeGlobalHandler(s: State): Handler {
  return (error: unknown, isFatal?: boolean) => {
    const previous = s.previousHandler;
    const callPrevious = () => {
      if (previous) previous(error, isFatal);
    };
    try {
      capture(isFatal ? 'crash' : 'exception', error);
    } catch {
      // Never a second problem.
    }
    if (!isFatal || isDev() || S !== s) {
      callPrevious();
      return;
    }
    // A fatal error in a release build: the previous handler ends the app, so the problem is saved and sent first
    // (at most FATAL_WAIT_MS), then that handler runs, as it would have.
    let called = false;
    const once = () => {
      if (called) return;
      called = true;
      try {
        callPrevious();
      } catch {
        // What the previous handler does is its own.
      }
    };
    setTimeout(once, FATAL_WAIT_MS);
    Promise.all([save(s), flush(FATAL_WAIT_MS - 100)]).then(once, once);
  };
}

// ── API ───────────────────────────────────────────────────────────────────────────────────────────────────────────
/** Starts monitoring. Call once, as early as you can (index.js / App.tsx). */
export function init(options: Options): void {
  try {
    close();
    const o = (options && typeof options === 'object' ? options : {}) as Options;
    const probe = { debug: !!o.debug };
    if (o.enabled === false) return;
    if (typeof o.key !== 'string' || !KEY_RE.test(o.key.trim())) {
      debug(probe, "not started: key must be its crk_ app key (the console's Apps & websites: Add, then its Set up page)");
      return;
    }
    if (typeof fetch !== 'function') {
      debug(probe, 'not started: fetch is missing');
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
    let runtime = 'react-native';
    let platform: State['platform'] = 'mobile';
    try {
      const os = String(Platform.OS);
      const constants = (Platform as unknown as { constants?: { Release?: unknown } }).constants;
      const version = os === 'android' && constants && constants.Release ? String(constants.Release) : String(Platform.Version);
      runtime = clip(os + ' ' + version, 60);
      platform = os === 'android' || os === 'ios' ? 'mobile' : os === 'windows' || os === 'macos' ? 'desktop' : 'other';
    } catch {
      // 'react-native' and mobile, then.
    }
    const rate = Number(o.sampleRate);
    const names = extraNames(o.scrubNames, probe);
    const patterns = extraPatterns(o.scrubPatterns, probe);
    const alternation = names.map((n) => n.replace(/\./g, '\\.')).join('|');
    const s: State = {
      key: o.key.trim(),
      endpoint,
      release,
      environment,
      sampleRate: o.sampleRate === undefined ? 1 : Number.isFinite(rate) ? Math.min(1, Math.max(0, rate)) : 1,
      beforeSend: typeof o.beforeSend === 'function' ? o.beforeSend : null,
      debug: !!o.debug,
      context: o.context && typeof o.context === 'object' ? o.context : null,
      extraNames: names.length
        ? { re: new RegExp('((?:' + alternation + ')\\\\?["\']?[ ]*[=:][ ]*\\\\?["\']?)[^ \\t\\r\\n&,;"\'<>\\\\]+', 'gi'), notAfter: /[A-Za-z0-9]/, replace: (m) => m[1] + '[removed]' }
        : null,
      extraKeys: names.length ? new RegExp('(?:^|[^A-Za-z0-9])(?:' + alternation + ')$', 'i') : null,
      extraPatterns: patterns.length ? patterns : null,
      platform,
      runtime,
      storage: o.storage && typeof o.storage.getItem === 'function' && typeof o.storage.setItem === 'function' && typeof o.storage.removeItem === 'function' ? o.storage : null,
      queue: new Map(),
      timer: null,
      saveTimer: null,
      sending: null,
      notBefore: 0,
      backoff: 0,
      blockedUntil: 0,
      logged: new Set(),
      previousHandler: null,
      ownHandler: null,
    };
    S = s;
    const utils = errorUtils();
    if (utils && typeof utils.setGlobalHandler === 'function') {
      s.previousHandler = typeof utils.getGlobalHandler === 'function' ? utils.getGlobalHandler() || null : null;
      s.ownHandler = makeGlobalHandler(s);
      utils.setGlobalHandler(s.ownHandler);
    }
    if (o.capturePromiseRejections !== false && !isDev()) {
      const hermes = (globalThis as { HermesInternal?: { enablePromiseRejectionTracker?: (options: unknown) => void } }).HermesInternal;
      if (hermes && typeof hermes.enablePromiseRejectionTracker === 'function') {
        hermes.enablePromiseRejectionTracker({
          allRejections: true,
          onUnhandled: (_id: number, rejection: unknown) => {
            if (S === s) capture('promise', rejection);
          },
          onHandled: () => undefined,
        });
      }
    }
    restore(s);
    debug(s, 'started: ' + SDK_NAME + ' ' + VERSION + ' reporting to ' + endpoint);
  } catch (e) {
    S = null;
    debug(options && typeof options === 'object' ? { debug: !!options.debug } : null, 'not started: ' + describe(e));
  }
}

/** Stops monitoring and gives ErrorUtils its previous handler back (call flush() first to send what is waiting). */
export function close(): void {
  const s = S;
  S = null;
  if (!s) return;
  try {
    if (s.timer) clearTimeout(s.timer);
    if (s.saveTimer) clearTimeout(s.saveTimer);
    const utils = errorUtils();
    if (utils && s.ownHandler && typeof utils.getGlobalHandler === 'function' && typeof utils.setGlobalHandler === 'function') {
      if (utils.getGlobalHandler() === s.ownHandler && s.previousHandler) utils.setGlobalHandler(s.previousHandler);
    }
  } catch {
    // Never a second problem.
  }
}

/** Reports an error you caught (from an error boundary too: pass info.componentStack as componentStack). */
export function captureException(error: unknown, extra?: CaptureExtra): void {
  try {
    capture('exception', error, extra);
  } catch {
    // Never a second problem.
  }
}

/** Reports a message. extra.level: 'warning' (the default) or 'error'. */
export function captureMessage(text: string, extra?: CaptureExtra): void {
  try {
    const e = extra && typeof extra === 'object' ? extra : {};
    capture('log', null, { route: e.route, context: e.context, level: e.level, message: typeof text === 'string' ? text : describe(text), stack: undefined });
  } catch {
    // Never a second problem.
  }
}

/** The screen now shown, sent as the route of what goes wrong next (call it from your navigation's state change). */
export function setRoute(route: string | null | undefined): void {
  try {
    if (S) S.route = route === null || route === undefined ? undefined : String(route);
  } catch {
    // Never a second problem.
  }
}

export default { init, close, captureException, captureMessage, setRoute, flush, scrub };
