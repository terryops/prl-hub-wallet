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
  assert.ok(csp.includes(`connect-src ${hosts.join(" ")}`));
  assert.ok(csp.includes("script-src 'self'"));
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
