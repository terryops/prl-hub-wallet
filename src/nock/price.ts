// NOCK → USD from CoinGecko, the price Iris shows and the native app's NockPriceManager uses. A public
// GET with no wallet data in it; kept five minutes. Read by the page only while NOCK is on screen.
const KEY = "nock.price", FRESH_MS = 5 * 60000, KEEP_MS = 60 * 60000;
const URL = "https://api.coingecko.com/api/v3/simple/price?ids=nockchain&vs_currencies=usd";

export async function loadNockPrice(): Promise<number | undefined> {
  const saved = (await chrome.storage.local.get(KEY).catch(() => ({})) as Record<string, { usd?: number; at?: number } | undefined>)[KEY];
  const age = saved?.at ? Date.now() - saved.at : Infinity;
  if (saved?.usd && age < FRESH_MS) return saved.usd;
  try {
    const response = await fetch(URL, { credentials: "omit", referrerPolicy: "no-referrer", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(15000) });
    const usd = response.ok ? (await response.json())?.nockchain?.usd : undefined;
    if (typeof usd === "number" && Number.isFinite(usd) && usd > 0) {
      await chrome.storage.local.set({ [KEY]: { usd, at: Date.now() } }).catch(() => {});
      return usd;
    }
  } catch { /* Offline: the last price for a while, then none. */ }
  return saved?.usd && age < KEEP_MS ? saved.usd : undefined;
}
