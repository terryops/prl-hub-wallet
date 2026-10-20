// B1–B6 integration checks. All external HTTP and worker broadcasts use fixtures.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { fixtureWallet, fits, accountFixture } from "./qa-support.mjs";
const q = await fixtureWallet();
const { page, context, worker, rpc, market, vectors, errors } = q;
const button = (name) => page.getByRole("button", { name, exact: true });
const closeDialog = () => button("关闭").click();
try {
  await page.locator(".fiat").filter({ hasText: "≈ $20.00 · ¥142.00" }).waitFor();
  assert.equal(await page.locator('main select,#language,#secondary').count(), 0);
  await page.locator('#wallet-settings').click();
  assert.equal(await page.locator("#secondary option").count(), 19);
  await page.locator("#secondary").selectOption(""); await page.locator(".fiat").filter({ hasText: /^≈ \$20.00$/ }).waitFor();
  const other = await context.newPage(); await other.goto(q.url); await other.locator('#wallet-settings').click(); await other.locator("#secondary").filter({ has: other.locator('option[value=""]:checked') }).waitFor();
  await page.locator("#secondary").selectOption("__auto__"); await other.waitForFunction(() => document.querySelector("#secondary").value === "__auto__"); await other.close();
  await closeDialog();
  market.mode = "usd"; await page.reload(); await page.locator(".fiat").filter({ hasText: /^≈ \$20.00$/ }).waitFor();
  market.mode = "off"; await page.reload(); await page.locator(".balance").waitFor();
  // Wait until both requests resolve before asserting the absent row.
  await page.waitForFunction(() => document.querySelector(".balance")?.textContent.includes("25.00"));
  assert.equal(await page.locator(".market-line").count(), 0);
  await button("↓ 收款").click(); await page.locator(".qr").waitFor(); await closeDialog();
  market.mode = "both";
  await page.locator('#wallet-settings').click(); await page.getByLabel("钱包网络").selectOption("testnet"); await page.locator(".address-card code").filter({ hasText: "tprl1" }).waitFor();
  assert.equal(await page.locator(".market-line").count(), 0); assert.equal(await page.locator(".donate-entry,.web-links").count(), 0);
  const requestsBefore = market.requests.length; await page.waitForTimeout(200); assert.equal(market.requests.length, requestsBefore);
  await page.locator('#wallet-settings').click(); await page.getByLabel("钱包网络").selectOption("mainnet"); await page.locator(".fiat").waitFor();
  console.log("PASS B1 market, USD fallback, missing price, local/cross-window preferences, mainnet only");

  await button("地址簿").click(); await button("添加").click();
  await page.getByLabel("名称", { exact: true }).fill("QA Friend"); await page.getByLabel("地址", { exact: true }).fill(vectors.cases[0].to); await page.getByLabel("备注（可选）").fill("Public test contact"); await button("保存").click();
  await page.locator(".contact strong").filter({ hasText: "QA Friend" }).waitFor();
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await button("复制地址").click(); assert.equal(await page.evaluate(() => navigator.clipboard.readText()), vectors.cases[0].to);
  await page.locator(".contact summary").click(); await button("编辑联系人").click(); await page.getByLabel("名称", { exact: true }).fill("QA Exchange"); await button("保存").click();
  await page.locator(".contact strong").filter({ hasText: "QA Exchange" }).waitFor();
  await button("↑ 转账").click(); await page.getByLabel("地址簿", { exact: true }).selectOption(vectors.cases[0].to);
  assert.equal(await page.getByLabel("收款地址", { exact: true }).inputValue(), vectors.cases[0].to);
  await page.getByLabel("转账金额", { exact: true }).fill("1"); await button("预览转账").click(); await button("确认并发送").waitFor();
  await page.locator("dialog .payee").filter({ hasText: "QA Exchange" }).waitFor(); await closeDialog();
  await button("↑ 转账").click(); await page.getByLabel("收款地址", { exact: true }).fill(vectors.addresses[1]); await page.getByLabel("转账金额", { exact: true }).fill("2");
  await button("保存到地址簿").click(); await page.getByLabel("名称", { exact: true }).fill("Second contact"); await button("保存").click();
  await button("预览转账").waitFor(); assert.equal(await page.getByLabel("收款地址", { exact: true }).inputValue(), vectors.addresses[1]); assert.equal(await page.getByLabel("转账金额", { exact: true }).inputValue(), "2"); await closeDialog();
  console.log("PASS B2 contact add/edit/copy, send picker, preview name, save recipient without losing draft");

  await button("交易记录").click(); assert.equal(await page.locator(".transaction").count(), 3); assert.equal(await page.locator(".peer").count(), 2);
  for (const peer of await page.locator(".peer code").evaluateAll((codes) => codes.map((c) => c.title))) assert.equal(peer, vectors.cases[0].to);
  assert.equal(await page.locator(".peer strong").count(), 2);
  await page.locator(".peer-copy").first().click(); assert.equal(await page.evaluate(() => navigator.clipboard.readText()), vectors.cases[0].to);
  console.log("PASS B3 receipt source, largest outgoing external address, hidden self-send, copy and contact names");

  await button("支持开发者").click(); await button("5 PRL").click(); await button("确认捐赠").waitFor();
  const receipt = page.locator("dialog .donation-address"); assert.equal(await receipt.locator("span").count(), 2);
  assert.equal((await receipt.locator("span").allTextContents()).join(""), "prl1pmkyxyht58rzhe7cj9ha7ncpm6r28x6g0htq93ffs5hsh7lqsxj7qw9pyjv");
  assert.equal(await page.locator("dialog .fiat,dialog .market-line").count(), 0);
  assert.match(await page.locator("dialog dl").innerText(), /手续费/); assert.match(await page.locator("dialog dl").innerText(), /合计支出/);
  await page.getByLabel("再次输入密码确认", { exact: true }).fill("wrong-password"); await button("确认捐赠").click(); await page.getByRole("status").filter({ hasText: "密码错误" }).waitFor(); assert.equal(await worker.evaluate(() => fixture.broadcasts.length), 0);
  for (const theme of ["light", "dark"]) for (const width of [320, 360, 390, 1280]) { await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" }); await page.setViewportSize({ width, height: 900 }); await fits(page, `donation ${theme} ${width}`); }
  await closeDialog(); await button("支持开发者").click(); await page.getByLabel("自定义金额").fill("0.9"); await button("捐赠").click(); await page.getByRole("status").filter({ hasText: "最少 1 PRL" }).waitFor(); await closeDialog();
  // Complete the existing signing path against a worker fetch stub only.
  await button("支持开发者").click(); await button("10 PRL").click(); await button("确认捐赠").waitFor(); await page.getByLabel("再次输入密码确认", { exact: true }).fill("public-test-password"); await button("确认捐赠").click();
  await page.locator(".pending").waitFor(); assert.equal(await worker.evaluate(() => fixture.broadcasts.length), 2, "one post to each mainnet indexer");
  console.log("PASS B4 fixed two-line address, fee/total, no fiat, minimum and password/signing fixture path");

  for (const kind of ["workers", "wallet"]) {
    const link = page.locator(`.web-links a[href*="#${kind}?"]`), expected = `https://pearlhub.net/#${kind}?addr=${vectors.addresses[0]}`;
    assert.equal(await link.getAttribute("href"), expected);
    const opened = context.waitForEvent("page"); await link.click(); const popup = await opened; await popup.waitForURL(expected); assert.equal(new URL(popup.url()).search, ""); await popup.close();
  }
  console.log("PASS B5 new tabs with fragment-only mainnet prefill (destination uses fixture, no save)");
  await button("地址簿").click(); await page.locator(".contact").filter({ hasText: "Second contact" }).locator("summary").click(); await page.locator(".contact").filter({ hasText: "Second contact" }).getByRole("button", { name: "删除联系人" }).click(); await page.waitForFunction(() => document.querySelectorAll(".contact").length === 1);
  for (const theme of ["light", "dark"]) for (const width of [320, 360, 390, 1280]) {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" }); await page.setViewportSize({ width, height: 900 });
    for (const tab of ["钱包", "交易记录", "地址簿"]) { await button(tab).click(); await fits(page, `${tab} ${theme} ${width}`); }
    if (width === 390) await page.screenshot({ path: `out/features/wallet-${theme}-390.png`, fullPage: true });
  }
  await accountFixture(worker, [{ id: "remote-contact", name: "Remote contact", address: vectors.addresses[1], note: "Public remote sample", updated: 10 }]);
  await button("钱包设置").click();
  page.once("dialog", (d) => d.accept());
  await button("邮箱登录").click(); await button("退出登录").waitFor();
  await page.waitForFunction(() => document.querySelector(".account-actions button")?.disabled === false);
  const sync = await worker.evaluate(() => accountFixture);
  assert.equal(sync.authCalls, 1); assert.equal(sync.calls.length, 2); assert.equal(sync.rev, 1);
  assert.equal(sync.data.contacts.filter((c) => !c.deleted).length, 2);
  assert.ok(sync.data.contacts.some((c) => c.name === "QA Exchange"));
  assert.ok(sync.data.contacts.some((c) => c.name === "Remote contact"));
  assert.ok(!JSON.stringify(sync.calls).includes(vectors.mnemonic));
  assert.ok(!JSON.stringify(sync.calls).includes("access_token"));
  assert.ok(!JSON.stringify(sync.calls).includes("refresh_token"));
  assert.equal((await rpc("contact-link")).data.email, "qa@example.invalid");
  assert.ok((await rpc("contact-link")).data.lastSync);
  for (const theme of ["light", "dark"]) for (const width of [320, 360, 390, 1280]) {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" }); await page.setViewportSize({ width, height: 700 }); await fits(page, `account ${theme} ${width}`);
    assert.equal(await page.locator(".account-links a").count(), 2);
    if (width === 390) await page.screenshot({ path: `out/features/account-${theme}-390.png` });
  }
  const accountWindow = await context.newPage(); await accountWindow.goto(q.url); await accountWindow.locator(".balance").waitFor();
  await accountWindow.getByRole("button", { name: "钱包设置", exact: true }).click();
  await accountWindow.getByRole("button", { name: "退出登录", exact: true }).waitFor();
  await accountWindow.getByRole("button", { name: "退出登录", exact: true }).click();
  await button("邮箱登录").waitFor(); await accountWindow.getByRole("button", { name: "邮箱登录", exact: true }).waitFor();
  assert.equal((await rpc("contact-link")).data.connected, false);
  let stored = await worker.evaluate(() => chrome.storage.local.get(["wallet.contacts", "wallet.contactSync", "pearl.account.v1"]));
  assert.equal(stored["wallet.contacts"].length, 1); assert.equal(stored["wallet.contactSync"], undefined); assert.equal(stored["pearl.account.v1"], undefined);
  // Returning to this account restores its cache even when guest import is declined.
  page.once("dialog", (d) => d.dismiss()); await button("邮箱登录").click();
  await button("退出登录").waitFor(); await accountWindow.getByRole("button", { name: "退出登录", exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector(".account-actions button")?.disabled === false);
  stored = await worker.evaluate(() => chrome.storage.local.get("wallet.contacts"));
  assert.equal(stored["wallet.contacts"].length, 2);
  await worker.evaluate(() => { accountFixture.revoked = true; }); await button("立即同步").click();
  await button("邮箱登录").waitFor(); await accountWindow.getByRole("button", { name: "邮箱登录", exact: true }).waitFor();
  await page.getByRole("status").filter({ hasText: "登录已过期" }).waitFor();
  assert.equal((await rpc("contact-link")).data.connected, false);
  // A failed initial sync must not hide a successfully established email session.
  await worker.evaluate(() => { accountFixture.revoked = false; accountFixture.unavailable = true; });
  page.once("dialog", (d) => d.accept()); await button("邮箱登录").click();
  await button("退出登录").waitFor(); await page.getByRole("status").filter({ hasText: "操作未完成" }).waitFor();
  assert.equal((await rpc("contact-link")).data.connected, true);

  await button("退出登录").click(); await button("邮箱登录").waitFor();
  await worker.evaluate(() => { accountFixture.pro = false; accountFixture.unavailable = false; accountFixture.calls = []; });
  const localBefore = await worker.evaluate(() => chrome.storage.local.get("wallet.contacts"));
  page.once("dialog", (d) => d.dismiss()); await button("邮箱登录").click();
  await button("退出登录").waitFor();
  await page.waitForFunction(() => document.querySelector(".account-actions button")?.disabled === true);
  await page.getByText("数据同步是 Pro 专属权益。免费账号的数据仅保存在本机，不会同步到云端或其他设备。", { exact: true }).waitFor();
  const free = (await rpc("contact-link")).data;
  assert.equal(free.connected, true); assert.equal(free.pro, false); assert.equal(free.lastSync, undefined);
  assert.deepEqual(await worker.evaluate(() => accountFixture.calls), [], "free sign-in never reads or uploads cloud contacts");
  assert.equal((await worker.evaluate(() => chrome.storage.local.get("wallet.contacts")))["wallet.contacts"].length, 2, "free login preserves its existing local account cache");
  assert.ok(localBefore["wallet.contacts"].length > 0);
  await fits(page, "free account sync gate");
  await page.screenshot({ path: "out/features/account-free-390.png" });
  await worker.evaluate(() => { accountFixture.pro = true; });
  const upgraded = await rpc("contact-sync"); assert.equal(upgraded.ok, true); assert.equal(upgraded.data.pro, true);
  await page.waitForFunction(() => document.querySelector(".account-actions button")?.disabled === false);
  const callsBefore = await worker.evaluate(() => accountFixture.calls.length);
  const contactsBefore = await worker.evaluate(() => chrome.storage.local.get("wallet.contacts"));
  await worker.evaluate(() => { accountFixture.pro = false; });
  const revoked = await rpc("contact-sync"); assert.equal(revoked.ok, true); assert.equal(revoked.data.pro, false);
  await page.waitForFunction(() => document.querySelector(".account-actions button")?.disabled === true);
  assert.equal(await worker.evaluate(() => accountFixture.calls.length), callsBefore, "revoked Pro never requests cloud contacts");
  assert.deepEqual(await worker.evaluate(() => chrome.storage.local.get("wallet.contacts")), contactsBefore);
  await button("退出登录").click(); await button("邮箱登录").waitFor(); await accountWindow.close(); await closeDialog();

  console.log("PASS email PKCE connect, public-contact sync, guest/cache isolation, cross-window login/logout, revoked-session recovery and failed initial sync");
  for (const request of market.requests) { assert.match(request.url, /^https:\/\/pearlhub.net\/v1\/(price|fx)$/); assert.equal(request.method, "GET"); assert.equal(request.body, null); assert.equal(request.headers.authorization, undefined); assert.equal(request.headers.cookie, undefined); }
  assert.deepEqual(errors, []);
  const result = { browser: process.env.PRL_QA_BROWSER || "chromium", browserVersion: context.browser()?.version(), extension: q.manifest.version, result: "passed", fixturesOnly: true, realBroadcasts: 0, checkedAt: new Date().toISOString(), checks: ["B1", "B2", "B3", "B4", "B5", "email account sync and lifecycle", "320/360/390/1280 light/dark"], edgeSidePanel: "manual toolbar click still required; see store/README.md" };
  await writeFile(`out/features/${result.browser}-result.json`, JSON.stringify(result, null, 2) + "\n");
  console.log("PASS B6", result.browser, "MV3 wallet, new features, responsive layouts and no page errors");
} finally { await q.close(); }
