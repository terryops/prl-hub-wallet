// The Android build (vite.android.config.ts defines __PEARL_ANDROID__) on mainnet: reads go to our own index
// first, which is same-origin inside the app (https://pearlhub.net/node); a broadcast goes to both, to our own
// index with a plain fetch and to the official one through the shell's net.post (BRIDGE.md in prl-hub-android).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createVault, bytes64 } from "../src/vault.ts";
import type { VaultData } from "../src/wallet.ts";
import { rawTxid } from "../src/transactions.ts";
import { NODE_KEY } from "../src/chain.ts";
const vectors = JSON.parse(readFileSync(new URL("./native-vectors.json", import.meta.url), "utf8"));
const password = "public-test-password", OWN = "https://pearlhub.net/node", OFFICIAL = "https://blockbook.pearlresearch.ai";

// The shell's message channel: replies to net.post with the official node's answer.
type Call = { id: string; method: string; params: Record<string, string> };
const shellCalls: Call[] = [];
let official: (body: string) => { status: number; body: string } = () => ({ status: 503, body: "" });
let deliver: (event: { data: unknown }) => void = () => {};
const PearlAndroid = {
  postMessage(raw: string) {
    const call = JSON.parse(raw) as Call; shellCalls.push(call);
    const result = call.method === "net.post" ? official(call.params.body) : {};
    setTimeout(() => deliver({ data: JSON.stringify({ id: call.id, ok: true, result }) }), 0);
  },
  addEventListener(_type: string, listener: typeof deliver) { deliver = listener; },
};
const area = () => {
  let items: Record<string, unknown> = {};
  return {
    async get(keys?: string | string[] | null) { return structuredClone(keys == null ? items : Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter((k) => k in items).map((k) => [k, items[k]]))); },
    async set(next: Record<string, unknown>) { Object.assign(items, structuredClone(next)); },
    async remove(keys: string | string[]) { for (const k of Array.isArray(keys) ? keys : [keys]) delete items[k]; },
    async clear() { items = {}; }, async setAccessLevel() {},
  };
};
let listener: (message: unknown, sender: unknown, reply: (data: any) => void) => boolean;
const local = area(), session = area();
Object.assign(globalThis, {
  __PEARL_ANDROID__: true,
  window: { PearlAndroid },
  chrome: { storage: { local, session }, runtime: { id: "test", getURL: (p: string) => `chrome-extension://test/${p}`, sendMessage: async () => {}, onMessage: { addListener(fn: typeof listener) { listener = fn; } }, onInstalled: { addListener() {} }, onStartup: { addListener() {} } }, sidePanel: { setPanelBehavior: async () => {} }, alarms: { get: async () => true, create: async () => {}, onAlarm: { addListener() {} } } },
});
await import("../src/background.ts");
const rpc = (command: string, fields: Record<string, unknown> = {}) => new Promise<any>((resolve) => listener({ command, ...fields }, { id: "test", url: "chrome-extension://test/index.html" }, resolve));

test("Android: reads come from our own index with its key, and a send goes to both nodes", async () => {
  const data: VaultData = { network: "mainnet", selected: "a", wallets: [{ id: "a", name: "A", mnemonic: vectors.mnemonic, receiveIndex: 0 }], pending: [] };
  const sealed = await createVault(data, password);
  await local.set({ "pearl.wallet.v1": sealed.envelope });
  await session.set({ "wallet.session": { key: bytes64.encode(sealed.key), active: Date.now() } });
  const requests: { url: string; method: string; key: string | null; body?: string }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const u = new URL(String(url));
    requests.push({ url: u.href, method: init.method || "GET", key: new Headers(init.headers).get("x-pearl-hub-key"), body: init.body == null ? undefined : String(init.body) });
    // In the app the official indexer is only reachable through the shell; a direct POST there would fail.
    if (u.origin === OFFICIAL && init.method === "POST") throw new TypeError("CORS");
    const path = u.href.startsWith(OWN + "/") ? u.pathname.slice("/node".length) : u.pathname;
    if (path.includes("/sendtx/")) return Response.json({ result: rawTxid(String(init.body)) });
    if (path.includes("/estimatefee/")) return Response.json({ result: "0.00002" });
    if (path.includes("/feestats/") || path.includes("/block/")) return Response.json({ error: "not here" }, { status: 400 });
    if (path === "/api/v2/" || path === "/api/v2") return Response.json({ blockbook: { bestHeight: 130800 } });
    if (path.includes("/utxo/")) return Response.json(path.includes("/zpub") ? [{ txid: "aa".repeat(32), vout: 0, value: "100000000", address: vectors.addresses[0], confirmations: 3 }] : []);
    return Response.json({ balance: "100000000", unconfirmedBalance: "0", transactions: [], page: 1, totalPages: 1 });
  }) as typeof fetch;
  try {
    const refreshed = await rpc("refresh");
    assert.equal(refreshed.ok, true, refreshed.error);
    const reads = requests.filter((r) => r.method === "GET");
    assert.ok(reads.length > 0);
    assert.ok(reads.every((r) => r.url.startsWith(OWN + "/api/") && r.key === NODE_KEY), JSON.stringify(reads));
    assert.equal(refreshed.data.snapshot.indexer, OWN);

    let officialBody = "";
    official = (body) => { officialBody = body; return { status: 200, body: JSON.stringify({ result: rawTxid(body) }) }; };
    requests.length = 0;
    const review = await rpc("prepare", { to: vectors.cases[0].to, amount: "0.1", fee: 20000 });
    assert.equal(review.ok, true, review.error);
    const sent = await rpc("send", { id: review.data.id, password });
    assert.equal(sent.ok, true, sent.error); assert.equal(sent.data.outcome, "submitted");
    await new Promise((resolve) => setTimeout(resolve, 10));
    const posts = requests.filter((r) => r.method === "POST");
    assert.deepEqual(posts.map((r) => [r.url, r.key]), [[OWN + "/api/v2/sendtx/", NODE_KEY]]);
    const relayed = shellCalls.filter((c) => c.method === "net.post");
    assert.deepEqual(relayed.map((c) => [c.params.url, c.params.contentType]), [[OFFICIAL + "/api/v2/sendtx/", "text/plain"]]);
    // The same signed transaction to both, nothing else to the shell.
    assert.equal(officialBody, posts[0].body); assert.match(officialBody, /^[0-9a-f]+$/);
    assert.deepEqual([...new Set(shellCalls.map((c) => c.method))], ["net.post"]);
  } finally { globalThis.fetch = original; }
});
