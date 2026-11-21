# Changelog

## [1.0.0] - 2026-11-21

First release on npm: the React Native / Expo library served at https://app.cyberrakshak.ai/sdk/react-native/ since
2026-11-21, compiled from its TypeScript to JavaScript with types.

- Reports every error reaching React Native's global handler (fatal ones as crashes, kept across the crash with
  `storage`) and unhandled promise rejections in release builds on Hermes.
- `init`, `setRoute`, `captureException` (with an error boundary's `componentStack`), `captureMessage`, `flush`,
  `scrub`, `close`; options `key`, `endpoint`, `release`, `environment`, `enabled`, `sampleRate`, `beforeSend`, `debug`,
  `context`, `storage`, `capturePromiseRejections`.
- Secrets scrubbed on the phone before anything leaves, by the rules every Cyber Rakshak library shares.
