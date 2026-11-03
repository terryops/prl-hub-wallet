// NOCK is opt-in on Android, as in the iOS app since 2.1.9 (NockWalletStore.enabled): off until switched on in
// 设置 → 钱包与安全, for this device. Off means no NOCK key is derived, no node is asked and the wallet page has no
// NOCK entry; saved NOCK history stays for when it is switched back on. No key and no network here: this only
// reads what the NOCK service stored (service.ts State), so the page can use it without loading the NOCK core.

/// iOS NockWalletStore.enabledKey.
export const NOCK_ENABLED = "nock.enabled";
/// The wallet page's old "close the NOCK line" (iOS NockInlineLink.hiddenKey), gone with the switch.
export const NOCK_LINK_HIDDEN = "nock.linkHidden";
const STATE_PREFIX = "nock.state.";

/// iOS NockWalletStore.State.usesNock, on a stored state: its NOCK address was shown, or it holds or has held NOCK.
export function usesNock(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  const s = raw as { addressShown?: unknown; balance?: { total?: unknown }; history?: unknown };
  if (s.addressShown === true || (Array.isArray(s.history) && s.history.length > 0)) return true;
  try { return typeof s.balance?.total === "string" && BigInt(s.balance.total) > 0n; } catch { return false; }
}

/// Whether NOCK is on here: as last set; before that ever happened (the first run of the build that made NOCK
/// opt-in), on only where a wallet on this device already uses it, so nobody loses sight of NOCK they hold. That
/// first answer is saved, and the old closed-line flag dropped (iOS NockWalletStore.initialEnabled).
export async function loadNockEnabled(): Promise<boolean> {
  const saved = (await chrome.storage.local.get(NOCK_ENABLED))[NOCK_ENABLED];
  if (typeof saved === "boolean") return saved;
  const all = await chrome.storage.local.get(null);
  const on = Object.entries(all).some(([key, value]) => key.startsWith(STATE_PREFIX) && usesNock(value));
  await chrome.storage.local.set({ [NOCK_ENABLED]: on });
  await chrome.storage.local.remove(NOCK_LINK_HIDDEN);
  return on;
}

/// 设置 → 钱包与安全 → NOCK 钱包.
export const saveNockEnabled = (on: boolean) => chrome.storage.local.set({ [NOCK_ENABLED]: on });
