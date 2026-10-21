// The send confirmation's figures, as in the native app's receipt (prl-hub Sources/Wallet/SendConfirmSheet.swift).
import { formatAmount } from "./wallet.ts";

/// A network fee above this gets its own warning: 5 × the native app's 0.001 PRL send reserve
/// (prl-hub WalletStore.sendFeeReserve × highFeeReserveMultiple), in atoms.
export const HIGH_FEE = 500_000n;
export const feeIsHigh = (fee: string | bigint) => BigInt(fee) > HIGH_FEE;

/// The address in 4-character groups, to check piece by piece against the receiving wallet.
export function addressGroups(address: string) {
  const groups: string[] = [];
  for (let i = 0; i < address.length; i += 4) groups.push(address.slice(i, i + 4));
  return groups;
}

/// Atoms as PRL, grouped like the balance (1,234.5), with up to the chain's 8 decimals and no trailing zeros.
export function receiptAmount(value: string | bigint, locale: string) {
  const atoms = BigInt(value), [whole, fraction] = formatAmount(atoms < 0n ? -atoms : atoms).split(".");
  const grouped = (atoms < 0n ? "−" : "") + new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(BigInt(whole));
  const digits = fraction.replace(/0+$/, "");
  if (!digits) return grouped;
  const decimal = new Intl.NumberFormat(locale).formatToParts(1.1).find((part) => part.type === "decimal")?.value || ".";
  return grouped + decimal + digits;
}
