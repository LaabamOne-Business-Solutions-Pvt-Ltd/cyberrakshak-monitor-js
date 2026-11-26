# Changelog

## [1.1.1] - 2026-11-26

- Words only: where its key is made. Since 2026-11-26 the Cyber Rakshak console adds a mobile app, an API, an MCP server, or
  a script or cron job as an item of its own, with its own key and Errors page (**Apps & websites** → **Add**; the key
  is shown once on its **Set up** page). The header, the `key` option and the debug message say so. A key made before
  on a website's **Security scan** tab keeps working. Nothing changes in what is sent, or how.

## [1.1.0] - 2026-11-22

- Scrubbing, the same rules as every Cyber Rakshak library (the shared `scrub-vectors.json`): IBANs that pass the
  ISO 13616 mod-97 check become `[iban]`; the values after `authorization`, `cookie` / `set-cookie`, `signature`,
  `otp`, `pin`, `cvv`, `cvc`, `iban`, `bban`, `pan`, account number, sort code, card number and bank auth id are
  removed, as whole words only (`company:`, `spinning:` and `japan:` stay).
- `scrubNames` and `scrubPatterns` (init options): names and regular expressions of your own, applied after the built-in
  rules to the message, the stack, the route and context values. They only add: nothing switches the built-in
  rules off. A name or pattern that is not usable is left out (said with `debug`).
- A context entry whose name is a secret name (built in, or one of yours) is sent as `[removed]`.
- The app key's message names where it is made: the site's Security scan tab, Apps, servers and scripts.
- `captureRequestError(error, request, context)`: the whole of Next.js's `onRequestError`. The route is the method and
  `routePath` (never `request.path`, which carries the query string, never the headers); it resolves once what is
  waiting is sent (at most 2 s), so a serverless function is not frozen first. Types included.

## [1.0.0] - 2026-11-21

First release on npm: the Node.js library served at https://app.cyberrakshak.ai/sdk/node/ since 2026-11-21, as an ES
module and its CommonJS twin (the same code), with TypeScript types.

- Reports uncaught exceptions (then exits with code 1, as Node would), unhandled promise rejections (Node's
  `--unhandled-rejections` behaviour kept) and Express / Connect 5xx errors (`expressErrorHandler()`).
- `captureException`, `captureMessage`, `flush`, `scrub`, `close`; options `key`, `endpoint`, `release`,
  `environment`, `enabled`, `sampleRate`, `beforeSend`, `debug`, `context`, `platform`, `captureUncaught`,
  `captureRejections`, `exitSend`.
- Secrets scrubbed before anything leaves, by the rules every Cyber Rakshak library shares.
