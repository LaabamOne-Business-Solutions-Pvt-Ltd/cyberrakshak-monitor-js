# @cyberrakshak/monitor

Cyber Rakshak error monitoring for **Node.js 18+**: what goes wrong in your server or script lands on your site's
**Errors** page in the Cyber Rakshak console, scrubbed of secrets before it leaves. One file, no dependencies, ES module
and CommonJS.

## What it catches

- **Uncaught exceptions**: reported, then Node exits with code 1, as it would have (at most 2 s are spent sending).
- **Unhandled promise rejections**: reported, with Node's own `--unhandled-rejections` behaviour kept.
- **Express / Connect errors** that end a request with a 5xx, with `expressErrorHandler()` (4xx are not reported).
- Anything you report yourself: `captureException(error)` and `captureMessage(text)`.

The handlers your app already had still run: the library adds a report, it never changes what happens.

## Install

```sh
npm install @cyberrakshak/monitor
```

## Use

```js
import * as monitor from '@cyberrakshak/monitor';      // or: const monitor = require('@cyberrakshak/monitor');
monitor.init({ key: process.env.CR_MONITOR_KEY, release: '2026.11.21', environment: 'production' });
app.use(monitor.expressErrorHandler());               // Express: after your routes
monitor.captureException(err, { route: 'nightly-import', context: { batch: 42 } });
await monitor.flush(2000);                            // before you call process.exit() yourself
```

The key is your site's app key (`crk_…`), made on the site's **Security scan** tab: under **Apps, servers and scripts**, press **Make an app key**. Types are included (`index.d.ts`).

## Next.js

On Vercel or any serverless host, report from `instrumentation.ts`, in the Node.js runtime:

```ts
import type { Instrumentation } from 'next';

export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const monitor = await import('@cyberrakshak/monitor');
  monitor.init({ key: process.env.CR_MONITOR_KEY, release: process.env.VERCEL_GIT_COMMIT_SHA, environment: process.env.VERCEL_ENV });
}

export const onRequestError: Instrumentation.onRequestError = async (err, request, context) => {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const monitor = await import('@cyberrakshak/monitor');
  await monitor.captureRequestError(err, request, context);
};
```

`captureRequestError` reports the error under the route Next.js names (`POST /app/api/pay/route`): never
`request.path`, which carries the query string, and never the headers. It resolves once what is waiting is sent (at
most 2 s), so the function is not frozen before it goes. Set `CR_MONITOR_KEY` only where you want reports (Vercel's
Production environment, say): with no key nothing starts and nothing is sent.

## Options

| Option | Meaning |
|---|---|
| `key` | Your site's app key, `crk_` and 32 letters or digits. Required; with no valid key the library does nothing. |
| `endpoint` | Where reports go. Default `https://app.cyberrakshak.ai/api/v1/app-reports`. |
| `release` | Your version or build (`A-Z a-z 0-9 . _ + -`, at most 60), so a problem shows the release it started in. |
| `environment` | `production`, `staging`… (`a-z 0-9 _ -`, at most 30). |
| `enabled` | `false` sends nothing (default `true`). |
| `sampleRate` | 0 to 1: the share of problems sent (default 1, all). |
| `beforeSend` | Gets each problem, already scrubbed; return it (changed if you like) or `null` to drop it. Not a promise. |
| `debug` | Says on standard error what the library does and why something was not sent. The key is never printed. |
| `context` | Values sent with every problem: at most 20, strings (300 characters), numbers, true/false. |
| `scrubNames` | Names of your own whose values are removed, like `password=`: whole words, `A-Z a-z 0-9 _ . -`, at most 50. Only adds to the built-in rules. |
| `scrubPatterns` | Regular expressions of your own (`RegExp`, or a string compiled with the `g` flag): what they match becomes `[removed]`. At most 20; one that does not compile, or matches an empty text, is left out. Only adds to the built-in rules. |
| `platform` | `server` (the default), `script`, `desktop`, `mobile` or `other`. |
| `captureUncaught` | Report uncaught exceptions (default `true`). |
| `captureRejections` | Report unhandled promise rejections (default `true`). |
| `exitSend` | On `process.exit()`, send what is still waiting from a short-lived child process, 2 s at most (default `true`). |

Functions: `init(options)`, `captureException(error, { route, context, level })`, `captureMessage(text, { level, route,
context })` (level `warning` by default), `captureRequestError(error, request, context)` (Next.js), `expressErrorHandler()`, `flush(timeoutMs)` (resolves to `true` when nothing
is left waiting), `scrub(text)` (shows what a text would become), `close()`.

## What is sent, and what never is

Sent, per problem: its kind (exception, crash, unhandled promise, log message, failed request), its message, its stack
trace (file, line and function; never argument values), the route or command (never its query string), the level, how
many times it happened and when last; with each request: the library's name and version, `node` and its version, your
release and environment.

Never sent: request or response bodies, headers, cookies, sessions, form fields, environment variables, local
variables.

**Scrubbed before anything leaves**: query strings; `Bearer`/`Basic` values; the value after `password`, `secret`,
`token`, `api_key` and the like; JSON Web Tokens; keys that say what they are (`crk_`, `sk_live_`, `ghp_`, `AKIA`…);
email addresses; IBANs (mod-97 checked); card numbers (Luhn-checked); the value after `pin`, `otp`, `cvv`, `iban`,
`sort_code`, `card_number`, `account_number`, `cookie`, `signature`, `authorization` and the like, as whole words only
(`company:` and `spinning:` stay); long hex and random-looking runs. They become `[removed]`, `[token]`, `[email]`,
`[iban]` or `[card]`, and a context entry whose name is one of these names is sent as `[removed]`. `scrubNames` and
`scrubPatterns` add names and patterns of your own; nothing switches the built-in rules off. The console scrubs
everything again when it arrives.

At most 10 problems go per request, each request under 64 KB; repeats of one problem are counted, not resent; a request
takes at most 5 s; `429` and `5xx` answers are retried later (never before `Retry-After`). Nothing in the library throws
into your code.

Full documentation, the same library for other platforms, and every file's SHA-256:
**https://app.cyberrakshak.ai/sdk/README.md**

## Licence

MIT. Copyright (c) 2026 Laabam One Business Solutions (OPC) Private Limited. See [LICENSE](LICENSE).
