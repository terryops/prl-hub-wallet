// The NOCK side of the open wallet, run by the background (background.ts), as the native app's
// NockWalletStore.swift. The account comes from the same seed as the PRL wallet (passed in while it is
// unlocked); chain state from the public nodes (client.ts).
//
// The node keeps no history per address, so the wallet keeps its own: a row for each note it sees
// arrive, plus the sends it broadcast. That state (address, last balance, history, sends in flight) is
// kept per wallet in chrome.storage.local, unencrypted like the address book, and goes when the wallet
// is removed. It holds no key: the recovery phrase stays in the encrypted vault and signing happens
// here, from the phrase, each time.
import { base64 } from "@scure/base";
import { NockClient, noteId, isMiningReward, isRefusal, isAlreadyKnown, isTransient, secondNodeAllowed, NockRPCError, type NockNote, type TxDetails } from "./client.ts";
import { nockCall, deriveAccount, addressProblem, NockFailure, type NockAccount } from "./core.ts";
import { parseNock, plainNock } from "./units.ts";
import { NockError, errorText, type NockText } from "./errors.ts";

export type NockTx = {
  /// The txid for a send; "note:<name>" for a note that arrived.
  id: string;
  kind: "received" | "mined" | "sent";
  /// Nicks sent to the recipient, or received.
  amount: string;
  fee?: string;
  /// Recipient of a send.
  counterparty?: string;
  txId?: string;
  height?: number;
  /// ms. The block's own time when `timeExact`; otherwise estimated from the height until it is fetched.
  time: number;
  timeExact: boolean;
  status: "pending" | "confirmed" | "failed";
};
type PendingSend = {
  txId: string; recipient: string; amount: string; fee: string;
  /// What comes back to this wallet once mined: the change (or, sent to itself, everything but the fee).
  returning: string;
  inputs: string[];
  /// Our own outputs of this transaction: they arrive as notes but aren't income.
  changeNotes: string[];
  createdAt: number;
  /// A node acknowledged it (false: the broadcast's outcome is unknown).
  verified: boolean;
  status: NockTx["status"];
};
export type NockBalance = { total: string; available: string; locked: string };
type State = {
  address?: string; balance?: NockBalance; tip?: number; history: NockTx[];
  /// Notes already accounted for (a row, or our own change) → when last seen. Kept a few days after a note
  /// goes, so one that drops out of a single read doesn't come back as a second "received" row.
  seen: Record<string, number>;
  pending: PendingSend[];
  syncedAt?: number;
  /// The receive page showed this wallet's NOCK address (the person went to get it).
  addressShown?: boolean;
};
/// A signed send waiting for the person's confirmation: nothing has left the device yet.
type Prepared = { walletId: string; txId: string; recipient: string; amount: string; fee: string; change: string; returning: string; sweep: boolean; body: string; inputs: string[]; changeNotes: string[]; createdAt: number };

export type NockView = {
  address?: string; balance: NockBalance; hasBalance: boolean;
  /// What's shown is the last session's snapshot, until the first fresh read.
  balanceIsCached: boolean;
  /// A fresh read landed this session.
  backendReady: boolean;
  syncError?: NockText; syncedAt?: number; tip?: number;
  history: (NockTx & { confirmations?: number })[];
  /// The wallet uses NOCK: it fetched its address from the receive page, or holds or held NOCK. The wallet
  /// page then shows the NOCK strip where it otherwise shows only a one-line link.
  inUse: boolean;
  /// Blocks until the soonest locked block reward unlocks.
  blocksUntilNextUnlock?: number;
  hasPendingSend: boolean;
  /// A send whose broadcast nobody confirmed: no new send until it is settled.
  hasUnverifiedSend: boolean;
  /// How often the page reads again: faster while a send waits for its block (~150 s apart).
  pollMs: number;
  /// The extension: the last read failed for want of a node, and the second node isn't allowed yet; the page
  /// offers to allow it (nodes.ts).
  offerSecondNode: boolean;
};
export type PreparedView = { id: string; recipient: string; amount: string; fee: string; change: string; returning: string; sweep: boolean; feeIsHigh: boolean };

