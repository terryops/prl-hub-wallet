// Actual packaged UI, public wallet vector, simulated 25 PRL. No real broadcasts.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { dirname } from "node:path";
import { fixtureWallet, fits } from "./qa-support.mjs";
const langs = ["en", "ru", "zh-Hans", "zh-Hant", "vi", "id", "es", "pt-BR", "fr", "de", "it", "tr", "ja", "ko", "hi", "th"];
const output = process.env.PRL_QA_SCREENSHOT_OUTPUT || "store/screenshots";
const assetOutput = dirname(output);
await mkdir(output, { recursive: true });
const q = await fixtureWallet({ output: "out/store-qa", viewport: { width: 1280, height: 800 }, language: "en" });
try {
  const { page, rpc, vectors } = q;
  assert.equal((await rpc("contact-save", { name: "QA Exchange", address: vectors.cases[0].to, note: "Public test data" })).ok, true);
  const files = [];
  async function capture(lang, scene) {
    await fits(page, `${lang} ${scene}`);
    await page.mouse.move(0, 0);
    if (scene === "contacts") {
      const contact = page.locator(".contacts .contact").first();
      // Centred, not merely "visible": scrolling the least amount leaves the card on the bottom edge,
      // half a pixel outside the frame.
      await contact.evaluate((e) => e.scrollIntoView({ block: "center" }));
      // A visible DOM node can still sit below the screenshot's viewport.
      const box = await contact.boundingBox(), viewport = page.viewportSize();
      assert.ok(box && viewport && box.y >= 0 && box.y + box.height <= viewport.height, `${lang}: contact must fit in the screenshot`);
      assert.equal(await contact.locator("strong").textContent(), "QA Exchange");
    } else await page.evaluate(() => scrollTo(0, 0));
    const filename = `${output}/${lang}-${scene}.png`;
    await page.screenshot({ path: filename, fullPage: false });
    const png = await readFile(filename);
    assert.equal(png.readUInt32BE(16), 1280); assert.equal(png.readUInt32BE(20), 800);
    files.push(filename);
  }
  for (const lang of langs) {
    const texts = JSON.parse(await readFile(`src/i18n/${lang}.json`, "utf8"));
    const button = (key) => page.getByRole("button", { name: texts[key], exact: true });
    await page.locator('#wallet-settings').click(); await page.locator("#language").selectOption(lang);
    await page.waitForFunction((lang) => document.documentElement.lang === lang, lang);
    await button('关闭').click();
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await button("钱包").click(); await capture(lang, "wallet-light");
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" }); await capture(lang, "wallet-dark");
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await button("地址簿").click(); await page.locator(".contact").waitFor(); await capture(lang, "contacts");
    await button("↑ 转账").click(); await page.getByLabel(texts["地址簿"], { exact: true }).selectOption(vectors.cases[0].to);
    await page.getByLabel(texts["转账金额"], { exact: true }).fill("1"); await button("预览转账").click(); await button("确认并发送").waitFor(); await capture(lang, "send-preview"); await button("关闭").click();
    await button("支持开发者").click(); await page.getByRole("button", { name: "5 PRL", exact: true }).click(); await button("确认捐赠").waitFor(); await capture(lang, "donation-preview"); await button("关闭").click();
  }
  // Chrome Web Store also needs a 440×280 promotional image. Reuse the shipped
  // logo rather than displaying a fake wallet or a fabricated screenshot.
  const promo = await q.context.newPage(); await promo.setViewportSize({ width: 440, height: 280 });
  const icon = (await readFile("public/icon.png")).toString("base64");
  await promo.setContent(`<html><body style="margin:0;width:440px;height:280px;display:grid;place-items:center;background:linear-gradient(125deg,#132945,#234875)"><img alt="" style="width:128px;height:128px" src="data:image/png;base64,${icon}"></body></html>`);
  await promo.screenshot({ path: `${assetOutput}/promo-small.png`, fullPage: false }); await promo.close();
  const storeIcon = await q.context.newPage(); await storeIcon.setViewportSize({ width: 128, height: 128 });
  await storeIcon.setContent(`<html><body style="margin:0;background:transparent"><img alt="" style="display:block;width:128px;height:128px" src="data:image/png;base64,${icon}"></body></html>`);
  await storeIcon.screenshot({ path: `${assetOutput}/icon-128.png`, fullPage: false, omitBackground: true }); await storeIcon.close();
  assert.equal(await q.worker.evaluate(() => fixture.broadcasts.length), 0); assert.deepEqual(q.errors, []);
  await writeFile(`${output}/generated.json`, JSON.stringify({ version: q.manifest.version, generatedAt: new Date().toISOString(), dimensions: [1280, 800], simulatedBalancePRL: 25, publicTestWallet: true, realBroadcasts: 0, smallPromotionalImage: `${assetOutput}/promo-small.png`, storeIcon: `${assetOutput}/icon-128.png`, files }, null, 2) + "\n");
  console.log(`PASS ${files.length} actual extension screenshots at 1280×800; fixtures only`);
} finally { await q.close(); }
