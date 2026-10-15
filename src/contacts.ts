import { isAddress, type Network } from "./wallet.ts";
export const CONTACTS = "wallet.contacts";
export type Contact = { id: string; name: string; address: string; note: string; [key: string]: unknown };
export type ContactDraft = { id?: string; name: string; address: string; note: string };
const normalized = (address: string) => address.trim().toLowerCase();
const shortAddress = (address: string) => address.length > 16 ? address.slice(0, 10) + "…" + address.slice(-6) : address;
export function readContacts(raw: unknown, network: Network): Contact[] {
  return (Array.isArray(raw) ? raw : []).filter((c): c is Contact => !!c && typeof c.id === "string" && typeof c.name === "string" && typeof c.address === "string" && isAddress(normalized(c.address), network))
    .map((c) => ({ ...c, address: normalized(c.address), note: typeof c.note === "string" ? c.note : "" }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
export const contactName = (contacts: Contact[], address: string) => contacts.find((c) => c.address === normalized(address))?.name;
// Mutate the original list, preserving other-network entries and future fields.
export function saveContact(raw: unknown, draft: ContactDraft, network: Network): unknown[] {
  if (raw !== undefined && !Array.isArray(raw)) throw new Error("地址簿数据无效。");
  const all = Array.isArray(raw) ? [...raw] : [], address = normalized(draft.address);
  if (!isAddress(address, network)) throw new Error("收款地址无效或网络不匹配。");
  const index = draft.id ? all.findIndex((c) => c?.id === draft.id) : -1;
  if (draft.id && index < 0) throw new Error("联系人不存在，请刷新。");
  if (all.some((c, i) => i !== index && typeof c?.address === "string" && normalized(c.address) === address)) throw new Error("这个地址已经在地址簿中。");
  const next = { ...(index >= 0 ? all[index] : {}), id: draft.id || crypto.randomUUID(), name: draft.name.trim() || shortAddress(address), address, note: draft.note };
  if (index >= 0) all[index] = next; else all.push(next);
  return all;
}
export function removeContact(raw: unknown, id: string): unknown[] {
  if (!Array.isArray(raw)) throw new Error("地址簿数据无效。");
  return raw.filter((c) => c?.id !== id);
}
