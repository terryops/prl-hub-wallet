import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { contactChanges, syncContacts, CONTACT_LINK } from "../src/contact-sync.ts";
import { CONTACTS } from "../src/contacts.ts";
import { ACCOUNT, logoutAccount } from "../src/account.ts";
import { configOf, defaults, mergeItems } from "../shared/store.ts";
import type { Item } from "../shared/types.ts";
const vectors = JSON.parse(readFileSync(new URL("./native-vectors.json", import.meta.url), "utf8"));
const contact = { id: "contact-1", name: "Friend", address: vectors.addresses[0], note: "", updated: 10, future: { keep: true } };
test("contact baseline retains timestamps, marks actual edits and carries deletion tombstones", () => {
  assert.equal(contactChanges([contact], { [contact.id]: contact }, 100)[0].updated, 10);
  assert.equal(contactChanges([{ ...contact, name: "New" }], { [contact.id]: contact }, 100)[0].updated, 100);
  assert.equal(contactChanges([], { [contact.id]: contact }, 100)[0].deleted, true);
  assert.deepEqual(contactChanges([], { [contact.id]: contact }, 100)[0].future, { keep: true });
  assert.deepEqual(contactChanges([{ ...contact, note: { future: true } }], { [contact.id]: contact }, 100), []);
  assert.throws(() => contactChanges([{ ...contact, updated: Infinity }], {}, 100), /配置/);
  const removed = { ...contact, deleted: true, updated: 20 };
  assert.equal(contactChanges([], { [contact.id]: removed }, 100)[0].updated, 20);
  assert.equal(contactChanges([contact], { [contact.id]: removed }, 100)[0].updated, 100);
});
test("account contact sync retries revisions, adopts remote edits, keeps other settings and never sends wallet secrets", async () => {
  const userId = "u_account-fixture", original = fetch;
  const storage: Record<string, unknown> = { [ACCOUNT]: { user_id: userId, access_token: "A".repeat(43), refresh_token: "B".repeat(43), expires_at: Date.now() + 900000 }, [CONTACTS]: [contact], [CONTACT_LINK]: { userId, base: { [contact.id]: contact } } };
  Object.assign(globalThis, { chrome: { storage: { local: { get: async (key: string) => ({ [key]: storage[key] }), set: async (rows: object) => Object.assign(storage, rows) } } } });
  let config = { ...configOf(defaults()), contacts: [{ ...contact, name: "Remote", updated: 20 }], future: { retained: true } }, puts = 0;
  globalThis.fetch = async (_url, init) => {
    if (String(_url).endsWith("/v1/account")) return Response.json({ pro: true });
    assert.equal(init!.credentials, "omit");
    assert.equal((init!.headers as Record<string,string>).Authorization, "Bearer " + "A".repeat(43));
    if (init!.method === "GET") return Response.json({ rev: puts, schema_version: 1, data: config });
    puts++;
    if (puts === 1) return new Response(null, { status: 409 });
    config = JSON.parse(init!.body as string).data;
    return Response.json({});
  };
  try {
    await syncContacts(() => {});
    assert.equal(puts, 2); assert.equal((storage[CONTACTS] as typeof contact[])[0].name, "Remote");
    assert.equal(config.future, undefined); assert.deepEqual(config.calculator, defaults().calculator);
    storage[CONTACTS] = [];
    await syncContacts(() => {});
    assert.equal(config.contacts[0].deleted, true);
    config.contacts = [{ ...contact, name: "Stale browser", updated: 10 }];
    await syncContacts(() => {});
    assert.equal(config.contacts[0].deleted, true, "an older browser's opaque settings cannot revive deleted contacts");
  } finally { globalThis.fetch = original; }
});
test("a 到达目标价 (reach) price alert in the account does not stop contact sync, and is kept", async () => {
  // pearlhub.net and the apps save reach alerts since 2026-10-21; the wallet's older copy of store.ts
  // refused the whole config ("invalid_config"), so contact sync failed for anyone who had one.
  const userId = "u_account-fixture", original = fetch;
  const storage: Record<string, unknown> = { [ACCOUNT]: { user_id: userId, access_token: "A".repeat(43), refresh_token: "B".repeat(43), expires_at: Date.now() + 900000 }, [CONTACTS]: [contact], [CONTACT_LINK]: { userId, base: {} } };
  Object.assign(globalThis, { chrome: { storage: { local: { get: async (key: string) => ({ [key]: storage[key] }), set: async (rows: object) => Object.assign(storage, rows) } } } });
  const reach = { id: "RULE-REACH", updated: 5, kind: "reach", value: 2.5, window: 0, enabled: true, seen_fired: 0 };
  let config = { ...configOf(defaults()), rules: [reach] }, puts = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/v1/account")) return Response.json({ pro: true });
    if (init!.method === "GET") return Response.json({ rev: puts, schema_version: 1, data: config });
    puts++; config = JSON.parse(init!.body as string).data; return Response.json({});
  };
  try {
    await syncContacts(() => {});
    assert.equal(puts, 1); assert.equal(config.contacts[0].id, contact.id);
    assert.deepEqual(config.rules, [reach]);
  } finally { globalThis.fetch = original; }
});
test("contacts declined at a free sign-in are not uploaded once the account has Pro", async () => {
  const userId = "u_account-fixture", original = fetch, declined = { ...contact, id: "declined", address: vectors.addresses[1] }, added = { ...contact, id: "added" };
  const storage: Record<string, unknown> = { [ACCOUNT]: { user_id: userId, access_token: "A".repeat(43), refresh_token: "B".repeat(43), expires_at: Date.now() + 900000 }, [CONTACTS]: [declined, added], [CONTACT_LINK]: { userId, base: {}, localOnly: ["declined"] } };
  Object.assign(globalThis, { chrome: { storage: { local: { get: async (key: string) => ({ [key]: storage[key] }), set: async (rows: object) => Object.assign(storage, rows) } } } });
  let uploaded: { id: string }[] = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/v1/account")) return Response.json({ pro: true });
    if (init!.method === "GET") return Response.json({ rev: 0, schema_version: 1, data: configOf(defaults()) });
    uploaded = JSON.parse(init!.body as string).data.contacts; return Response.json({});
  };
  try {
    await syncContacts(() => {});
    assert.deepEqual(uploaded.map((c) => c.id), ["added"]);
    assert.deepEqual((storage[CONTACTS] as { id: string }[]).map((c) => c.id), ["added"]);
    assert.equal((storage[CONTACT_LINK] as { localOnly?: string[] }).localOnly, undefined);
  } finally { globalThis.fetch = original; }
});
test("locking during a contact request cannot restore contacts or link state", async () => {
  const userId = "u_account-fixture", original = fetch; let writes = 0;
  Object.assign(globalThis, { chrome: { storage: { local: { get: async (key: string) => key === ACCOUNT ? { [ACCOUNT]: { user_id: userId, access_token: "A".repeat(43), refresh_token: "B".repeat(43), expires_at: Date.now() + 900000 } } : {}, set: async () => { writes++; } } } } });
  globalThis.fetch = async () => Response.json({ schema_version: 1, rev: 0, data: null });
  try { await assert.rejects(syncContacts(() => { throw new Error("locked"); }), /locked/); assert.equal(writes, 0); }
  finally { globalThis.fetch = original; }
});
for (const phase of ["final-read", "storage-commit"]) test(`logout cancels contact synchronization during ${phase} without restoring account contacts`, async () => {
  const original = fetch, userId = "u_account-fixture";
  const guest = [{ ...contact, id: "guest", name: "Guest" }];
  const storage: Record<string, unknown> = { [ACCOUNT]: { user_id: userId, access_token: "A".repeat(43), refresh_token: "B".repeat(43), expires_at: Date.now() + 900000 }, [CONTACTS]: [contact], [CONTACT_LINK]: { userId, base: { [contact.id]: contact } }, "pearl.account.guestContacts": guest };
  let release!: () => void, reached!: () => void, contactsReads = 0, paused = false;
  const barrier = new Promise<void>(resolve => release = resolve), started = new Promise<void>(resolve => reached = resolve);
  Object.assign(globalThis, { chrome: { storage: { local: {
    get: async (key: string | string[]) => {
      const value = structuredClone(Object.fromEntries((Array.isArray(key) ? key : [key]).map(k => [k, storage[k]])));
      if (key === CONTACTS) contactsReads++;
      if (phase === "final-read" && key === CONTACT_LINK && contactsReads === 2 && !paused) { paused = true; reached(); await barrier; }
      return value;
    },
    set: async (rows: Record<string, unknown>) => {
      if (phase === "storage-commit" && CONTACT_LINK in rows && !paused) { paused = true; reached(); await barrier; }
      Object.assign(storage, structuredClone(rows));
    },
    remove: async (keys: string | string[]) => { for (const key of Array.isArray(keys) ? keys : [keys]) delete storage[key]; },
  } } } });
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/v1/account")) return Response.json({ pro: true });
    if (String(url).endsWith("/logout")) return Response.json({ ok: true });
    return Response.json(init?.method === "PUT" ? {} : { schema_version: 1, rev: 1, data: { contacts: [{ ...contact, name: "Remote", updated: 20 }] } });
  };
  try {
    const syncing = syncContacts(() => {}), rejected = assert.rejects(syncing, /account_changed/);
    await started; const logout = logoutAccount();
    await new Promise(resolve => setTimeout(resolve, 0)); release(); await logout; await rejected;
    assert.equal(storage[ACCOUNT], undefined); assert.equal(storage[CONTACT_LINK], undefined);
    assert.deepEqual(storage[CONTACTS], guest);
  } finally { release(); globalThis.fetch = original; }
});


