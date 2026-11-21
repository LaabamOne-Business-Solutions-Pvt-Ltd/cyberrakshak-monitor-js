# Changelog

## [1.0.0] - 2026-11-21

First release on npm: the Node.js library served at https://app.cyberrakshak.ai/sdk/node/ since 2026-11-21, as an ES
module and its CommonJS twin (the same code), with TypeScript types.

- Reports uncaught exceptions (then exits with code 1, as Node would), unhandled promise rejections (Node's
  `--unhandled-rejections` behaviour kept) and Express / Connect 5xx errors (`expressErrorHandler()`).
- `captureException`, `captureMessage`, `flush`, `scrub`, `close`; options `key`, `endpoint`, `release`,
  `environment`, `enabled`, `sampleRate`, `beforeSend`, `debug`, `context`, `platform`, `captureUncaught`,
  `captureRejections`, `exitSend`.
- Secrets scrubbed before anything leaves, by the rules every Cyber Rakshak library shares.
