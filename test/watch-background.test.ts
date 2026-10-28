// The background's read-only wallet commands (iOS commitWatchWallet / removeWallet / applyWebWallets,
// prl-hub c14f2e6 / 97097a7), through the same message route as the wallet page.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createVault, open, bytes64 } from "../src/vault.ts";
import type { VaultData } from "../src/wallet.ts";
const vectors = JSON.parse(readFileSync(new URL("./native-vectors.json", import.meta.url), "utf8"));
const [main0, main1, main2] = vectors.addresses as string[];
const password = "public-test-password";
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
Object.assign(globalThis, { chrome: { storage: { local, session }, runtime: { id: "test", getURL: (p: string) => `chrome-extension://test/${p}`, sendMessage: async () => {}, onMessage: { addListener(fn: typeof listener) { listener = fn; } }, onInstalled: { addListener() {} }, onStartup: { addListener() {} } }, sidePanel: { setPanelBehavior: async () => {} }, alarms: { get: async () => true, create: async () => {}, onAlarm: { addListener() {} } } } });
await import("../src/background.ts");
const rpc = (command: string, fields: Record<string, unknown> = {}) => new Promise<any>((resolve) => listener({ command, ...fields }, { id: "test", url: "chrome-extension://test/index.html" }, resolve));
async function reset(data?: VaultData) {
  await rpc("lock");
  await local.clear();
  if (!data) return;
  const sealed = await createVault(data, password);
  await local.set({ "pearl.wallet.v1": sealed.envelope });
  await session.set({ "wallet.session": { key: bytes64.encode(sealed.key), active: Date.now() } });
}
async function vaultData() {
  const s = (await session.get("wallet.session"))["wallet.session"] as { key: string };
  return open((await local.get("pearl.wallet.v1"))["pearl.wallet.v1"] as never, bytes64.decode(s.key));
}
const seedWallet = { id: "seed", name: "Seed", mnemonic: vectors.mnemonic, receiveIndex: 2 };

test("the first wallet can be read-only: a new vault with only an address in it", async () => {
  await reset();
  assert.equal((await rpc("watch-add", { name: "Pool", address: main1, password: "short" })).error, "解锁密码至少 10 个字符。");
  assert.equal((await rpc("watch-add", { name: "Pool", address: "tprl1nope", password })).error, "watch-address");
  const added = await rpc("watch-add", { name: " Pool ", address: main1.toUpperCase(), password });
  assert.ok(added.ok, added.error);
  assert.equal(added.data.exists, true); assert.equal(added.data.locked, false);
  assert.deepEqual(added.data.wallets, [{ id: added.data.selected, name: "Pool", index: 0, primaryAddress: main1, address: main1, watch: true }]);
  const stored = await vaultData();
  assert.deepEqual(stored.wallets.map((w) => [w.name, w.mnemonic, w.watch]), [["Pool", "", main1]]);
});

test("adding an address a wallet here already shows just switches to it", async () => {
  await reset({ wallets: [seedWallet, { id: "w", name: "Watched", mnemonic: "", receiveIndex: 0, watch: main1 }], selected: "w", network: "mainnet", pending: [] });
  const same = await rpc("watch-add", { name: "Again", address: main0 });
  assert.ok(same.ok); assert.equal(same.data.existing, "Seed"); assert.equal(same.data.selected, "seed");
  const watched = await rpc("watch-add", { name: "Again", address: main1 });
  assert.equal(watched.data.existing, "Watched"); assert.equal(watched.data.selected, "w");
  assert.equal((await vaultData()).wallets.length, 2);
  // Locked: no adding without unlocking first.
  await rpc("lock");
  assert.equal((await rpc("watch-add", { name: "X", address: main2 })).ok, false);
});

test("a read-only wallet signs, derives and reveals nothing", async () => {
  await reset({ wallets: [{ id: "w", name: "Watched", mnemonic: "", receiveIndex: 0, watch: main1 }, seedWallet], selected: "w", network: "mainnet", pending: [] });
  for (const command of ["backup", "receive", "prepare", "send", "fee", "retry", "discard", "nock-status", "nock-refresh", "nock-prepare"]) {
    assert.equal((await rpc(command, { password, to: main2, amount: "1", fee: 1000, id: "x", txid: "1".repeat(64) })).error, "只读钱包不能转账", command);
  }
  const status = await rpc("status");
  assert.equal(status.data.wallets[1].primaryAddress, main0);
  assert.equal(status.data.wallets[1].address, (await rpc("status")).data.wallets[1].address);
  // On the other network it reads nothing.
  await rpc("network", { network: "testnet" });
  assert.equal((await rpc("refresh")).error, "watch-network");
});

test("removing a read-only wallet needs no password; the last one removes the vault", async () => {
  await reset({ wallets: [seedWallet, { id: "w", name: "Watched", mnemonic: "", receiveIndex: 0, watch: main1 }], selected: "w", network: "mainnet", pending: [] });
  assert.equal((await rpc("watch-remove", { id: "seed" })).error, "钱包不存在。");
  const left = await rpc("watch-remove", { id: "w" });
  assert.ok(left.ok); assert.equal(left.data.selected, "seed"); assert.equal(left.data.wallets.length, 1);
  await reset({ wallets: [{ id: "w", name: "Watched", mnemonic: "", receiveIndex: 0, watch: main1 }], selected: "w", network: "mainnet", pending: [] });
  const none = await rpc("watch-remove", { id: "w" });
  assert.deepEqual(none.data, { exists: false, locked: true });
  assert.equal((await local.get("pearl.wallet.v1"))["pearl.wallet.v1"], undefined);
});

test("restoring the seed behind a read-only wallet replaces it", async () => {
  await reset({ wallets: [{ id: "w", name: "Watched", mnemonic: "", receiveIndex: 0, watch: main0 }], selected: "w", network: "mainnet", pending: [] });
  const restored = await rpc("create", { name: "Restored", mnemonic: vectors.mnemonic, password });
  assert.ok(restored.ok, restored.error);
  assert.deepEqual(restored.data.wallets.map((w: { name: string; watch?: boolean }) => [w.name, !!w.watch]), [["Restored", false]]);
});

test("the web 钱包 page's rows and changes", async () => {
  await reset({ wallets: [seedWallet, { id: "w", name: "Watched", mnemonic: "", receiveIndex: 0, watch: main1 }], selected: "w", network: "testnet", pending: [] });
  assert.deepEqual((await rpc("web-rows")).data, [{ addr: main0, label: "Seed", watch: false }, { addr: main1, label: "Watched", watch: true }]);
  const applied = await rpc("watch-apply", { changes: { added: [{ addr: main2, label: "From web" }], renamed: { [main1]: "Renamed", [main0]: "Not this" }, removed: [] } });
  assert.deepEqual(applied.data.wallets.map((w: { name: string }) => w.name), ["Seed", "Renamed", "From web"]);
  const unchanged = await rpc("watch-apply", { changes: { added: [{ addr: main2, label: "Twin" }], renamed: {}, removed: [main0] } });
  assert.equal(unchanged.data.wallets.length, 3);
  const removed = await rpc("watch-apply", { changes: { added: [], renamed: {}, removed: [main1, main2] } });
  assert.deepEqual(removed.data.wallets.map((w: { name: string }) => w.name), ["Seed"]);
  assert.equal(removed.data.selected, "seed");
});
