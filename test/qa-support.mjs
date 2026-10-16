import { chromium } from "playwright";
import { readFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";

export function browserOptions(options = {}) {
  const channel = process.env.PRL_QA_BROWSER || "chromium";
  return {
    channel, headless: process.env.PRL_QA_HEADED !== "1", locale: "zh-CN",
    args: [`--disable-extensions-except=${resolve("dist")}`, `--load-extension=${resolve("dist")}`],
    ...(process.env.PRL_QA_EXECUTABLE ? { executablePath: process.env.PRL_QA_EXECUTABLE } : {}),
    ...options,
  };
}
export async function publicMarketFixture(context) {
  const market = { mode: "both", requests: [] };
  // Intercept page requests before any wallet page loads. Worker chain requests
  // are separately stubbed, since Playwright routing cannot intercept all SW fetches.
  await context.route(/^https?:\/\//, async (route) => {
    const request = route.request(), url = request.url();
    if (/^https:\/\/pearlhub.net\/v1\/(price|fx)$/.test(url)) {
      market.requests.push({ url, method: request.method(), body: request.postData(), headers: request.headers() });
      const price = url.endsWith("price");
      await route.fulfill({ status: market.mode === "off" || !price && market.mode === "usd" ? 503 : 200, contentType: "application/json", body: JSON.stringify(price
        ? { usd: 0.8, ts: Date.now() / 1000 }
        : { ok: true, ts: Date.now() / 1000, base: "USD", rates: { CNY: 7.1, TWD: 31.23, RUB: 92, VND: 25000, IDR: 15500, HKD: 7.8, EUR: 0.9, JPY: 149, KRW: 1340, GBP: 0.76, SGD: 1.3, AUD: 1.5, CAD: 1.35 } }) });
    } else {
      // Deep-link navigation is verified without loading the real web app.
      await route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>Isolated QA destination</title><p>Fixture only</p>" });
    }
  });
  return market;
}
// Branded browsers (Edge) start service workers of their own built-in extensions too,
// and one of those may come first: pick the wallet's by what it is, not by position.
async function extensionWorker(context) {
  const ours = (w) => w.url().endsWith("/background.js") &&
    w.evaluate(() => globalThis.chrome?.runtime?.getManifest?.().side_panel?.default_path === "index.html").catch(() => false);
  for (const deadline = Date.now() + 30000; ;) {
    for (const w of context.serviceWorkers()) if (await ours(w)) return w;
    if (Date.now() > deadline) throw new Error("The wallet's service worker did not start");
    await context.waitForEvent("serviceworker", { timeout: 2000 }).catch(() => {});
  }
}
export async function fixtureWallet({ output = "out/features", viewport = { width: 390, height: 900 }, language = "zh-Hans" } = {}) {
  const vectors = JSON.parse(await readFile(new URL("./native-vectors.json", import.meta.url), "utf8"));
  await mkdir(output, { recursive: true });
  const profile = await mkdtemp(resolve(output) + "/browser-");
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, browserOptions({ viewport }));
    const market = await publicMarketFixture(context);
    const worker = await extensionWorker(context);
    const manifest = await worker.evaluate(() => chrome.runtime.getManifest());
    const version = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")).version;
    if (manifest.version !== version) throw new Error(`Build extension ${version} before browser QA`);
    const panel = await worker.evaluate(() => chrome.sidePanel.getOptions({}));
    if (panel.path !== "index.html") throw new Error("Wallet side panel is not configured");
    await worker.evaluate(({ address, testnet, to, language }) => {
      globalThis.fixture = { broadcasts: [], amount: "2500000000", offline: false };
      globalThis.fetch = async (url, init = {}) => {
        const u = new URL(String(url)), p = u.pathname;
        if (!/^https:\/\/blockbook\.(?:testnet\.)?pearlresearch\.ai$/.test(u.origin)) throw new Error("Unexpected fixture host");
        if (fixture.offline) throw new Error("Fixture offline");
        if (p.includes("/sendtx/")) { fixture.broadcasts.push(init.body); throw new Error("Fixture broadcast response lost"); }
        if (p.includes("/estimatefee/")) return Response.json({ result: "0.0005" });
        if (p.includes("/tx/")) return Response.json({ error: "Transaction not found" }, { status: 404 });
        const own = u.hostname.includes("testnet") ? testnet : address, key = u.hostname.includes("testnet") ? "/vpub" : "/zpub";
        if (p.includes("/utxo/")) return Response.json(p.includes(key) ? [{ txid: "11".repeat(32), vout: 0, value: fixture.amount, address: own, confirmations: 10 }] : []);
        if (!p.includes("/xpub/") && !p.includes("/address/")) throw new Error("Unexpected fixture endpoint");
        return Response.json({ balance: fixture.amount, transactions: p.includes("/xpub/") ? [
          { txid: "44".repeat(32), blockTime: 1700000000, confirmations: 10, vin: [{ addresses: [to], value: "100000000" }], vout: [{ addresses: [own], value: "100000000" }] },
          { txid: "55".repeat(32), blockTime: 1699999000, confirmations: 11, vin: [{ addresses: [own], value: "2500000000" }], vout: [{ addresses: [own], value: "2399999000" }, { addresses: [to], value: "100000000" }] },
          { txid: "66".repeat(32), blockTime: 1699998000, confirmations: 12, vin: [{ addresses: [own], value: "100000000" }], vout: [{ addresses: [own], value: "99999000" }] },
        ] : [], page: 1, totalPages: 1 });
      };
      return chrome.storage.local.set({ language });
    }, { address: vectors.addresses[0], testnet: vectors.testnet.address, to: vectors.cases[0].to, language });
    const page = await context.newPage(), errors = [];
    context.on("page", (p) => p.on("pageerror", (e) => errors.push(e.message)));
    page.on("pageerror", (e) => errors.push(e.message));
    const url = `chrome-extension://${worker.url().split("/")[2]}/index.html`;
    const rpc = (command, data = {}) => page.evaluate(({ command, data }) => chrome.runtime.sendMessage({ command, ...data }), { command, data });
    await page.goto(url);
    const created = await rpc("create", { mnemonic: vectors.mnemonic, password: "public-test-password", name: "QA Wallet" });
    if (!created.ok) throw new Error(created.error);
    await page.reload(); await page.locator(".balance").filter({ hasText: "25.00" }).waitFor(); await page.locator(".market-line").waitFor();
    return { context, worker, page, rpc, market, vectors, errors, url, manifest,
      close: async () => { await context.close(); await rm(profile, { recursive: true, force: true }); } };
  } catch (error) { await context?.close(); await rm(profile, { recursive: true, force: true }); throw error; }
}

