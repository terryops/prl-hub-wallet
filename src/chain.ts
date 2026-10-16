import { addressMap, accountPath, derived, outpoint, isAddress, registerAddressPath, type Network, type UTXO } from "./wallet.ts";
export const origin = (network: Network) => network === "mainnet" ? "https://blockbook.pearlresearch.ai" : "https://blockbook.testnet.pearlresearch.ai";
export type IO = { addresses?: string[]; value?: string; hex?: string };
export type ChainTx = { txid: string; blockHeight?: number; blockTime?: number; confirmations?: number; fees?: string; vin?: IO[]; vout?: IO[] };
type Account = { balance: string; unconfirmedBalance: string; transactions?: ChainTx[]; page?: number; totalPages?: number; tokens?: { name: string; path?: string }[] };
export type Snapshot = { network: Network; walletId: string; balance: string; pending: string; utxos: UTXO[]; history: { txid: string; time: number; confirmations: number; delta: string; amount?: string; fee?: string; address?: string; sent?: boolean }[]; page: number; hasMore: boolean; changeAddresses: string[]; addressPaths?: Record<string, string>; scanHeight?: number; time: number };
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
  constructor(message: string, status: number) { super(message); this.status = status; }
}
export async function request<T>(network: Network, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(origin(network) + path, { ...init, signal: AbortSignal.timeout(25000), cache: "no-store", credentials: "omit", redirect: "error" });
  const body = await response.text();
  if (body.length > 12000000) throw new Error("链上响应过大，请稍后重试。");
  let data;
  try { data = JSON.parse(body); } catch { throw new Error("链上服务暂时不可用。"); }
  if (!response.ok || data.error) throw new ChainError(typeof data.error === "string" ? data.error.slice(0, 160) : "链上服务暂时不可用。", response.status);
  return data;
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
export async function loadAccount(publicKey: string, network: Network, walletId: string, knownChange: string[], page = 1, scan = false, options: { paths?: Record<string, string>; fromHeight?: number; active?: () => void } = {}): Promise<Snapshot> {
  for (const [address, path] of Object.entries(options.paths || {})) registerAddressPath(publicKey, network, address, path);
  const mine = addressMap(publicKey, network), changes = new Set(knownChange.filter((a) => mine.get(a)?.branch === 1));
  changes.add(derived(publicKey, network, 1, 0).address!);
  const historyPage = (path: string) => {
    options.active?.();
    return request<Account>(network, path);
  };
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
        const utxos = await request<UTXO[]>(network, `/api/v2/utxo/${a}`);
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
  const utxoGroups = [await request<UTXO[]>(network, `/api/v2/utxo/${publicKey}`)];
  for (const u of utxoGroups[0]) if (u.address) {
    const address = u.address.toLowerCase();
    const d = u.path ? registerAddressPath(publicKey, network, address, u.path) : mine.get(address);
    if (d?.branch === 1) changes.add(address);
  }
  const changeHistory: ChainTx[] = [];
  for (const address of changes) {
    const [utxos, history] = await Promise.all([
      request<UTXO[]>(network, `/api/v2/utxo/${address}`),
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
    scanHeight: spent.reduce((height, tx) => (tx.confirmations || 0) > 0 ? Math.max(height, tx.blockHeight || 0) : height, options.fromHeight || 0), time: Date.now()
  };
}
export async function estimateFee(network: Network) {
  const data = await request<{ result: unknown }>(network, "/api/v1/estimatefee/2");
  if ((typeof data.result !== "string" && typeof data.result !== "number") || typeof data.result === "string" && !data.result.trim()) throw new Error("手续费率超出范围。");
  const value = Number(data.result);
  if (!Number.isFinite(value) || value <= 0) throw new Error("手续费率超出范围。");
  return Math.min(10000000, Math.max(1000, Math.floor(value * 100000000)));
}