/// Seconds between blocks since Aletheia: only to estimate a time until the real one loads.
export const BLOCK_MS = 150000;
export const PREPARED_MS = 600000, DROP_AFTER_MS = 30 * 60000, HISTORY_LIMIT = 1000, SEEN_MS = 3 * 86400000, STALE_MS = 30000;
const REVIEW = "nock.review";
export const stateKey = (walletId: string) => `nock.state.${walletId}`;
const zero: NockBalance = { total: "0", available: "0", locked: "0" };

/// What lives only as long as the background does (the service worker may stop any time).
type Runtime = { generation: number; account?: NockAccount; notes?: NockNote[]; tip?: number; backendReady: boolean; syncError?: NockText; lastLoadAt?: number; loading?: Promise<void>; blockTimes: Map<number, number>;
  /// The last read failed because no node answered (not a node's own verdict).
  nodeDown?: boolean };
const runtimes = new Map<string, Runtime>();
let generations = 0;
const runtime = (walletId: string) => {
  let r = runtimes.get(walletId);
  if (!r) runtimes.set(walletId, r = { generation: ++generations, backendReady: false, blockTimes: new Map() });
  return r;
};

let client = new NockClient();
/// Tests: the nodes and transport.
export function setClient(next: NockClient) { client = next; runtimes.clear(); }

async function readState(walletId: string): Promise<State> {
  const raw = (await chrome.storage.local.get(stateKey(walletId)))[stateKey(walletId)] as Partial<State> | undefined;
  // Lenient: a field added later must not make an older saved state unreadable.
  return { history: Array.isArray(raw?.history) ? raw.history : [], seen: raw?.seen && typeof raw.seen === "object" ? raw.seen : {}, pending: Array.isArray(raw?.pending) ? raw.pending : [],
    address: typeof raw?.address === "string" ? raw.address : undefined, balance: raw?.balance, tip: typeof raw?.tip === "number" ? raw.tip : undefined,
    syncedAt: typeof raw?.syncedAt === "number" ? raw.syncedAt : undefined, addressShown: raw?.addressShown === true };
}
/// Written only while the runtime that read it is still the wallet's: a wallet removed meanwhile stays removed.
async function writeState(walletId: string, generation: number, state: State) {
  if (runtimes.get(walletId)?.generation !== generation) return;
  await chrome.storage.local.set({ [stateKey(walletId)]: state });
}

/// Mutations of a wallet's state run one at a time (reads, sends, marks), so none overwrites another.
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(work: () => Promise<T>): Promise<T> {
  const result = queue.then(work);
  queue = result.catch(() => {});
  return result;
}

const sortHistory = (h: NockTx[]) => [...h].sort((a, b) => (a.status === "pending") !== (b.status === "pending") ? (a.status === "pending" ? -1 : 1) : b.time - a.time);
const inFlight = (s: State) => new Set(s.pending.filter((p) => p.status === "pending").flatMap((p) => p.inputs));
/// Inputs of unmined sends are spent as far as this wallet is concerned.
const liveNotes = (r: Runtime, s: State) => { const held = inFlight(s); return (r.notes || []).filter((n) => !held.has(noteId(n))); };
const sum = (values: string[]) => values.reduce((total, v) => total + BigInt(v), 0n);

function balanceOf(r: Runtime, s: State): NockBalance {
  const live = liveNotes(r, s);
  // Change of unmined sends is on its way back: counted in the total, spendable once mined.
  const change = sum(s.pending.filter((p) => p.status === "pending").map((p) => p.returning));
  return { total: (sum(live.map((n) => n.assets)) + change).toString(), available: sum(live.filter((n) => n.spendable).map((n) => n.assets)).toString(), locked: sum(live.filter((n) => !n.spendable && isMiningReward(n)).map((n) => n.assets)).toString() };
}

