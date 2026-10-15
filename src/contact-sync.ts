import { normalizeConfig, mergeItems, configOf, defaults } from "../shared/store.ts";
import { accountAPI, accountState, accountGuard, saveAccountContacts, saveAccountPro, CONTACT_LINK } from "./account.ts";
import { CONTACTS, type Contact } from "./contacts.ts";
import { isAddress } from "./wallet.ts";
export { CONTACT_LINK };
type Link = { userId: string; base: Record<string, Contact>; lastSync?: number; localOnly?: string[] };
const syncable = (c: unknown): c is Contact => {
  const row = c as Contact | null;
  return !!row && typeof row.id === "string" && /^[A-Za-z0-9-]{1,64}$/.test(row.id) && typeof row.name === "string" && typeof row.note === "string" && typeof row.address === "string" && (isAddress(row.address, "mainnet") || isAddress(row.address, "testnet"));
};
export function contactChanges(contacts: unknown, base: Record<string, Contact>, now: number): (Contact & { updated: number; deleted?: boolean })[] {
  if (!Array.isArray(contacts)) throw new Error("同步配置无效。");
  const rows = contacts.filter(syncable);
  const stamp = (value: unknown): number => { if (value == null) return 0; if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER) return value; throw new Error("同步配置无效。"); };
  const content = (c: Contact) => JSON.stringify([c.name, c.address, c.note, c.deleted === true]);
  const changes = rows.map((c) => ({ ...c, updated: content(c) !== (base[c.id] && content(base[c.id])) ? Math.max(now, stamp(c.updated) + 1, stamp(base[c.id]?.updated) + 1) : stamp(base[c.id].updated) }));
  const live = new Set(contacts.map((c) => c?.id));
  return [...changes, ...Object.values(base).filter((c) => !live.has(c.id)).map((c) => ({ ...c, deleted: true, updated: c.deleted === true ? stamp(c.updated) : Math.max(now, stamp(c.updated) + 1) }))];
}
export async function syncContacts(active: () => void) {
  const guard = accountGuard();
  const account = await accountState();
  guard();
  if (!account.userId) throw new Error("account_required");
  const userId = account.userId;
  const profile = await accountAPI<{ pro: boolean }>("/v1/account", "GET", undefined, userId);
  guard(); active();
  await saveAccountPro(userId, profile.pro === true);
  guard(); active();
  if (!profile.pro) return accountState();
  const saved = (await chrome.storage.local.get(CONTACT_LINK))[CONTACT_LINK] as Link | undefined;
  const base = saved?.userId === userId ? saved.base : {};
  // Contacts this browser had before a free sign-in, which the user chose not to add to the account.
  // They stay out of the account list; logout restores them from the guest copy.
  const localOnly = new Set(saved?.userId === userId ? saved.localOnly || [] : []);
  const shared = (rows: unknown[]) => rows.filter((row) => !localOnly.has((row as Contact | null)?.id as string));
  const check = () => { guard(); active(); };
  const stillActive = async () => { check(); const current = await accountState(); check(); if (current.userId !== userId) throw new Error("account_changed"); };
  for (let attempt = 0; attempt < 3; attempt++) {
    let server;
    try {
      server = await accountAPI<{ schema_version: number; rev: number; data: import("../shared/types.ts").Config | null }>("/v1/account/config", "GET", undefined, userId);
    } catch (e) {
      if ((e as Error).message !== "sync_requires_pro") throw e;
      await saveAccountPro(userId, false); return accountState();
    }
    await stillActive();
    if (server.schema_version !== 1) throw new Error("invalid_config");
    const remote = normalizeConfig(server.data || {});
    const local = ((await chrome.storage.local.get(CONTACTS))[CONTACTS] || []) as unknown[]; active();
    const changes = contactChanges(shared(local), base || {}, Date.now());
    // A contact added independently on two devices gets one shared identity.
    for (const row of changes) {
      if (row.deleted || base?.[row.id]) continue;
      const twin = remote.contacts?.find((c) => !c.deleted && c.address === row.address);
      if (twin) Object.assign(row, twin);
    }
    const contacts = mergeItems(remote.contacts || [], changes);
    const config = { ...remote, contacts };
    const data = configOf({ ...defaults(), ...config }); await stillActive();
    if (new TextEncoder().encode(JSON.stringify(data)).length > 65536) throw new Error("同步配置无效。");
    try { await accountAPI("/v1/account/config", "PUT", { schema_version: 1, rev: server.rev, data }, userId); }
    catch (e) {
      if ((e as Error).message === "sync_requires_pro") { await saveAccountPro(userId, false); return accountState(); }
      if ((e as { status?: number }).status === 409 && attempt < 2) continue;
      throw e;
    }
    await stillActive();
    const latest = ((await chrome.storage.local.get(CONTACTS))[CONTACTS] || []) as unknown[];
    await stillActive();
    if (JSON.stringify(latest) !== JSON.stringify(local)) continue;
    const live = contacts.filter((c) => !c.deleted);
    const foreign = shared(local).filter((row) => !syncable(row)), foreignIDs = new Set(foreign.map((row) => (row as Contact | null)?.id));
    await saveAccountContacts(userId, [...live.filter((row) => !foreignIDs.has(row.id)), ...foreign], { userId, base: Object.fromEntries(contacts.map((c) => [c.id, c])), lastSync: Date.now() }, check);
    const result = await accountState(); check(); return result;
  }
  throw new Error("同步失败，请重试。");
}
