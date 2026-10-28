// Read-only wallets (iOS prl-hub c14f2e6 / 97097a7): the web 钱包 page merge (shared/android-host.ts, a
// port of iOS WebSharedMerge.wallets and its WebReadOnlyWalletSyncTests), the vault-side helpers
// (src/watch.ts) and the one-address refresh (chain.ts loadWatch).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mergeWallets, walletRows, walletRowId, walletChangesEmpty, withoutSkipped, MAX_WEB_WALLETS } from "../shared/android-host.ts";
import { applyWebWallets, supersede, webRows, watchName } from "../src/watch.ts";
import { loadWatch, resetIndexers, OWN_MAINNET } from "../src/chain.ts";
import type { VaultData, Wallet } from "../src/wallet.ts";
const vectors = JSON.parse(readFileSync(new URL("./native-vectors.json", import.meta.url), "utf8"));

const a = "prl1" + "a".repeat(38), b = "prl1" + "b".repeat(38), c = "prl1" + "c".repeat(38);
type Web = Parameters<typeof mergeWallets>[1];
const live = (rows: Web) => rows.filter((r) => r.deleted !== true);
const entry = (rows: Web, addr: string) => live(rows).find((r) => r.addr === addr);
const seed = (addr: string, label: string) => ({ addr, label });
const watch = (addr: string, label: string) => ({ addr, label, watch: true });
const rows = (...w: { addr: string; label: string; watch?: boolean }[]) => walletRows(w);

test("row ids are iOS's: w- and 32 hex digits of the address's SHA-256; labels fit the web's 40", async () => {
  assert.match(await walletRowId(a), /^w-[0-9a-f]{32}$/);
  assert.equal(await walletRowId(a), await walletRowId(a));
  assert.notEqual(await walletRowId(a), await walletRowId(b));
  const [long] = await rows(seed(a, "名".repeat(39) + "😀"));
  assert.equal(long.label, "名".repeat(39));   // the emoji is two UTF-16 units: dropped whole
  assert.equal((await rows(seed(a, "  ")))[0].label, "Pearl Wallet");
  assert.deepEqual((await rows(seed(a, "A"), seed(a, "Twin"), seed("tprl1" + "a".repeat(38), "Testnet"))).map((r) => r.label), ["A"]);
});

test("an address added on the web arrives as a read-only wallet, once; taking it in adds no twin there", async () => {
  const web: Web = [{ id: "4b0c0f5e-0000-4000-8000-000000000001", updated: 5, addr: b, label: "Pool B" }];
  const first = mergeWallets(await rows(seed(a, "Main")), web, {}, 10);
  assert.deepEqual(first.native.added, [{ addr: b, label: "Pool B" }]);
  assert.deepEqual(first.native.renamed, {}); assert.deepEqual(first.native.removed, []);
  const next = mergeWallets(await rows(seed(a, "Main"), watch(b, "Pool B")), first.rows, first.base, 20);
  assert.ok(!next.changed && walletChangesEmpty(next.native));
  assert.equal(live(next.rows).length, 2);
});

test("another device's wallet comes in read-only", async () => {
  const mac = mergeWallets(await rows(seed(c, "Mac")), [], {}, 10);
  const phone = mergeWallets(await rows(seed(a, "Phone")), mac.rows, {}, 20);
  assert.deepEqual(phone.native.added, [{ addr: c, label: "Mac" }]);
  const after = mergeWallets(await rows(seed(a, "Phone"), watch(c, "Mac")), phone.rows, phone.base, 30);
  assert.ok(!after.changed && walletChangesEmpty(after.native) && live(after.rows).length === 2);
});

test("renames travel both ways and the web wins a tie", async () => {
  const id = "4b0c0f5e-0000-4000-8000-000000000002";
  const first = mergeWallets([], [{ id, updated: 5, addr: b, label: "B" }], {}, 10);
  const mine = mergeWallets(await rows(watch(b, "B here")), first.rows, first.base, 20);
  assert.ok(mine.changed); assert.equal(entry(mine.rows, b)?.label, "B here"); assert.ok(walletChangesEmpty(mine.native));
  assert.ok(entry(mine.rows, b)!.updated > 5);
  const remote = mine.rows.map((r) => ({ ...r, label: "B web", updated: 99 }));
  const theirs = mergeWallets(await rows(watch(b, "B here")), remote, mine.base, 100);
  assert.deepEqual(theirs.native.renamed, { [b]: "B web" }); assert.ok(!theirs.changed);
  const both = mergeWallets(await rows(watch(b, "B again")), remote, mine.base, 100);
  assert.deepEqual(both.native.renamed, { [b]: "B web" });
});

