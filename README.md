# PRL Wallet — Open source Wallet from Pearl Hub

A self-custody browser wallet for Pearl (PRL), for Chrome and Edge: create or restore
wallets, view balances and history, receive, and sign and send PRL on your own device.
It opens in the browser side panel or as a full page and supports 16 interface languages.

This repository is the wallet's complete source, and where it is developed. The packages
Pearl Hub publishes (version 0.1.2 and later) are built from it; see
[Verify a package](#verify-a-package). Development notes, in Chinese, are in
[DEVELOPMENT.md](DEVELOPMENT.md).

## Security model

- Recovery phrases and private keys are created, stored and used only inside the
  extension, and transactions are signed there. They are never uploaded.
- Wallets are encrypted with your unlock password (PBKDF2-SHA256 with 600,000
  iterations, then AES-256-GCM) in `chrome.storage.local`, never in
  `chrome.storage.sync`. After unlocking, the key is kept in `chrome.storage.session`
  (extension pages only) and is cleared after 5 minutes of inactivity or when the
  browser restarts. Showing a recovery phrase, sending, removing a wallet and changing
  the password each ask for the password again.
- There are no content scripts and no `externally_connectable`: web pages cannot reach
  the wallet or ask it to sign. The background worker accepts messages only from the
  extension's own page.
- The content security policy allows connections to six sites only; the extension has site
  permissions for three of them, and a fourth only if you allow the backup Nockchain node
  (below). Balances, history
  and broadcasts go first to Pearl Hub's own blockchain index at `pearlhub.net/node`, and
  to Pearl's official `blockbook.pearlresearch.ai` when ours is unavailable or behind
  (testnet: `blockbook.testnet.pearlresearch.ai` only). These queries receive the wallet's
  extended public key; signed transactions are broadcast to both. `pearlhub.net` also
  serves the PRL price and exchange rates (without any address or identity) and the
  optional email account, which syncs contacts with Pearl Hub Pro.
- NOCK (Nockchain): the same recovery phrase also opens a NOCK address, derived as the
  official Nockchain wallet does. Once you open NOCK, its balance comes from NockBox's public
  node `rpc.nockbox.org` (requests carry identifiers derived from that address), NOCK
  transactions signed in the extension are broadcast there, and the NOCK price comes from
  `api.coingecko.com` without any address or identity. If `rpc.nockbox.org` can't be reached
  (its gateway refuses some networks), the NOCK page offers the node the official Nockchain
  wallet uses by default, `216.158.95.10` (plain HTTP, no CORS): Chrome then asks you for that
  one optional site permission, and only once granted does the extension use it, as a second
  node. The NOCK core is the native app's Rust
  crate compiled to WebAssembly (`nock-core/`, `src/nock/nock_core.wasm`), which is why the
  policy allows `'wasm-unsafe-eval'`.
- Contacts, and the NOCK address and history, are stored unencrypted in the extension's
  local storage.
- Everything is bundled; no remote code is loaded. No ads, analytics or crash reporting.

The wallet has not been independently audited. Back up every recovery phrase:
uninstalling the extension deletes its wallets. Privacy policy:
https://pearlhub.net/privacy.

## Build

Use Node.js 22.6 or newer, and Python 3 for packaging.

```sh
npm ci
npm test
npm run build
```

`dist/` is the unpacked extension: open `chrome://extensions` (or `edge://extensions`),
turn on Developer mode, choose **Load unpacked** and select `dist/`.

`npm run package` builds and writes two ZIPs:

- `pearl-hub-wallet-<version>.zip`, offered on pearlhub.net. Its manifest keeps the
  `key` field, so the extension ID is always `njnhepcaamfibhkfbfhlmknoldgjmefc`.
- `pearl-hub-wallet-<version>-store.zip`, uploaded to the Chrome Web Store, which assigns
  its own ID and does not accept `key`.

Both replace `icon.png` with `store/icon-128.png`; otherwise they contain `dist/` as built.

`npm run build:android` builds the wallet page that the Pearl Hub Android app bundles
(`dist-android/`). The browser checks (`npm run qa`, `qa:features`, `qa:languages`,
`store:screenshots`) load `dist/` into Chromium with Playwright and use local fixtures only;
install the browser once with `npx playwright install chromium`.

## Verify a package

Check out the tag for the version you want, run `npm ci && npm run package`, unzip
your build and the published ZIP into two directories and compare them with
`diff -r`. With the same `package-lock.json` the files are identical; only ZIP
timestamps differ. A copy installed from the Chrome Web Store also carries files and
manifest fields the store adds (such as `_metadata/` and `update_url`).

## Project layout

- `src/`: the wallet page (`main.tsx`), the background service worker
  (`background.ts`), password encryption (`vault.ts`), key derivation and signing
  (`wallet.ts`, `chain.ts`), contacts, account sign-in and contact sync, and 16 languages.
- `src/android/`: the wallet inside the Pearl Hub Android app, one page on a `chrome.*`
  shim (`android.html`, `vite.android.config.ts`).
- `shared/`: copies of files from the Pearl Hub Web frontend
  ([prl-hub-web](https://github.com/terryops/prl-hub-web), `src/`): the security and
  account copy, the configuration model used for contact sync, the icon table and the
  Android bridge. That is their source; `npm run sync:shared` copies them again from a
  `prl-hub-web` checkout next to this one (or `npm run sync:shared -- <its src path>`),
  and `-- --check` only lists the differences.
- `public/`: the manifest, localized store name and description, icon, Ionicons
  license and the bundled privacy notice.
- `store/`: the Chrome Web Store listing text in 16 languages, the 128 px icon, promo
  image and screenshots, and the submission notes (`SUBMIT.md`, in Chinese).
- `scripts/`: `store-release.mjs` uploads a store package and submits it for review
  through the Chrome Web Store API; `sync-shared.mjs` refreshes `shared/`.
- `test/`: unit tests (`*.test.ts`) and the browser checks (`*.mjs`). `native-vectors.json`
  holds public test vectors from the native app (the standard BIP39 test phrase);
  `native-verify.go` is an optional consensus check of signed fixtures. No test uses real funds.
- `ICONS.md`: Ionicons provenance and the icon mapping.

## License

The code is available under the [MIT license](LICENSE). Bundled Ionicons keep their own
MIT notice in `public/licenses/ionicons.txt`. The Pearl Hub name and the icons in
`public/icon.png` and `store/icon-128.png` are the publisher's branding and are not
licensed under the MIT code license.

Related source: [iPhone / iPad / Mac app](https://github.com/terryops/prl-hub),
[Web frontend](https://github.com/terryops/prl-hub-web),
[server](https://github.com/terryops/prl-hub-server).
Support: [Pearl Hub community](https://t.me/prl_hub).
