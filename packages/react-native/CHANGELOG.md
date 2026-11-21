# Changelog

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

## [1.0.0] - 2026-11-21

First release on npm: the React Native / Expo library served at https://app.cyberrakshak.ai/sdk/react-native/ since
2026-11-21, compiled from its TypeScript to JavaScript with types.

- Reports every error reaching React Native's global handler (fatal ones as crashes, kept across the crash with
  `storage`) and unhandled promise rejections in release builds on Hermes.
- `init`, `setRoute`, `captureException` (with an error boundary's `componentStack`), `captureMessage`, `flush`,
  `scrub`, `close`; options `key`, `endpoint`, `release`, `environment`, `enabled`, `sampleRate`, `beforeSend`, `debug`,
  `context`, `storage`, `capturePromiseRejections`.
- Secrets scrubbed on the phone before anything leaves, by the rules every Cyber Rakshak library shares.
