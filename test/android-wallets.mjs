// The Android app's wallet (dist-android, vite.android.config.ts) in Chromium at a phone's width, without the emulator:
// served at https://pearlhub.net/wallet/ as the shell does (BRIDGE.md in prl-hub-android), with a stand-in for the
// shell's window.PearlAndroid and the app page's window.__pearlApp, and every chain, price and NOCK request answered
// here. It walks adding and managing wallets as in the iOS app (WalletSwitcher.swift, Onboarding.swift) in Chinese and
// English and saves a screenshot of each step.
//   npm run build:android && node test/android-wallets.mjs [screenshot directory]
// QA_LANGS=all (or a comma-separated list) for other languages, QA_WIDTH for another phone width (default 360).
import { chromium } from "playwright";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { extname, resolve } from "node:path";

const root = new URL("../", import.meta.url).pathname;
const dist = `${root}dist-android/`;
if (!existsSync(`${dist}android.html`)) throw new Error("Build the Android wallet first: npm run build:android");
const out = resolve(process.argv[2] || `${root}out/android-wallets`);
mkdirSync(out, { recursive: true });
const vectors = JSON.parse(readFileSync(new URL("./native-vectors.json", import.meta.url), "utf8"));
const copy = JSON.parse(readFileSync(new URL("../src/android/copy.json", import.meta.url), "utf8"));
const i18n = (lang) => JSON.parse(readFileSync(new URL(`../src/i18n/${lang}.json`, import.meta.url), "utf8"));
// The policy the shell sends with the wallet page (web/scripts/build-android.mjs in prl-hub-web).
const csp = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data:; connect-src 'self' https://blockbook.pearlresearch.ai https://blockbook.testnet.pearlresearch.ai https://rpc.nockbox.org https://api.coingecko.com https://nockscan.com; frame-ancestors 'self'; object-src 'none'; base-uri 'none'; form-action 'none'";
const WIDTH = Number(process.env.QA_WIDTH) || 360;
const LANGS = process.env.QA_LANGS === "all" ? Object.keys(copy) : process.env.QA_LANGS ? process.env.QA_LANGS.split(",") : ["zh-Hans", "en"];
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".wasm": "application/wasm" };

// The shell (BRIDGE.md) and the app page (shared/android-host.ts), recording what the wallet asks of them.
function stand(lang) {
  window.__qa = { calls: [], clipboard: "", secure: false };
  const listeners = [];
  window.PearlAndroid = {
    postMessage(raw) {
      const { id, method, params } = JSON.parse(raw);
      window.__qa.calls.push({ method, params });
      const handlers = {
        info: () => ({ flavor: "play", versionName: "2.0", versionCode: 3, sdkInt: 35, deviceSecure: true, launches: 1, firstLaunch: Math.floor(Date.now() / 1000) }),
        "wallet.secret": () => { let s = localStorage.getItem("qa.secret"); if (!s) { if (!params.create) throw "no_secret"; s = "qa-" + "s".repeat(40); localStorage.setItem("qa.secret", s); } return { secret: s }; },
        "wallet.clear": () => { localStorage.removeItem("qa.secret"); return {}; },
        "clipboard.read": () => ({ text: window.__qa.clipboard }),
        "clipboard.clear": () => ({ cleared: true }),
        "ui.secure": () => { window.__qa.secure = params.on; return {}; },
      };
      let reply;
      try { reply = { id, ok: true, result: (handlers[method] || (() => ({})))() }; } catch (error) { reply = { id, ok: false, error: String(error) }; }
      setTimeout(() => listeners.forEach((l) => l({ data: JSON.stringify(reply) })), 5);
    },
    addEventListener(type, listener) { if (type === "message") listeners.push(listener); },
  };
  let contacts = [];
  window.__pearlApp = {
    prefs: () => ({ lang, secondary: "", theme: "light", palette: "classic" }),
    contacts: () => contacts, setContacts: (next) => { contacts = next; },
    subscribe: () => () => {}, openPage() {}, visible: () => true, widgetPlaced: () => true, open() {},
  };
}

