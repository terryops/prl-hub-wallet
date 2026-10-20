import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadAccount, mergeUTXOs, transactionPeer, estimateFee, chooseFeePerKB, notFound, alreadyKnown, ChainError, request, requestFrom, indexers, origin, pinned, healthyFirst, resetIndexers, txCopies, NODE_KEY, BENCH_MS, KEY_REFUSED_BENCH_MS } from "../src/chain.ts";
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
test("invalid fee estimates fall back to the default rate and say it is not an estimate", async () => {
  const original = fetch;
  try {
    for (const result of [-1, "-1", "NaN", "", null, false, {}, undefined]) {
      globalThis.fetch = async () => Response.json({ result });
      assert.deepEqual(await estimateFee("mainnet"), { fee: 50000, estimated: false });
    }
    globalThis.fetch = async () => { throw new Error("offline"); };
    assert.deepEqual(await estimateFee("mainnet"), { fee: 50000, estimated: false });
    globalThis.fetch = async () => Response.json({ result: "0.0005" });
    assert.deepEqual(await estimateFee("mainnet"), { fee: 50000, estimated: true });
  } finally { globalThis.fetch = original; }
});
// The official indexer's answers on 2026-10-20 (tip 130692): its 2-block estimate asked ~1,955 sat/vB
// while recent blocks took 1–81 sat/vB. Blocks with only a coinbase have no fee statistics.
const feeDay = (overrides: Record<string, unknown> = {}) => async (url: string | URL | Request) => {
  const p = new URL(String(url)).pathname;
  const answers: Record<string, unknown> = {
    "/api/v1/estimatefee/2": { result: "0.01954566" }, "/api/v1/estimatefee/6": { result: "0.00001708" },
    "/api/v2/": { blockbook: { bestHeight: 130692 } },
    "/api/v2/feestats/130690": { txCount: 8, decilesFeePerKb: [1005, 1005, 1007, 1008, 3000, 50218, 50218, 2384097, 2386245, 2386648, 2386648] },
    "/api/v2/feestats/130692": { txCount: 60, decilesFeePerKb: [1003, 2014, 81441, 81441, 81441, 81441, 81441, 81441, 81441, 81441, 2390461] },
    ...overrides,
  };
  if (p in answers) return answers[p] instanceof Response ? answers[p] as Response : Response.json(answers[p]);
  if (p.startsWith("/api/v2/feestats/")) return Response.json({ txCount: 0, decilesFeePerKb: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] });
  throw new Error("unexpected " + p);
};
test("a skewed 2-block estimate is capped by the 6-block estimate and recent blocks' median fees", async () => {
  const original = fetch;
  try {
    globalThis.fetch = feeDay() as typeof fetch;
    // Was 1,954,566 per kB (about 0.003 PRL for a 154-vbyte payment, 24 times this); now the busiest recent block's median.
    assert.deepEqual(await estimateFee("mainnet"), { fee: 81441, estimated: true });
    globalThis.fetch = feeDay({ "/api/v2/": { error: "down" } }) as typeof fetch;
    assert.deepEqual(await estimateFee("mainnet"), { fee: 1708, estimated: true }, "no block statistics: the 6-block estimate caps");
    globalThis.fetch = feeDay({ "/api/v1/estimatefee/2": { result: "-1" } }) as typeof fetch;
    assert.deepEqual(await estimateFee("mainnet"), { fee: 81441, estimated: true }, "no 2-block estimate: the cap is the rate");
    globalThis.fetch = feeDay({ "/api/v2/feestats/130692": { txCount: 60, decilesFeePerKb: [1, 2, 3] }, "/api/v2/feestats/130690": new Response("busy", { status: 503 }) }) as typeof fetch;
    assert.deepEqual(await estimateFee("mainnet"), { fee: 1708, estimated: true }, "malformed or failed statistics are skipped");
  } finally { globalThis.fetch = original; }
});
test("fee choice: the cap, the fallback and the relay floor and ceiling", () => {
  assert.equal(chooseFeePerKB(1954566, 1708, [50218, 81441]), 81441);
  assert.equal(chooseFeePerKB(20000, 1708, [50218]), 20000, "an estimate below the cap stands");
  assert.equal(chooseFeePerKB(20000, null, []), 20000, "nothing to cap with");
  assert.equal(chooseFeePerKB(null, null, []), 50000);
  assert.equal(chooseFeePerKB(null, 3000, []), 3000);
  assert.equal(chooseFeePerKB(500, null, []), 1000);
  assert.equal(chooseFeePerKB(99999999, 99999999, []), 10000000);
});
test("the indexer's real not-found answer is recognised; already-known replies of Pearl and Core nodes too", async () => {
  const original = fetch;
  try {
    globalThis.fetch = async () => Response.json({ error: `Transaction '${"ab".repeat(32)}' not found` }, { status: 400 });
    const e = await request("mainnet", "/api/v2/tx/" + "ab".repeat(32)).catch((e) => e);
    assert.ok(e instanceof ChainError); assert.equal(notFound(e), true);
    assert.equal(notFound(new ChainError("Transaction not found", 404)), true);
    assert.equal(notFound(new ChainError("not found", 503)), false);
    assert.equal(notFound(new Error("not found")), false);
  } finally { globalThis.fetch = original; }
  for (const m of ["already have transaction 00ff", "-27: transaction already exists", "txn-already-in-mempool", "txn-already-known", "Transaction already in block chain", "-25: already in the mempool"]) assert.equal(alreadyKnown(m), true, m);
  for (const m of ["-26: min relay fee not met", "bad-txns-inputs-missingorspent", ""]) assert.equal(alreadyKnown(m), false, m);
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
// Two mainnet indexers (see indexers() in src/chain.ts): Pearl Hub's own through its gateway, then the official one.
const OWN = "https://pearlhub.net/node", OFFICIAL = "https://blockbook.pearlresearch.ai";
/// A fetch that answers per indexer; records [indexer, path, key header] per request.
function twoIndexers(answer: (own: boolean, path: string) => Response | Promise<Response>) {
  const calls: [string, string, string | null][] = [];
  const mock = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input)), own = url.hostname === "pearlhub.net", path = own ? url.pathname.replace(/^\/node\//, "/") : url.pathname;
    calls.push([own ? "own" : url.hostname === "blockbook.pearlresearch.ai" ? "official" : url.hostname, path, new Headers(init?.headers).get("x-pearl-hub-key")]);
    return answer(own, path + url.search);
  }) as typeof fetch;
  return { mock, calls };
}
test("mainnet reads ask our own index first, with its key; the official one is the fallback; testnet only the official one", async () => {
  const original = fetch; resetIndexers();
  try {
    const { mock, calls } = twoIndexers((own) => Response.json({ from: own ? "own" : "official" }));
    globalThis.fetch = mock;
    assert.deepEqual(indexers("mainnet"), [OWN, OFFICIAL]); assert.deepEqual(indexers("testnet"), ["https://blockbook.testnet.pearlresearch.ai"]);
    assert.deepEqual(await requestFrom(indexers("mainnet"), "/api/v2/"), { data: { from: "own" }, base: OWN });
    assert.deepEqual(calls, [["own", "/api/v2/", NODE_KEY]]);
    calls.length = 0; await request("testnet", "/api/v2/");
    assert.deepEqual(calls, [["blockbook.testnet.pearlresearch.ai", "/api/v2/", null]], "the key goes only to our gateway");
    assert.equal(origin("mainnet"), OFFICIAL, "explorer links stay on the official explorer");
  } finally { globalThis.fetch = original; resetIndexers(); }
});
test("a failing index is benched (503, 429, no answer, a website instead of JSON; a refused key for longer), a slow or not-found answer is not", async () => {
  const original = fetch;
  try {
    for (const [failure, benchMs] of [
      [() => Response.json({ error: "node unhealthy" }, { status: 503 }), BENCH_MS],
      [() => Response.json({ error: "rate limited" }, { status: 429 }), BENCH_MS],
      [() => { throw new TypeError("Failed to fetch"); }, BENCH_MS],
      [() => new Response("<!doctype html><title>Pearl Hub</title>", { status: 200, headers: { "content-type": "text/html" } }), BENCH_MS],
      [() => Response.json({ error: "unauthorized" }, { status: 401 }), KEY_REFUSED_BENCH_MS],
      [() => { throw new DOMException("timed out", "TimeoutError"); }, null],
      [() => Response.json({ error: `Transaction '${"ab".repeat(32)}' not found` }, { status: 400 }), null],
    ] as const) {
      resetIndexers();
      const { mock, calls } = twoIndexers((own) => own ? failure() : Response.json({ from: "official" }));
      globalThis.fetch = mock;
      assert.deepEqual(await request("mainnet", "/api/v2/"), { from: "official" }, "falls back");
      calls.length = 0; await request("mainnet", "/api/v2/");
      // Benched: the official index is asked first until the bench ends; never dropped.
      assert.deepEqual(calls.map((c) => c[0]), benchMs ? ["official"] : ["own", "official"], String(failure));
      if (benchMs) {
        const now = Date.now();
        assert.deepEqual(healthyFirst([OWN, OFFICIAL], now + benchMs - 1000), [OFFICIAL, OWN]);
        assert.deepEqual(healthyFirst([OWN, OFFICIAL], now + benchMs + 1000), [OWN, OFFICIAL]);
      }
    }
    // Both failing: the last error is reported.
    resetIndexers();
    globalThis.fetch = twoIndexers(() => Response.json({ error: "down" }, { status: 502 })).mock;
    await assert.rejects(request("mainnet", "/api/v2/"), (e) => e instanceof ChainError && e.status === 502);
  } finally { globalThis.fetch = original; resetIndexers(); }
});
test("with a fallback left, the first index gets at most 12 seconds", async () => {
  const original = fetch, timeout = AbortSignal.timeout, asked: number[] = []; resetIndexers();
  AbortSignal.timeout = ((ms: number) => { asked.push(ms); return timeout.call(AbortSignal, ms); }) as typeof AbortSignal.timeout;
  try {
    globalThis.fetch = twoIndexers((own) => own ? Response.json({ error: "x" }, { status: 503 }) : Response.json({})).mock;
    await request("mainnet", "/api/v2/");
    assert.deepEqual(asked, [12000, 25000]);
  } finally { AbortSignal.timeout = timeout; globalThis.fetch = original; resetIndexers(); }
});
test("one refresh reads from one index: the one that answered first, and a later failure there fails the refresh", async () => {
  const original = fetch, account = { balance: "0", unconfirmedBalance: "0", page: 1, totalPages: 1, transactions: [], tokens: [] };
  try {
    // Ours answers: every read of the refresh goes to it.
    resetIndexers();
    let { mock, calls } = twoIndexers((_own, path) => Response.json(path.includes("/utxo/") ? [] : account));
    globalThis.fetch = mock;
    const ours = await loadAccount(vectors.xpub, "mainnet", "w", []);
    assert.equal(ours.indexer, OWN); assert.ok(calls.length > 3); assert.ok(calls.every((c) => c[0] === "own"));
    // Ours is down: the official one serves the whole refresh.
    resetIndexers();
    ({ mock, calls } = twoIndexers((own, path) => own ? Response.json({ error: "node unhealthy" }, { status: 503 }) : Response.json(path.includes("/utxo/") ? [] : account)));
    globalThis.fetch = mock;
    const official = await loadAccount(vectors.xpub, "mainnet", "w", []);
    assert.equal(official.indexer, OFFICIAL); assert.deepEqual(calls.filter((c) => c[0] === "own").length, 1);
    // Ours answers the first page, then fails: the refresh fails instead of finishing on the other index.
    resetIndexers();
    let first = true;
    ({ mock, calls } = twoIndexers((own, path) => {
      if (own && !first) return Response.json({ error: "node unhealthy" }, { status: 503 });
      first = false;
      return Response.json(path.includes("/utxo/") ? [] : account);
    }));
    globalThis.fetch = mock;
    await assert.rejects(loadAccount(vectors.xpub, "mainnet", "w", []));
    assert.ok(calls.every((c) => c[0] === "own"), "never mixed in the official index");
    // A strict pin (加载更多) never leaves its index.
    resetIndexers();
    ({ mock, calls } = twoIndexers((own) => own ? Response.json({ error: "x" }, { status: 503 }) : Response.json(account)));
    globalThis.fetch = mock;
    await assert.rejects(loadAccount(vectors.xpub, "mainnet", "w", [], 2, false, { bases: pinned("mainnet", OWN, true) }));
    assert.ok(calls.every((c) => c[0] === "own"));
    assert.deepEqual(pinned("mainnet", OFFICIAL), [OFFICIAL, OWN]); assert.deepEqual(pinned("mainnet", "https://elsewhere.example"), [OWN, OFFICIAL]);
  } finally { globalThis.fetch = original; resetIndexers(); }
});
test("the fee estimate prefers the index the balance came from, and every indexer is asked for a transaction", async () => {
  const original = fetch; resetIndexers();
  try {
    const { mock, calls } = twoIndexers((own, path) => path.startsWith("/api/v2/tx/")
      ? own ? Response.json({ error: `Transaction '${"ab".repeat(32)}' not found` }, { status: 400 }) : Response.json({ txid: "ab".repeat(32), confirmations: 0 })
      : Response.json(path === "/api/v2/" ? { blockbook: { bestHeight: 0 } } : { result: own ? "0.0002" : "0.0001" }));
    globalThis.fetch = mock;
    assert.deepEqual(await estimateFee("mainnet", OFFICIAL), { fee: 10000, estimated: true });
    assert.ok(calls.every((c) => c[0] === "official"));
    assert.deepEqual(await estimateFee("mainnet"), { fee: 20000, estimated: true });
    assert.deepEqual((await txCopies("mainnet", "ab".repeat(32))).map((c) => [c.base, c.state]), [[OWN, "missing"], [OFFICIAL, "found"]]);
  } finally { globalThis.fetch = original; resetIndexers(); }
});