// An isolated PKCE account server. It replaces the identity popup with a callback
// for this extension; no email, real account or external request is involved.
export async function accountFixture(worker, contacts = []) {
  await worker.evaluate(({ contacts }) => {
    const chainFetch = globalThis.fetch;
    globalThis.accountFixture = { rev: 0, data: null, calls: [], revoked: false, unavailable: false, authCalls: 0, pro: true };
    chrome.identity.launchWebAuthFlow = async ({ url }) => {
      const auth = new URL(url);
      if (auth.origin !== "https://pearlhub.net" || auth.searchParams.get("platform") !== "extension" || !auth.searchParams.get("code_challenge")) throw new Error("Invalid fixture authorization");
      accountFixture.authCalls++;
      return auth.searchParams.get("redirect_uri") + "?code=" + "C".repeat(43) + "&state=" + auth.searchParams.get("state");
    };
    globalThis.fetch = async (url, init = {}) => {
      const u = new URL(String(url)), path = u.pathname;
      if (u.origin !== "https://pearlhub.net") return chainFetch(url, init);
      if (init.credentials !== "omit" || init.redirect !== "error") throw new Error("Unsafe account fixture request");
      if (path === "/v1/auth/exchange") return Response.json({ user_id: "u_qa", device_id: "qa-device", access_token: "A".repeat(43), refresh_token: "B".repeat(43), expires_in: 900 });
      if (path === "/v1/auth/refresh") return Response.json({ error: "refresh_revoked" }, { status: 401 });
      if (path === "/v1/auth/logout") return Response.json({ ok: true });
      if (init.headers?.Authorization !== "Bearer " + "A".repeat(43) || init.headers?.["X-Account-ID"] !== "u_qa") throw new Error("Invalid account fixture credentials");
      if (accountFixture.revoked) return Response.json({ error: "unauthorized" }, { status: 401 });
      if (path === "/v1/account") return Response.json({ email: "qa@example.invalid", pro: accountFixture.pro });
      if (path !== "/v1/account/config") throw new Error("Unexpected account fixture endpoint");
      accountFixture.calls.push({ method: init.method, body: init.body });
      if (accountFixture.unavailable) return Response.json({ error: "account_failed" }, { status: 503 });
      if (init.method === "GET") return Response.json({ schema_version: 1, rev: accountFixture.rev, data: accountFixture.data });
      const body = JSON.parse(init.body);
      if (body.schema_version !== 1 || body.rev !== accountFixture.rev) return new Response(null, { status: 409 });
      accountFixture.data = body.data; accountFixture.rev++;
      return Response.json({ rev: accountFixture.rev });
    };
    // Contacts from the web/app are public config; no wallet secrets are present.
    if (contacts.length) accountFixture.data = { contacts };
  }, { contacts });
}
export async function fits(page, label) {
  const dimensions = await page.evaluate(() => ({ width: innerWidth, page: document.documentElement.scrollWidth, dialog: [...document.querySelectorAll("dialog[open]")].every((d) => d.scrollWidth <= d.clientWidth) }));
  if (dimensions.page > dimensions.width || !dimensions.dialog) throw new Error(`${label}: horizontal overflow ${JSON.stringify(dimensions)}`);
}
