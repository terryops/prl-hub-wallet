import { HDKey } from "@scure/bip32";
import { generateMnemonic, validateMnemonic, mnemonicToSeedSync } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import * as btc from "@scure/btc-signer";
import { hex } from "@scure/base";

export type Network = "mainnet" | "testnet";
export type UTXO = { txid: string; vout: number; value: string; address?: string; path?: string; confirmations?: number };
export type Wallet = { id: string; name: string; mnemonic: string; receiveIndex: number; changeAddresses?: Partial<Record<Network, string[]>>; addressPaths?: Partial<Record<Network, Record<string, string>>>; scanHeight?: Partial<Record<Network, number>> };
export type Pending = { txid: string; hex: string; walletId: string; network: Network; to: string; amount: string; fee: string; inputs: string[]; time: number; status: "unknown" | "submitted" | "rejected" };
export type VaultData = { wallets: Wallet[]; selected: string; network: Network; pending: Pending[] };
export const versions = (network: Network) => network === "mainnet"
  ? { public: 0x04b24746, private: 0x04b2430c }
  : { public: 0x045f1cf6, private: 0x045f18bc };
export const chain = (network: Network) => ({ ...btc.NETWORK, bech32: network === "mainnet" ? "prl" : "tprl" });
// OysterMobile does not call InitKeyScopes: its testnet facade retains coin 808276.
export const accountPath = (_network: Network) => "m/86'/808276'/0'";
export const normalizeMnemonic = (text: string) => text.normalize("NFKD").trim().toLowerCase().split(/\s+/).join(" ");
export function checkedMnemonic(text: string) {
  const m = normalizeMnemonic(text);
  if (![12, 24].includes(m.split(" ").length) || !validateMnemonic(m, wordlist)) throw new Error("助记词无效，请检查单词和顺序。");
  return m;
}
export const newMnemonic = () => generateMnemonic(wordlist, 128);
export function account(mnemonic: string, network: Network) {
  const seed = mnemonicToSeedSync(checkedMnemonic(mnemonic));
  const root = HDKey.fromMasterSeed(seed, versions(network));
  seed.fill(0);
  try { return root.derive(accountPath(network)); }
  finally { root.wipePrivateData(); }
}
export function xpub(mnemonic: string, network: Network) {
  const a = account(mnemonic, network);
  try { return a.publicExtendedKey; } finally { a.wipePrivateData(); }
}
export function derived(publicKey: string, network: Network, branch = 0, index = 0) {
  if (![0, 1].includes(branch) || !Number.isSafeInteger(index) || index < 0 || index >= 0x80000000) throw new Error("地址索引无效。");
  const child = HDKey.fromExtendedKey(publicKey, versions(network)).deriveChild(branch).deriveChild(index);
  const internal = child.publicKey!.slice(1);
  return { ...btc.p2tr(internal, undefined, chain(network)), branch, index };
}
export function isAddress(address: string, network: Network) {
  try { return btc.Address(chain(network)).decode(address).type === "tr"; } catch { return false; }
}
export function parseAmount(text: string): bigint {
  const s = text.trim().replace(",", ".");
  if (!/^\d+(\.\d{0,8})?$/.test(s)) throw new Error("金额最多保留 8 位小数。");
  const [whole, fraction = ""] = s.split(".");
  const value = BigInt(whole) * 100000000n + BigInt(fraction.padEnd(8, "0"));
  if (value > 9223372036854775807n) throw new Error("金额过大。");
  return value;
}
export function formatAmount(value: string | bigint) {
  const n = BigInt(value), sign = n < 0n ? "−" : "", a = n < 0n ? -n : n;
  return sign + (a / 100000000n).toString() + "." + (a % 100000000n).toString().padStart(8, "0").replace(/0+$/, "").padEnd(2, "0");
}
export const outpoint = (u: UTXO) => `${u.txid}:${u.vout}`;
const addressCache = new Map<string, Map<string, ReturnType<typeof derived>>>();
export function addressMap(publicKey: string, network: Network) {
  const key = `${network}:${publicKey}`;
  if (!addressCache.has(key)) {
    const result = new Map<string, ReturnType<typeof derived>>();
    // Covers the native app's legacy change indices, as well as its receive rotation.
    for (let branch = 0; branch < 2; branch++) for (let index = 0; index < 200; index++) {
      const d = derived(publicKey, network, branch, index);
      result.set(d.address!, d);
    }
    addressCache.set(key, result);
    if (addressCache.size > 12) addressCache.delete(addressCache.keys().next().value!);
  }
  return addressCache.get(key)!;
}
function checkedUTXOs(utxos: UTXO[], publicKey: string, network: Network) {
  const mine = addressMap(publicKey, network), seen = new Set<string>();
  return utxos.map((u) => {
    if (!/^[a-f0-9]{64}$/.test(u.txid) || !Number.isSafeInteger(u.vout) || u.vout < 0 || u.vout > 0xffffffff || !/^\d+$/.test(u.value) || BigInt(u.value) <= 0n || BigInt(u.value) > 9223372036854775807n || seen.has(outpoint(u))) throw new Error("交易输入无效。");
    seen.add(outpoint(u));
    const address = u.address?.toLowerCase();
    const d = address ? u.path ? registerAddressPath(publicKey, network, address, u.path) : mine.get(address) : undefined;
    if (!d) throw new Error("交易输入不属于此钱包，或地址索引超出支持范围。");
    return { ...u, address, d };
  });
}
// Testnet Blockbook labels paths with coin type 1 although the keys are derived under 808276
// (see accountPath). Only branch and index are used, and the derived address must still match.
const pathPattern = { mainnet: /^m\/86'\/808276'\/0'\/([01])\/(\d+)$/, testnet: /^m\/86'\/(?:808276|1)'\/0'\/([01])\/(\d+)$/ };
export function registerAddressPath(publicKey: string, network: Network, address: string, path?: string) {
  const match = path?.match(pathPattern[network]);
  if (!match) { if (path != null) throw new Error("地址路径无效。"); return undefined; }
  const known = addressMap(publicKey, network).get(address.toLowerCase());
  if (known && known.branch === Number(match[1]) && known.index === Number(match[2])) return known;
  const d = derived(publicKey, network, Number(match[1]), Number(match[2]));
  if (d.address !== address.toLowerCase()) throw new Error("地址路径无效。");
  addressMap(publicKey, network).set(d.address!, d);
  return d;
}
export function feeFor(nIn: number, nOut: number, feePerKB: number) {
  if (!Number.isSafeInteger(feePerKB) || feePerKB < 1000 || feePerKB > 10000000) throw new Error("手续费率超出范围。");
  // Same reservation and integer rounding as OysterMobile.
  return BigInt(Math.floor((11 + nIn * 58 + nOut * 43) * feePerKB / 1000));
}
const MAX_INPUTS = 1000;
function economicInputs<T extends UTXO>(utxos: T[], feePerKB: number): T[] {
  feeFor(0, 1, feePerKB); // Validate even when the pool is empty.
  return utxos.filter(u => {
    if (!/^\d+$/.test(u.value) || BigInt(u.value) <= 0n || BigInt(u.value) > 9223372036854775807n) throw new Error("交易输入无效。");
    // Spending an input adds 58 reserved bytes. Leave coins whose value cannot
    // cover that cost; including them can turn a funded send into a deficit.
    return BigInt(u.value) * 1000n > 58n * BigInt(feePerKB);
  });
}
export function maxAmount(utxos: UTXO[], feePerKB: number) {
  const spendable = economicInputs(utxos, feePerKB);
  if (spendable.length > MAX_INPUTS) throw new Error("输入数量过多，请分批转账。");
  const total = spendable.reduce((sum, u) => sum + BigInt(u.value), 0n);
  const fee = feeFor(spendable.length, 1, feePerKB);
  return total > fee ? total - fee : 0n;
}
export function planTransaction(publicKey: string, network: Network, to: string, amount: bigint, feePerKB: number, utxos: UTXO[]) {
  if (!isAddress(to, network)) throw new Error("收款地址无效或网络不匹配。");
  to = to.toLowerCase();
  if (amount < 330n || amount > 9223372036854775807n) throw new Error("转账金额至少为 0.00000330 PRL。");
  const selected: ReturnType<typeof checkedUTXOs> = [];
  // Validate ownership and duplicates across the entire pool before selecting.
  const spendable = economicInputs(checkedUTXOs(utxos, publicKey, network), feePerKB);
  // A fragmented wallet can still fund a small payment. For large pools prefer
  // larger inputs so an affordable payment does not hit the transaction limit.
  if (spendable.length > MAX_INPUTS) spendable.sort((a, b) => BigInt(a.value) > BigInt(b.value) ? -1 : BigInt(a.value) < BigInt(b.value) ? 1 : 0);
  let total = 0n;
  for (const u of spendable) {
    if (selected.length === MAX_INPUTS) {
      if (total >= amount + feeFor(selected.length, 1, feePerKB)) break;
      throw new Error("输入数量过多，请分批转账。");
    }
    selected.push(u); total += BigInt(u.value);
    if (total >= amount + feeFor(selected.length, 2, feePerKB)) break;
  }
  if (!selected.length || total < amount + feeFor(selected.length, 1, feePerKB)) throw new Error("可用余额不足。");
  const remaining = total - amount - feeFor(selected.length, 2, feePerKB);
  const change = remaining >= 330n ? remaining : 0n;
  const fee = total - amount - change;
  return { to, amount, fee, change, selected, changeAddress: derived(publicKey, network, 1, 0).address!, feePerKB };
}
export function signTransaction(mnemonic: string, network: Network, plan: ReturnType<typeof planTransaction>) {
  const a = account(mnemonic, network);
  try {
    const rebuilt = planTransaction(a.publicExtendedKey, network, plan.to, plan.amount, plan.feePerKB, plan.selected);
    if (rebuilt.fee !== plan.fee || rebuilt.change !== plan.change) throw new Error("交易预览已变化，请重新确认。");
    const tx = new btc.Transaction({ version: 2, lockTime: 0 });
    for (const u of rebuilt.selected) tx.addInput({ txid: u.txid, index: u.vout, sequence: 0xffffffff, witnessUtxo: { script: u.d.script, amount: BigInt(u.value) }, tapInternalKey: u.d.tapInternalKey });
    tx.addOutputAddress(rebuilt.to, rebuilt.amount, chain(network));
    if (rebuilt.change) tx.addOutputAddress(rebuilt.changeAddress, rebuilt.change, chain(network));
    for (let i = 0; i < rebuilt.selected.length; i++) {
      const u = rebuilt.selected[i], child = a.deriveChild(u.d.branch).deriveChild(u.d.index);
      try { tx.signIdx(child.privateKey!, i, undefined, crypto.getRandomValues(new Uint8Array(32))); }
      finally { child.wipePrivateData(); }
    }
    tx.finalize();
    return { hex: hex.encode(tx.extract()), txid: tx.id, vsize: tx.vsize };
  } finally { a.wipePrivateData(); }
}