function view(r: Runtime, s: State, offerSecondNode = false): NockView {
  const fresh = r.backendReady && !!r.notes;
  const balance = fresh ? balanceOf(r, s) : s.balance || zero;
  const tip = fresh ? r.tip : s.tip;
  const locked = fresh && tip !== undefined ? liveNotes(r, s).filter((n) => !n.spendable && isMiningReward(n) && n.unlockHeight > tip).map((n) => n.unlockHeight - tip) : [];
  const hasPendingSend = s.pending.some((p) => p.status === "pending");
  return {
    address: r.account?.address ?? s.address, balance, hasBalance: fresh || !!s.balance, balanceIsCached: !fresh && !!s.balance, backendReady: r.backendReady,
    syncError: r.syncError, syncedAt: s.syncedAt, tip,
    history: sortHistory(s.history).map((tx) => ({ ...tx, confirmations: tx.status === "confirmed" && tx.height !== undefined && tip !== undefined && tip >= tx.height ? tip - tx.height + 1 : undefined })),
    inUse: !!s.addressShown || BigInt(balance.total) > 0n || s.history.length > 0,
    blocksUntilNextUnlock: locked.length ? Math.min(...locked) : undefined,
    hasPendingSend, hasUnverifiedSend: s.pending.some((p) => p.status === "pending" && !p.verified),
    pollMs: hasPendingSend ? 20000 : 60000,
    offerSecondNode,
  };
}

/// The page's view, from what is stored and what this session has read. No network, no key.
export async function nockStatus(walletId: string) {
  const r = runtime(walletId), s = await readState(walletId);
  return view(r, s, !!r.nodeDown && !await secondNodeAllowed());
}

/// The wallet's NOCK account (the address and the lock commitments the node indexes notes by).
async function account(walletId: string, mnemonic: string) {
  const r = runtime(walletId);
  if (r.account) return r.account;
  const generation = r.generation, derived = await deriveAccount(mnemonic);
  if (runtimes.get(walletId)?.generation !== generation) throw new NockError("钱包或网络已切换，已取消本次转账");
  r.account = derived;
  return derived;
}

/// Reads the chain for the wallet: balance, arrivals, and how its sends fared. Single-flight: a call while
/// one runs waits for that one. `stale`: skip the read when the last one is younger than that (ms).
export async function nockRefresh(walletId: string, mnemonic: string, stale = 0): Promise<NockView> {
  const r = runtime(walletId);
  const a = await account(walletId, mnemonic);
  await serial(async () => {
    const s = await readState(walletId);
    // The first derivation fills the address in. Defensive: a cache that belongs to another key must not
    // leak into this one.
    if (s.address !== a.address) await writeState(walletId, r.generation, s.address === undefined ? { ...s, address: a.address } : { history: [], seen: {}, pending: [], address: a.address });
  });
  if (!(stale && r.lastLoadAt && Date.now() - r.lastLoadAt < stale)) {
    r.loading ||= serial(() => load(walletId, r, a)).finally(() => { r.loading = undefined; });
    await r.loading;
  }
  return nockStatus(walletId);
}

