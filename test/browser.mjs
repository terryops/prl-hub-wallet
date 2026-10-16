import { chromium } from "playwright";
import assert from "node:assert/strict";
import { readFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { browserOptions, publicMarketFixture } from "./qa-support.mjs";
const vectors = JSON.parse(await readFile(new URL("./native-vectors.json", import.meta.url), "utf8"));
const output = resolve("out/extension-qa"); await mkdir(output, { recursive: true });
const profile = await mkdtemp(output + "/chrome-");
const launch = async () => { const c = await chromium.launchPersistentContext(profile, browserOptions({ viewport: { width: 800, height: 950 } })); await publicMarketFixture(c); return c; };
let context = await launch();
const errors = [];
const check = (name) => console.log("PASS", name);
try {
  let worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  const id = worker.url().split("/")[2];
  await worker.evaluate(() => chrome.storage.local.set({ language: "zh-Hans" }));
  const options = await worker.evaluate(() => chrome.sidePanel.getOptions({}));
  assert.equal(options.path, "index.html"); check("Chrome MV3 loaded; toolbar side panel configured");
  if (process.env.PRL_QA_LIVE === "1") {
  const live = await worker.evaluate(async ({ address, testnet, xpub, vpub }) => {
    const targets = [["https://blockbook.pearlresearch.ai", address, xpub], ["https://blockbook.testnet.pearlresearch.ai", testnet, vpub]];
    const results = await Promise.all(targets.flatMap(([base, addr, key]) => [
      ["address", `/api/v2/address/${addr}?details=basic`], ["xpub", `/api/v2/xpub/${key}?details=basic`], ["utxo", `/api/v2/utxo/${key}`]
    ].map(async ([kind, path]) => {
      try {
        const response = await fetch(base + path, { signal: AbortSignal.timeout(12000), credentials: "omit" });
        const body = await response.json(); return { network: base.includes("testnet") ? "testnet" : "mainnet", kind, status: response.status, valid: kind === "utxo" ? Array.isArray(body) && body.every((u) => typeof u.value === "string") : typeof body.balance === "string" };
      } catch { return { network: base.includes("testnet") ? "testnet" : "mainnet", kind, status: "unavailable", valid: false }; }
    })));
    return results;
  }, { address: vectors.addresses[0], testnet: vectors.testnet.address, xpub: vectors.xpub, vpub: vectors.testnet.xpub });
  console.log("LIVE READ", JSON.stringify(live));
  }
  // All subsequent network traffic, including broadcast, is intercepted inside our
  // isolated extension worker. No real coins or signed transactions are broadcast.
  await worker.evaluate(({ address, change, to }) => {
    globalThis.fixture = { broadcasts: [], mode: "unknown", expected: "", confirmations: 0, fail: false };
    globalThis.fetch = async (url, init = {}) => {
      if (globalThis.fixture.fail) throw new Error("Fixture offline");
      const u = new URL(String(url)), p = u.pathname;
      if (!/^https:\/\/blockbook\.(?:testnet\.)?pearlresearch\.ai$/.test(u.origin)) throw new Error("Unexpected test host");
      const testnet = u.hostname.includes("testnet"), empty = { balance: "0", unconfirmedBalance: "0", page: 1, totalPages: 1, transactions: [], tokens: [] };
      const utxos = [
        { txid: "11".repeat(32), vout: 0, value: "100000000", address, confirmations: 10 },
        { txid: "22".repeat(32), vout: 1, value: "200000000", address, confirmations: 10 },
        { txid: "33".repeat(32), vout: 0, value: "50000000", address: change, confirmations: 10 },
      ];
      if (p.startsWith("/api/v2/sendtx")) {
        globalThis.fixture.broadcasts.push(init.body);
        if (globalThis.fixture.mode === "unknown") throw new Error("Fixture response lost");
        return Response.json({ result: globalThis.fixture.expected });
      }
      if (p.startsWith("/api/v2/tx/")) return Response.json({ txid: globalThis.fixture.expected, confirmations: globalThis.fixture.confirmations });
      if (p.startsWith("/api/v1/estimatefee/")) return Response.json({ result: "0.0005" });
      if (p.startsWith("/api/v2/utxo/")) {
        const { address: _address, ...changeUTXO } = utxos[2];
        return Response.json(testnet ? [] : p.endsWith(change) ? [changeUTXO] : p.includes("/zpub") ? utxos : []);
      }
      if (p.startsWith("/api/v2/xpub/") || p.startsWith("/api/v2/address/")) return Response.json(testnet ? empty : { ...empty, balance: "350000000", tokens: [{ name: address }], transactions: [{ txid: "44".repeat(32), blockTime: 1700000000, confirmations: 10, vin: [{ addresses: [to], value: "100000000" }], vout: [{ addresses: [address], value: "100000000" }] }] });
      throw new Error("Unexpected fixture endpoint");
    };
  }, { address: vectors.addresses[0], change: "prl1puwagcza86exfh3cx6ur08wq7njc32e66ep0zje7le6c7cak8lqeq655gqa", to: vectors.cases[0].to });
  const page = await context.newPage(); page.on("pageerror", (error) => errors.push(error.message));
  const rpc = (command, data = {}) => page.evaluate(({ command, data }) => chrome.runtime.sendMessage({ command, ...data }), { command, data });
  await page.goto(`chrome-extension://${id}/index.html`);
  await page.getByRole("button", { name: "恢复已有钱包" }).waitFor();
  await page.screenshot({ path: output + "/welcome.png", fullPage: true });
  await page.getByRole("button", { name: "恢复已有钱包" }).click();
  await page.getByLabel("助记词", { exact: true }).fill(vectors.mnemonic);
  await page.getByLabel("设置解锁密码", { exact: true }).fill("public-test-password");
  await page.getByLabel("再次输入密码", { exact: true }).fill("public-test-password");
  await page.getByRole("button", { name: "保存钱包", exact: true }).click();
  await page.locator(".balance").filter({ hasText: "3.50" }).waitFor();
  assert.equal(await page.locator(".address-card code").innerText(), vectors.addresses[0]);
  const persisted = await worker.evaluate(() => chrome.storage.local.get(null));
  assert.equal(JSON.stringify(persisted).includes("abandon"), false);
  const denied = await rpc("backup", { password: "wrong-password" }); assert.equal(denied.ok, false);
  check("restore native wallet; aggregate/deduplicate internal change; encrypted persistence; reauthentication");
  await page.screenshot({ path: output + "/wallet-desktop.png", fullPage: true });
  for (const width of [320, 360, 420, 800]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    if (width === 360) await page.screenshot({ path: output + "/wallet-sidepanel.png", fullPage: true });
  }
  check("320/360/420/800 layouts have no horizontal overflow");
  await worker.evaluate(() => { fixture.fail = true; });
  await page.getByRole("button", { name: "刷新 ↻", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "操作失败。" }).waitFor();
  assert.match(await page.locator(".balance").innerText(), /3\.50/);
  await worker.evaluate(() => { fixture.fail = false; });
  check("failed refresh preserves the previous balance and displays an error");
  await page.getByRole("button", { name: "↓ 收款" }).click();
  assert.equal(await page.locator(".receive code").innerText(), vectors.addresses[0]);
  await page.getByRole("button", { name: "换一个收款地址" }).click();
  await page.locator(".receive code").filter({ hasText: vectors.addresses[1] }).waitFor();
  assert.ok((await page.locator(".qr").getAttribute("src")).startsWith("data:image/"));
  await page.getByRole("button", { name: "关闭", exact: true }).click(); check("receive QR and native-compatible address rotation");
  await page.getByRole("button", { name: "交易记录", exact: true }).click();
  assert.equal(await page.locator(".transaction").count(), 1); check("transaction history");
  await page.getByRole("button", { name: "↑ 转账" }).click();
  await page.getByLabel("收款地址", { exact: true }).fill(vectors.cases[0].to);
  await page.getByLabel("转账金额", { exact: true }).fill("1");
  await page.getByRole("button", { name: "预览转账" }).click();
  await page.getByRole("button", { name: "确认并发送" }).waitFor();
  await page.screenshot({ path: output + "/send-preview.png", fullPage: true });
  await page.getByLabel("再次输入密码确认", { exact: true }).fill("wrong-password");
  await page.getByRole("button", { name: "确认并发送" }).click();
  await page.getByRole("status").filter({ hasText: "密码错误" }).waitFor();
  assert.equal(await worker.evaluate(() => fixture.broadcasts.length), 0);
  await page.getByLabel("再次输入密码确认", { exact: true }).fill("public-test-password");
  await page.getByRole("button", { name: "确认并发送" }).click();
  await page.getByRole("button", { name: "重试原交易" }).waitFor();
  const sent = (await rpc("status")).data.pending[0];
  assert.equal(sent.status, "unknown");
  const broadcastHex = await worker.evaluate(() => fixture.broadcasts[0]);
  await worker.evaluate((txid) => { fixture.mode = "submitted"; fixture.expected = txid; }, sent.txid);
  const reattempt = await rpc("prepare", { to: vectors.cases[0].to, amount: "1", fee: 50000 });
  assert.equal(reattempt.ok, false); assert.match(reattempt.error, /不足/);
  check("local signing; password gates sending; ambiguous broadcast reserves inputs");
  await page.getByRole("button", { name: "重试原交易" }).click();
  await page.getByLabel("解锁密码", { exact: true }).fill("public-test-password");
  await page.getByRole("button", { name: "重试原交易", exact: true }).last().click();
  await page.locator(".pending span").filter({ hasText: "已广播" }).waitFor();
  assert.equal(await worker.evaluate(() => fixture.broadcasts[1]), broadcastHex);
  await worker.evaluate(() => { fixture.confirmations = 1; });
  await page.getByRole("button", { name: "刷新 ↻", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector(".pending")); check("retry exact transaction; refresh automatically reconciles confirmation");
  await page.getByRole("button", { name: "钱包", exact: true }).click();
  await page.getByRole("button", { name: "＋ 创建钱包" }).click();
  await page.waitForFunction(() => document.querySelectorAll(".words>div").length === 12);
  const words = await page.locator(".words>div").evaluateAll((nodes) => nodes.map((n) => n.childNodes[n.childNodes.length - 1].textContent));
  await page.getByRole("button", { name: "我已保存，核对备份" }).click();
  for (const index of [2, 6, 10]) await page.getByLabel(`第 ${index + 1} 个单词`).fill(words[index]);
  await page.getByLabel("当前解锁密码", { exact: true }).fill("public-test-password");
  await page.getByRole("button", { name: "保存钱包", exact: true }).click();
  await page.locator('#wallet-switcher').click();
  await page.waitForFunction(() => document.querySelectorAll('.wallet-choice').length === 2);
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  check("create second wallet with verified mnemonic backup");
  await page.locator('#wallet-settings').click();
  await page.getByLabel("钱包网络").selectOption("testnet");
  await page.locator(".address-card code").filter({ hasText: "tprl1" }).waitFor(); check("testnet switch");
  await page.getByRole("button", { name: "钱包设置" }).click();
  await page.getByLabel("钱包名称", { exact: true }).fill("备用钱包");
  await page.getByRole("button", { name: "保存名称" }).click();
  await page.getByLabel("当前解锁密码", { exact: true }).fill("public-test-password");
  await page.getByLabel("新密码", { exact: true }).fill("changed-public-password");
  await page.getByLabel("再次输入新密码", { exact: true }).fill("changed-public-password");
  await page.getByRole("button", { name: "更新密码" }).click();
  await page.getByRole("status").filter({ hasText: "密码已更新" }).waitFor();
  assert.equal((await rpc("backup", { password: "public-test-password" })).ok, false);
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "备份助记词" }).click();
  await page.getByLabel("解锁密码", { exact: true }).fill("changed-public-password");
  await page.getByRole("button", { name: "查看助记词" }).click();
  await page.locator(".words>div").last().waitFor();
  const second = await context.newPage(); await second.goto(`chrome-extension://${id}/index.html`);
  await second.getByRole("button", { name: "锁定钱包" }).waitFor();
  await second.getByRole("button", { name: "锁定钱包" }).click();
  await page.getByRole("button", { name: "解锁钱包", exact: true }).waitFor();
  assert.equal(await page.locator(".words>div").count(), 0); await second.close();
  check("rename/password change; wrong old password refused; lock clears mnemonic in every window");
  await page.getByLabel("解锁密码", { exact: true }).fill("changed-public-password");
  await page.getByRole("button", { name: "解锁钱包", exact: true }).click();
  await page.getByRole("button", { name: "钱包设置" }).click();
  await page.locator("summary").filter({ hasText: "移除当前钱包" }).click();
  await page.locator('details input[name="name"]').fill("备用钱包");
  await page.locator('details input[name="password"]').fill("changed-public-password");
  await page.getByRole("button", { name: "移除钱包", exact: true }).click();
  await page.locator('#wallet-switcher').click();
  await page.waitForFunction(() => document.querySelectorAll('.wallet-choice').length === 1);
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  check("remove one wallet after password/name verification; other wallet retained");
  await page.getByRole("button", { name: "锁定钱包" }).click();
  await page.getByRole("button", { name: "解锁钱包", exact: true }).waitFor();
  assert.equal(await worker.evaluate(async () => Object.keys(await chrome.storage.session.get(null)).length), 0);
  await page.getByLabel("解锁密码", { exact: true }).fill("changed-public-password");
  await page.getByRole("button", { name: "解锁钱包", exact: true }).click();
  await page.getByRole("button", { name: "锁定钱包" }).waitFor();
  await worker.evaluate(async () => { const s = (await chrome.storage.session.get("wallet.session"))["wallet.session"]; await chrome.storage.session.set({ "wallet.session": { ...s, active: Date.now() - 6 * 60000 } }); });
  await page.reload(); await page.getByRole("button", { name: "解锁钱包", exact: true }).waitFor(); check("manual and inactivity locks clear session secrets");
  const manifest = JSON.parse(await readFile("dist/manifest.json", "utf8"));
  assert.equal(manifest.content_scripts, undefined); assert.equal(manifest.externally_connectable, undefined);
  assert.equal(manifest.host_permissions.length, 3); assert.equal(manifest.permissions.includes("tabs"), false);
  assert.equal(errors.length, 0, errors.join("\n"));
  check("no content scripts/external signing interface; narrow permissions; no page errors");
  await context.close(); context = await launch();
  const afterRestart = await context.newPage();
  await afterRestart.goto(`chrome-extension://${id}/index.html`);
  await afterRestart.getByRole("button", { name: "解锁钱包", exact: true }).waitFor(); check("browser restart keeps encrypted vault and starts locked");
} finally { await context.close(); await rm(profile, { recursive: true, force: true }); }