test("free accounts check membership without reading or uploading contacts, and preserve all local data", async () => {
  const original = fetch, userId = "u_free-account";
  const storage: Record<string, unknown> = { [ACCOUNT]: { user_id: userId, access_token: "A".repeat(43), refresh_token: "B".repeat(43), expires_at: Date.now() + 900000 }, [CONTACTS]: [contact], [CONTACT_LINK]: { userId, base: { [contact.id]: contact } } };
  Object.assign(globalThis, { chrome: { storage: { local: { get: async (key: string) => ({ [key]: storage[key] }), set: async (rows: object) => Object.assign(storage, rows) } } } });
  const requests: string[] = [];
  globalThis.fetch = async url => { requests.push(String(url)); assert.ok(String(url).endsWith("/v1/account")); return Response.json({ pro: false }); };
  try {
    const result = await syncContacts(() => {});
    assert.equal(result.connected, true); assert.equal(result.pro, false);
    assert.equal(result.lastSync, undefined); assert.equal(requests.length, 1);
    assert.deepEqual(storage[CONTACTS], [contact]);
    assert.deepEqual(storage[CONTACT_LINK], { userId, base: { [contact.id]: contact } });
  } finally { globalThis.fetch = original; }
});
test("a newer edit or restore beats an older deletion in either merge order", () => {
  const removed = { id: "a", updated: 100, deleted: true }, edited = { id: "a", updated: 200, name: "edited" };
  for (const [left, right] of [[[removed], [edited]], [[edited], [removed]]]) {
    const [merged] = mergeItems<Item>(left, right);
    assert.equal(merged.deleted, undefined); assert.equal(merged.name, "edited"); assert.equal(merged.updated, 200);
  }
  const live = { id: "a", updated: 100, name: "old", future: { keep: true } }, newer = { id: "a", updated: 200, deleted: true };
  for (const [left, right] of [[[live], [newer]], [[newer], [live]]]) {
    const [merged] = mergeItems<Item>(left, right);
    assert.equal(merged.deleted, true); assert.deepEqual(merged.future, { keep: true }, "the loser still fills fields the winner lacks");
  }
});
test("an unchanged contact list is not uploaded again", async () => {
  const userId = "u_account-fixture", original = fetch;
  const storage: Record<string, unknown> = { [ACCOUNT]: { user_id: userId, access_token: "A".repeat(43), refresh_token: "B".repeat(43), expires_at: Date.now() + 900000 }, [CONTACTS]: [contact], [CONTACT_LINK]: { userId, base: {} } };
  Object.assign(globalThis, { chrome: { storage: { local: { get: async (key: string) => ({ [key]: storage[key] }), set: async (rows: object) => Object.assign(storage, rows) } } } });
  let config: unknown = configOf(defaults()), rev = 0, puts = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/v1/account")) return Response.json({ pro: true });
    if (init!.method === "GET") return Response.json({ rev, schema_version: 1, data: config });
    puts++; rev++; config = JSON.parse(init!.body as string).data; return Response.json({});
  };
  try {
    await syncContacts(() => {}); assert.equal(puts, 1);
    await syncContacts(() => {}); await syncContacts(() => {});
    assert.equal(puts, 1, "repeated syncs without changes keep the server revision");
    assert.equal((storage[CONTACT_LINK] as { lastSync?: number }).lastSync! > 0, true);
    storage[CONTACTS] = [{ ...contact, name: "Edited" }];
    await syncContacts(() => {}); assert.equal(puts, 2);
  } finally { globalThis.fetch = original; }
});
test("a contact edited on this browser after another device deleted it is kept everywhere", async () => {
  const userId = "u_account-fixture", original = fetch;
  const storage: Record<string, unknown> = { [ACCOUNT]: { user_id: userId, access_token: "A".repeat(43), refresh_token: "B".repeat(43), expires_at: Date.now() + 900000 }, [CONTACTS]: [{ ...contact, name: "Edited here" }], [CONTACT_LINK]: { userId, base: { [contact.id]: contact } } };
  Object.assign(globalThis, { chrome: { storage: { local: { get: async (key: string) => ({ [key]: storage[key] }), set: async (rows: object) => Object.assign(storage, rows) } } } });
  let uploaded: { id: string; name?: string; deleted?: boolean }[] = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/v1/account")) return Response.json({ pro: true });
    if (init!.method === "GET") return Response.json({ rev: 1, schema_version: 1, data: { ...configOf(defaults()), contacts: [{ id: contact.id, updated: 20, deleted: true }] } });
    uploaded = JSON.parse(init!.body as string).data.contacts; return Response.json({});
  };
  try {
    await syncContacts(() => {});
    assert.equal(uploaded.length, 1); assert.equal(uploaded[0].deleted, undefined); assert.equal(uploaded[0].name, "Edited here");
    assert.deepEqual((storage[CONTACTS] as { name: string }[]).map((c) => c.name), ["Edited here"]);
  } finally { globalThis.fetch = original; }
});
