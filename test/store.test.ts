import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const json = (file: string) => JSON.parse(readFileSync(new URL(file, import.meta.url), "utf8"));
test("store locales disclose every actual permission with matching names/descriptions", () => {
  const manifest = json("../public/manifest.json"), pkg = json("../package.json");
  assert.equal(pkg.version, "0.1.8"); assert.equal(manifest.version, pkg.version);
  assert.deepEqual(manifest.permissions, ["storage", "alarms", "sidePanel", "identity"]);
  assert.deepEqual(manifest.host_permissions, ["https://blockbook.pearlresearch.ai/*", "https://blockbook.testnet.pearlresearch.ai/*", "https://pearlhub.net/*"]);
  // The backup Nockchain node: asked for only from the NOCK page, so updates don't disable the extension.
  assert.deepEqual(manifest.optional_host_permissions, ["http://216.158.95.10/*"]);
  assert.equal(manifest.name, "__MSG_name__");
  assert.equal(manifest.content_scripts, undefined); assert.equal(manifest.externally_connectable, undefined);
  for (const host of manifest.host_permissions) assert.ok(manifest.content_security_policy.extension_pages.includes(host.slice(0, -2)));
  for (const [lang, locale] of [["en", "en"], ["ru", "ru"], ["zh-Hans", "zh_CN"], ["zh-Hant", "zh_TW"], ["vi", "vi"], ["id", "id"], ["es", "es"], ["pt-BR", "pt_BR"], ["fr", "fr"], ["de", "de"], ["it", "it"], ["tr", "tr"], ["ja", "ja"], ["ko", "ko"], ["hi", "hi"], ["th", "th"]]) {
    const listing = json(`../store/${lang}.json`), messages = json(`../public/_locales/${locale}/messages.json`);
    assert.equal(listing.language, lang); assert.equal(messages.name.message, listing.name); assert.equal(messages.description.message, listing.shortDescription);
    assert.ok(listing.shortDescription.length <= 132); assert.ok(listing.detailedDescription.length > 300); assert.ok(listing.dataUseDisclosure.length > 200);
    assert.deepEqual(Object.keys(listing.permissionJustifications).sort(), [...manifest.permissions, ...manifest.host_permissions, ...manifest.optional_host_permissions].sort());
    assert.ok(Object.values(listing.permissionJustifications).every((value) => typeof value === "string" && value.length > 15));
  }
});
