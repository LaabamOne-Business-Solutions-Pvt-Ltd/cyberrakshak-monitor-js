# Cyber Rakshak error monitoring for JavaScript

What goes wrong in your apps, servers and scripts, on their own **Errors** page in the Cyber Rakshak console:
scrubbed of secrets before it leaves, counted rather than resent, and never in your app's way.

| Package | For | |
|---|---|---|
| [`@cyberrakshak/monitor`](packages/monitor) | Node.js 18+ (ES module and CommonJS, with types) | `npm install @cyberrakshak/monitor` |
| [`@cyberrakshak/react-native`](packages/react-native) | React Native and Expo (no native modules, with types) | `npm install @cyberrakshak/react-native` |

Each package's README has its example, options and what is sent. The full documentation, and the same library for PHP,
Python, shell, Android and iOS: **https://app.cyberrakshak.ai/sdk/README.md**

## Development

```sh
npm ci --ignore-scripts
npm run build        # packages/react-native/src -> lib/ (tsc)
npm run typecheck    # the source strictly against react-native's own types; both packages' types as an app uses them
npm test             # both packages, against test/fake-server.mjs (127.0.0.1 only: never a real Cyber Rakshak host)
node scripts/check-pack.mjs   # exactly what npm would publish, with the library files' SHA-256
```

The library files are not edited here. `packages/monitor/cyberrakshak-monitor.mjs` and `.cjs` and
`packages/react-native/src/cyberrakshak-monitor.ts` are byte for byte the ones served at https://app.cyberrakshak.ai/sdk/
(and listed with their SHA-256 in https://app.cyberrakshak.ai/sdk/index.json), as are `LICENSE`,
`test/fake-server.mjs` and `test/scrub-vectors.json`. They are changed in the Cyber Rakshak console's repository and
copied here by its `scripts/sdk-packages.mjs`, whose `--check` also checks that the versions below match.

## For maintainers

**Versions.** Both packages carry the same version, the libraries' own (`VERSION` in the source, `index.json`'s
`version`). A release: copy the new files in (`node scripts/sdk-packages.mjs` in the console repository), set `version`
in both `packages/*/package.json`, add both `CHANGELOG.md` entries, commit, then tag `vX.Y.Z` and push the tag.

**Publishing is by tag, through npm's trusted publishing** (`.github/workflows/publish.yml`): GitHub's OIDC token is
exchanged for a short-lived npm token, so no npm token is stored in this repository or its secrets, and every version
gets a provenance statement linking it to the commit and workflow run that built it. A version already on npm is skipped.

**1.0.0 is published once by hand.** npm lets a trusted publisher be set only on a package that already exists, so the
first version of each package goes from a maintainer's computer:

1. On npmjs.com, as the account that will own the packages: create the organisation **`cyberrakshak`** (free plan,
   public packages). Turn on two-factor authentication for the account.
2. In a clean checkout of this repository at the `v1.0.0` commit:
   ```sh
   npm login
   npm ci --ignore-scripts && npm run build && npm run typecheck && npm test && node scripts/check-pack.mjs
   npm publish --access public -w @cyberrakshak/monitor
   npm publish --access public -w @cyberrakshak/react-native
   ```
   (No `--provenance` here: provenance can only be made in CI.)
3. For **each** package on npmjs.com, Settings → Trusted publishing → GitHub Actions:
   organisation or user `LaabamOne-Business-Solutions-Pvt-Ltd`, repository `cyberrakshak-monitor-js`, workflow filename
   `publish.yml`, environment `npm`.
4. Then, in each package's Settings → Publishing access: "Require two-factor authentication and disallow tokens", so
   that from now on only this workflow can publish.
5. Push the tag `v1.0.0`: the workflow runs every check and skips both packages (1.0.0 is on npm already). The first
   version that really goes through trusted publishing is the next one, when its tag is pushed.

## Licence

MIT. Copyright (c) 2026 Laabam One Business Solutions (OPC) Private Limited. See [LICENSE](LICENSE).
