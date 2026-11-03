import type { Lang } from "./i18n/index.ts";
import { loadFX, saveFX, FX_MAX_AGE, type FX } from "../shared/currency.ts";
type FXStore = Parameters<typeof loadFX>[0];
export const currencies = [
  { code: "CNY", symbol: "¥", decimals: 2 }, { code: "TWD", symbol: "NT$", decimals: 0 },
  { code: "HKD", symbol: "HK$", decimals: 2 }, { code: "RUB", symbol: "₽", decimals: 2 },
  { code: "VND", symbol: "₫", decimals: 0 }, { code: "IDR", symbol: "Rp", decimals: 0 },
  { code: "EUR", symbol: "€", decimals: 2 }, { code: "JPY", symbol: "¥", decimals: 0 },
  { code: "KRW", symbol: "₩", decimals: 0 }, { code: "GBP", symbol: "£", decimals: 2 },
  { code: "SGD", symbol: "S$", decimals: 2 }, { code: "AUD", symbol: "A$", decimals: 2 },
  { code: "CAD", symbol: "C$", decimals: 2 }, { code: "BRL", symbol: "R$", decimals: 2 }, { code: "TRY", symbol: "₺", decimals: 2 }, { code: "INR", symbol: "₹", decimals: 2 }, { code: "THB", symbol: "฿", decimals: 2 },
] as const;
export type Market = { usd?: number; rates?: Record<string, number>; stale?: boolean };
export const isSecondary = (value: unknown): value is string => value === "__auto__" || value === "" || currencies.some((c) => c.code === value);
export function secondaryCode(pref: string, lang: Lang) {
  return pref === "__auto__" ? ({ en: "", ru: "RUB", "zh-Hans": "CNY", "zh-Hant": "TWD", vi: "VND", id: "IDR", es: "EUR", "pt-BR": "BRL", fr: "EUR", de: "EUR", it: "EUR", tr: "TRY", ja: "JPY", ko: "KRW", hi: "INR", th: "THB" })[lang] : pref;
}
export function dualFiat(usd: number, pref: string, lang: Lang, rates: Record<string, number> = {}) {
  if (!Number.isFinite(usd)) return "—";
  const number = (value: number, decimals: number) => new Intl.NumberFormat(lang, { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(value);
  const primary = "$" + number(usd, 2), currency = currencies.find((c) => c.code === secondaryCode(pref, lang));
  const rate = currency && rates[currency.code];
  return currency && typeof rate === "number" && rate > 0 && Number.isFinite(rate * usd) ? primary + " · " + currency.symbol + number(usd * rate, currency.decimals) : primary;
}
// Public GETs only: no wallet data, auth, cookies or address parameters.
async function get(path: "price" | "fx", signal: AbortSignal) {
  const response = await fetch(`https://pearlhub.net/v1/${path}`, { credentials: "omit", referrerPolicy: "no-referrer", redirect: "error", cache: "no-store", signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]) });
  if (!response.ok) throw new Error("Market unavailable");
  return response.json();
}
// The table's rates for the wallet's currencies, if it is a current USD table.
function ratesOf(r: Partial<FX> | null | undefined): Record<string, number> | undefined {
  const all = r?.ok === true && r.base === "USD" && r.stale !== true && r.rates && typeof r.rates === "object" ? r.rates : undefined;
  return all && Object.fromEntries(currencies.flatMap(({ code }) => typeof all[code] === "number" && Number.isFinite(all[code]) && all[code] > 0 ? [[code, all[code]]] : []));
}
// Rates move little within a day, so they are asked at most once a day (as iOS's CurrencyManager and the
// website, shared/currency.ts); when a refresh fails the last table stays in use.
async function loadRates(signal: AbortSignal, store?: FXStore) {
  const cached = loadFX(store), last = ratesOf(cached?.fx);
  if (cached && last && Date.now() - cached.at < FX_MAX_AGE) return last;
  try {
    const fx = await get("fx", signal), rates = ratesOf(fx);
    if (rates) { saveFX(fx, Date.now(), store); return rates; }
  } catch { /* Fall back to the last table. */ }
  return last;
}
export async function loadMarket(signal: AbortSignal, store?: FXStore): Promise<Market> {
  const [p, rates] = await Promise.all([get("price", signal).catch(() => null), loadRates(signal, store)]);
  // Same freshness boundary as AlertQuote.isFresh; stale prices must not look current.
  if (!p || typeof p.usd !== "number" || !Number.isFinite(p.usd) || p.usd <= 0 || typeof p.ts !== "number" || !Number.isFinite(p.ts) || Date.now() / 1000 - p.ts >= 300 || p.ts > Date.now() / 1000 + 60) return {};
  return { usd: p.usd, rates };
}
