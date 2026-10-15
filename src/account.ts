import { CONTACTS } from "./contacts.ts";
export const ACCOUNT = "pearl.account.v1", CONTACT_LINK = "wallet.contactSync";
const ORIGIN = "https://pearlhub.net", GUEST = "pearl.account.guestContacts";
type Credentials = { user_id: string; device_id: string; access_token: string; refresh_token: string; expires_at: number; email?: string; pro?: boolean };
const random = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
const stored = async () => (await chrome.storage.local.get(ACCOUNT))[ACCOUNT] as Credentials | undefined;
let epoch = 0, rotating: Promise<Credentials> | undefined, signing: Promise<unknown> | undefined;
let stateQueue: Promise<unknown> = Promise.resolve(), disconnecting: Promise<{ connected: false }> | undefined;
function mutateAccount<T>(work: () => Promise<T>): Promise<T> {
  const result = stateQueue.then(work);
  stateQueue = result.catch(() => {});
  return result;
}
const assertAccount = (at: number) => { if (at !== epoch) throw new Error("account_changed"); };
export function accountGuard() {
  const at = epoch;
  return () => { assertAccount(at); if (disconnecting) throw new Error("account_changed"); };
}
export async function saveAccountPro(userId: string, pro: boolean) {
  const guard = accountGuard();
  await mutateAccount(async () => {
    guard();
    const current = await stored();
    guard();
    if (current?.user_id !== userId) throw new Error("account_changed");
    await chrome.storage.local.set({ [ACCOUNT]: { ...current, pro } });
    guard();
  });
}
export async function saveAccountContacts(userId: string, contacts: unknown, link: unknown, active: () => void) {
  const guard = accountGuard();
  const check = () => { guard(); active(); };
  await mutateAccount(async () => {
    check();
    const current = await stored();
    check();
    if (current?.user_id !== userId) throw new Error("account_changed");
    await chrome.storage.local.set({ [CONTACTS]: contacts, [CONTACT_LINK]: link });
    check();
  });
}
async function send<T>(path: string, method = "GET", body?: unknown, token?: string, userId?: string): Promise<T> {
  const r = await fetch(ORIGIN + path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(userId ? { "X-Account-ID": userId } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body), credentials: "omit", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(30000) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { const error = new Error(data.error || "account_failed"); Object.assign(error, { status: r.status }); throw error; }
  return data;
}
async function rotate(current: Credentials, at: number): Promise<Credentials> {
  assertAccount(at);
  if (rotating) return rotating;
  const latest = await stored();
  assertAccount(at);
  if (latest?.user_id !== current.user_id) throw new Error("account_changed");
  if (latest.refresh_token !== current.refresh_token) return latest;
  if (rotating) return rotating;
  rotating = (async () => {
    try {
      const result = await send<Credentials & { expires_in: number }>("/v1/auth/refresh", "POST", { refresh_token: current.refresh_token });
      const next = { ...current, ...result, expires_at: Date.now() + result.expires_in * 1000 };
      return await mutateAccount(async () => {
        assertAccount(at);
        const previous = await stored();
        assertAccount(at);
        if (previous?.user_id !== current.user_id || previous.refresh_token !== current.refresh_token) throw new Error("account_changed");
        await chrome.storage.local.set({ [ACCOUNT]: next });
        assertAccount(at);
        return next;
      });
    } catch (e) {
      if ((e as { status?: number }).status === 401 && at === epoch) await clearAccount();
      throw e;
    } finally { rotating = undefined; }
  })();
  return rotating;
}
export async function accountAPI<T>(path: string, method = "GET", body?: unknown, expected?: string): Promise<T> {
  const at = epoch;
  let account = await stored();
  assertAccount(at);
  if (!account || expected && expected !== account.user_id) throw new Error("account_required");
  if (account.expires_at < Date.now() + 30000) account = await rotate(account, at);
  assertAccount(at);
  let result: T;
  try { result = await send<T>(path, method, body, account.access_token, account.user_id); }
  catch (e) { if ((e as { status?: number }).status !== 401) throw e; account = await rotate(account, at); result = await send<T>(path, method, body, account.access_token, account.user_id); }
  const current = await stored();
  assertAccount(at);
  if (current?.user_id !== account.user_id) throw new Error("account_changed");
  return result;
}
export async function accountState() {
  const a = await stored(), link = (await chrome.storage.local.get(CONTACT_LINK))[CONTACT_LINK] as { userId?: string; lastSync?: number } | undefined;
  const pro = a?.pro === true;
  return { connected: !!a, userId: a?.user_id, email: a?.email, pro, lastSync: pro && link?.userId === a?.user_id ? link?.lastSync : undefined };
}
export async function loginAccount(importLocal: boolean) {
  if (disconnecting) throw new Error("account_changed");
  if (signing) return signing;
  const at = epoch;
  signing = (async () => {
    const verifier = random(), state = random(), redirect = chrome.identity.getRedirectURL("account");
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
    const challenge = btoa(String.fromCharCode(...hash)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
    let device = (await chrome.storage.local.get("pearl.account.device"))["pearl.account.device"];
    if (!device) { device = crypto.randomUUID(); await chrome.storage.local.set({ "pearl.account.device": device }); }
    const url = new URL(ORIGIN); url.search = new URLSearchParams({ account: "connect", redirect_uri: redirect, code_challenge: challenge, state, device_id: String(device), platform: "extension", device_name: /Edg\//.test(navigator.userAgent) ? "Edge Wallet" : "Chrome Wallet" }).toString();
    const callback = await chrome.identity.launchWebAuthFlow({ url: url.href, interactive: true });
    if (!callback || at !== epoch) throw new Error("account_changed");
    const response = new URL(callback);
    const codes = response.searchParams.getAll("code"), states = response.searchParams.getAll("state");
    if (response.origin + response.pathname !== redirect || states.length !== 1 || states[0] !== state || codes.length !== 1 || !/^[A-Za-z0-9_-]{43}$/.test(codes[0])) throw new Error("bad_callback");
    const a = await send<Credentials & { expires_in: number }>("/v1/auth/exchange", "POST", { code: codes[0], code_verifier: verifier, redirect_uri: redirect });
    if (at !== epoch) throw new Error("account_changed");
    const info = await send<{ email: string; pro: boolean }>("/v1/account", "GET", undefined, a.access_token, a.user_id);
    if (at !== epoch) throw new Error("account_changed");
    return mutateAccount(async () => {
      assertAccount(at);
      const previous = await stored(), current = (await chrome.storage.local.get(CONTACTS))[CONTACTS] || [];
      const cacheKey = `pearl.account.contacts.${a.user_id}`, cache = (await chrome.storage.local.get(cacheKey))[cacheKey] as { contacts?: unknown; base?: unknown; lastSync?: number; localOnly?: string[] } | undefined;
      assertAccount(at);
      if (previous && previous.user_id !== a.user_id) throw new Error("account_changed");
      const rows = (value: unknown) => Array.isArray(value) ? value as { id?: unknown; address?: unknown }[] : [];
      const local = rows(current);
      let contacts: unknown[], localOnly = importLocal ? undefined : cache?.localOnly;
      if (cache?.contacts) {
        // A returning account keeps its own list; importing adds this browser's contacts it lacks.
        const own = rows(cache.contacts);
        contacts = importLocal ? [...own, ...local.filter((c) => !own.some((o) => o.id === c.id || o.address === c.address))] : own;
      } else if (importLocal) contacts = local;
      else if (info.pro) contacts = [];
      else {
        // A free account still shows this browser's contacts, but they were not added to the account:
        // remember them so a later Pro sync does not upload them.
        contacts = local;
        if (!previous) localOnly = local.map((c) => c.id).filter((id): id is string => typeof id === "string");
      }
      await chrome.storage.local.set({ ...(!previous ? { [GUEST]: current } : {}), [ACCOUNT]: { ...a, email: info.email, pro: info.pro === true, expires_at: Date.now() + a.expires_in * 1000 }, [CONTACTS]: contacts, [CONTACT_LINK]: { userId: a.user_id, base: cache?.base || {}, lastSync: cache?.lastSync, ...(localOnly?.length ? { localOnly } : {}) } });
      assertAccount(at);
      const state = await accountState();
      assertAccount(at);
      return state;
    });
  })().finally(() => { signing = undefined; });
  return signing;
}
async function clearAccount() {
  epoch++;
  await mutateAccount(async () => {
    const a = await stored();
    if (a) {
      const values = await chrome.storage.local.get([CONTACTS, CONTACT_LINK, GUEST]);
      const link = values[CONTACT_LINK] as { base?: unknown; lastSync?: number; localOnly?: string[] } | undefined;
      await chrome.storage.local.set({ [`pearl.account.contacts.${a.user_id}`]: { contacts: values[CONTACTS] || [], base: link?.base || {}, lastSync: link?.lastSync, ...(link?.localOnly ? { localOnly: link.localOnly } : {}) }, [CONTACTS]: values[GUEST] || [] });
    }
    await chrome.storage.local.remove([ACCOUNT, CONTACT_LINK]);
  });
}
export async function logoutAccount() {
  if (disconnecting) return disconnecting;
  // Cancel in-flight login/rotation before any storage read or server request.
  epoch++;
  disconnecting = (async () => {
    const a = await mutateAccount(stored);
    // Revoke the server session before reporting a completed logout.
    if (a) {
      try { await accountAPI("/v1/auth/logout", "POST", {}); }
      catch (e) {
        // An older rotation can finish after the logout invalidation. Retry
        // revocation with the current stored session once it has settled.
        if ((e as Error).message === "account_changed") {
          try { await accountAPI("/v1/auth/logout", "POST", {}); }
          catch (next) { if ((next as { status?: number }).status !== 401 && (next as Error).message !== "account_required") throw next; }
        } else if ((e as { status?: number }).status !== 401 && (e as Error).message !== "account_required") throw e;
      }
    }
    await clearAccount(); return { connected: false as const };
  })().finally(() => { disconnecting = undefined; });
  return disconnecting;
}