test("removals travel both ways", async () => {
  const id = "4b0c0f5e-0000-4000-8000-000000000003";
  const first = mergeWallets([], [{ id, updated: 5, addr: b, label: "B" }], {}, 10);
  const linked = mergeWallets(await rows(watch(b, "B")), first.rows, first.base, 20);
  const gone = mergeWallets([], linked.rows, linked.base, 30);
  assert.ok(gone.changed); assert.equal(live(gone.rows).length, 0);
  assert.deepEqual(gone.rows.find((r) => r.id === id), { id, deleted: true, updated: 31 });
  const there = mergeWallets(await rows(watch(b, "B")), [{ id, updated: 50, deleted: true }], linked.base, 60);
  assert.deepEqual(there.native.removed, [b]); assert.ok(!there.changed);
});

test("a read-only wallet added here goes to the web, without its flag, and then follows it", async () => {
  const mine = await rows(watch(c, "C"));
  const pushed = mergeWallets(mine, [], {}, 10);
  assert.ok(pushed.changed); assert.equal(entry(pushed.rows, c)?.label, "C"); assert.ok(walletChangesEmpty(pushed.native));
  assert.equal(pushed.rows[0].watch, undefined);
  const remote = pushed.rows.map((r) => ({ id: r.id, updated: 80, deleted: true }));
  assert.deepEqual(mergeWallets(mine, remote, pushed.base, 90).native.removed, [c]);
});

test("a wallet with its seed here only ever pushes", async () => {
  const mine = await rows(seed(a, "Main"));
  const pushed = mergeWallets(mine, [], {}, 10);
  const renamed = mergeWallets(mine, pushed.rows.map((r) => ({ ...r, label: "Renamed", updated: 50 })), pushed.base, 60);
  assert.ok(walletChangesEmpty(renamed.native) && !renamed.changed);
  const removed = mergeWallets(mine, pushed.rows.map((r) => ({ id: r.id, updated: 70, deleted: true })), pushed.base, 80);
  assert.ok(walletChangesEmpty(removed.native) && !removed.changed);
  // …until it changes here: then it goes back.
  const again = mergeWallets(await rows(seed(a, "Main 2")), pushed.rows.map((r) => ({ id: r.id, updated: 70, deleted: true })), pushed.base, 90);
  assert.ok(again.changed); assert.equal(entry(again.rows, a)?.label, "Main 2");
});

test("no twin of an address the web already watches, and never more than the web's 10", async () => {
  const web: Web = [{ id: "own-entry", updated: 1, addr: a, label: "Watched on web" }];
  const merged = mergeWallets(await rows(seed(a, "Main")), web, {}, 10);
  assert.equal(live(merged.rows).length, 1); assert.ok(!merged.changed);
  const full: Web = Array.from({ length: MAX_WEB_WALLETS }, (_, i) => ({ id: `full-${i}`, updated: 1, addr: "prl1" + String(i).repeat(38).slice(0, 38), label: `W${i}` }));
  const capped = mergeWallets(await rows(seed(c, "Eleventh")), full, {}, 10);
  assert.equal(live(capped.rows).length, MAX_WEB_WALLETS); assert.ok(!capped.changed);
  assert.equal(entry(capped.rows, c), undefined);   // tried again on a later sync
  assert.equal(capped.native.added.length, MAX_WEB_WALLETS);
});

const wallet = (w: Partial<Wallet> & { id: string }): Wallet => ({ name: w.id, mnemonic: "", receiveIndex: 0, ...w });
const vault = (wallets: Wallet[], network: VaultData["network"] = "mainnet"): VaultData => ({ wallets, selected: wallets[0]?.id || "", network, pending: [] });
const [main0, main1, main2] = vectors.addresses as string[];

test("the vault's rows: each seed wallet's mainnet #0, read-only ones flagged, testnet ones left out", () => {
  const data = vault([wallet({ id: "s", name: "Seed", mnemonic: vectors.mnemonic, receiveIndex: 3 }), wallet({ id: "w", name: "Watched", watch: main1 }), wallet({ id: "t", name: "Test", watch: vectors.testnet.address })], "testnet");
  assert.deepEqual(webRows(data), [{ addr: main0, label: "Seed", watch: false }, { addr: main1, label: "Watched", watch: true }]);
});

