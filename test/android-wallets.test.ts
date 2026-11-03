// The Android build's 管理钱包 and 恢复钱包, as the iOS app's (WalletStore.removeWallet / commitWallet): any wallet
// can be removed without opening it first, and a phrase that is already here opens that wallet instead of failing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createVault, bytes64 } from "../src/vault.ts";
import type { VaultData } from "../src/wallet.ts";
const vectors = JSON.parse(readFileSync(new URL("./native-vectors.json", import.meta.url), "utf8"));
const password = "public-test-password", OTHER = "legal winner thank year wave sausage worth useful legal winner thank yellow";
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
  window: {},
  chrome: { storage: { local, session }, runtime: { id: "test", getURL: (p: string) => `chrome-extension://test/${p}`, sendMessage: async () => {}, onMessage: { addListener(fn: typeof listener) { listener = fn; } }, onInstalled: { addListener() {} }, onStartup: { addListener() {} } }, sidePanel: { setPanelBehavior: async () => {} }, alarms: { get: async () => true, create: async () => {}, onAlarm: { addListener() {} } } },
});
await import("../src/background.ts");
const rpc = (command: string, fields: Record<string, unknown> = {}) => new Promise<any>((resolve) => listener({ command, ...fields }, { id: "test", url: "chrome-extension://test/index.html" }, resolve));
async function vault(data: VaultData) {
  await rpc("lock");
  const sealed = await createVault(data, password);
  await local.set({ "pearl.wallet.v1": sealed.envelope });
  await session.set({ "wallet.session": { key: bytes64.encode(sealed.key), active: Date.now() } });
}
const three = (): VaultData => ({ network: "mainnet", selected: "a", pending: [], wallets: [
  { id: "a", name: "A", mnemonic: vectors.mnemonic, receiveIndex: 0 },
  { id: "b", name: "B", mnemonic: OTHER, receiveIndex: 0 },
  { id: "w", name: "Watched", mnemonic: "", receiveIndex: 0, watch: vectors.addresses[1] },
] });

test("Android: 管理钱包 removes a wallet that isn't open, keeping the open one; it still needs the device secret and the right name", async () => {
  await vault(three());
  assert.equal((await rpc("delete", { id: "b", name: "B", password: "wrong" })).ok, false);
  assert.equal((await rpc("delete", { id: "b", name: "A", password })).ok, false);
  const removed = await rpc("delete", { id: "b", name: "B", password });
  assert.equal(removed.ok, true, removed.error);
  assert.equal(removed.data.selected, "a");
  assert.deepEqual(removed.data.wallets.map((w: { id: string }) => w.id), ["a", "w"]);
  // The open one: the first that's left opens, as before.
  const open = await rpc("delete", { id: "a", name: "A", password });
  assert.equal(open.ok, true, open.error);
  assert.equal(open.data.selected, "w");
  assert.equal((await rpc("delete", { id: "missing", name: "x", password })).ok, false);
});

test("Android: restoring a phrase that is already here opens that wallet and names it", async () => {
  await vault(three());
  const again = await rpc("create", { name: "Pearl Wallet 3", mnemonic: ` ${OTHER.toUpperCase().split(" ").join("\n")} `, password });
  assert.equal(again.ok, true, again.error);
  assert.equal(again.data.existing, "B");
  assert.equal(again.data.selected, "b");
  assert.equal(again.data.wallets.length, 3);
  // The device secret is still checked first.
  assert.equal((await rpc("create", { name: "x", mnemonic: OTHER, password: "wrong" })).ok, false);
});
