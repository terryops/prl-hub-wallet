import { test } from "node:test";
import assert from "node:assert/strict";
import { currencies, dualFiat, isSecondary, secondaryCode, loadMarket } from "../src/market.ts";
import { featureCopy } from "../src/feature-copy.ts";
test("native secondary currencies, language defaults and precision", () => {
  assert.equal(currencies.length, 17); assert.equal(isSecondary("USD"), false);
  assert.equal(secondaryCode("__auto__", "en"), ""); assert.equal(secondaryCode("__auto__", "zh-Hant"), "TWD");
  assert.equal(dualFiat(2, "__auto__", "zh-Hans", { CNY: 7.1 }), "$2.00 · ¥14.20");
  assert.equal(dualFiat(2, "TWD", "en", { TWD: 31.23 }), "$2.00 · NT$62");
  assert.equal(dualFiat(2, "", "en", { CNY: 7.1 }), "$2.00");
  assert.equal(dualFiat(2, "CNY", "en", { CNY: NaN }), "$2.00");
  for (const copy of Object.values(featureCopy)) assert.deepEqual(Object.keys(copy), Object.keys(featureCopy.en));
});
test("fixed public GETs send no wallet identity; FX failure falls back to USD; price failure hides row", async () => {
  const original = fetch, requests: { url: string; init: RequestInit }[] = [];
  let price: unknown = { usd: 0.8, ts: Date.now() / 1000 }, fxOK = false;
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init: init! });
    return String(url).endsWith("price") ? Response.json(price) : Response.json({ ok: true, base: "USD", rates: { CNY: 7.1, EUR: -1, XXX: 1 } }, { status: fxOK ? 200 : 503 });
  };
  try {
    assert.deepEqual(await loadMarket(new AbortController().signal), { usd: 0.8, rates: undefined });
    fxOK = true; assert.deepEqual((await loadMarket(new AbortController().signal)).rates, { CNY: 7.1 });
    price = { usd: 0.8, ts: Date.now() / 1000 - 301 }; assert.deepEqual(await loadMarket(new AbortController().signal), {});
    price = { usd: 0, ts: Date.now() / 1000 }; assert.deepEqual(await loadMarket(new AbortController().signal), {});
    globalThis.fetch = async () => { throw new Error("offline"); }; assert.deepEqual(await loadMarket(new AbortController().signal), {});
    for (const { url, init } of requests) { assert.match(url, /^https:\/\/pearlhub.net\/v1\/(price|fx)$/); assert.equal(init.credentials, "omit"); assert.equal(init.body, undefined); }
  } finally { globalThis.fetch = original; }
});
