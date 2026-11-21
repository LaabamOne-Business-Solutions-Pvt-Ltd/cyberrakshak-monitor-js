// Types for @cyberrakshak/monitor (cyberrakshak-monitor.mjs and its CommonJS twin cyberrakshak-monitor.cjs).
// Written by hand to match the library; test/api.test.mjs checks that every function it exports is declared here.
// index.d.ts (for `require`) and index.d.mts (for `import`) are the same text; the same test checks that too.

/** What went wrong: an error you caught, an uncaught one (crash), an unhandled promise, a message, a failed request. */
export type Kind = 'exception' | 'crash' | 'promise' | 'log' | 'http' | 'script';
export type Level = 'error' | 'warning';
/** A value sent with a problem: strings are cut to 300 characters; other types are left out. */
export type ContextValue = string | number | boolean | null;

/** One problem as it is sent. beforeSend gets it already scrubbed, and may change it or return null to drop it. */
export interface Problem {
  kind: Kind;
  message: string;
  stack?: string;
  /** The route or command (never its query string). */
  route?: string;
  level: Level;
  /** How many times it happened (repeats are counted, not resent). */
  count: number;
  /** ISO 8601: when it last happened. */
  at: string;
  context?: Record<string, ContextValue>;
}

export interface Options {
  /** Your site's app key: crk_ and 32 letters or digits, from the site's Errors page. Without a valid key nothing starts. */
  key: string;
  /** Where reports go. Default https://app.cyberrakshak.ai/api/v1/app-reports. */
  endpoint?: string;
  /** Your version or build: A-Z a-z 0-9 . _ + - (at most 60). Anything else is left out. */
  release?: string;
  /** production, staging...: a-z 0-9 _ - (at most 30), lower-cased. Anything else is left out. */
  environment?: string;
  /** false sends nothing (default true). */
  enabled?: boolean;
  /** 0 to 1: the share of problems sent (default 1, all). */
  sampleRate?: number;
  /** Gets each problem, already scrubbed: return it (changed if you like), or null / nothing to drop it. Must not return a promise. */
  beforeSend?: (problem: Problem) => Problem | null | undefined | void;
  /** Says on standard error what the library does and why something was not sent. The key is never printed. */
  debug?: boolean;
  /** Values sent with every problem: at most 20; strings (300 characters), numbers, true/false, null. */
  context?: Record<string, unknown>;
  /** 'server' (the default) unless you say 'script', 'desktop', 'other' or 'mobile'. */
  platform?: 'server' | 'script' | 'desktop' | 'other' | 'mobile';
  /** Report uncaught exceptions, then let Node exit with code 1 as it would (default true). */
  captureUncaught?: boolean;
  /** Report unhandled promise rejections, keeping Node's --unhandled-rejections behaviour (default true). */
  captureRejections?: boolean;
  /** On process.exit(), send what is still waiting from a short-lived child process, 2 s at most (default true). */
  exitSend?: boolean;
}

export interface CaptureExtra {
  /** The route or command it happened in (its query string is dropped). */
  route?: string;
  /** Values for this problem only, added to Options.context. */
  context?: Record<string, unknown>;
  /** captureException: 'error' by default. captureMessage: 'warning' by default. */
  level?: Level;
}

/** An Express / Connect error-handling middleware (four parameters, as Express needs). */
export type ExpressErrorHandler = (
  error: unknown,
  req: { method?: string; originalUrl?: string; url?: string; baseUrl?: string; route?: { path?: unknown } },
  res: unknown,
  next: (error?: unknown) => void,
) => void;

/** Starts monitoring (stopping any earlier start first). Never throws: a bad key or option is said with `debug`. */
export declare function init(options: Options): void;

/** Stops monitoring: its process handlers are removed and anything still waiting is forgotten (call flush() first). */
export declare function close(): void;

/** Reports an error you caught. */
export declare function captureException(error: unknown, extra?: CaptureExtra): void;

/** Reports a message; level 'warning' unless you say 'error'. */
export declare function captureMessage(text: string, extra?: CaptureExtra): void;

/** Error middleware for Express / Connect: reports errors that end a request with a 5xx (not 4xx), then passes them on unchanged. Add it after your routes. */
export declare function expressErrorHandler(): ExpressErrorHandler;

/** Sends what is waiting now. Resolves to true when nothing is left waiting, within `timeoutMs` (default 2000). */
export declare function flush(timeoutMs?: number): Promise<boolean>;

/** What a text becomes once scrubbed: what this library would send. */
export declare function scrub(text: unknown): string;

declare const monitor: {
  init: typeof init;
  close: typeof close;
  captureException: typeof captureException;
  captureMessage: typeof captureMessage;
  expressErrorHandler: typeof expressErrorHandler;
  flush: typeof flush;
  scrub: typeof scrub;
};
export default monitor;
