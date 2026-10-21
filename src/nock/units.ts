// NOCK amounts. Nicks are integers: 1 NOCK = 65,536 nicks (2^16), so a nick is 2^-16 NOCK, which
// BigInt arithmetic holds exactly. Same rules as the native app's NockCore.swift.

/// 1 NOCK = 2^16 nicks.
export const NICKS_PER_NOCK = 65536n;

/// Typed NOCK amounts take at most this many decimals (a nick is ~0.0000153 NOCK).
export const TYPED_DECIMALS = 6;

/// The nearest whole nick to a typed NOCK amount ("1234.5", "0,25"), or null when it isn't one:
/// digits with at most one decimal mark and TYPED_DECIMALS decimals.
export function parseNock(raw: string): bigint | null {
  const text = raw.trim().replace(",", ".");
  if (!/^\d+(\.\d*)?$|^\.\d+$/.test(text)) return null;
  const [whole = "", fraction = ""] = text.split(".");
  if (fraction.length > TYPED_DECIMALS) return null;
  const scale = 10n ** BigInt(TYPED_DECIMALS);
  const units = BigInt(whole || "0") * scale + BigInt(fraction.padEnd(TYPED_DECIMALS, "0"));
  // Round half up to a whole nick.
  const nicks = (units * NICKS_PER_NOCK * 2n + scale) / (scale * 2n);
  return nicks > 2n ** 63n - 1n ? null : nicks;
}

/// Nicks as decimal digits: whole part and up to `decimals` fraction digits, rounded down, no trailing zeros.
function digits(nicks: bigint, decimals: number) {
  const whole = nicks / NICKS_PER_NOCK, rest = nicks % NICKS_PER_NOCK;
  const fraction = (rest * 10n ** BigInt(decimals) / NICKS_PER_NOCK).toString().padStart(decimals, "0").replace(/0+$/, "");
  return { whole, fraction };
}

/// What the send form takes back ("1234.567812"): plain, ungrouped, rounded down to TYPED_DECIMALS
/// places so it always parses again.
export function plainNock(nicks: bigint | string) {
  const { whole, fraction } = digits(BigInt(nicks), TYPED_DECIMALS);
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

/// "1,234.5678": grouped for `locale`, up to `decimals` places, rounded down (as the native app shows it).
export function formatNock(nicks: bigint | string, locale: string, decimals = 6) {
  const n = BigInt(nicks), { whole, fraction } = digits(n < 0n ? -n : n, decimals);
  const grouped = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(whole);
  const mark = new Intl.NumberFormat(locale).formatToParts(1.1).find((part) => part.type === "decimal")?.value || ".";
  return (n < 0n ? "−" : "") + grouped + (fraction ? mark + fraction : "");
}

/// NOCK as a JavaScript number, for prices only.
export const nockNumber = (nicks: bigint | string) => Number(BigInt(nicks)) / Number(NICKS_PER_NOCK);
