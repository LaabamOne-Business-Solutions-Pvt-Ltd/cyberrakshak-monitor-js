# @cyberrakshak/react-native

Cyber Rakshak error monitoring for **React Native and Expo**: what goes wrong in your app lands on your site's
**Errors** page in the Cyber Rakshak console, scrubbed of secrets on the phone before it leaves. No native modules, no
dependencies: plain JavaScript, so it works in Expo Go and with any build.

## What it catches

- **Every error that reaches React Native's global handler** (`ErrorUtils`); fatal ones are reported as crashes. In a
  release build the app's previous handler runs after at most 1 s of saving and sending; in development, at once.
  Pass a `storage` (AsyncStorage) and a crash that closes the app is kept and sent at the next launch.
- **Unhandled promise rejections**, in release builds on Hermes (in development React Native's own warning keeps that
  hook).
- Anything you report yourself, `captureException(error)` and `captureMessage(text)`, and errors from your error
  boundary.

The handler your app already had still runs: the library adds a report, it never changes what happens.

## Install

```sh
npm install @cyberrakshak/react-native
# optional, to keep a crash for the next launch:
npx expo install @react-native-async-storage/async-storage   # or npm install it
```

## Use

```ts
import * as monitor from '@cyberrakshak/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
monitor.init({ key: 'crk_…', release: '1.4.2+57', environment: 'production', storage: AsyncStorage });
monitor.setRoute('Checkout');                 // from your navigation's state change
// in an error boundary: monitor.captureException(error, { componentStack: info.componentStack });
```

The key is your site's app key (`crk_…`), made on the site's **Security scan** tab: under **Apps, servers and scripts**, press **Make an app key**. Types are included. Import it with
`import * as monitor` (as above): it is compiled to CommonJS, which Metro, Expo and Jest all load.

## Options

| Option | Meaning |
|---|---|
| `key` | Your site's app key, `crk_` and 32 letters or digits. Required; with no valid key the library does nothing. |
| `endpoint` | Where reports go. Default `https://app.cyberrakshak.ai/api/v1/app-reports`. |
| `release` | Your version or build (`A-Z a-z 0-9 . _ + -`, at most 60), so a problem shows the release it started in. |
| `environment` | `production`, `staging`… (`a-z 0-9 _ -`, at most 30). |
| `enabled` | `false` sends nothing (default `true`). |
| `sampleRate` | 0 to 1: the share of problems sent (default 1, all). |
| `beforeSend` | Gets each problem, already scrubbed; return it (changed if you like) or `null` to drop it. |
| `debug` | Says on the console what the library does and why something was not sent. The key is never printed. |
| `context` | Values sent with every problem: at most 20, strings (300 characters), numbers, true/false. |
| `scrubNames` | Names of your own whose values are removed, like `password=`: whole words, `A-Z a-z 0-9 _ . -`, at most 50. Only adds to the built-in rules. |
| `scrubPatterns` | Regular expressions of your own (`RegExp`, or a string compiled with the `g` flag): what they match becomes `[removed]`. At most 20; one that does not compile, or matches an empty text, is left out. Only adds to the built-in rules. |
| `storage` | Where waiting problems are kept between launches: AsyncStorage, or anything with `getItem`, `setItem`, `removeItem`. |
| `capturePromiseRejections` | Unhandled promise rejections, in release builds on Hermes (default `true`). |

Functions: `init(options)`, `setRoute(screen)`, `captureException(error, { route, context, level, componentStack })`,
`captureMessage(text, { level, route, context })` (level `warning` by default), `flush(timeoutMs)` (resolves to `true`
when nothing is left waiting), `scrub(text)` (shows what a text would become), `close()`.

## What is sent, and what never is

Sent, per problem: its kind (exception, crash, unhandled promise, log message), its message, its stack trace, the screen
(`setRoute`, never a query string), the level, how many times it happened and when last; with each request: the
library's name and version, the OS and its version (`android 14`, `ios 18.1`), your release and environment.

Never sent: what a user types, form fields, request or response bodies, headers, cookies, device identifiers, location,
contacts.

**Scrubbed on the phone before anything leaves**: query strings; `Bearer`/`Basic` values; the value after `password`,
`secret`, `token`, `api_key` and the like; JSON Web Tokens; keys that say what they are (`crk_`, `sk_live_`, `ghp_`,
`AKIA`…); email addresses; IBANs (mod-97 checked); card numbers (Luhn-checked); the value after `pin`, `otp`, `cvv`,
`iban`, `sort_code`, `card_number`, `account_number`, `cookie`, `signature`, `authorization` and the like, as whole
words only (`company:` and `spinning:` stay); long hex and random-looking runs. They become `[removed]`, `[token]`,
`[email]`, `[iban]` or `[card]`, and a context entry whose name is one of these names is sent as `[removed]`.
`scrubNames` and `scrubPatterns` add names and patterns of your own; nothing switches the built-in rules off. The
console scrubs everything again when it arrives.

At most 10 problems go per request, each request under 64 KB; repeats of one problem are counted, not resent; what
could not be sent is kept (with `storage`) and tried again later, never before `Retry-After`. Nothing in the library
throws into your app.

Full documentation, the same library for other platforms, and every file's SHA-256:
**https://app.cyberrakshak.ai/sdk/README.md**

## Licence

MIT. Copyright (c) 2026 Laabam One Business Solutions (OPC) Private Limited. See [LICENSE](LICENSE).
