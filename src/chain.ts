import { addressMap, accountPath, derived, outpoint, isAddress, registerAddressPath, type Network, type UTXO } from "./wallet.ts";
// Defined per module (not imported) so the Chrome build folds it even across shared chunks.
declare const __PEARL_ANDROID__: boolean | undefined;
const ANDROID = typeof __PEARL_ANDROID__ !== "undefined" && __PEARL_ANDROID__ === true;
// Blockbook indexers, as in the native app (prl-hub Sources/WalletKit/BlockbookClient.swift). Mainnet has
// two: Pearl Hub's own, behind prl-hub/node-gateway (which refuses reads with a 503 while it lags), and
// Pearl's official one. Reads try them in order and one refresh reads from one index only; broadcasts and
// transaction lookups ask both. On 2026-10-20 the official indexer kept showing a block's transactions as
// unconfirmed for hours, which no "is it reachable" failover catches, hence a second, independent index.
// The Android build reads through its app shell, which proxies only the official indexer.
export const OWN_MAINNET = "https://pearlhub.net/node", OFFICIAL_MAINNET = "https://blockbook.pearlresearch.ai", OFFICIAL_TESTNET = "https://blockbook.testnet.pearlresearch.ai";
/// Lets the wallet through the gateway (EXTENSION_KEYS in prl-hub/node-gateway/wrangler.toml). Not a secret:
/// it is in this public source. It keeps the wallet's traffic apart from the native app's, and removing it
/// there moves this version back to the official indexer.
export const NODE_KEY = "212e47a59f6f1f1e4a98b50428700972391dd55cee237080";
/// The indexers of `network`, in order of preference.
export const indexers = (network: Network) => network === "testnet" ? [OFFICIAL_TESTNET] : ANDROID ? [OFFICIAL_MAINNET] : [OWN_MAINNET, OFFICIAL_MAINNET];
/// `base` first, then the others; `strict`: `base` only, for the reads of one refresh, which must not mix
/// two indexes that may disagree. An indexer this network doesn't have changes nothing.
export function pinned(network: Network, base: string | undefined, strict = false) {
  const all = indexers(network);
  if (!base || !all.includes(base)) return all;
  return strict ? [base] : [base, ...all.filter((b) => b !== base)];
}
/// The official explorer, for links: our own index has no web pages.
export const origin = (network: Network) => network === "mainnet" ? OFFICIAL_MAINNET : OFFICIAL_TESTNET;
/// Headers for a request to `base`: the gateway refuses requests to our own index without the key.
export const indexerHeaders = (base: string, headers?: HeadersInit) => {
  const out = new Headers(headers);
  if (base === OWN_MAINNET) out.set("X-Pearl-Hub-Key", NODE_KEY);
  return out;
};
export type IO = { addresses?: string[]; value?: string; hex?: string };
export type ChainTx = { txid: string; blockHeight?: number; blockTime?: number; confirmations?: number; fees?: string; vin?: IO[]; vout?: IO[] };
type Account = { balance: string; unconfirmedBalance: string; transactions?: ChainTx[]; page?: number; totalPages?: number; tokens?: { name: string; path?: string }[] };
export type Snapshot = { network: Network; walletId: string; balance: string; pending: string; utxos: UTXO[]; history: { txid: string; time: number; confirmations: number; delta: string; amount?: string; fee?: string; address?: string; sent?: boolean }[]; page: number; hasMore: boolean; changeAddresses: string[]; addressPaths?: Record<string, string>; scanHeight?: number; time: number; indexer?: string };
export function transactionPeer(tx: ChainTx, mine: ReadonlySet<string>) {
  const own = (io: IO) => (io.addresses || []).some((a) => mine.has(a.toLowerCase()));
  const sent = (tx.vin || []).some(own);
  const external = (sent ? tx.vout : tx.vin || [])?.filter((io) => !own(io)) || [];
  // Swift selects the largest external output for sends. For receipts the B3
  // requirement asks for the source, so apply that rule to external inputs.
  const largest = external.reduce<IO | undefined>((best, io) => !best || BigInt(io.value || "0") > BigInt(best.value || "0") ? io : best, undefined);
  return { sent, address: largest?.addresses?.[0]?.toLowerCase() || "" };
}
export class ChainError extends Error {
  status: number;
  /// The answer wasn't JSON at all (a proxy's or website's page): the indexer isn't really there.
  unusable: boolean;
  constructor(message: string, status: number, unusable = false) { super(message); this.status = status; this.unusable = unusable; }
}
/// The indexer doesn't know this transaction: Blockbook answers 400 {"error":"Transaction '<txid>' not found"}.
export const notFound = (e: unknown) => e instanceof ChainError && (e.status === 400 || e.status === 404) && /not found/i.test(e.message);
/// A node already has this transaction (mempool or chain): Pearl's node says "already have transaction" or
/// "transaction already exists", Bitcoin Core-style nodes "txn-already-…" or "already in block chain".
export const alreadyKnown = (message: string) => /already.*(known|block chain|mempool)|already (have|exists)|txn-already/i.test(message);
// An indexer that just failed goes to the back of the line for a while; it is never dropped, as it is still
// a fallback. Kept in the service worker's memory, so a restart forgets it.
export const BENCH_MS = 60000, KEY_REFUSED_BENCH_MS = 600000;
const benchedUntil = new Map<string, number>();
export const resetIndexers = () => benchedUntil.clear();
/// `bases` with the benched ones last.
export function healthyFirst(bases: string[], now = Date.now()) {
  const benched = (base: string) => (benchedUntil.get(base) ?? 0) > now;
  return [...bases.filter((b) => !benched(b)), ...bases.filter(benched)];
}
/// How long to bench an indexer after `error`; null when it says nothing about the indexer's health. A
/// timeout is a slow query (a long history), not a sick indexer: the gateway answers a 503 within seconds
/// when our index is unhealthy. A refused key (401/403) won't fix itself in a minute, so it sits out longer.
export function benchTime(error: unknown): number | null {
  if (error instanceof ChainError) {
    if (error.status === 401 || error.status === 403) return KEY_REFUSED_BENCH_MS;
    return error.status >= 500 || error.status === 429 || error.status === 0 || error.unusable ? BENCH_MS : null;
  }
  if (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError")) return null;
  // No answer at all: offline, connection refused, TLS.
  return BENCH_MS;
}
export const benched = (base: string, error: unknown) => {
  const time = benchTime(error);
  if (time != null) benchedUntil.set(base, Date.now() + time);
};
/// One indexer's JSON answer to `path`.
export async function ask<T>(base: string, path: string, init?: RequestInit, timeout = 25000): Promise<T> {
  const response = await fetch(base + path, { ...init, headers: indexerHeaders(base, init?.headers), signal: AbortSignal.timeout(timeout), cache: "no-store", credentials: "omit", redirect: "error" });
  const body = await response.text();
  if (body.length > 12000000) throw new ChainError("链上响应过大，请稍后重试。", response.status);
  let data;
  try { data = JSON.parse(body); } catch { throw new ChainError("链上服务暂时不可用。", response.status, true); }
  if (!response.ok || data?.error) throw new ChainError(typeof data?.error === "string" ? data.error.slice(0, 160) : "链上服务暂时不可用。", response.status);
  return data;
}
/// `path` from the first of `bases` that answers, and which one it was. The others are the fallback; one
/// that fails is benched (see benchTime). With a fallback left, the first choice gets at most 12 seconds.
export async function requestFrom<T>(bases: string[], path: string, init?: RequestInit, timeout = 25000): Promise<{ data: T; base: string }> {
  const order = healthyFirst(bases);
  let last: unknown = new ChainError("链上服务暂时不可用。", 0);
  for (const [i, base] of order.entries()) {
    try { return { data: await ask<T>(base, path, init, i < order.length - 1 ? Math.min(timeout, 12000) : timeout), base }; }
    catch (error) { benched(base, error); last = error; }
  }
  throw last;
}
export async function request<T>(network: Network, path: string, init?: RequestInit, timeout = 25000, bases = indexers(network)): Promise<T> {
  return (await requestFrom<T>(bases, path, init, timeout)).data;
}
/// One indexer's answer for a transaction.
export type TxCopy = { base: string } & ({ state: "found"; raw: Record<string, unknown> } | { state: "missing" } | { state: "unknown" });
/// `txid` from every indexer at once, in order of preference. "missing": that indexer says it doesn't
/// know it; "unknown": no usable answer (ours answers 503 while it catches up, which says nothing).
export function txCopies(network: Network, txid: string, timeout = 20000): Promise<TxCopy[]> {
  return Promise.all(indexers(network).map(async (base): Promise<TxCopy> => {
    try {
      const raw = await ask<Record<string, unknown>>(base, `/api/v2/tx/${txid}`, undefined, timeout);
      return raw && typeof raw === "object" && typeof raw.txid === "string" && raw.txid.toLowerCase() === txid ? { base, state: "found", raw } : { base, state: "unknown" };
    } catch (error) { return { base, state: notFound(error) ? "missing" : "unknown" }; }
  }));
}
export function mergeUTXOs(groups: UTXO[][]): UTXO[] {
  const result = new Map<string, UTXO>();
  for (const group of groups) {
    if (!Array.isArray(group)) throw new Error("链上输入列表无效。");
    for (const u of group) {
      if (!/^[a-f0-9]{64}$/.test(u.txid) || !Number.isSafeInteger(u.vout) || !/^\d+$/.test(u.value) || !Number.isSafeInteger(u.confirmations ?? 0) || (u.confirmations ?? 0) < 0) throw new Error("链上输入数据无效。");
      const old = result.get(outpoint(u));
      if (old && (old.value !== u.value || (old.address && u.address && old.address !== u.address) || (old.path && u.path && old.path !== u.path))) throw new Error("链上输入数据不一致。");
      result.set(outpoint(u), { ...old, ...u, address: u.address || old?.address, path: u.path || old?.path });
    }
  }
  return [...result.values()];
}
export async function loadAccount(publicKey: string, network: Network, walletId: string, knownChange: string[], page = 1, scan = false, options: { paths?: Record<string, string>; fromHeight?: number; active?: () => void; bases?: string[] } = {}): Promise<Snapshot> {
  for (const [address, path] of Object.entries(options.paths || {})) registerAddressPath(publicKey, network, address, path);
  const mine = addressMap(publicKey, network), changes = new Set(knownChange.filter((a) => mine.get(a)?.branch === 1));
  changes.add(derived(publicKey, network, 1, 0).address!);
  // Whichever indexer answers first serves this whole refresh: a read that fails there fails the refresh,
  // and the next one starts over, rather than mixing two indexes that may disagree.
  let at = options.bases ?? indexers(network);
  const get = async <T>(path: string) => {
    options.active?.();
    const { data, base } = await requestFrom<T>(at, path);
    at = [base];
    return data;
  };
  const historyPage = (path: string) => get<Account>(path);
  const read = (p: number) => historyPage(`/api/v2/xpub/${publicKey}?details=txs&tokens=used&page=${p}&pageSize=10`);
  const first = await read(page);
  for (const token of first.tokens || []) if (token.path) registerAddressPath(publicKey, network, token.name, token.path);
  if (!/^\d+$/.test(first.balance)) throw new Error("链上余额数据无效。");
  const txs = [...(first.transactions || [])];
  // Receive-heavy wallets need only outgoing transactions to discover change.
  // Advance the height only after all candidate addresses have answered.
  const from = !scan && options.fromHeight != null ? `&from=${Math.max(0, options.fromHeight - 12)}` : "";
  const spent: ChainTx[] = [];
  for (let p = 1, pages = 1; p <= pages; p++) {
    const data = await historyPage(`/api/v2/xpub/${publicKey}?details=txs&tokens=used&filter=inputs&page=${p}&pageSize=100${from}`);
    pages = data.totalPages || 1;
    if (!Number.isSafeInteger(pages) || pages < 1 || pages > 1000000) throw new Error("找零扫描响应无效。");
    for (const token of data.tokens || []) if (token.path) registerAddressPath(publicKey, network, token.name, token.path);
    spent.push(...data.transactions || []);
  }
  let pathlessScanComplete = false;
  const discover = async (transactions: ChainTx[]) => {
    const candidates = new Set(transactions.flatMap((tx) => (tx.vout || []).flatMap((io) => io.addresses || [])).map((a) => a.toLowerCase()).filter((a) => !mine.has(a) && isAddress(a, network)));
    // Older indexers omit paths. The manual recovery scan verifies funded
    // candidates against the internal branch, without guessing ownership.
    if (scan && candidates.size && !pathlessScanComplete) {
      const funded = new Set<string>();
      for (const a of candidates) {
        options.active?.();
        const utxos = await get<UTXO[]>(`/api/v2/utxo/${a}`);
        if (!Array.isArray(utxos)) throw new Error("链上输入列表无效。");
        if (utxos.length) funded.add(a);
      }
      for (let index = 200; index < 10000 && funded.size; index++) {
        const d = derived(publicKey, network, 1, index);
        mine.set(d.address!, d); funded.delete(d.address!);
        if (index % 100 === 0) { await new Promise((resolve) => setTimeout(resolve, 0)); options.active?.(); }
        if (index === 9999) pathlessScanComplete = true;
      }
    }
    for (const tx of transactions) for (const io of tx.vout || []) for (const a of io.addresses || []) if (mine.get(a.toLowerCase())?.branch === 1) changes.add(a.toLowerCase());
  };
  await discover([...txs, ...spent]);
  // The indexer's xpub scan may omit internal-chain addresses. Query them separately
  // and deduplicate outpoints rather than adding potentially overlapping balances.
  const utxoGroups = [await get<UTXO[]>(`/api/v2/utxo/${publicKey}`)];
  for (const u of utxoGroups[0]) if (u.address) {
    const address = u.address.toLowerCase();
    const d = u.path ? registerAddressPath(publicKey, network, address, u.path) : mine.get(address);
    if (d?.branch === 1) changes.add(address);
  }
  const changeHistory: ChainTx[] = [];
  for (const address of changes) {
    const [utxos, history] = await Promise.all([
      get<UTXO[]>(`/api/v2/utxo/${address}`),
      historyPage(`/api/v2/address/${address}?details=txs&page=${page}&pageSize=10`)
    ]);
    if (!Array.isArray(utxos)) throw new Error("链上输入列表无效。");
    const d = mine.get(address)!;
    // Only xpub UTXOs contain ownership metadata. Address queries inherit the
    // exact address and derivation path we requested; never guess external/0.
    const path = `${accountPath(network)}/${d.branch}/${d.index}`;
    utxoGroups.push(utxos.map((u) => {
      if ((u.address && u.address !== address) || (u.path && u.path !== path)) throw new Error("链上输入数据不一致。");
      return { ...u, address, path };
    }));
    const ownHistory = [...(history.transactions || [])];
    if (!Number.isSafeInteger(history.totalPages || 1) || (history.totalPages || 1) < 1 || (history.totalPages || 1) > 1000000) throw new Error("找零扫描响应无效。");
    if (scan) for (let p = 2; p <= (history.totalPages || 1); p++) {
      ownHistory.push(...((await historyPage(`/api/v2/address/${address}?details=txs&page=${p}&pageSize=10`)).transactions || []));
    }
    changeHistory.push(...ownHistory);
    // Discover old change-of-change transactions, including sends never touching
    // the external branch. Iterating a Set also visits newly discovered addresses.
    await discover(ownHistory);
    if ((history.totalPages || 1) > page) first.totalPages = Math.max(first.totalPages || 1, history.totalPages || 1);
  }
  const utxos = mergeUTXOs(utxoGroups);
  const allTxs = new Map<string, ChainTx>();
  for (const tx of [...txs, ...changeHistory]) allTxs.set(tx.txid, tx);
  // Used xpub tokens can exceed the supported signing scan. They are still ours
  // for history display; recognizing them does not widen the signing key range.
  const historyMine = new Set([...mine.keys(), ...(first.tokens || []).flatMap((token) => typeof token.name === "string" && isAddress(token.name.toLowerCase(), network) ? [token.name.toLowerCase()] : [])]);
  const ownValue = (rows: IO[]) => rows.reduce((sum, io) => sum + ((io.addresses || []).some((a) => historyMine.has(a.toLowerCase())) ? BigInt(io.value || "0") : 0n), 0n);
  return {
    network, walletId, utxos,
    balance: utxos.filter((u) => (u.confirmations || 0) > 0).reduce((s, u) => s + BigInt(u.value), 0n).toString(),
    pending: utxos.filter((u) => !u.confirmations).reduce((s, u) => s + BigInt(u.value), 0n).toString(),
    history: [...allTxs.values()].map((tx) => { const peer = transactionPeer(tx, historyMine); return { txid: tx.txid, time: tx.blockTime || 0, confirmations: tx.confirmations || 0, delta: (ownValue(tx.vout || []) - ownValue(tx.vin || [])).toString(), amount: (peer.sent ? (tx.vout || []).filter((io) => !(io.addresses || []).some((a) => historyMine.has(a.toLowerCase()))).reduce((n, io) => n + BigInt(io.value || "0"), 0n) : ownValue(tx.vout || [])).toString(), fee: tx.fees || "0", ...peer }; }).sort((a, b) => b.time - a.time),
    page, hasMore: page < (first.totalPages || 1), changeAddresses: [...changes], addressPaths: Object.fromEntries([...mine].filter(([a, d]) => d.index >= 200 && (changes.has(a) || utxos.some((u) => u.address === a))).map(([a, d]) => [a, `${accountPath(network)}/${d.branch}/${d.index}`])),
    // reduce, not Math.max(...spent): a full scan can return more transactions than a call accepts as arguments.
    scanHeight: spent.reduce((height, tx) => (tx.confirmations || 0) > 0 ? Math.max(height, tx.blockHeight || 0) : height, options.fromHeight || 0), time: Date.now(), indexer: at[0]
  };
}
// Fee rates are in atomic units per 1000 vbytes, as in the native app (BlockbookClient.estimateFeePerKB).
// Floor ~1 sat/vB (the relay minimum); the ceiling guards against an absurd indexer value.
export const FEE_MIN = 1000, FEE_MAX = 10000000, FEE_FALLBACK = 50000;
/// The node's estimate for confirming within `blocks` blocks (Blockbook returns PRL/kB); null when the
/// request fails or the node can't estimate (its "-1" sentinel).
export async function nodeFeeEstimate(network: Network, blocks: number, bases = indexers(network)): Promise<number | null> {
  try {
    const data = await request<{ result: unknown }>(network, `/api/v1/estimatefee/${blocks}`, undefined, 10000, bases);
    if ((typeof data.result !== "string" && typeof data.result !== "number") || typeof data.result === "string" && !data.result.trim()) return null;
    const value = Number(data.result);
    // 1 PRL/kB is already ten times the ceiling.
    return Number.isFinite(value) && value > 0 ? Math.floor(Math.min(value, 1) * 100000000) : null;
  } catch { return null; }
}
/// The median fee rate of each of the last `count` blocks that had transactions besides the coinbase
/// (`/feestats/` is ~150 bytes a block). Empty when the tip or every block's stats couldn't be read.
export async function recentBlockMedianFees(network: Network, count = 6, bases = indexers(network)): Promise<number[]> {
  let tip: unknown, at = bases;
  try {
    const status = await requestFrom<{ blockbook?: { bestHeight?: unknown } }>(bases, "/api/v2/", undefined, 10000);
    tip = status.data.blockbook?.bestHeight; at = pinned(network, status.base);
  } catch { return []; }
  if (typeof tip !== "number" || !Number.isSafeInteger(tip) || tip <= 0) return [];
  const heights = Array.from({ length: Math.min(count, tip) }, (_, i) => tip - i);
  const medians = await Promise.all(heights.map(async (height) => {
    try {
      const stats = await request<{ txCount?: unknown; decilesFeePerKb?: unknown }>(network, `/api/v2/feestats/${height}`, undefined, 10000, at);
      if (typeof stats.txCount !== "number" || stats.txCount <= 0 || !Array.isArray(stats.decilesFeePerKb) || stats.decilesFeePerKb.length !== 11) return null;
      const median = Number(stats.decilesFeePerKb[5]);
      return Number.isFinite(median) && median > 0 ? Math.floor(median) : null;
    } catch { return null; }
  }));
  return medians.filter((median): median is number => median != null);
}
/// The node's 2-block estimate is the default, but it can sit far above what blocks actually take: on
/// 2026-10-20 the official node asked ~1,955 sat/vB while every recent block was including 1 sat/vB
/// transactions (its estimator was skewed by a mempool still holding transactions mined hours earlier).
/// So it is capped at the higher of the 6-block estimate and recent blocks' median fee; real congestion
/// raises both, a skewed estimator doesn't. Same rule as the native app.
export function chooseFeePerKB(fast: number | null, slow: number | null, recentMedians: number[]) {
  const cap = Math.max(slow ?? 0, ...recentMedians.slice(0, 64), 0);
  const rate = fast != null ? (cap > 0 ? Math.min(fast, cap) : fast) : cap > 0 ? cap : FEE_FALLBACK;
  return Math.min(FEE_MAX, Math.max(FEE_MIN, rate));
}
/// The fee rate for a send. Never fails: `estimated` is false only when nothing at all could be learned
/// about fees and the default rate is used.
/// `prefer`: the indexer the balance on screen came from (the others stay the fallback).
export async function estimateFee(network: Network, prefer?: string): Promise<{ fee: number; estimated: boolean }> {
  const bases = pinned(network, prefer);
  const [fast, slow, medians] = await Promise.all([nodeFeeEstimate(network, 2, bases), nodeFeeEstimate(network, 6, bases), recentBlockMedianFees(network, 6, bases)]);
  return { fee: chooseFeePerKB(fast, slow, medians), estimated: fast != null || slow != null || medians.length > 0 };
}
