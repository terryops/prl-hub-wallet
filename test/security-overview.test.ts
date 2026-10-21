import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import manifest from "../public/manifest.json" with { type: "json" };
import locales from "../shared/security-overview-locales.json" with { type: "json" };

// The wallet's Security Overview (extensionSecurity in shared/security-overview.ts)
// states these facts. If one changes, update the copy in all sixteen languages.
const source = (name: string) => readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8");
const hosts = ["https://blockbook.pearlresearch.ai", "https://blockbook.testnet.pearlresearch.ai", "https://pearlhub.net"];

test("security overview: no content scripts, no web-page route, three sites only", () => {
  const m = manifest as Record<string, unknown>;
  assert.equal(m.content_scripts, undefined);
  assert.equal(m.externally_connectable, undefined);
  assert.deepEqual(manifest.host_permissions, hosts.map((host) => host + "/*"));
  const csp = manifest.content_security_policy.extension_pages.split(";").map((part) => part.trim());
  // Beyond the three sites: the extension's own files (the NOCK core's .wasm), the public Nockchain node and
  // CoinGecko's NOCK price, all without a site permission (they send CORS headers), and the second Nockchain
  // node, reachable only once the person grants its optional permission (extNock, extPages).
  assert.ok(csp.includes(`connect-src 'self' ${hosts.join(" ")} https://rpc.nockbox.org http://216.158.95.10:5556 https://api.coingecko.com`));
  assert.deepEqual((manifest as { optional_host_permissions?: string[] }).optional_host_permissions, ["http://216.158.95.10/*"]);
  // 'wasm-unsafe-eval' lets the packaged NOCK core (WebAssembly) run; no other code can be evaluated.
  assert.ok(csp.includes("script-src 'self' 'wasm-unsafe-eval'"));
  assert.match(source("background.ts"), /sender\.id !== chrome\.runtime\.id \|\| sender\.url\?\.split\("\?"\)\[0\]\.split\("#"\)\[0\] !== chrome\.runtime\.getURL\("index\.html"\)/);
});

test("security overview: vault, lock and sync facts match the code", () => {
  const vault = source("vault.ts"), background = source("background.ts");
  assert.match(vault, /const iterations = 600000;/);
  assert.match(vault, /hash: "SHA-256"/);
  assert.match(vault, /"AES-GCM"/);
  assert.match(vault, /deriveBits\(\{[^}]*\}, material, 256\)/);
  assert.match(background, /LOCK_MS = 5 \* 60000/);
  assert.match(background, /chrome\.storage\.session\.setAccessLevel\(\{ accessLevel: "TRUSTED_CONTEXTS" \}\)/);
  for (const file of readdirSync(new URL("../src/", import.meta.url)).filter((name) => /\.tsx?$/.test(name)))
    assert.doesNotMatch(source(file), /chrome\.storage\.sync/, file);
  assert.match(locales["zh-Hans"].extKeys, /60 万/);
  assert.match(locales["zh-Hans"].extKeys, /5 分钟/);
  assert.match(locales.en.extKeys, /600,000/);
  assert.match(locales.en.extKeys, /5 minutes/);
});

test("security overview: balances and history go to our own index first, then the official one", async () => {
  // extHistory / extExplorer describe indexers() in src/chain.ts; change the copy with it.
  const { indexers, OWN_MAINNET } = await import("../src/chain.ts");
  const { extensionSecurity } = await import("../shared/security-overview.ts");
  assert.equal(OWN_MAINNET, "https://pearlhub.net/node");
  assert.deepEqual(indexers("mainnet"), [OWN_MAINNET, "https://blockbook.pearlresearch.ai"]);
  assert.deepEqual(indexers("testnet"), ["https://blockbook.testnet.pearlresearch.ai"]);
  for (const [lang, copy] of Object.entries(locales)) {
    assert.match(copy.extHistory, /pearlhub\.net\/node[\s\S]*blockbook\.pearlresearch\.ai/, lang);
    assert.match(copy.extHistory, /xpub/, lang);
    assert.match(copy.extExplorer, /blockbook\.testnet\.pearlresearch\.ai/, lang);
  }
  // Our server receives them now, so the row sits under "Sent to our server", not "What we never receive".
  const section = (title: string) => extensionSecurity.find((s) => s.title === title)!.rows.map((r) => r.text);
  assert.ok(section("toServer").includes("extHistory"));
  assert.ok(!section("neverReceive").includes("extHistory"));
});
