// NOCK (Nockchain) in the real extension: the WebAssembly core, the background service and the page, with
// stand-in Nockchain nodes (canned replies from nock-core tests/vectors.rs), a stand-in nockscan.com (no
// history yet) and a stand-in price. Nothing reaches a real node or nockscan; no transaction leaves the browser.
import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import { fixtureWallet, fits } from "./qa-support.mjs";

const out = "out/nock";
await mkdir(out, { recursive: true });
const fx = JSON.parse(await readFile(new URL("./nock-fixtures.json", import.meta.url), "utf8"));
const q = await fixtureWallet({ output: out });
const { page, context, worker, rpc, errors } = q;
const button = (name) => page.getByRole("button", { name, exact: true });
const dialog = () => page.locator("dialog.nock-dialog");
const prices = [];
await context.route(/^https:\/\/api\.coingecko\.com\//, async (route) => {
  prices.push(route.request().url());
  await route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ nockchain: { usd: 0.02285086 } }) });
});
await worker.evaluate((fx) => {
  globalThis.nockFixture = { calls: [], scans: 0, cli: 0, sends: [], offline: false, lose: false, accepted: true, nockboxDown: false, granted: false };
  // The second node's optional permission, as Chrome would report it once granted.
  chrome.permissions.contains = async () => nockFixture.granted;
  const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const framed = (message) => {
    const trailer = new TextEncoder().encode("grpc-status:0\r\ngrpc-message:\r\n"), out = new Uint8Array(10 + message.length + trailer.length), view = new DataView(out.buffer);
    view.setUint32(1, message.length); out.set(message, 5);
    out[5 + message.length] = 0x80; view.setUint32(6 + message.length, trailer.length); out.set(trailer, 10 + message.length);
    return new Response(out, { status: 200, headers: { "content-type": "application/grpc-web+proto" } });
  };
  const chain = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    // nockscan.com knows nothing of this address yet: its 404, which the wallet reads as no history.
    if (u.origin === "https://nockscan.com") { nockFixture.scans++; return new Response(JSON.stringify({ error: "Address not found" }), { status: 404, headers: { "content-type": "application/json" } }); }
    if (u.origin !== "https://rpc.nockbox.org" && u.origin !== "http://216.158.95.10:5556") return chain(url, init);
    if (u.origin === "http://216.158.95.10:5556") { if (!nockFixture.granted) throw new TypeError("Failed to fetch"); nockFixture.cli++; }
    // rpc.nockbox.org's gateway when its node is unreachable from this network: trailers-only UNAVAILABLE.
    else if (nockFixture.nockboxDown) return new Response(null, { status: 503, headers: { "grpc-status": "14", "grpc-message": "upstream%20connect%20error" } });
    if (init.headers?.["Content-Type"] !== "application/grpc-web+proto" || init.credentials !== "omit") throw new Error("Unexpected gRPC-web request");
    const path = u.pathname.slice(1), body = new Uint8Array(init.body);
    nockFixture.calls.push(path);
    if (nockFixture.offline) throw new TypeError("Failed to fetch");
    if (path.endsWith("/WalletGetBalance")) return framed(b64(new TextDecoder("latin1").decode(body).includes(fx.firstNames.simple) ? fx.balanceSimple : fx.balanceCoinbase));
    if (path.endsWith("/GetBlocks")) return framed(b64(fx.blocks));
    if (path.endsWith("/TransactionAccepted")) return framed(b64(nockFixture.accepted ? fx.accepted : fx.notAccepted));
    if (path.endsWith("/GetTransactionDetails")) return new Response(null, { status: 200, headers: { "grpc-status": "5", "grpc-message": "not%20found" } });
    if (path.endsWith("/WalletSendTransaction")) {
      nockFixture.sends.push(btoa(String.fromCharCode(...body)));
      if (nockFixture.lose) throw new TypeError("Failed to fetch");
      return framed(b64(fx.sendAck));
    }
    throw new Error("Unexpected gRPC path " + path);
  };
}, fx);
const calls = () => worker.evaluate(() => nockFixture.calls.length);
const shots = async (name) => {
  for (const theme of ["light", "dark"]) for (const width of [320, 360, 390, 1280]) {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" }); await page.setViewportSize({ width, height: 900 });
    await fits(page, `${name} ${theme} ${width}`);
    if (width === 390 || width === 1280) await page.screenshot({ path: `${out}/${name}-${theme}-${width}.png`, fullPage: true });
  }
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" }); await page.setViewportSize({ width: 390, height: 900 });
};