const empty = { balance: "0", unconfirmedBalance: "0", txs: 0, transactions: [], page: 1, totalPages: 1, tokens: [] };
async function run(lang) {
  const t = i18n(lang), w = copy[lang], fill = (s, ...v) => s.replace(/\{(\d)\}/g, (_, i) => String(v[Number(i)]));
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: WIDTH, height: 780 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: lang === "en" ? "en-US" : "zh-CN" });
  await context.addInitScript(stand, lang);
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === "https://pearlhub.net" && url.pathname.startsWith("/wallet/")) {
      const name = url.pathname.slice("/wallet/".length) || "android.html";
      const file = name === "icon.png" ? `${root}public/icon.png` : `${dist}${name}`;
      if (!name.includes("..") && existsSync(file)) return route.fulfill({ status: 200, body: readFileSync(file), headers: { "content-type": types[extname(file)] || "application/octet-stream", ...(name.endsWith(".html") ? { "content-security-policy": csp } : {}) } });
    }
    if (url.origin === "https://pearlhub.net" && url.pathname === "/v1/price") return route.fulfill({ json: { usd: 0.8, ts: Date.now() / 1000 } });
    if (url.origin === "https://pearlhub.net" && url.pathname === "/v1/fx") return route.fulfill({ json: { ok: true, ts: Date.now() / 1000, base: "USD", rates: { CNY: 7.1 } } });
    // Our own index and the official one: empty wallets (no NOCK node either).
    const path = url.origin === "https://pearlhub.net" && url.pathname.startsWith("/node/") ? url.pathname.slice(5) : /blockbook/.test(url.hostname) ? url.pathname : "";
    if (path.includes("/utxo/")) return route.fulfill({ json: [] });
    if (path.includes("/estimatefee/")) return route.fulfill({ json: { result: "0.0005" } });
    if (path.startsWith("/api/")) return route.fulfill({ json: empty });
    return route.fulfill({ status: 404, body: "" });
  });
  const page = await context.newPage(), errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|status of 404/.test(m.text())) errors.push(m.text()); });
  const shot = async (name) => {
    await page.waitForTimeout(200);
    const width = await page.evaluate(() => ({ page: document.documentElement.scrollWidth, dialogs: [...document.querySelectorAll("dialog[open]")].every((d) => d.scrollWidth <= d.clientWidth) }));
    assert.ok(width.page <= WIDTH && width.dialogs, `${lang} ${name}: nothing wider than ${WIDTH} px ${JSON.stringify(width)}`);
    await page.screenshot({ path: `${out}/${lang}-${name}.png` });
  };
  const calls = (method) => page.evaluate((m) => window.__qa.calls.filter((c) => c.method === m).map((c) => c.params), method);
  const secure = () => page.evaluate(() => window.__qa.secure);
  const sheet = page.locator("dialog:not(.wallet-alert)"), alert = page.locator("dialog.wallet-alert");
  const title = () => sheet.locator(".dialog-title h2").innerText();
  const button = (name, scope = page) => scope.getByRole("button", { name, exact: true });
  const back = () => page.evaluate(() => window.__pearlBack());
  const ok = (label) => console.log(`✓ ${lang}: ${label}`);
  try {
    await page.goto("https://pearlhub.net/wallet/");
    // Welcome (iOS WelcomeView).
    await page.locator(".welcome-hero").waitFor();
    for (const name of [w.createNew, t["用助记词恢复钱包"], t["添加只读钱包"]]) await button(name).waitFor();
    assert.equal(await page.getByText(w.welcomeNote).count(), 1);
    await shot("01-welcome"); ok("welcome: hero, 创建新钱包, 用助记词恢复钱包, 添加只读钱包 + ⓘ, the one line");

    // 创建钱包, step 1: the name, and no phrase yet.
    await button(w.createNew).click();
    await sheet.locator(".create-flow").waitFor();
    assert.equal(await title(), w.createWallet);
    assert.equal(await sheet.getByText(fill(w.stepOf, 1)).count(), 1);
    assert.equal(await sheet.getByLabel(w.walletName).inputValue(), "Pearl Wallet");
    assert.equal(await sheet.locator(".seed-grid").count(), 0);
    assert.equal(await button(w.stepBack, sheet).count(), 0);
    assert.equal(await secure(), false);
    await shot("02-create-name"); ok("创建钱包 opens on the name step: Pearl Wallet, 步骤 1 / 3, no phrase, no FLAG_SECURE");

    // Step 2: 生成助记词 makes the phrase; it shows under FLAG_SECURE, with no copy button.
    await button(w.generatePhrase, sheet).click();
    await sheet.locator(".seed-grid").waitFor();
    const first = await sheet.locator(".seed-word").allInnerTexts();
    assert.equal(first.length, 12);
    assert.equal(await sheet.getByText(fill(w.stepOf, 2)).count(), 1);
    assert.equal(await secure(), true);
    assert.equal(await sheet.locator(".seed-warning").count(), 1);
    assert.equal(await sheet.getByRole("button", { name: /复制|Copy/ }).count(), 0);
    await shot("03-create-phrase"); ok("生成助记词: 12 words, 步骤 2 / 3, FLAG_SECURE on, one warning, no copy");

    // 上一步 drops it; the system back does the same; each 生成助记词 makes a new phrase.
    await button(w.stepBack, sheet).click();
    await sheet.getByText(fill(w.stepOf, 1)).waitFor();
    assert.equal(await sheet.locator(".seed-grid").count(), 0);
    await page.waitForFunction(() => window.__qa.secure === false);
    await button(w.generatePhrase, sheet).click();
    await sheet.locator(".seed-grid").waitFor();
    const second = await sheet.locator(".seed-word").allInnerTexts();
    assert.notDeepEqual(second, first);
    assert.equal(await back(), true);
    await sheet.getByText(fill(w.stepOf, 1)).waitFor();
    await button(w.generatePhrase, sheet).click();
    await sheet.locator(".seed-grid").waitFor();
    const words = await sheet.locator(".seed-word").allInnerTexts();
    ok("上一步 and the system back return to the name step and drop the phrase; a new one each time");

    // Step 3: three words, three choices each (iOS VerifyStep); a wrong one is refused before anything is saved.
    await button(w.backedUp, sheet).click();
    await sheet.getByText(fill(w.stepOf, 3)).waitFor();
    const groups = sheet.locator(".quiz-card");
    assert.equal(await groups.count(), 3);
    const confirm = button(w.confirmCreate, sheet);
    assert.equal(await confirm.isDisabled(), true);
    await shot("04-create-verify");
    const positions = [];
    for (let n = 0; n < 3; n++) {
      const group = groups.nth(n), position = Number((await group.locator("p").innerText()).match(/\d+/)[0]) - 1;
      positions.push(position);
      assert.ok((await group.locator("button").count()) <= 3);
      const options = await group.locator("button").allInnerTexts();
      await group.getByRole("button", { name: n === 0 ? options.find((o) => o !== words[position]) : words[position], exact: true }).click();
    }
    await confirm.click();
    await sheet.getByText(w.chooseWrong).waitFor();
    assert.equal((await calls("wallet.secret")).length, 0);
    await shot("05-create-wrong"); ok("验证助记词: 3 × 3 choices, 确认并创建 waits for all, a wrong word is refused and nothing is saved");
    await groups.nth(0).getByRole("button", { name: words[positions[0]], exact: true }).click();
    await confirm.click();
    await page.locator(".balance-card").waitFor();
    assert.deepEqual((await calls("wallet.secret")).map((p) => p.create), [true]);
    await page.waitForFunction(() => window.__qa.secure === false);
    assert.equal(await page.locator(".manage-grid").count(), 0);
    await shot("06-wallet"); ok("确认并创建 saves after the device check; the wallet page has no 管理钱包 grid");

    // The switcher's menu.
    await page.locator("#wallet-switcher").click();
    const menu = page.locator(".switcher-menu");
    await menu.waitFor();
    assert.equal(await menu.getByRole("menuitemradio").count(), 1);
    assert.equal(await menu.getByRole("menuitemradio", { checked: true }).count(), 1);
    for (const name of [w.addWallet, w.manageWallets]) await menu.getByRole("menuitem", { name }).waitFor();
    await shot("07-switcher"); ok("switcher: the wallet (✓, short address), 添加钱包, 管理钱包");
    assert.equal(await back(), true); assert.equal(await menu.count(), 0);

    // 添加钱包 → 用助记词恢复钱包 (back returns to 添加钱包), with 粘贴 and the word count.
    await page.locator("#wallet-switcher").click();
    await menu.getByRole("menuitem", { name: w.addWallet }).click();
    await sheet.locator(".add-wallet").waitFor();
    assert.equal(await title(), w.addWallet);
    await shot("08-add"); ok("添加钱包: 创建新钱包, 用助记词恢复钱包, 添加只读钱包 + ⓘ");
    await button(t["用助记词恢复钱包"], sheet).click();
    assert.equal(await title(), w.restoreWallet);
    await sheet.locator(".dialog-back").click();
    assert.equal(await title(), w.addWallet);
    await button(t["用助记词恢复钱包"], sheet).click();
    assert.equal(await sheet.getByLabel(w.walletName).inputValue(), "Pearl Wallet 2");
    const restore = sheet.locator("form button.primary");
    assert.equal(await restore.isDisabled(), true);
    await page.evaluate((m) => { window.__qa.clipboard = m; }, vectors.mnemonic);
    await button(w.paste, sheet).click();
    await sheet.getByText(w.wordsEntered.replace("{count}", "12")).waitFor();
    assert.equal(await secure(), true);
    await shot("09-restore"); ok("恢复钱包: back to 添加钱包; Pearl Wallet 2; 粘贴; 已输入 12 个词; FLAG_SECURE");
    await restore.click();
    await page.waitForFunction(() => !document.querySelector("dialog:not(.wallet-alert)")?.open);
    assert.equal(await page.locator("#wallet-switcher").innerText(), "Pearl Wallet 2");
    assert.equal((await calls("clipboard.clear")).length, 1);
    ok("恢复钱包 saves, opens the wallet and clears the pasted phrase");

    // 管理钱包: rows, a tap switches and the page stays.
    await page.locator("#wallet-switcher").click();
    await menu.getByRole("menuitem", { name: w.manageWallets }).click();
    await sheet.locator(".manage-list").waitFor();
    assert.equal(await title(), w.manageWallets);
    const rows = sheet.locator(".manage-row");
    assert.equal(await rows.count(), 2);
    assert.equal(await rows.nth(1).getByRole("img", { name: w.currentWallet }).count(), 1);
    await shot("10-manage"); ok("管理钱包: a row per wallet, ✓ on the current one, + in the title");
    await rows.nth(0).locator(".manage-open").click();
    await rows.nth(0).getByRole("img", { name: w.currentWallet }).waitFor();
    assert.equal(await sheet.evaluate((d) => d.open), true);
    assert.equal(await page.locator("#wallet-switcher").innerText(), "Pearl Wallet");
    ok("a tap switches and 管理钱包 stays open");

    // + → 添加钱包 → 添加只读钱包: saved, back on 管理钱包.
    await sheet.getByRole("button", { name: w.addWallet, exact: true }).click();
    assert.equal(await title(), w.addWallet);
    await button(t["添加只读钱包"], sheet).click();
    assert.equal(await title(), t["只读钱包"]);
    await sheet.getByLabel(t["地址"], { exact: true }).fill(vectors.addresses[1]);
    await sheet.locator("form button.primary").click();
    await sheet.locator(".manage-list").waitFor();
    assert.equal(await title(), w.manageWallets);
    assert.equal(await rows.count(), 3);
    ok("+ → 添加只读钱包 returns to 管理钱包 with the new wallet");

    // ••• → 重命名 (an alert with the name).
    await rows.nth(0).locator(".manage-more").click();
    await sheet.locator(".row-menu").waitFor();
    await shot("11-manage-menu");
    await sheet.locator(".row-menu").getByRole("menuitem", { name: w.rename }).click();
    await alert.locator("input").waitFor();
    assert.equal(await alert.locator("h2").innerText(), w.renameWallet);
    assert.equal(await alert.locator("input").inputValue(), "Pearl Wallet");
    await alert.locator("input").fill("Savings");
    await shot("12-rename");
    await button(t["保存"], alert).click();
    await rows.nth(0).getByText("Savings").waitFor();
    assert.equal(await alert.evaluate((d) => d.open), false);
    ok("重命名: an in-app alert (no prompt()), the list follows");

    // 删除 the read-only wallet: no device check.
    const secrets = (await calls("wallet.secret")).length;
    await rows.nth(2).locator(".manage-open").click({ button: "right" });   // a long press opens the same menu
    await sheet.locator(".row-menu").getByRole("menuitem", { name: w.delete }).click();
    await alert.getByText(t["只从本机删除这个地址，不影响链上资产，之后可以再添加。"]).waitFor();
    assert.equal(await alert.locator("h2").innerText(), fill(w.removeAsk, `${t["只读钱包"]}`));
    await shot("13-remove-watch");
    await button(w.removeWallet, alert).click();
    await page.waitForFunction(() => document.querySelectorAll(".manage-row").length === 2);
    assert.equal((await calls("wallet.secret")).length, secrets);
    ok("删除 a read-only wallet: its own message, removed without a device check");

    // 删除 a wallet with a phrase that isn't open: 取消 keeps it; 移除钱包 asks the device first.
    await rows.nth(1).locator(".manage-more").click();
    await sheet.locator(".row-menu").getByRole("menuitem", { name: w.delete }).click();
    await alert.getByText(w.removeSeed).waitFor();
    assert.equal(await alert.locator("h2").innerText(), fill(w.removeAsk, "Pearl Wallet 2"));
    await shot("14-remove-seed");
    assert.equal(await back(), true);
    assert.equal(await alert.evaluate((d) => d.open), false); assert.equal(await rows.count(), 2);
    await rows.nth(1).locator(".manage-more").click();
    await sheet.locator(".row-menu").getByRole("menuitem", { name: w.delete }).click();
    await button(w.removeWallet, alert).click();
    await page.waitForFunction(() => document.querySelectorAll(".manage-row").length === 1);
    assert.equal((await calls("wallet.secret")).length, secrets + 1);
    assert.equal(await page.locator("#wallet-switcher").innerText(), "Savings");
    ok("删除 a wallet with a phrase: the phrase warning; back cancels; removed after the device check; the open one stays");
    assert.equal(await back(), true);
    assert.equal(await sheet.evaluate((d) => d.open), false);

    // 设置 → 钱包与安全 (window.__pearlWallet): 管理钱包 opens this page; 移除钱包 the alert.
    await page.evaluate(() => window.__pearlWallet.open("wallets"));
    await sheet.locator(".manage-list").waitFor();
    assert.equal(await page.evaluate(() => window.__pearlWallet.state().count), 1);
    await back();
    await page.evaluate(() => window.__pearlWallet.open("remove"));
    await alert.getByText(w.removeSeed).waitFor();
    assert.equal(await alert.locator("h2").innerText(), fill(w.removeAsk, "Savings"));
    await button(t["取消"], alert).click();
    ok("设置 → 管理钱包 opens 管理钱包; 设置 → 移除钱包 asks in the same alert");

    // Dark appearance, one look.
    await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
    await page.locator("#wallet-switcher").click();
    await menu.getByRole("menuitem", { name: w.addWallet }).click();
    await button(w.createNew, sheet).click();
    await shot("15-create-name-dark");
    assert.deepEqual(errors, []);
    ok("no page errors");
  } finally { await browser.close(); }
}
for (const lang of LANGS) await run(lang);
console.log(`Screenshots: ${out}`);
