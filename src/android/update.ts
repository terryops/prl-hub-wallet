// The iOS UpdateChecker's counterpart. The website APK reads pearlhub.net's latest.json; the Play build
// asks Google Play through the shell (update.check, StoreUpdate.kt). No wallet/account data is sent.
export const LATEST_URL = "https://pearlhub.net/downloads/android/latest.json";
export const UPDATE_KEY = "android.update", UPDATE_INTERVAL = 6 * 3600000;
export type LatestVersion = { versionCode: number; versionName: string; minSdk: number; url: string };
export type AppVersion = { flavor: "play" | "direct"; versionCode: number; sdkInt: number };
/// What the banner offers: Play tells only the newer version's code, so no name and no download link.
export type UpdateNotice = { versionCode: number; versionName?: string; url?: string };
export type StoreLookup = () => Promise<{ available: boolean; versionCode: number }>;
type Saved = { checkedAt?: number; latest?: LatestVersion; dismissed?: number };
type Storage = { get(key: string): Promise<Record<string, unknown>>; set(value: Record<string, unknown>): Promise<unknown> };
export function parseLatest(value: unknown): LatestVersion | undefined {
  if (!value || typeof value !== "object") return;
  const v = value as Record<string, unknown>;
  if (!Number.isSafeInteger(v.versionCode) || Number(v.versionCode) < 1 || typeof v.versionName !== "string" || !/^\d+(?:\.\d+){0,3}$/.test(v.versionName) || !Number.isInteger(v.minSdk) || Number(v.minSdk) < 26 || typeof v.url !== "string") return;
  try {
    const url = new URL(v.url);
    if (url.protocol !== "https:" || url.hostname !== "pearlhub.net" || url.port || url.username || url.password || !url.pathname.startsWith("/downloads/") || !url.pathname.endsWith(".apk") || url.search || url.hash) return;
    return { versionCode: Number(v.versionCode), versionName: v.versionName, minSdk: Number(v.minSdk), url: url.href };
  } catch { return; }
}
export function updateNotice(info: AppVersion, saved: Saved): LatestVersion | undefined {
  const latest = parseLatest(saved.latest);
  return info.flavor === "direct" && latest && latest.versionCode > info.versionCode && latest.versionCode !== saved.dismissed && latest.minSdk <= info.sdkInt ? latest : undefined;
}
export class UpdateChecker {
  private storage: Storage;
  private transport?: typeof fetch;
  private store?: StoreLookup;
  private checking?: Promise<LatestVersion | undefined>;
  // No stand-in transport: the global fetch at each call (a stored fetch called as a method throws "Illegal invocation").
  constructor(storage: Storage, transport?: typeof fetch, store?: StoreLookup) { this.storage = storage; this.transport = transport; this.store = store; }
  async check(info: AppVersion): Promise<UpdateNotice | undefined> {
    if (info.flavor === "play") return this.fromStore(info);
    if (info.flavor !== "direct") return;
    if (this.checking) return this.checking;
    this.checking = this.read(info).finally(() => { this.checking = undefined; });
    return this.checking;
  }
  private async read(info: AppVersion) {
    const raw = (await this.storage.get(UPDATE_KEY))[UPDATE_KEY];
    const saved: Saved = raw && typeof raw === "object" ? raw : {};
    const now = Date.now();
    if (typeof saved.checkedAt === "number" && now >= saved.checkedAt && now - saved.checkedAt < UPDATE_INTERVAL) return updateNotice(info, saved);
    // Include missing/failed files in the six-hour gate: an unpublished manifest stays quiet.
    const next = { ...saved, checkedAt: now };
    try {
      const init: RequestInit = { headers: { Accept: "application/json" }, credentials: "omit", cache: "no-store", signal: AbortSignal.timeout(15000) };
      const reply = await (this.transport ? this.transport(LATEST_URL, init) : fetch(LATEST_URL, init));
      if (reply.ok) {
        const latest = parseLatest(await reply.json());
        if (latest) next.latest = latest;
      }
    } catch { /* Offline, absent or malformed: keep a previously verified version, without an error UI. */ }
    // A dismissal while the fetch ran wins over its result.
    const current = (await this.storage.get(UPDATE_KEY))[UPDATE_KEY] as Saved | undefined;
    if (current?.dismissed !== undefined) next.dismissed = current.dismissed;
    await this.storage.set({ [UPDATE_KEY]: next });
    return updateNotice(info, next);
  }
  // Play answers locally (its own cache), so unlike the website's file this needs no six-hour gate.
  private async fromStore(info: AppVersion): Promise<UpdateNotice | undefined> {
    const reply = await this.store?.().catch(() => undefined);
    const code = reply?.available ? reply.versionCode : 0;
    if (!Number.isSafeInteger(code) || code <= info.versionCode) return;
    const saved = (await this.storage.get(UPDATE_KEY))[UPDATE_KEY] as Saved | undefined;
    return code === saved?.dismissed ? undefined : { versionCode: code };
  }
  async dismiss(versionCode: number) {
    const saved = (await this.storage.get(UPDATE_KEY))[UPDATE_KEY] as Saved | undefined;
    await this.storage.set({ [UPDATE_KEY]: { ...saved, dismissed: versionCode } });
  }
}
