// Read-only wallets (iOS WalletRecord.watchAddress, prl-hub c14f2e6 / 97097a7): a wallet that is only an
// address, kept in the vault next to the seed wallets, and its part in the account's web 钱包 page.
import { derived, isAddress, xpub, type VaultData, type Wallet } from "./wallet.ts";

/// Each wallet's mainnet main address (#0), for the account's web 钱包 page: deriving it reads the seed's
/// PBKDF2 again, so it is kept for the worker's lifetime.
const mainnetMain = new Map<string, string>();
export function mainnetAddress(w: Wallet) {
  if (w.watch) return isAddress(w.watch, "mainnet") ? w.watch : undefined;
  let a = mainnetMain.get(w.id);
  if (!a) { a = derived(xpub(w.mnemonic, "mainnet"), "mainnet", 0, 0).address!; mainnetMain.set(w.id, a); }
  return a;
}
/// The wallet's rows for the account's web 钱包 page (shared/android-host.ts walletRows).
export const webRows = (data: VaultData) => data.wallets.flatMap((w) => { const addr = mainnetAddress(w); return addr ? [{ addr, label: w.name, watch: !!w.watch }] : []; });
/// What the web 钱包 page changed about this device's read-only wallets (shared/android-host.ts
/// mergeWallets), applied to the vault's list. Wallets with their seed here are never touched.
/// `skipped` collects added addresses it couldn't take in (invalid, or the list is full).
export function applyWebWallets(data: VaultData, changes: { added?: { addr: string; label: string }[]; renamed?: Record<string, string>; removed?: string[] }, skipped: string[] = []) {
  let changed = false;
  for (const [addr, label] of Object.entries(changes.renamed || {})) {
    const name = String(label).trim().slice(0, 40), w = data.wallets.find((x) => x.watch === addr);
    if (name && w && w.name !== name) { w.name = name; changed = true; }
  }
  for (const a of changes.added || []) {
    if (typeof a?.addr !== "string") continue;
    if (data.wallets.some((x) => x.watch === a.addr || mainnetAddress(x) === a.addr)) continue;
    if (data.wallets.length >= 10 || !isAddress(a.addr, "mainnet")) { skipped.push(a.addr); continue; }
    const name = String(a.label || "").trim().slice(0, 40);
    data.wallets.push({ id: crypto.randomUUID(), name: name || watchName(data), mnemonic: "", receiveIndex: 0, watch: a.addr });
    changed = true;
  }
  const removed = new Set(changes.removed || []);
  const before = data.wallets.length;
  data.wallets = data.wallets.filter((w) => !(w.watch && removed.has(w.watch)));
  if (data.wallets.length !== before) {
    changed = true;
    if (!data.wallets.some((w) => w.id === data.selected)) data.selected = data.wallets[0]?.id || "";
  }
  return changed;
}
/// "只读钱包", "只读钱包 2", … — the first such name no wallet uses (iOS suggestedWatchName); the page
/// passes its own language's word, this is the fallback for one the web brought without a name.
export function watchName(data: VaultData, base = "Watch Wallet") {
  const used = new Set(data.wallets.map((w) => w.name));
  let name = base;
  for (let n = 2; used.has(name); n++) name = `${base} ${n}`;
  return name;
}
/// A seed wallet just restored here supersedes a read-only one watching its main address (iOS
/// WalletStore.cacheMainAddress, e.g. after 转账 → 用助记词恢复钱包).
export function supersede(data: VaultData, w: Wallet) {
  const main = derived(xpub(w.mnemonic, data.network), data.network, 0, 0).address!;
  data.wallets = data.wallets.filter((x) => x.watch !== main);
}
