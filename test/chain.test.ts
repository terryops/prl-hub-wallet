import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadAccount, mergeUTXOs, transactionPeer, estimateFee } from "../src/chain.ts";
import { derived, planTransaction, signTransaction } from "../src/wallet.ts";
const vectors = JSON.parse(readFileSync(new URL("./native-vectors.json", import.meta.url), "utf8"));
test("counterparty uses largest external output, ignores change/self sends and shows receipt source", () => {
  const mine = new Set(["own", "change"]), io = (address: string, value: string) => ({ addresses: [address], value });
  const tx = { txid: "test", vin: [io("own", "9999")], vout: [io("change", "8000"), io("small", "10"), io("large", "1000")] };
  assert.deepEqual(transactionPeer(tx, mine), { sent: true, address: "large" });
  assert.deepEqual(transactionPeer({ ...tx, vout: [io("change", "9990")] }, mine), { sent: true, address: "" });
  assert.deepEqual(transactionPeer({ ...tx, vin: [io("small", "10"), io("source", "90071992547409930")], vout: [io("own", "9990")] }, mine), { sent: false, address: "source" });
  assert.deepEqual(transactionPeer({ txid: "coinbase", vin: [], vout: [io("own", "1")] }, mine), { sent: false, address: "" });
});
test("used xpub token outside signing scan is recognized as own in self-send history", async () => {
  const original = globalThis.fetch, high = derived(vectors.xpub, "mainnet", 0, 201).address!;
  globalThis.fetch = async url => Response.json(String(url).includes("/utxo/") ? [] : {
    balance: "0", tokens: [{ name: high }], transactions: [{ txid: "77".repeat(32), vin: [{ addresses: [vectors.addresses[0]], value: "1000" }], vout: [{ addresses: [high], value: "900" }] }],
  });
  try {
    const result = await loadAccount(vectors.xpub, "mainnet", "test", []);
    assert.equal(result.history[0].address, ""); assert.equal(result.history[0].delta, "-100"); assert.equal(result.history[0].sent, true);
  } finally { globalThis.fetch = original; }
});
test("recursive legacy change is found; overlapping UTXOs/history are counted once", async () => {
  const original = globalThis.fetch;
  const c0 = derived(vectors.xpub, "mainnet", 1, 0).address!;
  const c70 = derived(vectors.xpub, "mainnet", 1, 70).address!;
  const c130 = derived(vectors.xpub, "mainnet", 1, 130).address!;
  const u = { txid: "ab".repeat(32), vout: 0, value: "123456789", address: c130, confirmations: 4 };
  const tx = (txid: string, address: string) => ({ txid: txid.repeat(32), blockTime: 123, confirmations: 4, vin: [], vout: [{ addresses: [address], value: u.value }] });
  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    if (path.includes("/utxo/")) { const { address: _address, ...raw } = u; return Response.json(path.endsWith(c130) ? [raw] : []); }
    const address = path.endsWith(c0) ? c0 : path.endsWith(c70) ? c70 : path.endsWith(c130) ? c130 : "xpub";
    return Response.json({ balance: "0", unconfirmedBalance: "0", page: 1, totalPages: 1, transactions: address === "xpub" ? [tx("11", c70)] : address === c70 ? [tx("22", c130)] : [] });
  };
  try {
    const s = await loadAccount(vectors.xpub, "mainnet", "test", [], 1, true);
    assert.equal(s.balance, u.value); assert.equal(s.utxos.length, 1);
    assert.equal(s.utxos[0].address, c130);
    assert.deepEqual(s.changeAddresses.sort(), [c0, c70, c130].sort());
    assert.equal(mergeUTXOs([[u], [u]]).length, 1);
    assert.throws(() => mergeUTXOs([[u], [{ ...u, value: "1" }]]));
  } finally { globalThis.fetch = original; }
});
test("Blockbook address responses overlap the xpub without address/path fields", async () => {
  const original = globalThis.fetch, address = derived(vectors.xpub, "mainnet", 1, 0).address!;
  const raw = { txid: "cd".repeat(32), vout: 0, value: "100000000", confirmations: 2 };
  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    if (path.includes("/utxo/")) return Response.json(path.endsWith(address) ? [raw] : [{ ...raw, address, path: "m/86'/808276'/0'/1/0" }]);
    return Response.json({ balance: raw.value, transactions: [] });
  };
  try {
    const s = await loadAccount(vectors.xpub, "mainnet", "test", []);
    assert.equal(s.balance, raw.value); assert.equal(s.utxos.length, 1);
    assert.equal(s.utxos[0].address, address);
    assert.equal(mergeUTXOs([[{ ...raw, address }], [raw]])[0].address, address);
    assert.throws(() => mergeUTXOs([[{ ...raw, address }], [{ ...raw, address: vectors.addresses[0] }]]), /不一致/);
  } finally { globalThis.fetch = original; }
});
test("stranded internal/70 inputs use that address's script and signing key", async () => {
  const original = globalThis.fetch, address = derived(vectors.xpub, "mainnet", 1, 70).address!;
  const raw = { txid: "ef".repeat(32), vout: 0, value: "100000000", confirmations: 2 };
  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    if (path.includes("/utxo/")) return Response.json(path.endsWith(address) ? [raw] : []);
    return Response.json({ balance: "0", transactions: [] });
  };
  try {
    const s = await loadAccount(vectors.xpub, "mainnet", "test", [address]);
    const plan = planTransaction(vectors.xpub, "mainnet", vectors.cases[0].to, 10000000n, 20000, s.utxos);
    assert.equal(plan.selected[0].d.branch, 1); assert.equal(plan.selected[0].d.index, 70);
    assert.equal(plan.selected[0].address, address);
    assert.ok(signTransaction(vectors.mnemonic, "mainnet", plan).hex);
    assert.throws(() => planTransaction(vectors.xpub, "mainnet", plan.to, plan.amount, plan.feePerKB, [raw]), /不属于/);
  } finally { globalThis.fetch = original; }
});
test("failed internal-chain query cannot fabricate zero or partial balance", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes("/address/")) throw new Error("offline");
    return Response.json(String(url).includes("/utxo/") ? [] : { balance: "0", transactions: [] });
  };
  try { await assert.rejects(loadAccount(vectors.xpub, "mainnet", "test", []), /offline/); }
  finally { globalThis.fetch = original; }
});
test("filtered outgoing pagination and height rewind discover verified high-index change and separate fees", async () => {
  const original = fetch, high = derived(vectors.xpub, "mainnet", 1, 12001).address!, urls: string[] = [];
  const input = { txid: "fa".repeat(32), vout: 0, value: "90000000", confirmations: 3, address: high, path: "m/86'/808276'/0'/1/12001" };
  globalThis.fetch = async (url) => {
    const u = new URL(String(url)); urls.push(u.href);
    if (u.pathname.includes("/utxo/")) return Response.json(u.pathname.endsWith(vectors.xpub) ? [input] : []);
    if (u.searchParams.get("filter") === "inputs") return Response.json({ totalPages: 2, transactions: [{ txid: "ff".repeat(32), blockHeight: 123, confirmations: 3 }], tokens: [{ name: high, path: input.path }] });
    return Response.json({ balance: "90000000", transactions: [{ txid: "fe".repeat(32), fees: "1000000", vin: [{ addresses: [vectors.addresses[0]], value: "100000000" }], vout: [{ addresses: [vectors.cases[0].to], value: "9000000" }, { addresses: [high], value: "90000000" }] }] });
  };
  try {
    const s = await loadAccount(vectors.xpub, "mainnet", "test", [], 1, false, { fromHeight: 100 });
    assert.equal(s.scanHeight, 123); assert.equal(s.addressPaths![high], input.path); assert.ok(s.changeAddresses.includes(high));
    const queries = urls.filter((u) => u.includes("filter=inputs")); assert.equal(queries.length, 2); assert.ok(queries.every((u) => u.includes("from=88")));
    assert.equal(s.history[0].amount, "9000000"); assert.equal(s.history[0].fee, "1000000"); assert.equal(s.history[0].delta, "-10000000");
    assert.equal(planTransaction(vectors.xpub, "mainnet", vectors.cases[0].to, 10000000n, 20000, s.utxos).selected[0].d.index, 12001);
    await assert.rejects(loadAccount(vectors.xpub, "mainnet", "test", [], 1, false, { paths: { [high]: "m/86'/808276'/0'/1/12000" } }), /路径/);
  } finally { globalThis.fetch = original; }
});
test("manual pathless recovery verifies change beyond the default 200-address window", async () => {
  const original = fetch, high = derived(vectors.xpub, "mainnet", 1, 231).address!;
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    if (u.pathname.includes("/utxo/")) return Response.json(u.pathname.endsWith(high) ? [{ txid: "fb".repeat(32), vout: 0, value: "100000000", confirmations: 2 }] : []);
    return Response.json({ balance: "0", transactions: u.pathname.includes("/xpub/") ? [{ txid: "fc".repeat(32), vout: [{ addresses: [high], value: "100000000" }] }] : [] });
  };
  try { const s = await loadAccount(vectors.xpub, "mainnet", "test", [], 1, true); assert.equal(s.balance, "100000000"); assert.equal(s.addressPaths![high], "m/86'/808276'/0'/1/231"); }
  finally { globalThis.fetch = original; }
});
test("pathless xpub UTXOs on verified internal addresses are included in recovery", async () => {
  const original = fetch, address = derived(vectors.xpub, "mainnet", 1, 70).address!;
  const input = { txid: "ea".repeat(32), vout: 0, value: "100000000", address, confirmations: 6 };
  const queries: string[] = [];
  globalThis.fetch = async url => {
    const path = new URL(String(url)).pathname; queries.push(path);
    return Response.json(path.includes("/utxo/") ? path.endsWith(vectors.xpub) ? [input] : [] : { balance: input.value, transactions: [] });
  };
  try {
    for (const scan of [false, true]) {
      const snapshot = await loadAccount(vectors.xpub, "mainnet", "test", [], 1, scan);
      assert.equal(snapshot.balance, input.value); assert.ok(snapshot.changeAddresses.includes(address));
      assert.ok(queries.some(path => path.endsWith("/utxo/" + address)));
      const recovery = snapshot.utxos.filter(u => snapshot.changeAddresses.includes(u.address || ""));
      assert.equal(planTransaction(vectors.xpub, "mainnet", vectors.addresses[0], 90000000n, 50000, recovery).selected[0].d.index, 70);
    }
  } finally { globalThis.fetch = original; }
});
test("testnet indexer paths use coin type 1 and still verify against the derived address", async () => {
  const original = globalThis.fetch, path = "m/86'/1'/0'/0/0", address = vectors.testnet.address;
  globalThis.fetch = async (url) => {
    const p = new URL(String(url)).pathname;
    if (p.includes("/utxo/")) return Response.json(p.includes("/vpub") ? [{ txid: "cd".repeat(32), vout: 0, value: "5000", address, path, confirmations: 3 }] : []);
    return Response.json({ balance: "5000", page: 1, totalPages: 1, tokens: [{ name: address, path }], transactions: [] });
  };
  try {
    const s = await loadAccount(vectors.testnet.xpub, "testnet", "test", []);
    assert.equal(s.balance, "5000"); assert.equal(s.utxos.length, 1);
    await assert.rejects(loadAccount(vectors.xpub, "mainnet", "test", []), /地址路径无效/, "mainnet keeps the exact coin type");
  } finally { globalThis.fetch = original; }
});
test("invalid fee estimates fail so the caller can label the fallback correctly", async () => {
  const original = fetch;
  try {
    for (const result of [-1, "-1", "NaN", "", null, false, {}, undefined]) {
      globalThis.fetch = async () => Response.json({ result });
      await assert.rejects(estimateFee("mainnet"), /手续费/);
    }
    globalThis.fetch = async () => Response.json({ result: "0.0005" });
    assert.equal(await estimateFee("mainnet"), 50000);
  } finally { globalThis.fetch = original; }
});
test("a full change scan over more spends than a call accepts as arguments still reports the scan height", async () => {
  // 1,500 indexer pages of 100 spends: Math.max(...spends) overflows the engine's argument limit.
  const original = globalThis.fetch, pages = 1500;
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    if (u.pathname.includes("/utxo/")) return Response.json([]);
    const page = Number(u.searchParams.get("page"));
    if (u.searchParams.get("filter") === "inputs") return Response.json({ totalPages: pages, transactions: Array.from({ length: 100 }, (_, i) => ({ txid: "s", blockHeight: page * 100 + i, confirmations: page === pages && i === 99 ? 0 : 1 })) });
    return Response.json({ balance: "0", page: 1, totalPages: 1, transactions: [] });
  };
  try { assert.equal((await loadAccount(vectors.xpub, "mainnet", "test", [], 1, true)).scanHeight, pages * 100 + 98); }
  finally { globalThis.fetch = original; }
});
