// Local-only browser regressions. Every Blockbook request, including broadcast,
// is intercepted in an isolated extension worker; no live service is contacted.
import { chromium } from "playwright";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { browserOptions, publicMarketFixture, fits } from "./qa-support.mjs";
const vectors = JSON.parse(await readFile(new URL("./native-vectors.json", import.meta.url), "utf8"));
const profile = await mkdtemp(join(tmpdir(), "prl-review-ui-"));
let context;
try {
  context = await chromium.launchPersistentContext(profile, browserOptions());
  await publicMarketFixture(context);
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  const id = worker.url().split("/")[2];
  await worker.evaluate(({ address }) => {
    globalThis.fixture = { hold: false, release: () => {}, broadcasts: 0, feeResult: "0.0005" };
    globalThis.fetch = async (url) => {
      if (fixture.hold) await new Promise((resolve) => { fixture.release = () => { fixture.hold = false; resolve(); }; });
      const path = new URL(String(url)).pathname;
      if (path.includes("/sendtx/")) { fixture.broadcasts++; return Response.json({ error: "min relay fee not met" }, { status: 400 }); }
      if (path.includes("/utxo/")) return Response.json(path.includes("/zpub") ? [{ txid: "aa".repeat(32), vout: 0, value: "100000000", address, confirmations: 2 }] : []);
      if (path.includes("/tx/")) return Response.json({ error: "Transaction not found" }, { status: 404 });
      if (path.includes("/estimatefee/")) return Response.json({ result: fixture.feeResult });
      return Response.json({ balance: "0", transactions: [] });
    };
    return chrome.storage.local.set({ language: "zh-Hans" });
  }, { address: vectors.addresses[0] });
  const page = await context.newPage(), errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`chrome-extension://${id}/index.html`);
  const rpc = (command, data = {}) => page.evaluate(({ command, data }) => chrome.runtime.sendMessage({ command, ...data }), { command, data });
  assert.equal((await rpc("create", { mnemonic: vectors.mnemonic, password: "public-test-password", name: "A" })).ok, true);
  await worker.evaluate(() => { fixture.hold = true; });
  await page.reload();
  await page.getByRole("button", { name: "更新中…", exact: true }).waitFor();
  const create = page.getByRole("button", { name: "＋ 创建钱包", exact: true });
  assert.equal(await create.isDisabled(), true);
  // Simulate a click arriving before React has rendered the disabled attribute.
  await create.evaluate((button) => { button.disabled = false; button.click(); });
  assert.equal(await page.locator("dialog[open]").count(), 0);
  await worker.evaluate(() => fixture.release());
  await page.getByRole("button", { name: "刷新 ↻", exact: true }).waitFor();
  await create.click();
  await page.waitForFunction(() => document.querySelectorAll(".words>div").length === 12 && [...document.querySelectorAll(".words>div")].every((el) => el.textContent.trim().length > 2));
  assert.equal(await page.locator(".words>div").count(), 12);
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  console.log("PASS create during automatic refresh stays closed; next create has 12 words");
  // The fee field remains editable while a slow node estimate is in flight.
  await worker.evaluate(() => {
    const original = globalThis.fetch;
    globalThis.fetch = async (...args) => {
      if (new URL(String(args[0])).pathname.includes("/estimatefee/") && fixture.holdFee) {
        fixture.feeStarted = true;
        await new Promise((resolve) => { fixture.releaseFee = () => { fixture.holdFee = false; resolve(); }; });
      }
      return original(...args);
    };
    fixture.holdFee = true;
  });
  const button = (name) => page.getByRole("button", { name, exact: true });
  await button("↑ 转账").click();
  await worker.evaluate(async () => {
    const deadline = Date.now() + 5000;
    while (!fixture.feeStarted) { if (Date.now() > deadline) throw new Error("Fee request did not start"); await new Promise((r) => setTimeout(r, 10)); }
  });
  await page.getByLabel("手续费率", { exact: true }).fill("12345");
  await worker.evaluate(() => fixture.releaseFee());
  await page.waitForFunction(() => document.querySelector("dialog .primary")?.disabled === false);
  assert.equal(await page.getByLabel("手续费率", { exact: true }).inputValue(), "12345");
  await page.getByText("已使用手动填写的手续费率。", { exact: true }).waitFor();
  await button("关闭").click();
  await button("↑ 转账").click();
  await page.getByText("已读取链上建议值，可手动调整。", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("手续费率", { exact: true }).inputValue(), "50000");
  await button("关闭").click();
  console.log("PASS delayed estimates preserve manual fees; a new draft resets the fee source");
  for (const result of ["-1", null]) {
    await worker.evaluate(result => { fixture.feeResult = result; }, result);
    await button("↑ 转账").click();
    await page.getByText("当前为默认值，请核对手续费。", { exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector("dialog .primary")?.disabled === false);
    assert.equal(await page.getByLabel("手续费率", { exact: true }).inputValue(), "50000");
    assert.equal(await page.getByText("已读取链上建议值，可手动调整。", { exact: true }).count(), 0);
    await button("关闭").click();
  }
  await worker.evaluate(() => { fixture.feeResult = "0.0005"; });
  console.log("PASS invalid fee responses display the default value instead of claiming a network estimate");
  for (const theme of ["light", "dark"]) for (const width of [320, 360, 390, 1280]) {
    await page.emulateMedia({ colorScheme: theme }); await page.setViewportSize({ width, height: 700 });
    for (const tab of ["钱包", "交易记录", "地址簿"]) {
      await button(tab).click(); await page.evaluate(() => scrollTo(0, 0)); await fits(page, `${tab} ${theme} ${width}`);
      const nav = await page.locator("nav").boundingBox(), balance = await page.locator(".balance-card").boundingBox();
      assert.ok(nav.y + nav.height <= 360 && nav.y + nav.height <= balance.y, "navigation precedes the balance and is visible without scrolling");
      assert.equal(await page.locator('nav button[aria-pressed="true"]').count(), 1);
      assert.equal(await page.locator('nav button[aria-pressed="true"]').innerText(), tab);
    }
  }
  await button("钱包").click(); await page.emulateMedia({ colorScheme: "light" }); await page.setViewportSize({ width: 390, height: 700 });
  console.log("PASS visible navigation and selected state across tabs, widths and themes");
  const review = await rpc("prepare", { to: vectors.cases[0].to, amount: "0.1", fee: 20000 });
  assert.equal(review.ok, true, review.error);
  assert.equal((await rpc("send", { id: review.data.id, password: "public-test-password" })).data.outcome, "rejected");
  await page.reload();
  await page.getByText("节点拒绝了此交易", { exact: true }).waitFor();
  await page.getByRole("button", { name: "移除待确认记录", exact: true }).click();
  assert.match(await page.locator("dialog").innerText(), /不会撤销链上交易/);
  const checkbox = await page.locator('dialog input[type="checkbox"]').boundingBox(), acknowledgement = await page.locator(".checkbox-row span").boundingBox();
  assert.ok(checkbox.width <= 20 && acknowledgement.x >= checkbox.x + checkbox.width, "checkbox sits next to its risk label");
  await page.locator('dialog input[type="password"]').fill("public-test-password");
  await page.locator('dialog input[type="checkbox"]').check();
  await page.locator("dialog").getByRole("button", { name: "移除待确认记录", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector("dialog[open]") && !document.querySelector(".pending"));
  assert.equal((await rpc("status")).data.pending.length, 0);
  assert.equal(await worker.evaluate(() => fixture.broadcasts), 1);
  await button("↑ 转账").click(); await page.getByLabel("收款地址", { exact: true }).fill(vectors.cases[0].to);
  await page.getByLabel("转账金额", { exact: true }).fill("0.1"); await button("预览转账").click(); await button("确认并发送").waitFor();
  await page.getByLabel("再次输入密码确认", { exact: true }).fill("public-test-password"); await button("确认并发送").click();
  await page.getByRole("status").filter({ hasText: "节点拒绝了此交易" }).waitFor();
  assert.doesNotMatch(await page.getByRole("status").innerText(), /广播结果待核对/);
  assert.equal((await rpc("status")).data.pending[0].status, "rejected");
  assert.equal(await worker.evaluate(() => fixture.broadcasts), 2);
  console.log("PASS rejected broadcast has a distinct user-facing result and retains its pending record");
  assert.deepEqual(errors, []);
  console.log("PASS rejected transaction can be discarded with warning, password and acknowledgement");
  console.log("browser tests: 6 passed, 0 failed");
} finally { await context?.close(); await rm(profile, { recursive: true, force: true }); }
