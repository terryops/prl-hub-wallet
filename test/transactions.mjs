// 交易详情 and 交易查询 in a real browser. Every indexer request, including the rebroadcast, is answered
// inside the isolated extension worker; no live service is contacted and nothing is broadcast.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fixtureWallet, fits } from "./qa-support.mjs";
const txs = JSON.parse(await readFile(new URL("./tx-fixtures.json", import.meta.url), "utf8"));
const output = "out/tx-detail";
const { context, page, worker, vectors, errors, close } = await fixtureWallet({ output, viewport: { width: 360, height: 900 } });
const pass = (text) => console.log(`PASS ${text}`);
try {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const own = vectors.addresses[0], other = vectors.cases[0].to;
  // The real mempool-style transaction (its signed bytes are its txid) paying this wallet, the history
  // fixture's receipt, a pool-style payout with 25 outputs, and a real coinbase with an OP_RETURN output.
  const mempool = { ...txs.normal, confirmations: 0, blockHeight: -1, blockTime: 1792490300, vout: [{ ...txs.normal.vout[0], addresses: [own] }, txs.normal.vout[1]] };
  const receipt = { txid: "44".repeat(32), confirmations: 10, blockHeight: 130000, blockTime: 1700000000, value: "100000000", fees: "1000", vin: [{ addresses: [other], value: "100001000", isAddress: true }], vout: [{ addresses: [own], value: "100000000", isAddress: true }] };
  const payout = { ...txs.normal, txid: "77".repeat(32), confirmations: 5, blockHeight: 130600, value: undefined, vout: Array.from({ length: 25 }, (_, i) => ({ addresses: [i === 7 ? own : other], value: String(1000 + i), isAddress: true })) };
  await worker.evaluate(({ answers }) => {
    const original = globalThis.fetch;
    fixture.posted = [];
    globalThis.fetch = async (url, init = {}) => {
      const p = new URL(String(url)).pathname;
      if (p.includes("/sendtx/")) { fixture.posted.push(init.body); return Response.json({ result: answers[0].txid }); }
      const m = /^\/api\/v2\/tx\/([0-9a-f]{64})$/.exec(p);
      if (m) {
        const tx = answers.find((t) => t.txid === m[1]);
        return tx ? Response.json(tx) : Response.json({ error: `Transaction '${m[1]}' not found` }, { status: 400 });
      }
      return original(url, init);
    };
  }, { answers: [mempool, receipt, payout, txs.coinbase] });
  const button = (name) => page.getByRole("button", { name, exact: true });
  const dialog = page.locator("dialog[open]");

  await button("交易记录").click();
  const row = page.locator(".transaction").first();
  await row.locator(".tx-id").waitFor();
  await fits(page, "history at 360 px");
  await page.screenshot({ path: `${output}/history-360.png` });
  await row.getByRole("button", { name: "复制交易 ID" }).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), receipt.txid);
  assert.equal(await dialog.count(), 0, "copying the txid doesn't open the details");
  await row.click({ position: { x: 12, y: 14 } });
  await dialog.locator("h2", { hasText: "交易详情" }).waitFor();
  await dialog.locator(".tx-status.confirmed", { hasText: "已确认" }).waitFor();
  const text = await dialog.innerText();
  for (const fact of ["130000", "+1.00 PRL", "0.00001 PRL", receipt.txid]) assert.ok(text.includes(fact), fact);
  assert.equal(await dialog.getByRole("link", { name: /区块浏览器/ }).getAttribute("href"), `https://blockbook.pearlresearch.ai/tx/${receipt.txid}`);
  assert.equal(await dialog.locator(".tx-rows li.mine").count(), 1);
  assert.equal(await dialog.locator(".tx-rows li.mine strong").innerText(), "QA Wallet");
  assert.equal(await button("重新广播").count(), 0, "a confirmed transaction isn't rebroadcast");
  await dialog.getByRole("button", { name: "复制交易 ID" }).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), receipt.txid);
  await fits(page, "details at 360 px");
  await page.screenshot({ path: `${output}/details-360.png` });
  await button("关闭").click();
  // The detail button opens the same panel from the keyboard.
  await page.locator(".transaction").nth(1).getByRole("button", { name: "交易详情" }).focus();
  await page.keyboard.press("Enter");
  await dialog.locator("code", { hasText: "55".repeat(32) }).waitFor();
  await dialog.getByText("没有找到这笔交易。刚发出的交易可能要稍等片刻才能查到。", { exact: true }).waitFor();
  await button("关闭").click();
  pass("history rows copy their txid and open 交易详情 (status, facts, own rows named, explorer link)");

  await page.getByRole("button", { name: "交易查询", exact: true }).click();
  await dialog.locator("h2", { hasText: "交易查询" }).waitFor();
  const input = page.getByLabel("交易 ID（txid）或区块浏览器链接", { exact: true });
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "交易 ID（txid）或区块浏览器链接");
  await input.fill("hello"); await button("查询").click();
  await page.getByText("请输入交易 ID：64 位，由 0–9 和 a–f 组成。", { exact: true }).waitFor();
  await input.fill(` https://blockbook.pearlresearch.ai/tx/${"99".repeat(32)} `); await button("查询").click();
  await page.getByText("没有找到这笔交易。刚发出的交易可能要稍等片刻才能查到。", { exact: true }).waitFor();
  assert.equal(await input.inputValue(), "99".repeat(32));
  await input.fill(mempool.txid.toUpperCase()); await button("查询").click();
  await dialog.locator(".tx-status:not(.confirmed)", { hasText: "待确认" }).waitFor();
  assert.ok((await dialog.innerText()).includes("+30.42439163 PRL"));
  assert.equal(await dialog.locator(".tx-rows").nth(1).locator("li").first().getAttribute("class"), "mine");
  await page.screenshot({ path: `${output}/lookup-mempool-360.png` });
  await button("重新广播").click();
  await page.getByText("已重新广播，交易再次发往网络。", { exact: true }).waitFor();
  assert.deepEqual(await worker.evaluate(() => fixture.posted), [mempool.hex]);
  pass("lookup refuses non-txids, finds explorer links, reports not found, and rebroadcasts the indexer's signed copy");

  await input.fill(txs.coinbase.txid); await button("查询").click();
  await dialog.getByText("Coinbase：新挖出的币", { exact: true }).waitFor();
  await dialog.getByText("OP_RETURN", { exact: true }).waitFor();
  await input.fill(payout.txid); await button("查询").click();
  const outputs = dialog.locator(".tx-rows").nth(1);
  await outputs.getByRole("button", { name: "显示全部 (25)", exact: true }).waitFor();
  assert.equal(await outputs.locator("li").count(), 10);
  assert.equal(await outputs.locator("li").first().getAttribute("class"), "mine", "this wallet's output comes first");
  await outputs.getByRole("button", { name: "显示全部 (25)", exact: true }).click();
  assert.equal(await outputs.locator("li").count(), 25);
  await outputs.getByRole("button", { name: "收起", exact: true }).click();
  assert.equal(await outputs.locator("li").count(), 10);
  pass("coinbase and OP_RETURN rows; long output lists collapse to 10 with 显示全部");

  for (const scheme of ["light", "dark"]) for (const width of [320, 390]) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width, height: 900 });
    await fits(page, `lookup ${scheme} ${width}`);
    await page.screenshot({ path: `${output}/lookup-${scheme}-${width}.png` });
  }
  await page.evaluate(() => chrome.storage.local.set({ language: "en" }));
  await dialog.locator("h2", { hasText: "Transaction Lookup" }).waitFor();
  await page.getByLabel("Transaction ID (txid) or explorer link", { exact: true }).fill(mempool.txid);
  await page.getByRole("button", { name: "Look up", exact: true }).click();
  await dialog.getByText("Net for your addresses", { exact: true }).waitFor();
  await fits(page, "lookup en dark 390");
  await page.screenshot({ path: `${output}/lookup-en-dark-390.png` });
  pass("320/390 px light and dark without overflow; English copy");
  // Every language at the narrowest width, on the busiest result: 25 outputs, all shown.
  await page.emulateMedia({ colorScheme: "light" }); await page.setViewportSize({ width: 320, height: 900 });
  for (const lang of ["en", "ru", "zh-Hans", "zh-Hant", "vi", "id", "es", "pt-BR", "fr", "de", "it", "tr", "ja", "ko", "hi", "th"]) {
    const copy = JSON.parse(await readFile(new URL(`../src/i18n/${lang}.json`, import.meta.url), "utf8"));
    await page.evaluate((language) => chrome.storage.local.set({ language }), lang);
    await dialog.locator("h2", { hasText: copy["交易查询"] }).waitFor();
    await page.getByLabel(copy["交易 ID（txid）或区块浏览器链接"], { exact: true }).fill(payout.txid);
    await page.getByRole("button", { name: copy["查询"], exact: true }).click();
    // The same result stays open across languages, so it may already be expanded.
    await dialog.getByRole("button", { name: new RegExp(`^(${copy["收起"]}|${copy["显示全部"]} \\(25\\))$`) }).waitFor();
    const more = dialog.getByRole("button", { name: `${copy["显示全部"]} (25)`, exact: true });
    if (await more.count()) await more.click();
    await dialog.getByRole("button", { name: copy["收起"], exact: true }).waitFor();
    await dialog.getByText(copy["你的地址净收支"], { exact: true }).waitFor();
    await fits(page, `lookup ${lang} 320`);
  }
  await page.screenshot({ path: `${output}/lookup-th-320.png` });
  assert.deepEqual(errors, []);
  pass("all 16 languages fit at 320 px; no page errors");
} finally { await close(); }