try {
  // A wallet that never used NOCK: only the quiet link, and no Nockchain request at all.
  const link = page.locator(".nock-link");
  await link.waitFor();
  assert.equal((await link.innerText()).trim(), "NOCK 钱包");
  assert.equal(await page.locator(".nock-strip").count(), 0);
  await page.waitForTimeout(500);
  assert.equal(await calls(), 0, "the wallet page reads nothing from Nockchain until NOCK is used");
  assert.equal(await worker.evaluate(() => nockFixture.scans), 0, "nor from nockscan");
  assert.equal(prices.length, 0);
  await shots("wallet-link");
  console.log("PASS link only, no Nockchain reads before use");

  // The NOCK page (iOS NockWalletView): balance from both lock kinds, locked block rewards on their own
  // row, 收款 · 转账 · 记录, the last three under 最近交易; 全部 lists a row per note.
  await link.click();
  await page.locator(".nock-summary .balance-number").filter({ hasText: /^155$/ }).waitFor();
  await page.locator(".nock-summary .nock-price").filter({ hasText: "$0.0229" }).waitFor();
  await page.locator(".nock-summary .fiat").filter({ hasText: "≈ $3.54" }).waitFor();
  assert.deepEqual((await page.locator(".nock-locked > div").allInnerTexts()).map((r) => r.replace(/\s+/g, " ").trim()), ["可用 85 NOCK", "锁定 · 挖矿收入约 4 小时后可用 70 NOCK"]); // 100 blocks at 150 s, as on iOS
  assert.deepEqual(await page.locator(".nock-actions button").allInnerTexts(), ["收款", "转账", "记录"]);
  await page.locator(".nock-recent-head").filter({ hasText: "最近交易" }).waitFor();
  assert.equal(await page.locator(".nock-recent .nock-row").count(), 3);
  assert.equal(await page.locator(".nock-footnote").count(), 0, "the nockscan note is on the history page, as on iOS");
  assert.ok(await worker.evaluate(() => nockFixture.scans) > 0, "history asked of nockscan once NOCK is open");
  await shots("page");
  await page.locator(".nock-recent-head").getByRole("button", { name: "全部", exact: true }).click();
  assert.deepEqual((await dialog().locator(".nock-history .nock-row .tx-main strong").allInnerTexts()).sort(), ["收到", "收到", "挖矿收入", "挖矿收入"].sort());
  await dialog().locator(".nock-footnote").filter({ hasText: "nockscan.com" }).waitFor();
  await dialog().getByRole("button", { name: "关闭", exact: true }).click();
  console.log("PASS page: 155 NOCK (85 available, 70 locked ~4 h), price and fiat, 3 recent rows, 4 in 全部");

  // Receive: the address of the same seed; getting it marks the wallet as using NOCK.
  await button("收 NOCK").click();
  await dialog().locator(".receive code").filter({ hasText: fx.address }).waitFor();
  await dialog().locator(".qr").waitFor();
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await dialog().getByRole("button", { name: "复制地址", exact: true }).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), fx.address);
  await shots("receive");
  await dialog().getByRole("button", { name: "关闭", exact: true }).click();
  console.log("PASS receive: address, QR, copy");

  // Send: checks while typing, the receipt, the password, then one broadcast.
  await button("转 NOCK").click();
  const to = dialog().getByLabel("收款地址", { exact: true }), amount = dialog().getByLabel("金额 (NOCK)", { exact: true }), send = dialog().getByRole("button", { name: "发送", exact: true });
  await to.fill("not-an-address"); await dialog().locator(".field-note.error").filter({ hasText: "收款地址格式不正确" }).waitFor();
  await to.fill(fx.address); await dialog().locator(".field-note.warn").filter({ hasText: "这是你自己的 NOCK 地址" }).waitFor();
  await to.fill(fx.recipient); await amount.fill("1000");
  await dialog().locator(".field-note.error").filter({ hasText: "超过可用余额（手续费另计）" }).waitFor();
  assert.equal(await send.isDisabled(), true);
  await amount.fill("1.1234567"); await dialog().locator(".field-note.error").filter({ hasText: "金额最多支持 6 位小数" }).waitFor();
  await amount.fill("40"); await send.waitFor({ state: "visible" }); await page.waitForFunction(() => !document.querySelector("dialog.nock-dialog button.primary")?.disabled);
  await send.click();
  const confirm = dialog().getByRole("button", { name: "确认发送 40 NOCK" });
  await confirm.waitFor();
  const grouped = dialog().locator(".grouped-address");
  assert.equal(await grouped.locator("span").count(), Math.ceil(fx.recipient.length / 4));
  const rows = await dialog().locator(".receipt-section").last().locator(".receipt-row").allInnerTexts();
  assert.match(rows[0], /^发送\s+40 NOCK$/); assert.match(rows[1], /^网络手续费\s+\d+(\.\d+)? NOCK$/); assert.match(rows[2], /^合计\s+4\d(\.\d+)? NOCK$/);
  const fee = Number(rows[1].match(/([\d.]+) NOCK$/)[1]);
  await dialog().locator(".nock-info strong").filter({ hasText: "请核对地址" }).waitFor();
  assert.equal(await worker.evaluate(() => nockFixture.sends.length), 0, "nothing leaves before the password");
  await shots("receipt");
  await dialog().getByLabel("再次输入密码确认").fill("wrong-password-123"); await confirm.click();
  await dialog().locator(".field-note.error").filter({ hasText: "密码错误或钱包文件损坏。" }).waitFor();
  assert.equal(await worker.evaluate(() => nockFixture.sends.length), 0);
  await dialog().getByLabel("再次输入密码确认").fill("public-test-password"); await confirm.click();
  await page.locator(".nock-toast").filter({ hasText: "已发送 ✓" }).waitFor();
  assert.equal(await worker.evaluate(() => nockFixture.sends.length), 1);
  await page.locator(".nock-row").first().locator("strong").filter({ hasText: "发出" }).waitFor();
  await page.locator(".nock-row").first().locator(".nock-pending").filter({ hasText: "待确认" }).waitFor();
  // The 50 NOCK note is held by the send: 35 left to spend; its change counts in the total.
  const total = await page.locator(".nock-summary .balance-number").innerText();
  assert.ok(Math.abs(Number(total.replace(/,/g, "")) - (115 - fee)) < 0.0001, `${total} vs 115 − ${fee}`);
  console.log(`PASS send: address/amount checks, receipt, wrong password refused, one broadcast, pending row, total ${total}`);

  // MAX: everything spendable minus the fee, as text the form takes back.
  await button("转 NOCK").click();
  await dialog().getByRole("button", { name: "MAX", exact: true }).click();
  // 35 NOCK spendable (the 50 is held by the send above), less the fee for spending both notes.
  await page.waitForFunction(() => { const v = Number(document.querySelector('dialog.nock-dialog input[inputmode="decimal"]')?.value); return v > 20 && v < 35; });
  // A broadcast whose reply is lost and that no node admits to having: a warning, and no new send until it settles.
  await worker.evaluate(() => { nockFixture.lose = true; nockFixture.accepted = false; });
  await to.fill(fx.recipient); await amount.fill("1");
  await page.waitForFunction(() => !document.querySelector("dialog.nock-dialog button.primary")?.disabled);
  await send.click();
  await dialog().getByLabel("再次输入密码确认").fill("public-test-password");
  await dialog().getByRole("button", { name: "确认发送 1 NOCK" }).click();
  await dialog().locator(".fee-warning").filter({ hasText: "网络异常，无法确认转账是否已发出（无法连接 Nockchain 节点）。请先查看交易记录，切勿重复发送。" }).waitFor();
  await dialog().getByRole("button", { name: "关闭", exact: true }).click();
  await button("转 NOCK").click(); await to.fill(fx.recipient); await amount.fill("1");
  await page.waitForFunction(() => !document.querySelector("dialog.nock-dialog button.primary")?.disabled);
  await send.click();
  await dialog().locator(".field-note.error").filter({ hasText: "上一笔转账是否发出尚未确认，请先查看交易记录，稍后再试" }).waitFor();
  await dialog().getByRole("button", { name: "关闭", exact: true }).click();
  await worker.evaluate(() => { nockFixture.lose = false; nockFixture.accepted = true; });
  console.log("PASS MAX fills the form; a lost broadcast warns and blocks the next send");

  // Details of a send: recipient in groups, txid, explorer link.
  await page.locator(".nock-row").first().click();
  await dialog().locator(".receipt-row").filter({ hasText: "类型" }).filter({ hasText: "发出" }).waitFor();
  await dialog().locator(".grouped-address").waitFor();
  assert.match(await dialog().locator("a").filter({ hasText: "在浏览器中查看" }).getAttribute("href"), /^https:\/\/nockscan\.com\/tx\/[1-9A-HJ-NP-Za-km-z]+$/);
  await shots("detail");
  await dialog().getByRole("button", { name: "关闭", exact: true }).click();

  // Offline: the last data stays, with what went wrong.
  await worker.evaluate(() => { nockFixture.offline = true; });
  await page.locator(".nock-summary .balance-heading button").click();
  await page.locator(".nock-problem").filter({ hasText: /无法连接 Nockchain 节点，显示的是 .+ 的数据/ }).waitFor({ timeout: 15000 });
  await worker.evaluate(() => { nockFixture.offline = false; });
  console.log("PASS details and offline");

  // rpc.nockbox.org unreachable from this network: the page offers the second node; allowing it (Chrome's own
  // prompt, stubbed here) makes the next read go there.
  await worker.evaluate(() => { nockFixture.nockboxDown = true; });
  await page.locator(".nock-summary .balance-heading button").click();
  const offer = page.locator(".nock-offer");
  await offer.filter({ hasText: "rpc.nockbox.org 现在连不上" }).waitFor({ timeout: 15000 });
  await page.locator(".nock-problem").filter({ hasText: "Nockchain 节点暂时不可用（HTTP 503）" }).waitFor();
  assert.equal(await worker.evaluate(() => nockFixture.cli), 0, "the second node is not used before it is allowed");
  await shots("offer");
  await page.evaluate(() => { chrome.permissions.request = async () => true; });
  await worker.evaluate(() => { nockFixture.granted = true; });
  await offer.getByRole("button", { name: "允许使用备用节点" }).click();
  await page.waitForFunction(() => !document.querySelector(".nock-offer") && !document.querySelector(".nock-problem"), undefined, { timeout: 15000 });
  assert.ok(await worker.evaluate(() => nockFixture.cli) > 0, "read through the second node");
  await worker.evaluate(() => { nockFixture.nockboxDown = false; nockFixture.granted = false; });
  console.log("PASS rpc.nockbox.org down: the second node is offered, used only once allowed");

  // Back on the PRL page the wallet now uses NOCK: the strip with its balance instead of the link.
  await page.locator(".nock-back").click();
  await page.locator(".nock-strip .nock-strip-value b").waitFor();
  assert.equal(await page.locator(".nock-link").count(), 0);
  await page.locator(".nock-strip small").filter({ hasText: /^≈ \$\d+\.\d\d$/ }).waitFor();
  await shots("wallet-strip");
  // In English.
  await rpc("touch"); await worker.evaluate(() => chrome.storage.local.set({ language: "en" }));
  await page.locator(".nock-strip").filter({ hasText: "NOCK" }).click();
  await page.locator(".nock-back").filter({ hasText: "PRL Wallet" }).waitFor();
  await page.locator(".nock-recent-head").filter({ hasText: "Recent Transactions" }).waitFor();
  // The link to the full history, not the send form's "Max" (0.1.8's first build reused that string).
  assert.equal((await page.locator(".nock-recent-head .text-button").innerText()).trim(), "All");
  await shots("page-en");
  // Every language fits at 320 px: the page, the send form and the receipt.
  // A fresh read finds the earlier "lost" send at a node (the stand-in now says accepted), which frees new sends.
  assert.equal((await rpc("nock-refresh")).data.hasUnverifiedSend, false);
  const languages = ["en", "ru", "zh-Hans", "zh-Hant", "vi", "id", "es", "pt-BR", "fr", "de", "it", "tr", "ja", "ko", "hi", "th"];
  await page.setViewportSize({ width: 320, height: 800 });
  for (const language of languages) {
    await worker.evaluate((language) => chrome.storage.local.set({ language }), language);
    await page.waitForFunction((language) => document.documentElement.lang === language, language);
    await fits(page, `NOCK page ${language} 320`);
    await page.locator(".nock-actions button").nth(1).click();
    await dialog().locator("textarea").fill(fx.recipient); await dialog().locator('input[inputmode="decimal"]').fill("0.5");
    await fits(page, `NOCK send ${language} 320`);
    await page.waitForFunction(() => !document.querySelector("dialog.nock-dialog button.primary")?.disabled);
    await dialog().locator("form button.primary").click();
    await dialog().locator(".receipt, .field-note.error").first().waitFor();
    if (!await dialog().locator(".receipt").count()) throw new Error(`${language}: ${await dialog().locator(".field-note.error").innerText()} | ${JSON.stringify(await rpc("nock-status").then((r) => ({ v: r.data.hasUnverifiedSend, p: r.data.hasPendingSend, a: r.data.balance })))}`);
    await fits(page, `NOCK receipt ${language} 320`);
    if (["de", "hi", "th", "ja"].includes(language)) await page.screenshot({ path: `${out}/receipt-${language}-320.png` });
    await dialog().locator(".dialog-title button").click();
  }
  await page.setViewportSize({ width: 390, height: 900 });
  await worker.evaluate(() => chrome.storage.local.set({ language: "zh-Hans" }));
  console.log("PASS strip after use, English page, 16 languages fit at 320 px");

  // Locking closes the NOCK page; removing the wallet removes its NOCK state.
  await page.getByRole("button", { name: "锁定钱包" }).click();
  await page.locator("h1").filter({ hasText: "钱包已锁定" }).waitFor();
  assert.ok(Object.keys(await worker.evaluate(() => chrome.storage.local.get(null))).some((k) => k.startsWith("nock.state.")));
  const unlocked = await rpc("unlock", { password: "public-test-password" });
  assert.ok(unlocked.ok);
  // Removing the (only) wallet removes its NOCK address, history and sends too.
  const removed = await rpc("delete", { password: "public-test-password", name: "QA Wallet", expectedWalletId: unlocked.data.selected });
  assert.ok(removed.ok, removed.error);
  assert.deepEqual(Object.keys(await worker.evaluate(() => chrome.storage.local.get(null))).filter((k) => k.startsWith("nock.")).filter((k) => k !== "nock.price"), []);
  assert.deepEqual(errors, []);
  console.log("PASS lock; removing the wallet removes its NOCK state; no page errors");
} finally {
  await q.close();
}
