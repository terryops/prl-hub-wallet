import type { Lang } from "./i18n/index.ts";
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
export async function loadMarket(signal: AbortSignal): Promise<Market> {
  const [price, fx] = await Promise.allSettled([get("price", signal), get("fx", signal)]);
  const p = price.status === "fulfilled" ? price.value : null, r = fx.status === "fulfilled" ? fx.value : null;
  // Same freshness boundary as AlertQuote.isFresh; stale prices must not look current.
  if (!p || typeof p.usd !== "number" || !Number.isFinite(p.usd) || p.usd <= 0 || typeof p.ts !== "number" || !Number.isFinite(p.ts) || Date.now() / 1000 - p.ts >= 300 || p.ts > Date.now() / 1000 + 60) return {};
  const rates = r?.ok === true && r.base === "USD" && r.stale !== true && r.rates && typeof r.rates === "object" ? Object.fromEntries(currencies.flatMap(({ code }) => typeof r.rates[code] === "number" && Number.isFinite(r.rates[code]) && r.rates[code] > 0 ? [[code, r.rates[code]]] : [])) : undefined;
  return { usd: p.usd, rates };
}