async function load(walletId: string, r: Runtime, a: NockAccount, retried = false): Promise<void> {
  const generation = r.generation;
  const current = () => runtimes.get(walletId)?.generation === generation;
  try {
    const [plain, mined] = await Promise.all([client.notes(a.simpleFirstName, a.address), client.notes(a.coinbaseFirstName, a.address)]);
    if (!current()) return;
    const byId = new Map<string, NockNote>();
    for (const n of [...plain.notes, ...mined.notes]) byId.set(noteId(n), n);
    const tip = Math.max(plain.height, mined.height);
    const notes = [...byId.values()].sort((x, y) => y.originPage - x.originPage);
    const s = await readState(walletId);
    await reconcileSends(s, notes, current);
    if (!current()) return;
    r.notes = notes; r.tip = tip; r.backendReady = true; r.syncError = undefined; r.nodeDown = false; r.lastLoadAt = Date.now();
    s.tip = tip; s.syncedAt = Date.now();
    addArrivals(r, s, notes, tip);
    s.balance = balanceOf(r, s);
    await writeState(walletId, generation, s);
    // The balance is up; the rows' real block times follow (one request per ~21 h of blocks).
    await fillBlockTimes(walletId, r, s, tip).catch(() => {});
  } catch (error) {
    if (!current()) return;
    if (error instanceof NockRPCError && error.kind === "transport" && !r.backendReady && !retried) {
      // The first read of a session failing (network still waking up) tries once more shortly instead of
      // showing an error until the next poll.
      await new Promise((resolve) => setTimeout(resolve, 3000));
      return load(walletId, r, a, true);
    }
    r.syncError = errorText(error);
    r.nodeDown = isTransient(error);
    r.lastLoadAt = Date.now();
  }
}

/// Settle sends that got mined, give up on ones the nodes dropped, and take back a "dropped" one that made
/// it after all. After each wait the send is looked up again: a broadcast can't run meanwhile (same queue),
/// but a removed wallet ends it.
async function reconcileSends(s: State, notes: NockNote[], current: () => boolean) {
  const present = new Set(notes.map(noteId));
  for (const p of s.pending.filter((p) => p.status !== "confirmed")) {
    // Notes leave the balance only once a block spends them.
    const inputsGone = p.inputs.length > 0 && p.inputs.every((id) => !present.has(id));
    if (p.status === "failed") {
      if (!inputsGone) continue;
      // Given up on, but did it get mined (through another node)?
      const found = await lookup(p.txId);
      if (!current()) return;
      if (found && found !== "missing" && !found.pending) settle(s, p, found);
      continue;
    }
    if (inputsGone) {
      const found = await lookup(p.txId);
      if (!current()) return;
      if (found === "missing") markFailed(s, p);   // its notes went into another transaction: this one can never be mined
      else if (found && !found.pending) settle(s, p, found);
      continue;   // lookup failed, or the index hasn't caught up: ask again next time
    }
    // Still unmined: is a node holding it? A failed query changes nothing.
    let known: boolean | undefined;
    try { known = await client.accepted(p.txId); } catch { known = undefined; }
    if (!current()) return;
    if (known === true) p.verified = true;
    else if (known === false && Date.now() - p.createdAt > DROP_AFTER_MS) markFailed(s, p);
  }
  // Finished sends stay a few hours: their change may still arrive, a "dropped" one may still land.
  s.pending = s.pending.filter((p) => p.status === "pending" || Date.now() - p.createdAt <= 6 * 3600000);
}
/// The transaction as the explorer knows it; "missing" when not found, null when the lookup failed.
async function lookup(txId: string): Promise<TxDetails | "missing" | null> {
  try { return (await client.txDetails(txId)) ?? "missing"; } catch { return null; }
}
function settle(s: State, p: PendingSend, d: Extract<TxDetails, { pending: false }>) {
  p.status = "confirmed"; p.verified = true;
  const row = s.history.find((t) => t.id === p.txId);
  if (!row) return;
  row.status = "confirmed"; row.height = d.height;
  if (d.time) { row.time = d.time; row.timeExact = true; }
  if (d.fee) row.fee = d.fee;
}
function markFailed(s: State, p: PendingSend) {
  p.status = "failed";
  const row = s.history.find((t) => t.id === p.txId);
  if (row) row.status = "failed";
}

