import { createVault, keyFromPassword, open, seal, bytes64, type Envelope } from "./vault.ts";
import { checkedMnemonic, newMnemonic, xpub, derived, addressMap, parseAmount, planTransaction, signTransaction, maxAmount, outpoint, type Network, type VaultData, type Pending, type Wallet } from "./wallet.ts";
import { loadAccount, estimateFee, request, origin, notFound, alreadyKnown, type Snapshot } from "./chain.ts";
import { txDetail, rawTxid } from "./transactions.ts";
import { CONTACTS, saveContact, removeContact } from "./contacts.ts";
import { DONATION_ADDRESS, canDonate, donationAmount } from "./donation.ts";
import { CONTACT_LINK, syncContacts } from "./contact-sync.ts";
import { accountState, loginAccount, logoutAccount } from "./account.ts";
import { nativePost } from "./android/native.ts";
// Defined per module (not imported) so the Chrome build folds it even across shared chunks.
declare const __PEARL_ANDROID__: boolean | undefined;
const ANDROID = typeof __PEARL_ANDROID__ !== "undefined" && __PEARL_ANDROID__ === true;
const VAULT = "pearl.wallet.v1", SESSION = "wallet.session", REVIEW = "wallet.review", SNAPSHOT = "wallet.snapshot", LOCK_MS = 5 * 60000;
let lockEpoch = 0;
const assertEpoch = (epoch: number) => {
  if (epoch !== lockEpoch) throw new Error("操作已取消，钱包已锁定。");
};
type Session = { key: string; active: number };
type Review = { id: string; walletId: string; network: Network; to: string; amount: string; fee: string; change: string; feePerKB: number; utxos: Snapshot["utxos"]; expires: number; donation?: boolean };
type Message = { command: string; [key: string]: unknown };
const text = (v: unknown) => typeof v === "string" ? v : "";
const envelope = async () => (await chrome.storage.local.get(VAULT))[VAULT] as Envelope | undefined;
async function lock() {
  lockEpoch++; await chrome.storage.session.clear();
  const state = { exists: !!await envelope(), locked: true };
  void chrome.runtime.sendMessage({ event: "locked", state }).catch(() => {});
  return state;
}
async function session() {
  const epoch = lockEpoch;
  const s = (await chrome.storage.session.get(SESSION))[SESSION] as Session | undefined;
  assertEpoch(epoch);
  if (!s) throw new Error("钱包已锁定，请重新解锁。");
  if (Date.now() - s.active >= LOCK_MS) { await lock(); throw new Error("钱包已锁定，请重新解锁。"); }
  return s;
}
async function loaded() {
  const epoch = lockEpoch;
  const e = await envelope(); if (!e) throw new Error("尚未创建钱包。");
  const s = await session();
  const data = await open(e, bytes64.decode(s.key));
  assertEpoch(epoch);
  return { data, e, s };
}
async function save(data: VaultData) {
  const epoch = lockEpoch;
  const { e, s } = await loaded();
  const next = await seal(data, bytes64.decode(s.key), e.salt);
  assertEpoch(epoch);
  await chrome.storage.local.set({ [VAULT]: next });
}
async function passwordData(password: string) {
  const e = await envelope(); if (!e) throw new Error("尚未创建钱包。");
  const key = await keyFromPassword(password, bytes64.decode(e.salt));
  try { return await open(e, key); } finally { key.fill(0); }
}
async function status() {
  const epoch = lockEpoch;
  const exists = !!await envelope();
  try {
    const { data } = await loaded();
    const snapshot = (await chrome.storage.session.get(SNAPSHOT))[SNAPSHOT] as Snapshot | undefined;
    assertEpoch(epoch);
    return { exists, locked: false, network: data.network, selected: data.selected,
      wallets: data.wallets.map((w) => { const key = xpub(w.mnemonic, data.network); return { id: w.id, name: w.name, index: w.receiveIndex, primaryAddress: derived(key, data.network, 0, 0).address, address: derived(key, data.network, 0, w.receiveIndex).address }; }),
      pending: data.pending.filter((p) => p.walletId === data.selected && p.network === data.network).map(({ hex: _hex, inputs: _inputs, ...p }) => p),
      snapshot: snapshot?.walletId === data.selected && snapshot.network === data.network ? snapshot : undefined };
  } catch { return { exists, locked: true }; }
}
async function refresh(page = 1, scan = false) {
  const epoch = lockEpoch;
  const { data } = await loaded(), w = data.wallets.find((w) => w.id === data.selected)!;
  const snapshot = await loadAccount(xpub(w.mnemonic, data.network), data.network, w.id, w.changeAddresses?.[data.network] || [], page, scan, { paths: w.addressPaths?.[data.network], fromHeight: w.scanHeight?.[data.network], active: () => assertEpoch(epoch) });
  const current = await loaded();
  assertEpoch(epoch);
  if (current.data.selected !== w.id || current.data.network !== data.network) throw new Error("钱包已切换，请刷新。");
  const wallet = current.data.wallets.find(wallet => wallet.id === w.id)!;
  wallet.changeAddresses = { ...wallet.changeAddresses, [data.network]: snapshot.changeAddresses };
  wallet.addressPaths = { ...wallet.addressPaths, [data.network]: snapshot.addressPaths };
  wallet.scanHeight = { ...wallet.scanHeight, [data.network]: snapshot.scanHeight };
  const confirmed = new Set<Pending>();
  for (const pending of current.data.pending.filter(p => p.walletId === w.id && p.network === data.network)) {
    let tx = snapshot.history.find(tx => tx.txid === pending.txid);
    if (!tx) {
      try {
        tx = await request<Snapshot["history"][number]>(pending.network, `/api/v2/tx/${pending.txid}`);
      } catch { /* Offline/not-found is inconclusive; retain the input reservation. */ }
    }
    assertEpoch(epoch);
    if (tx?.txid !== pending.txid || !Number.isSafeInteger(tx.confirmations) || tx.confirmations < 0) continue;
    if (tx.confirmations > 0) confirmed.add(pending);
    else pending.status = "submitted";
  }
  current.data.pending = current.data.pending.filter(p => !confirmed.has(p));
  await save(current.data);
  const previous = (await chrome.storage.session.get(SNAPSHOT))[SNAPSHOT] as Snapshot | undefined;
  assertEpoch(epoch);
  const same = previous?.walletId === w.id && previous.network === data.network;
  // A page-1 refresh keeps the older pages loaded with 加载更多 only while its first page still reaches a
  // transaction that was already confirmed: everything older than that was loaded before, so nothing is
  // skipped. Unconfirmed entries are not carried over, since they may have left the mempool.
  const keep = same && previous.page > 1 && snapshot.history.some((tx) => (previous.history.find((old) => old.txid === tx.txid)?.confirmations || 0) > 0);
  if (same && (page > 1 || keep)) {
    const history = new Map(previous.history.filter((tx) => page > 1 || tx.confirmations > 0).map((tx) => [tx.txid, tx]));
    snapshot.history.forEach((tx) => history.set(tx.txid, tx));
    snapshot.history = [...history.values()].sort((a, b) => b.time - a.time);
    if (page === 1) { snapshot.page = previous.page; snapshot.hasMore = previous.hasMore; }
  }
  await chrome.storage.session.set({ [SNAPSHOT]: snapshot });
  return snapshot;
}
async function broadcast(p: Pending) {
  // Persisted before POST. A lost reply leaves this exact transaction available for
  // checking/retry and keeps its inputs reserved; never build a replacement silently.
  try {
    const response = ANDROID ? await nativePost(origin(p.network) + "/api/v2/sendtx/", p.hex, "text/plain")
      : await fetch(origin(p.network) + "/api/v2/sendtx/", { method: "POST", body: p.hex, headers: { "Content-Type": "text/plain" }, credentials: "omit", redirect: "error", signal: AbortSignal.timeout(25000) });
    const body = await response.json();
    if (response.ok && body.result === p.txid || typeof body.error === "string" && alreadyKnown(body.error)) return "submitted" as const;
    if (typeof body.error === "string" && /min relay fee|mempool min fee|insufficient fee|inputs-missingorspent|mandatory-script-verify-flag-failed|bad-txns-/i.test(body.error)) {
      // Spent inputs are also what a retry of this transaction reports once it is mined.
      if (!/inputs-missingorspent/i.test(body.error)) return "rejected" as const;
      try {
        const tx = await request<{ txid: string; confirmations: number }>(p.network, `/api/v2/tx/${p.txid}`);
        return tx?.txid === p.txid ? "submitted" as const : "unknown" as const;
      } catch (e) {
        if (notFound(e)) return "rejected" as const;
      }
    }
  } catch { /* Ambiguous transport outcome: keep the original transaction. */ }
  return "unknown" as const;
}
/// The open wallet's addresses this extension knows: the derived ones it signs for, change found on the
/// internal chain, and addresses registered from the indexer's derivation paths.
function ownAddresses(w: Wallet, network: Network) {
  const own = new Set(addressMap(xpub(w.mnemonic, network), network).keys());
  for (const a of w.changeAddresses?.[network] || []) own.add(a.toLowerCase());
  for (const a of Object.keys(w.addressPaths?.[network] || {})) own.add(a.toLowerCase());
  return own;
}
/// 重新广播 from 交易详情: send a transaction the indexer already holds to the network again. Sending the
/// same transaction twice is safe, so this needs no password and keeps no record.
async function pushTx(network: Network, hex: string, txid: string): Promise<{ outcome: "sent" | "known" | "rejected" | "unknown" | "notSent"; reason?: string }> {
  if (rawTxid(hex) !== txid) return { outcome: "notSent" };
  let response: { ok: boolean; status: number; json: () => Promise<unknown> };
  try {
    response = ANDROID ? await nativePost(origin(network) + "/api/v2/sendtx/", hex, "text/plain")
      : await fetch(origin(network) + "/api/v2/sendtx/", { method: "POST", body: hex, headers: { "Content-Type": "text/plain" }, credentials: "omit", redirect: "error", signal: AbortSignal.timeout(30000) });
  } catch { return { outcome: "unknown" }; }
  // Turned away before any node saw it (rate or size limit, unknown path): certainly not relayed.
  if ([401, 403, 404, 413, 429].includes(response.status)) return { outcome: "notSent" };
  let body: { result?: unknown; error?: unknown };
  try { body = (await response.json() || {}) as typeof body; } catch { return { outcome: "unknown" }; }
  if (response.ok && body.result === txid) return { outcome: "sent" };
  // Only a JSON error from the indexer is the node's verdict; anything else says nothing about the transaction.
  if (typeof body.error === "string" && body.error.trim()) return alreadyKnown(body.error) ? { outcome: "known" } : { outcome: "rejected", reason: body.error.slice(0, 300) };
  return { outcome: "unknown" };
}
let queue: Promise<unknown> = Promise.resolve();
function enqueue<T>(work: () => Promise<T>): Promise<T> {
  const result = queue.then(work);
  queue = result.catch(() => {});
  return result;
}
async function handle(m: Message, epoch: number) {
  if (m.command === "account-state" || m.command === "contact-link") return accountState();
  // Signing in waits on the browser's sign-in window outside the queue; its contact sync must not
  // interleave with contact-save/remove, which write the same list.
  if (m.command === "account-login") { await loginAccount(m.importLocal === true); return enqueue(() => syncContacts(() => {})); }
  if (m.command === "account-logout" || m.command === "contact-disconnect") return logoutAccount();
  const stillActive = () => assertEpoch(epoch);
  stillActive();
  if (m.command === "status") return status();
  if (m.command === "touch") {
    const s = await session(); await chrome.storage.session.set({ [SESSION]: { ...s, active: Date.now() } }); return {};
  }
  if (m.command === "generate") return { mnemonic: newMnemonic() };
  if (m.command === "unlock") {
    const e = await envelope(); if (!e) throw new Error("尚未创建钱包。");
    const key = await keyFromPassword(text(m.password), bytes64.decode(e.salt));
    try {
      await open(e, key);
      stillActive();
      await chrome.storage.session.set({ [SESSION]: { key: bytes64.encode(key), active: Date.now() } });
    } finally { key.fill(0); }
    return status();
  }
  if (m.command === "create") {
    const mnemonic = checkedMnemonic(text(m.mnemonic)), name = text(m.name).trim().slice(0, 40) || "我的钱包";
    const e = await envelope();
    let data: VaultData;
    if (e) { await session(); data = await passwordData(text(m.password)); }
    else data = { wallets: [], selected: "", network: "mainnet", pending: [] };
    if (data.wallets.length >= 10) throw new Error("最多管理 10 个钱包。");
    if (data.wallets.some((w) => w.mnemonic === mnemonic)) throw new Error("这个钱包已经添加。");
    const id = crypto.randomUUID(); data.wallets.push({ id, name, mnemonic, receiveIndex: 0 }); data.selected = id;
    stillActive();
    if (e) await save(data);
    else {
      const { envelope: next, key } = await createVault(data, text(m.password));
      try {
        stillActive();
        await chrome.storage.local.set({ [VAULT]: next });
        stillActive();
        await chrome.storage.session.set({ [SESSION]: { key: bytes64.encode(key), active: Date.now() } });
      } finally { key.fill(0); }
    }
    await chrome.storage.session.remove([SNAPSHOT, REVIEW]); return status();
  }
  const { data } = await loaded(), w = data.wallets.find((w) => w.id === data.selected)!;
  if ((m.expectedWalletId !== undefined && m.expectedWalletId !== data.selected) ||
      (m.expectedNetwork !== undefined && m.expectedNetwork !== data.network))
    throw new Error("钱包或网络已切换，请重新操作。");
  if (m.command === "contact-sync") return syncContacts(stillActive);
  // Android home-screen widget: the public key and change addresses it refreshes the balance from.
  if (ANDROID && m.command === "widget-keys") return { xpub: xpub(w.mnemonic, data.network), changeAddresses: w.changeAddresses?.[data.network] || [] };
  if (m.command === "contact-save" || m.command === "contact-remove") {
    const raw = (await chrome.storage.local.get(CONTACTS))[CONTACTS];
    const contacts = m.command === "contact-save"
      ? saveContact(raw, { id: text(m.id) || undefined, name: text(m.name), address: text(m.address), note: text(m.note) }, data.network)
      : removeContact(raw, text(m.id));
    stillActive();
    await chrome.storage.local.set({ [CONTACTS]: contacts });
    return {};
  }
  if (m.command === "select" || m.command === "network") {
    if (m.command === "select") {
      if (!data.wallets.some((w) => w.id === m.id)) throw new Error("钱包不存在。"); data.selected = text(m.id);
    } else {
      if (!["mainnet", "testnet"].includes(text(m.network))) throw new Error("网络无效。"); data.network = m.network as Network;
    }
    await save(data); await chrome.storage.session.remove([SNAPSHOT, REVIEW]); return status();
  }
  if (m.command === "rename") {
    const name = text(m.name).trim(); if (!name || name.length > 40) throw new Error("钱包名称应为 1–40 个字符。");
    w.name = name; await save(data); return status();
  }
  if (m.command === "receive") { w.receiveIndex = (w.receiveIndex + 1) % 10; await save(data); return status(); }
  if (m.command === "backup") {
    const verified = await passwordData(text(m.password));
    stillActive(); await session();
    return { mnemonic: verified.wallets.find((x) => x.id === w.id)!.mnemonic };
  }
  if (m.command === "delete") {
    await passwordData(text(m.password));
    stillActive(); await session();
    if (text(m.name) !== w.name) throw new Error("请输入准确的钱包名称。");
    if (data.pending.some((p) => p.walletId === w.id)) throw new Error("此钱包仍有待确认交易，请先核对链上状态。");
    data.wallets = data.wallets.filter((x) => x.id !== w.id);
    if (!data.wallets.length) { await chrome.storage.local.remove(VAULT); return lock(); }
    data.selected = data.wallets[0].id; await save(data); await chrome.storage.session.remove([SNAPSHOT, REVIEW]); return status();
  }
  if (m.command === "password") {
    await passwordData(text(m.password));
    const { envelope: next, key } = await createVault(data, text(m.nextPassword));
    try {
      stillActive();
      await chrome.storage.local.set({ [VAULT]: next });
      stillActive();
      await chrome.storage.session.set({ [SESSION]: { key: bytes64.encode(key), active: Date.now() } });
    } finally { key.fill(0); }
    await chrome.storage.session.remove(REVIEW); return status();
  }
  if (m.command === "refresh") { await refresh(Number.isSafeInteger(m.page) ? Number(m.page) : 1, m.scan === true); return status(); }
  if (m.command === "fee") return estimateFee(data.network);
  if (m.command === "tx-detail" || m.command === "tx-rebroadcast") {
    const txid = text(m.txid);
    if (!/^[0-9a-f]{64}$/.test(txid)) throw new Error("请输入交易 ID：64 位，由 0–9 和 a–f 组成。");
    let raw: unknown;
    try { raw = await request(data.network, `/api/v2/tx/${txid}`, undefined, 20000); }
    catch (e) {
      if (notFound(e)) { if (m.command === "tx-detail") return { found: false }; throw new Error("没有找到这笔交易。刚发出的交易可能要稍等片刻才能查到。"); }
      throw new Error("操作未完成，请重试。");
    }
    stillActive();
    const tx = txDetail(raw, txid, ownAddresses(w, data.network));
    if (!tx) throw new Error("操作未完成，请重试。");
    if (m.command === "tx-detail") return { found: true, tx };
    // Mined since the page was drawn: the network has it.
    if (tx.confirmations > 0) return { outcome: "known" };
    if (!tx.rebroadcast) throw new Error("操作未完成，请重试。");
    return pushTx(data.network, (raw as { hex: string }).hex.toLowerCase(), txid);
  }
  if (m.command === "prepare") {
    if (m.donation === true && !canDonate(data.network, derived(xpub(w.mnemonic, data.network), data.network, 0, 0).address!, derived(xpub(w.mnemonic, data.network), data.network, 0, w.receiveIndex).address!)) throw new Error("当前钱包不能捐赠。");
    const snapshot = await refresh(1, m.recovery === true);
    const refreshed = (await loaded()).data;
    const reserved = new Set(refreshed.pending.filter((p) => p.network === data.network).flatMap((p) => p.inputs));
    const utxos = snapshot.utxos.filter((u) => (u.confirmations || 0) > 0 && !reserved.has(outpoint(u)) && (m.recovery !== true || snapshot.changeAddresses.includes(u.address || "")));
    if (m.recovery === true && !utxos.length) throw new Error("没有可归集的已确认找零。");
    const fee = Number(m.fee);
    const amount = m.donation === true ? donationAmount(text(m.amount)) : m.max === true || m.recovery === true ? maxAmount(utxos, fee) : parseAmount(text(m.amount));
    const to = m.recovery === true ? derived(xpub(w.mnemonic, data.network), data.network, 0, 0).address! : m.donation === true ? DONATION_ADDRESS : text(m.to).trim();
    const plan = planTransaction(xpub(w.mnemonic, data.network), data.network, to, amount, fee, utxos);
    const review: Review = { id: crypto.randomUUID(), walletId: w.id, network: data.network, to: plan.to, amount: amount.toString(), fee: plan.fee.toString(), change: plan.change.toString(), feePerKB: fee, utxos: plan.selected, expires: Date.now() + 3 * 60000 };
    if (m.donation === true) review.donation = true;
    await chrome.storage.session.set({ [REVIEW]: review });
    return { ...review, utxos: undefined, changeAddress: plan.changeAddress };
  }
  if (m.command === "send") {
    const review = (await chrome.storage.session.get(REVIEW))[REVIEW] as Review | undefined;
    if (!review || review.id !== m.id || review.expires < Date.now() || review.walletId !== w.id || review.network !== data.network) throw new Error("交易预览已过期，请重新确认。");
    if (review.donation && (review.to !== DONATION_ADDRESS || BigInt(review.amount) < 100000000n || !canDonate(data.network, derived(xpub(w.mnemonic, data.network), data.network, 0, 0).address!, derived(xpub(w.mnemonic, data.network), data.network, 0, w.receiveIndex).address!))) throw new Error("当前钱包不能捐赠。");
    await passwordData(text(m.password));
    stillActive();
    const snapshot = await refresh(), current = new Map(snapshot.utxos.map((u) => [outpoint(u), u]));
    for (const u of review.utxos) { const live = current.get(outpoint(u)); if (!live || live.value !== u.value || live.address !== u.address || !live.confirmations) throw new Error("可用输入已变化，请重新生成预览。"); }
    const plan = planTransaction(xpub(w.mnemonic, data.network), data.network, review.to, BigInt(review.amount), review.feePerKB, review.utxos);
    if (plan.fee.toString() !== review.fee || plan.change.toString() !== review.change) throw new Error("交易费用已变化，请重新确认。");
    const signed = signTransaction(w.mnemonic, data.network, plan);
    const latest = (await loaded()).data;
    const p: Pending = { ...signed, walletId: w.id, network: data.network, to: review.to, amount: review.amount, fee: review.fee, inputs: review.utxos.map(outpoint), time: Date.now(), status: "unknown" };
    if (latest.pending.some((old) => old.network === p.network && old.inputs.some((key) => p.inputs.includes(key)))) throw new Error("这些输入已有待确认交易。");
    latest.pending.push(p); await save(latest); await chrome.storage.session.remove(REVIEW);
    stillActive(); await session();
    p.status = await broadcast(p); await save(latest);
    return { ...await status(), sent: p.txid, outcome: p.status };
  }
  if (m.command === "check" || m.command === "retry" || m.command === "discard") {
    const p = data.pending.find((p) => p.txid === m.txid && p.walletId === w.id && p.network === data.network);
    if (!p) throw new Error("待确认交易不存在。");
    if (m.command === "discard") {
      if (m.acknowledge !== true) throw new Error("请确认移除记录的风险。");
      await passwordData(text(m.password));
      stillActive(); await session();
      data.pending = data.pending.filter((x) => x !== p);
      await chrome.storage.session.remove(REVIEW);
    } else if (m.command === "retry") {
      await passwordData(text(m.password));
      stillActive(); await session();
      p.status = await broadcast(p);
    }
    else {
      try {
        const tx = await request<{ txid: string; confirmations: number }>(p.network, `/api/v2/tx/${p.txid}`);
        if (tx?.txid !== p.txid) throw new Error("链上交易编号不一致。");
        if (!Number.isSafeInteger(tx.confirmations) || tx.confirmations < 0) throw new Error("链上服务暂时不可用。");
        if (tx.confirmations > 0) data.pending = data.pending.filter((x) => x !== p);
        else p.status = "submitted";
      } catch (e) {
        // Not found alone cannot prove a broadcast failed. Keep its reservation
        // until the user explicitly discards it, including rejected transactions.
        if (!notFound(e)) throw e;
        if (p.status !== "rejected") p.status = "unknown";
      }
    }
    await save(data); return status();
  }
  throw new Error("操作无效。");
}
// Only our packaged wallet page can invoke the signing interface. No web-page
// provider, content script, externally_connectable route or arbitrary URL relay.
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id || sender.url?.split("?")[0].split("#")[0] !== chrome.runtime.getURL("index.html") || !message || typeof message.command !== "string") return false;
  if (message.command === "lock") { lock().then((data) => reply({ ok: true, data }), () => reply({ ok: false, error: "锁定失败。" })); return true; }
  const epoch = lockEpoch;
  // Transaction lookups only read: they neither wait behind a refresh or send nor hold one up.
  const independent = ["account-login", "account-state", "contact-link", "tx-detail", "tx-rebroadcast"].includes(message.command);
  const work = independent ? handle(message, epoch) : enqueue(() => handle(message, epoch));
  work.then((data) => reply({ ok: true, data }), (error) => reply({ ok: false, error: error instanceof Error ? error.message : "操作失败。" }));
  return true;
});
async function setup() {
  await chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  if (!await chrome.alarms.get("wallet.lock")) await chrome.alarms.create("wallet.lock", { periodInMinutes: 1 });
}
chrome.runtime.onInstalled.addListener(() => { void setup(); });
chrome.runtime.onStartup.addListener(() => { void lock(); void setup(); });
chrome.alarms.onAlarm.addListener(() => { void session().catch(() => {}); });
void setup();
