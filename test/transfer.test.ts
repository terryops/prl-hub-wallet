import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as btc from "@scure/btc-signer";
import { hex } from "@scure/base";
import { xpub, derived, outpoint, maxAmount, type Network, type VaultData, type UTXO } from "../src/wallet.ts";
import { createVault, bytes64 } from "../src/vault.ts";

const vectors = JSON.parse(readFileSync(new URL("./native-vectors.json", import.meta.url), "utf8"));
const password = "public-transfer-test-password";
const area = () => {
  const rows: Record<string, unknown> = {};
  return {
    async get(keys?: string | string[] | null) { return structuredClone(keys == null ? rows : Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(k => [k, rows[k]]))); },
    async set(values: Record<string, unknown>) { Object.assign(rows, structuredClone(values)); },
    async remove(keys: string | string[]) { for (const key of Array.isArray(keys) ? keys : [keys]) delete rows[key]; },
    async clear() { for (const key of Object.keys(rows)) delete rows[key]; },
    async setAccessLevel() {},
  };
};
const local = area(), session = area();
let listener: (message: unknown, sender: unknown, reply: (data: any) => void) => boolean;
const sender = { id: "transfer-test", url: "chrome-extension://transfer-test/index.html" };
Object.assign(globalThis, { chrome: {
  storage: { local, session }, runtime: { id: sender.id, getURL: (path: string) => `chrome-extension://${sender.id}/${path}`, sendMessage: async () => {}, onMessage: { addListener(fn: typeof listener) { listener = fn; } }, onInstalled: { addListener() {} }, onStartup: { addListener() {} } },
  sidePanel: { setPanelBehavior: async () => {} }, alarms: { get: async () => true, create: async () => {}, onAlarm: { addListener() {} } },
} });
await import("../src/background.ts");
const rpc = (command: string, fields: Record<string, unknown> = {}) => new Promise<any>(resolve => listener({ command, ...fields }, sender, resolve));