/// A row for each note seen for the first time (our own change excepted), timed from its height until
/// fillBlockTimes puts the block's own time in.
function addArrivals(r: Runtime, s: State, notes: NockNote[], tip: number) {
  const ownChange = new Set(s.pending.flatMap((p) => p.changeNotes)), rows = new Set(s.history.map((t) => t.id)), now = Date.now();
  for (const n of notes) {
    const id = noteId(n), firstSight = s.seen[id] === undefined;
    s.seen[id] = now;
    if (!firstSight || ownChange.has(id) || rows.has(`note:${id}`)) continue;
    const exact = r.blockTimes.get(n.originPage);
    s.history.push({ id: `note:${id}`, kind: isMiningReward(n) ? "mined" : "received", amount: n.assets, height: n.originPage, time: exact ?? now - Math.max(0, tip - n.originPage) * BLOCK_MS, timeExact: exact !== undefined, status: "confirmed" });
  }
  // A spent note never comes back (names are unique): forget it after a few days. A busy address keeps
  // its most recent rows only.
  s.seen = Object.fromEntries(Object.entries(s.seen).filter(([, at]) => now - at < SEEN_MS));
  s.history = sortHistory(s.history).slice(0, HISTORY_LIMIT);
}

/// Real block times for rows still on an estimate: the last ~3.5 days of blocks in at most four requests.
/// Older rows keep the estimate (shown as such).
async function fillBlockTimes(walletId: string, r: Runtime, s: State, tip: number) {
  const recent = s.history.flatMap((row) => !row.timeExact && row.height !== undefined && tip >= row.height && tip - row.height < 2000 ? [row.height] : []);
  if (!recent.length) return;
  const times = await client.blockTimes(Math.min(...recent));
  if (runtimes.get(walletId) !== r) return;
  for (const [h, t] of times) if (!r.blockTimes.has(h)) r.blockTimes.set(h, t);
  let changed = false;
  for (const row of s.history) {
    const t = !row.timeExact && row.height !== undefined ? r.blockTimes.get(row.height) : undefined;
    if (t !== undefined) { row.time = t; row.timeExact = true; changed = true; }
  }
  if (changed) { s.history = sortHistory(s.history); await writeState(walletId, r.generation, s); }
}

/// Marks the address as fetched from the receive page: getting it counts as starting to use NOCK.
export async function nockShown(walletId: string, mnemonic: string): Promise<NockView> {
  const r = runtime(walletId), a = await account(walletId, mnemonic);
  await serial(async () => {
    const s = await readState(walletId);
    if (s.address !== undefined && s.address !== a.address) return;
    if (s.addressShown && s.address) return;
    await writeState(walletId, r.generation, { ...s, address: a.address, addressShown: true });
  });
  return nockStatus(walletId);
}

/// Whether `address` can be paid, and whether it is this wallet's own.
export async function nockCheck(walletId: string, mnemonic: string, address: string) {
  const problem = await addressProblem(address);
  return { problem, own: !problem && address.trim() === (await account(walletId, mnemonic)).address };
}

const failure = (code: string) => new NockFailure(code, "");

