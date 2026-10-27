// What the Android app page offers the wallet frame (same origin, window.parent.__pearlApp).
// The wallet follows the app's language, currency and appearance, keeps its address book in
// the app's configuration (so Pro accounts sync it like the native app's), and asks the app
// to open other tabs.
import type { Lang } from "./types.ts";

export type HostPrefs = { lang: Lang; secondary: string; theme: "light" | "dark"; palette: "classic" | "mono" };
export type PearlHost = {
  prefs(): HostPrefs;
  contacts(): unknown[];
  setContacts(next: unknown[]): void;
  subscribe(listener: () => void): () => void;
  openPage(hash: string): void;
  // The 钱包 tab is on screen with nothing over it (the wallet's one-time donation ask waits for that).
  visible?(): boolean;
  // The wallet's iOS one-line links: 价格提醒 (Pro, live rules) and 桌面小组件 (hidden once one is placed).
  alerts?(): { pro: boolean; active: number; ready?: boolean };
  widgetPlaced?(): boolean;
  open?(target: "alerts" | "widgets"): void;
};

declare global {
  interface Window { __pearlApp?: PearlHost }
}

export function pearlHost(): PearlHost | undefined {
  try { return window.parent !== window ? window.parent.__pearlApp : window.__pearlApp; }
  catch { return undefined; }
}

type Row = { id: string; updated: number; deleted?: boolean; name?: string; address?: string; note?: string; [key: string]: unknown };
const content = (c: Partial<Row>) => JSON.stringify([c.name, c.address, c.note]);

// The wallet writes its whole live list; the configuration keeps change stamps and deletion
// tombstones so another device's edits merge instead of being overwritten.
export function contactsFromWallet<T extends { id: string; updated: number; deleted?: boolean }>(current: T[], next: unknown[], stamp: () => number): T[] {
  const byId = new Map((current as unknown as Row[]).map((c) => [c.id, c]));
  const seen = new Set<string>();
  const rows: Row[] = [];
  for (const raw of next) {
    const row = raw as Partial<Row> | null;
    if (!row || typeof row.id !== "string" || !/^[A-Za-z0-9-]{1,64}$/.test(row.id) || seen.has(row.id)) continue;
    seen.add(row.id);
    const old = byId.get(row.id);
    const { updated: _updated, deleted: _deleted, ...fields } = row;
    if (old && !old.deleted && content(old) === content(fields)) rows.push(old);
    else rows.push({ ...old, ...fields, id: row.id, deleted: undefined, updated: Math.max(stamp(), (old?.updated || 0) + 1) } as Row);
  }
  for (const old of current as unknown as Row[]) {
    if (seen.has(old.id)) continue;
    rows.push(old.deleted ? old : { ...old, deleted: true, updated: Math.max(stamp(), old.updated + 1) });
  }
  return rows.map((r) => { if (r.deleted === undefined) { const { deleted: _d, ...rest } = r; return rest as Row; } return r; }) as unknown as T[];
}

// What the wallet frame offers the app page (window.__pearlWallet in the frame): the 设置 tab's
// 钱包与安全 and Pearl 网络 pages, as in the iOS app, drive the wallet through it.
export type WalletTarget = "wallets" | "contacts" | "backup" | "recover" | "remove";
export type WalletState = { exists: boolean; locked: boolean; count: number; network: "mainnet" | "testnet" | null;
  // The selected wallet's main mainnet address while unlocked (我的监控's 用我的钱包地址).
  address?: string | null };
export type WalletControl = {
  state(): WalletState;
  open(target: WalletTarget): void;
  lock(): void;
  setNetwork(network: "mainnet" | "testnet"): Promise<boolean>;
  subscribe(listener: () => void): () => void;
  // A quiet chain refresh when the 钱包 tab comes back into view (iOS refreshes on appear and on foreground).
  refresh?(): void;
};

declare global {
  interface Window { __pearlWallet?: WalletControl }
}