for (const network of ["mainnet", "testnet"] as Network[]) for (const scenario of ["normal", "fragmented", "dust", "dust-MAX", "pathless-change"]) {
  test(`${network} ${scenario}: receive, preview, password, send and confirmed reconciliation`, async () => {
    await rpc("lock"); await local.clear();
    const data: VaultData = { wallets: [{ id: "public-wallet", name: "Public sample", mnemonic: vectors.mnemonic, receiveIndex: 0 }], selected: "public-wallet", network, pending: [] };
    const sealed = await createVault(data, password);
    await local.set({ "pearl.wallet.v1": sealed.envelope });
    await session.set({ "wallet.session": { key: bytes64.encode(sealed.key), active: Date.now() } });
    const key = xpub(vectors.mnemonic, network), address = derived(key, network).address!, change = derived(key, network, 1, 70).address!;
    const coin = (i: number, value: string, confirmations = 6, owned = address): UTXO => ({ txid: i.toString(16).padStart(64, "0"), vout: 0, value, address: owned, confirmations });
    const inputs = scenario === "fragmented" ? Array.from({ length: 1001 }, (_, i) => coin(i + 1, "100000"))
      : scenario.startsWith("dust") ? [coin(1, "10006000"), coin(2, "330")]
      : scenario === "pathless-change" ? [coin(1, "100000000", 6, change)] : [coin(1, "100000000"), coin(2, "200000000", 0)];
    const original = fetch, bodies: string[] = [];
    let mode = "submitted", confirmations = 0, signedId = "";
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input)), path = url.pathname;
      assert.equal(url.hostname, network === "mainnet" ? "blockbook.pearlresearch.ai" : "blockbook.testnet.pearlresearch.ai");
      if (path.includes("/sendtx/")) {
        assert.equal(init?.method, "POST"); const body = String(init?.body); bodies.push(body);
        signedId = btc.Transaction.fromRaw(hex.decode(body)).id;
        if (mode === "unknown") throw new Error("Mock lost reply");
        if (mode === "rejected") return Response.json({ error: "min relay fee not met" }, { status: 400 });
        return Response.json({ result: signedId });
      }
      if (path.includes("/tx/")) return Response.json({ txid: signedId, confirmations });
      if (path.includes("/utxo/")) return Response.json(path.endsWith(key) ? inputs : []);
      assert.ok(path.includes("/xpub/") || path.includes("/address/"));
      return Response.json({ balance: "0", transactions: [], totalPages: 1 });
    };
    try {
      for (const bad of [{ ...sender, id: "external" }, { ...sender, url: "https://example.invalid/" }]) {
        assert.equal(listener({ command: "send" }, bad, () => assert.fail("untrusted sender got a reply")), false);
      }
      const refreshed = await rpc("refresh"); assert.equal(refreshed.ok, true, refreshed.error);
      assert.equal(refreshed.data.snapshot.balance, inputs.filter(u => u.confirmations).reduce((n, u) => n + BigInt(u.value), 0n).toString());
      assert.equal(refreshed.data.snapshot.pending, scenario === "normal" ? "200000000" : "0");
      const recovery = scenario === "pathless-change", maximum = scenario === "dust-MAX";
      const to = recovery ? address : derived(key, network, 0, 3).address!;
      const review = await rpc("prepare", { to, amount: scenario === "fragmented" || scenario.startsWith("dust") ? "0.1" : "0.5", fee: 50000, recovery, max: maximum });
      assert.equal(review.ok, true, review.error); assert.equal(review.data.to, to);
      if (recovery || maximum) assert.equal(review.data.amount, maxAmount(inputs, 50000).toString());
      if (scenario === "dust") { assert.equal(review.data.fee, "6000"); assert.equal(review.data.change, "0"); }
      const reservedInputs = ((await session.get("wallet.review"))["wallet.review"] as any).utxos as UTXO[];
      assert.ok(reservedInputs.length <= 1000);
      if (scenario.startsWith("dust")) assert.equal(reservedInputs.length, 1);
      assert.equal((await rpc("send", { id: review.data.id, password: "wrong-public-password" })).ok, false); assert.equal(bodies.length, 0);
      const sent = await rpc("send", { id: review.data.id, password });
      assert.equal(sent.ok, true, sent.error); assert.equal(sent.data.outcome, "submitted"); assert.equal(sent.data.sent, signedId);
      const tx = btc.Transaction.fromRaw(hex.decode(bodies[0]));
      assert.equal(tx.getOutput(0).amount!.toString(), review.data.amount);
      assert.equal(reservedInputs.reduce((n, u) => n + BigInt(u.value), 0n), BigInt(review.data.amount) + BigInt(review.data.fee) + BigInt(review.data.change));
      assert.equal((await rpc("send", { id: review.data.id, password })).ok, false); assert.equal(bodies.length, 1);
      const second = await rpc("prepare", { to, amount: "0.1", fee: 50000, recovery });
      if (second.ok) {
        const next = ((await session.get("wallet.review"))["wallet.review"] as any).utxos as UTXO[];
        assert.ok(next.every(u => !reservedInputs.some(old => outpoint(old) === outpoint(u))));
      }
      if (scenario === "normal") {
        assert.equal(second.ok, false, "an unconfirmed receipt cannot fund a second spend");
        for (const outcome of ["unknown", "rejected", "submitted"]) {
          mode = outcome;
          const retry = await rpc("retry", { txid: signedId, password });
          assert.equal(retry.data.pending[0].status, outcome);
        }
        assert.equal(new Set(bodies).size, 1, "retries must preserve exact signed bytes");
        for (let i = 1; i <= 10; i++) assert.equal((await rpc("receive")).data.wallets[0].address, derived(key, network, 0, i % 10).address);
      }
      confirmations = 6;
      const confirmed = await rpc("refresh"); assert.equal(confirmed.ok, true, confirmed.error); assert.equal(confirmed.data.pending.length, 0);
      const posts = bodies.length; await rpc("lock");
      assert.equal((await rpc("send", { id: review.data.id, password })).ok, false); assert.equal(bodies.length, posts);
    } finally { globalThis.fetch = original; sealed.key.fill(0); }
  });
}
