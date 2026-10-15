# Pearl Hub Wallet

A self-custody browser wallet for Pearl (PRL), for Chrome and Edge: create or restore
wallets, view balances and history, receive, and sign and send PRL on your own device.
It opens in the browser side panel or as a full page and supports 16 interface languages.

This repository is the wallet's complete source. The packages Pearl Hub publishes
(version 0.1.2 and later) are built from it; see [Verify a package](#verify-a-package).

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
- The content security policy allows connections to three sites only:
  `blockbook.pearlresearch.ai` and `blockbook.testnet.pearlresearch.ai` (balances and
  history, which receive the wallet's extended public key, and broadcasts of signed
  transactions) and `pearlhub.net` (PRL price and exchange rates without any address
  or identity, and the optional email account, which syncs contacts with Pearl Hub Pro).
- Contacts are stored unencrypted in the extension's local storage.
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
- `shared/`: files shared with the Pearl Hub Web frontend
  ([prl-hub-web](https://github.com/terryops/prl-hub-web), `src/`): the security and
  account copy, the configuration model used for contact sync and the icon table.
- `public/`: the manifest, localized store name and description, icon, Ionicons
  license and the bundled privacy notice.
- `store/`: the Chrome Web Store listing text in 16 languages and the 128 px icon.
- `test/`: unit tests. `native-vectors.json` holds public test vectors from the native
  app (the standard BIP39 test phrase); no test uses real funds.
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