test("the web's changes touch read-only wallets only", () => {
  const data = vault([wallet({ id: "s", name: "Seed", mnemonic: vectors.mnemonic }), wallet({ id: "w", name: "Watched", watch: main1 })]);
  data.selected = "w";
  assert.ok(applyWebWallets(data, { added: [{ addr: main2, label: "Web" }, { addr: main2, label: "Twin" }, { addr: main0, label: "Seed's own" }, { addr: "prl1bad", label: "Bad" }] }));
  assert.deepEqual(data.wallets.map((w) => [w.name, w.watch]), [["Seed", undefined], ["Watched", main1], ["Web", main2]]);
  assert.ok(!applyWebWallets(data, { added: [{ addr: main2, label: "Again" }] }));
  assert.ok(applyWebWallets(data, { renamed: { [main1]: "  Pool  ", [main0]: "Not the seed" } }));
  assert.deepEqual(data.wallets.map((w) => w.name), ["Seed", "Pool", "Web"]);
  assert.ok(applyWebWallets(data, { removed: [main1, main0] }));
  assert.deepEqual(data.wallets.map((w) => w.name), ["Seed", "Web"]);
  assert.equal(data.selected, "s");   // the open one went: the first left opens
  assert.ok(applyWebWallets(data, { added: [{ addr: main1, label: "" }] }));
  assert.equal(data.wallets.at(-1)!.name, "Watch Wallet");
  data.wallets.push(...Array.from({ length: 7 }, (_, i) => wallet({ id: `x${i}`, watch: "prl1x" + i })));
  assert.equal(data.wallets.length, 10);
  const skipped: string[] = [];
  assert.ok(!applyWebWallets(data, { added: [{ addr: vectors.address150, label: "Eleventh" }, { addr: main2, label: "Already here" }] }, skipped));
  assert.deepEqual(skipped, [vectors.address150]);   // full: reported, not silently dropped
});

test("a web entry this device couldn't take in is offered again, never read as removed here", async () => {
  const id = "4b0c0f5e-0000-4000-8000-000000000009", web: Web = [{ id, updated: 5, addr: b, label: "B" }];
  const first = mergeWallets([], web, {}, 10);
  assert.deepEqual(first.native.added, [{ addr: b, label: "B" }]);
  // Committed as agreed although not taken in: next time it would look removed here and be tombstoned.
  assert.equal(live(mergeWallets([], web, first.base, 20).rows).length, 0);
  // Committed without it: offered again instead.
  const again = mergeWallets([], web, withoutSkipped(first.base, [b]), 20);
  assert.deepEqual(again.native.added, [{ addr: b, label: "B" }]); assert.ok(!again.changed);
  assert.deepEqual(withoutSkipped(first.base, []), first.base);
});

test("names and a restored seed superseding the read-only wallet that watched its address", () => {
  const data = vault([wallet({ id: "w", name: "只读钱包", watch: main0 }), wallet({ id: "w2", name: "只读钱包 2", watch: main1 })]);
  assert.equal(watchName(data, "只读钱包"), "只读钱包 3");
  const restored = wallet({ id: "s", name: "Pearl Wallet", mnemonic: vectors.mnemonic });
  data.wallets.push(restored);
  supersede(data, restored);
  assert.deepEqual(data.wallets.map((w) => w.id), ["w2", "s"]);
});

test("a read-only wallet reads its one address: confirmed balance, signed unconfirmed part, history as seen from it", async () => {
  const original = globalThis.fetch, asked: string[] = [];
  resetIndexers();
  globalThis.fetch = async (url) => {
    asked.push(String(url));
    return Response.json({ address: main1, balance: "250000000", unconfirmedBalance: "-100000000", page: 1, totalPages: 2, transactions: [
      { txid: "a".repeat(64), blockTime: 200, confirmations: 3, fees: "1000", vin: [{ addresses: [main1], value: "300000000" }], vout: [{ addresses: [main2], value: "100000000" }, { addresses: [main1], value: "199999000" }] },
      { txid: "b".repeat(64), blockTime: 100, confirmations: 9, vin: [{ addresses: [main2], value: "500000000" }], vout: [{ addresses: [main1], value: "300000000" }] },
    ] });
  };
  try {
    const s = await loadWatch(main1, "mainnet", "w", 1);
    assert.match(asked[0], new RegExp(`^${OWN_MAINNET}/api/v2/address/${main1}\\?details=txs&page=1&pageSize=10$`));
    assert.equal(s.balance, "250000000"); assert.equal(s.pending, "-100000000");
    assert.deepEqual(s.utxos, []); assert.deepEqual(s.changeAddresses, []);
    assert.equal(s.hasMore, true); assert.equal(s.walletId, "w"); assert.equal(s.indexer, OWN_MAINNET);
    assert.deepEqual(s.history.map((tx) => [tx.sent, tx.amount, tx.address]), [[true, "100000000", main2], [false, "300000000", main2]]);
  } finally { globalThis.fetch = original; resetIndexers(); }
});