/// Builds and signs a send on this device without broadcasting it: the confirmation shows the real fee.
/// `max` sends everything spendable (the fee comes out of it). The signed send waits in the session (it
/// goes when the wallet locks); nothing leaves the device until nockSend.
export function nockPrepare(walletId: string, mnemonic: string, to: string, amount: string, max: boolean, keep = true): Promise<{ prepared?: PreparedView; error?: NockText }> {
  return guarded(async () => {
    const recipient = to.trim();
    const problem = await addressProblem(recipient);
    if (problem) throw failure(problem);
    const nicks = max ? 0n : parseNock(amount);
    if (!max && !nicks) throw failure("zero_amount");
    const a = await account(walletId, mnemonic);
    // From a fresh read: the notes a send spends must be the chain's current ones.
    await nockRefresh(walletId, mnemonic, STALE_MS);
    const r = runtime(walletId);
    return serial(async () => {
      const s = await readState(walletId);
      if (!r.backendReady || r.tip === undefined || !r.notes) throw r.syncError ? new NockError(r.syncError.key, r.syncError.values) : new NockError("钱包未就绪");
      if (s.pending.some((p) => p.status === "pending" && !p.verified)) throw new NockError("上一笔转账是否发出尚未确认，请先查看交易记录，稍后再试");
      const spendable = liveNotes(r, s).filter((n) => n.spendable);
      if (!spendable.length) throw failure("no_funds");
      const generation = r.generation;
      const b = await nockCall<Record<string, unknown>>("buildSend", { mnemonic, account: 0, notes: spendable.map((n) => n.raw), recipient, sweep: max, height: r.tip, ...(max ? {} : { amount: nicks!.toString() }) });
      if (runtimes.get(walletId)?.generation !== generation || r.account !== a) throw new NockError("钱包或网络已切换，已取消本次转账");
      const text = (k: string) => typeof b[k] === "string" && /^\d+$/.test(b[k] as string) ? b[k] as string : "0";
      const names = (list: unknown, mine?: boolean) => (Array.isArray(list) ? list as Record<string, unknown>[] : []).flatMap((o) => typeof o.nameFirst === "string" && typeof o.nameLast === "string" && (mine === undefined || o.mine === mine) ? [`${o.nameFirst}/${o.nameLast}`] : []);
      if (typeof b.txId !== "string" || typeof b.body !== "string") throw new NockError("NOCK 钱包出错：{message}", { message: "build" });
      const p: Prepared = { walletId, txId: b.txId, recipient, amount: text("amount"), fee: text("fee"), change: text("change"), returning: text("returning"), sweep: max, body: b.body, inputs: names(b.inputs), changeNotes: names(b.outputs, true), createdAt: Date.now() };
      if (keep) await chrome.storage.session.set({ [REVIEW]: p });
      return { prepared: { id: p.txId, recipient: p.recipient, amount: p.amount, fee: p.fee, change: p.change, returning: p.returning, sweep: p.sweep, feeIsHigh: BigInt(p.amount) > 0n && BigInt(p.fee) * 10n >= BigInt(p.amount) } };
    });
  });
}

/// A public test key's address (the official wallet's `clutch inmate …` vector): MAX's quote is built to it
/// when the recipient isn't filled in yet. The quote is never broadcast.
const QUOTE_ADDRESS = "3b3eG8WgWHfXTeAMJzNDWxM3b6WFadxQiiJRQrY6zPJ4J2F5QtHjZRQ";

/// Everything spendable minus the fee for sending it all: what MAX puts in the amount field.
export async function nockMax(walletId: string, mnemonic: string, to: string): Promise<{ amount?: string; fee?: string; error?: NockText }> {
  // The recipient only shapes the output; any valid address quotes the same fee. Not the wallet's own: sending
  // everything to itself, the builder spends only some of the notes and the core refuses the sweep.
  const own = (await account(walletId, mnemonic)).address;
  const recipient = !(await addressProblem(to)) && to.trim() !== own ? to : QUOTE_ADDRESS;
  const r = await nockPrepare(walletId, mnemonic, recipient, "", true, false);
  return r.prepared ? { amount: plainNock(r.prepared.amount), fee: r.prepared.fee } : { error: r.error };
}

