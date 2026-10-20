import * as btc from "@scure/btc-signer";
import { hex } from "@scure/base";

// 交易详情 and 交易查询: one transaction as the indexer sees it, like the native app's TxDetail
// (prl-hub Sources/WalletKit/TxDetail.swift) and the web's transaction lookup.

/// One input or output. `address` is null for OP_RETURN data (`data`) and other scripts without
/// exactly one address. `mine`: on one of this wallet's addresses. Amounts are atomic units.
export type TxRow = { address: string | null; value: string; data: boolean; mine: boolean };
export type TxDetail = {
  txid: string;
  confirmations: number;
  /// null while unconfirmed.
  height: number | null;
  /// The block's time in seconds; for a mempool transaction, when the indexer first saw it.
  time: number | null;
  /// Sum of the outputs.
  value: string;
  fee: string;
  coinbase: boolean;
  /// Empty for a coinbase.
  inputs: TxRow[];
  outputs: TxRow[];
  /// What the transaction did to this wallet's addresses (their outputs minus their inputs); null
  /// when it touches none of them.
  net: string | null;
  /// Unconfirmed, not a coinbase, and the indexer returned the signed transaction for 重新广播.
  rebroadcast: boolean;
};

/// A txid typed or pasted as-is (any case, spaces around it), or inside an explorer link such as
/// https://blockbook.pearlresearch.ai/tx/<txid>. null when there is none.
export function parseTxid(input: string): string | null {
  const s = input.trim();
  if (/^[0-9a-f]{64}$/i.test(s)) return s.toLowerCase();
  const match = /\/tx\/([0-9a-f]{64})(?![0-9a-z])/i.exec(s);
  return match ? match[1].toLowerCase() : null;
}

/// The txid of a signed transaction's raw bytes; null when they don't parse.
export function rawTxid(raw: string): string | null {
  try {
    if (!/^(?:[0-9a-f]{2})+$/i.test(raw)) return null;
    return btc.Transaction.fromRaw(hex.decode(raw.toLowerCase()), { allowUnknownInputs: true, allowUnknownOutputs: true, disableScriptCheck: true }).id;
  } catch { return null; }
}

/// Rows on this wallet's addresses first, each group in its original order.
export const ownFirst = (rows: TxRow[]) => [...rows.filter((r) => r.mine), ...rows.filter((r) => !r.mine)];

type IO = { addresses?: unknown; isAddress?: unknown; value?: unknown; hex?: unknown; coinbase?: unknown };
const atoms = (value: unknown) => typeof value === "string" && /^\d{1,19}$/.test(value) ? BigInt(value).toString() : "0";
const count = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;

/// Blockbook's /api/v2/tx/<txid> answer; null when it isn't that transaction.
export function txDetail(raw: unknown, txid: string, own: ReadonlySet<string>): TxDetail | null {
  if (!raw || typeof raw !== "object") return null;
  const w = raw as { txid?: unknown; vin?: unknown; vout?: unknown; blockHeight?: unknown; confirmations?: unknown; blockTime?: unknown; value?: unknown; fees?: unknown; hex?: unknown };
  if (typeof w.txid !== "string" || w.txid.toLowerCase() !== txid || !Array.isArray(w.vin) || !Array.isArray(w.vout)) return null;
  const row = (io: IO): TxRow => {
    const addresses = Array.isArray(io?.addresses) ? io.addresses.filter((a): a is string => typeof a === "string") : [];
    const address = io?.isAddress !== false && addresses.length === 1 ? addresses[0].toLowerCase() : null;
    // An output script starting with OP_RETURN (0x6a) carries data, not coins.
    return { address, value: atoms(io?.value), data: address == null && typeof io?.hex === "string" && io.hex.startsWith("6a"), mine: address != null && own.has(address) };
  };
  const coinbase = w.vin.some((io: IO) => io?.coinbase != null);
  const inputs = coinbase ? [] : w.vin.map(row), outputs = w.vout.map(row);
  const confirmations = count(w.confirmations) ?? 0;
  const total = (rows: TxRow[]) => rows.reduce((sum, r) => sum + (r.mine ? BigInt(r.value) : 0n), 0n);
  const touched = inputs.some((r) => r.mine) || outputs.some((r) => r.mine);
  const signed = typeof w.hex === "string" ? w.hex.toLowerCase() : "";
  return {
    txid, confirmations,
    // A mempool transaction has no block yet (Blockbook reports height -1 or 0).
    height: confirmations > 0 ? count(w.blockHeight) : null,
    time: count(w.blockTime),
    value: typeof w.value === "string" && /^\d{1,19}$/.test(w.value) ? atoms(w.value) : outputs.reduce((sum, r) => sum + BigInt(r.value), 0n).toString(),
    fee: atoms(w.fees), coinbase, inputs, outputs,
    net: touched ? (total(outputs) - total(inputs)).toString() : null,
    rebroadcast: confirmations === 0 && !coinbase && !!signed && rawTxid(signed) === txid,
  };
}