/// Broadcasts the prepared send `id` once `verify` (the password, or the device's lock screen on Android)
/// passes. The inputs are held before the request goes out: a read racing the broadcast must not offer them
/// to another send, and a lost reply must not free them. Only a node's own refusal frees them.
export function nockSend(walletId: string, id: string, verify: () => Promise<void>, active: () => void): Promise<{ outcome?: "sent" | "failed" | "unverified"; txId?: string; error?: NockText }> {
  return guarded(async () => {
    const p = (await chrome.storage.session.get(REVIEW))[REVIEW] as Prepared | undefined;
    if (!p || p.txId !== id || p.walletId !== walletId) throw new NockError("钱包或网络已切换，已取消本次转账");
    if (Date.now() - p.createdAt >= PREPARED_MS) throw new NockError("确认超时，请重新发送");
    await verify();
    active();
    const r = runtime(walletId), generation = r.generation;
    const recorded = await serial(async () => {
      const s = await readState(walletId);
      if (s.pending.some((x) => x.status === "pending" && !x.verified)) throw new NockError("上一笔转账是否发出尚未确认，请先查看交易记录，稍后再试");
      const held = inFlight(s);
      if (p.inputs.some((input) => held.has(input))) throw new NockError("确认超时，请重新发送");
      s.pending = s.pending.filter((x) => x.txId !== p.txId);
      s.pending.push({ txId: p.txId, recipient: p.recipient, amount: p.amount, fee: p.fee, returning: p.returning, inputs: p.inputs, changeNotes: p.changeNotes, createdAt: p.createdAt, verified: false, status: "pending" });
      s.history = sortHistory([...s.history.filter((t) => t.id !== p.txId), { id: p.txId, kind: "sent", amount: p.amount, fee: p.fee, counterparty: p.recipient, txId: p.txId, time: p.createdAt, timeExact: true, status: "pending" }]);
      if (r.backendReady) s.balance = balanceOf(r, s);
      await writeState(walletId, generation, s);
      await chrome.storage.session.remove(REVIEW);
      return runtimes.get(walletId)?.generation === generation;
    });
    if (!recorded) throw new NockError("钱包或网络已切换，已取消本次转账");
    const update = (change: (s: State) => void) => serial(async () => { const s = await readState(walletId); change(s); if (r.backendReady) s.balance = balanceOf(r, s); await writeState(walletId, generation, s); });
    const verified = () => update((s) => { const x = s.pending.find((x) => x.txId === p.txId); if (x) x.verified = true; });
    try {
      await client.send(base64.decode(p.body));
      await verified();
      return { outcome: "sent" as const, txId: p.txId };
    } catch (error) {
      // A node may have taken it even though the reply got lost (or it already had it).
      if (await client.accepted(p.txId).catch(() => false) || isAlreadyKnown(error)) { await verified(); return { outcome: "sent" as const, txId: p.txId }; }
      // Only the node's own refusal proves nothing went out. A gateway 5xx, a timeout or a reply that
      // didn't parse leaves it open: the transaction may be in. Never invite a resend.
      if (!isRefusal(error)) return { outcome: "unverified" as const, txId: p.txId, error: { key: "网络异常，无法确认转账是否已发出（{message}）。请先查看交易记录，切勿重复发送。", values: { message: errorText(error) } } };
      await update((s) => { s.pending = s.pending.filter((x) => x.txId !== p.txId); s.history = s.history.filter((t) => t.id !== p.txId); });
      return { outcome: "failed" as const, error: errorText(error) };
    }
  });
}

/// NOCK errors as values, which the page shows in its own language. Anything else (a wrong password, the
/// wallet locked or switched meanwhile) is the background's own message and goes back as for PRL.
async function guarded<T>(work: () => Promise<T>): Promise<T | { error: NockText }> {
  try { return await work(); }
  catch (error) {
    if (!(error instanceof NockError || error instanceof NockFailure || error instanceof NockRPCError)) throw error;
    return { error: errorText(error) };
  }
}

/// The wallet was removed from this device: its NOCK address, history and sends go too.
export async function nockForget(walletId: string) {
  runtimes.delete(walletId);
  await chrome.storage.local.remove(stateKey(walletId));
}
/// Every wallet was removed.
export async function nockForgetAll() {
  runtimes.clear();
  const keys = Object.keys(await chrome.storage.local.get(null)).filter((k) => k.startsWith("nock.state."));
  if (keys.length) await chrome.storage.local.remove(keys);
}
