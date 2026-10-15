import { test } from "node:test";
import assert from "node:assert/strict";
import { ACCOUNT, CONTACT_LINK, accountAPI, accountState, loginAccount, logoutAccount } from "../src/account.ts";
import { CONTACTS } from "../src/contacts.ts";

const redirect = "https://njnhepcaamfibhkfbfhlmknoldgjmefc.chromiumapp.org/account";
const guest = [{ id: "guest", name: "Guest", address: "public-address", note: "" }];
const credentials = (expires = Date.now() + 900000) => ({ user_id: "u_extension", device_id: "fixture-device", access_token: "A".repeat(43), refresh_token: "B".repeat(43), expires_at: expires, email: "test@qq.com" });
function fixture(initial: Record<string, unknown> = {}, callback?: (url: URL) => string) {
  const rows: Record<string, unknown> = { [CONTACTS]: guest, wallet: { encrypted: "preserve-wallet" }, ...initial };
  Object.assign(globalThis, { chrome: {
    storage: { local: {
      get: async (key: string | string[]) => Object.fromEntries((Array.isArray(key) ? key : [key]).map((k) => [k, rows[k]])),
      set: async (data: object) => { Object.assign(rows, data); },
      remove: async (key: string | string[]) => { for (const k of Array.isArray(key) ? key : [key]) delete rows[k]; },
    } },
    identity: {
      getRedirectURL: (path: string) => { assert.equal(path, "account"); return redirect; },
      launchWebAuthFlow: async ({ url, interactive }: { url: string; interactive: boolean }) => {
        assert.equal(interactive, true); const u = new URL(url);
        assert.equal(u.origin, "https://pearlhub.net");
        assert.equal(u.searchParams.get("redirect_uri"), redirect);
        return callback ? callback(u) : redirect + "?code=" + "C".repeat(43) + "&state=" + u.searchParams.get("state");
      },
    },
  } });
  return rows;
}
test("extension login rejects substituted and ambiguous callbacks before exchanging a code", async () => {
  const original = fetch;
  globalThis.fetch = async () => { throw new Error("must not exchange"); };
  try {
    for (const callback of [
      () => redirect + "?code=" + "C".repeat(43) + "&state=wrong",
      (u: URL) => redirect + "?code=" + "C".repeat(43) + "&state=" + u.searchParams.get("state") + "&state=extra",
      (u: URL) => "https://attacker.invalid/account?code=" + "C".repeat(43) + "&state=" + u.searchParams.get("state"),
      (u: URL) => redirect + "?code=invalid&state=" + u.searchParams.get("state"),
    ]) {
      const rows = fixture({}, callback);
      await assert.rejects(loginAccount(false), /bad_callback/);
      assert.equal(rows[ACCOUNT], undefined); assert.deepEqual(rows[CONTACTS], guest);
      assert.deepEqual(rows.wallet, { encrypted: "preserve-wallet" });
    }
  } finally { globalThis.fetch = original; }
});
test("PKCE login works with a locked wallet, keeps credentials private, and restores guest contacts on logout", async () => {
  const original = fetch; let challenge = "", exchanged = 0, revoked = 0;
  const rows = fixture({}, (u) => { challenge = u.searchParams.get("code_challenge")!; return redirect + "?code=" + "C".repeat(43) + "&state=" + u.searchParams.get("state"); });
  globalThis.fetch = async (url, init) => {
    assert.equal(init!.credentials, "omit");
    if (String(url).endsWith("/exchange")) {
      exchanged++; const body = JSON.parse(init!.body as string);
      const expected = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body.code_verifier))).toString("base64url");
      assert.equal(expected, challenge); assert.equal(body.redirect_uri, redirect);
      return Response.json({ ...credentials(), expires_in: 900 });
    }
    assert.equal((init!.headers as Record<string, string>).Authorization, "Bearer " + "A".repeat(43));
    assert.equal((init!.headers as Record<string, string>)["X-Account-ID"], "u_extension");
    if (String(url).endsWith("/logout")) { revoked++; return Response.json({ ok: true }); }
    return Response.json({ email: "test@qq.com", pro: true });
  };
  try {
    const result = await loginAccount(false);
    assert.equal(exchanged, 1); assert.deepEqual(rows[CONTACTS], []);
    assert.equal(JSON.stringify(result).includes("access_token"), false);
    assert.equal(JSON.stringify(await accountState()).includes("refresh_token"), false);
    const userContacts = [{ ...guest[0], id: "user", name: "Account contact" }];
    rows[CONTACTS] = userContacts;
    await logoutAccount();
    assert.equal(revoked, 1); assert.deepEqual(rows[CONTACTS], guest); assert.equal(rows[ACCOUNT], undefined);
    assert.deepEqual(rows.wallet, { encrypted: "preserve-wallet" });
    await loginAccount(true);
    assert.deepEqual(rows[CONTACTS], userContacts, "the same account resumes its own cache rather than importing guests again");
    await logoutAccount();
  } finally { globalThis.fetch = original; }
});
test("concurrent requests share one refresh rotation and use only the new access token", async () => {
  const original = fetch, rows = fixture({ [ACCOUNT]: credentials(0) }); let refreshes = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/refresh")) {
      refreshes++; await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(JSON.parse(init!.body as string).refresh_token, "B".repeat(43));
      return Response.json({ ...credentials(), access_token: "D".repeat(43), refresh_token: "E".repeat(43), expires_in: 900 });
    }
    if (String(url).endsWith("/logout")) return Response.json({ ok: true });
    assert.equal((init!.headers as Record<string, string>).Authorization, "Bearer " + "D".repeat(43));
    return Response.json({ ok: true });
  };
  try {
    assert.deepEqual(await Promise.all([accountAPI("/v1/account"), accountAPI("/v1/account/config")]), [{ ok: true }, { ok: true }]);
    assert.equal(refreshes, 1); assert.equal((rows[ACCOUNT] as ReturnType<typeof credentials>).refresh_token, "E".repeat(43));
    await logoutAccount();
  } finally { globalThis.fetch = original; }
});
test("a temporary refresh failure preserves the session; a revoked refresh clears it and restores guest data", async () => {
  const original = fetch;
  const rows = fixture({ [ACCOUNT]: credentials(0), [CONTACTS]: [{ ...guest[0], name: "Account" }], "pearl.account.guestContacts": guest, [CONTACT_LINK]: { userId: "u_extension" } });
  try {
    globalThis.fetch = async () => Response.json({ error: "temporarily_unavailable" }, { status: 503 });
    await assert.rejects(accountAPI("/v1/account"), /temporarily_unavailable/);
    assert.ok(rows[ACCOUNT]);
    globalThis.fetch = async () => Response.json({ error: "unauthorized" }, { status: 401 });
    await assert.rejects(accountAPI("/v1/account"), /unauthorized/);
    assert.equal(rows[ACCOUNT], undefined); assert.equal(rows[CONTACT_LINK], undefined);
    assert.deepEqual(rows[CONTACTS], guest); assert.deepEqual(rows.wallet, { encrypted: "preserve-wallet" });
  } finally { globalThis.fetch = original; }
});
test("a response arriving after logout is rejected even if the request succeeded", async () => {
  const original = fetch; fixture({ [ACCOUNT]: credentials(), "pearl.account.guestContacts": guest });
  let finish!: (response: Response) => void, start!: () => void;
  const started = new Promise<void>((resolve) => { start = resolve; });
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/logout")) return Response.json({ ok: true });
    start(); return new Promise<Response>((resolve) => { finish = resolve; });
  };
  try {
    const request = accountAPI("/v1/account/config"); const rejected = assert.rejects(request, /account_changed/);
    await started; await logoutAccount(); finish(Response.json({ data: { contacts: guest } })); await rejected;
    assert.equal((await accountState()).connected, false);
  } finally { globalThis.fetch = original; }
});
test("logout cancels a login paused while reading the account contact cache", async () => {
  const original = fetch, rows = fixture();
  const get = chrome.storage.local.get.bind(chrome.storage.local);
  let release!: () => void, reached!: () => void;
  const barrier = new Promise<void>(resolve => release = resolve), started = new Promise<void>(resolve => reached = resolve);
  chrome.storage.local.get = (async (key: string | string[]) => {
    if (key === "pearl.account.contacts.u_extension") { reached(); await barrier; }
    return get(key);
  }) as typeof chrome.storage.local.get;
  globalThis.fetch = async url => Response.json(String(url).endsWith("/exchange") ? { ...credentials(), expires_in: 900 } : { email: "test@qq.com", pro: true, ok: true });
  try {
    const login = loginAccount(false); const rejected = assert.rejects(login, /account_changed/);
    await started;
    const logout = logoutAccount();
    // The storage commit and clearing may serialize; logout invalidates login immediately.
    await new Promise(resolve => setTimeout(resolve, 0)); release();
    await logout; await rejected;
    assert.equal((await accountState()).connected, false);
    assert.equal(rows[ACCOUNT], undefined); assert.equal(rows[CONTACT_LINK], undefined);
    assert.deepEqual(rows[CONTACTS], guest); assert.deepEqual(rows.wallet, { encrypted: "preserve-wallet" });
  } finally { release(); globalThis.fetch = original; }
});
test("logout waits for a started login storage commit and then removes its credentials", async () => {
  const original = fetch, rows = fixture(), set = chrome.storage.local.set.bind(chrome.storage.local);
  let release!: () => void, reached!: () => void;
  const barrier = new Promise<void>(resolve => release = resolve), started = new Promise<void>(resolve => reached = resolve);
  chrome.storage.local.set = async data => {
    if (ACCOUNT in data) { reached(); await barrier; }
    await set(data);
  };
  globalThis.fetch = async url => Response.json(String(url).endsWith("/exchange") ? { ...credentials(), expires_in: 900 } : { email: "test@qq.com", pro: true, ok: true });
  try {
    const login = loginAccount(false), rejected = assert.rejects(login, /account_changed/);
    await started; const logout = logoutAccount();
    await new Promise(resolve => setTimeout(resolve, 0)); release();
    await logout; await rejected;
    assert.equal((await accountState()).connected, false);
    assert.equal(rows[ACCOUNT], undefined); assert.equal(rows[CONTACT_LINK], undefined);
    assert.deepEqual(rows[CONTACTS], guest);
  } finally { release(); globalThis.fetch = original; }
});
test("a late refresh response cannot restore credentials after logout", async () => {
  const original = fetch, rows = fixture({ [ACCOUNT]: credentials(0), "pearl.account.guestContacts": guest });
  let release!: () => void, reached!: () => void;
  const barrier = new Promise<void>(resolve => release = resolve), started = new Promise<void>(resolve => reached = resolve);
  globalThis.fetch = async url => {
    if (String(url).endsWith("/refresh")) {
      reached(); await barrier;
      return Response.json({ ...credentials(), access_token: "D".repeat(43), expires_in: 900 });
    }
    return Response.json({ ok: true });
  };
  try {
    const request = accountAPI("/v1/account/config"), rejected = assert.rejects(request, /account_changed/);
    await started;
    // A still-valid access token lets logout revoke without starting a new rotation.
    rows[ACCOUNT] = credentials();
    await logoutAccount(); release(); await rejected;
    assert.equal(rows[ACCOUNT], undefined); assert.deepEqual(rows[CONTACTS], guest);
  } finally { release(); globalThis.fetch = original; }
});
test("temporary logout failure preserves account data and permits a later retry", async () => {
  const original = fetch, rows = fixture({ [ACCOUNT]: credentials(), "pearl.account.guestContacts": guest });
  try {
    globalThis.fetch = async () => Response.json({ error: "temporarily_unavailable" }, { status: 503 });
    await assert.rejects(logoutAccount(), /temporarily_unavailable/); assert.ok(rows[ACCOUNT]);
    globalThis.fetch = async () => Response.json({ ok: true });
    await logoutAccount(); assert.equal(rows[ACCOUNT], undefined); assert.deepEqual(rows[CONTACTS], guest);
  } finally { globalThis.fetch = original; }
});
test("a late unauthorized response after logout cannot rotate old credentials", async () => {
  const original = fetch, rows = fixture({ [ACCOUNT]: credentials(), "pearl.account.guestContacts": guest });
  let release!: () => void, reached!: () => void, refreshes = 0;
  const barrier = new Promise<void>(resolve => release = resolve), started = new Promise<void>(resolve => reached = resolve);
  globalThis.fetch = async url => {
    if (String(url).endsWith("/logout")) return Response.json({ ok: true });
    if (String(url).endsWith("/refresh")) { refreshes++; return Response.json({ ...credentials(), expires_in: 900 }); }
    reached(); await barrier; return Response.json({ error: "unauthorized" }, { status: 401 });
  };
  try {
    const request = accountAPI("/v1/account/config"), rejected = assert.rejects(request, /account_changed/);
    await started; await logoutAccount(); release(); await rejected;
    assert.equal(refreshes, 0); assert.equal(rows[ACCOUNT], undefined);
  } finally { release(); globalThis.fetch = original; }
});

test("a returning account adds this browser's contacts only when import is accepted", async () => {
  const original = fetch, own = [{ id: "own", name: "Own", address: "own-address", note: "" }];
  const duplicate = { id: "dup", name: "Same address", address: "own-address", note: "" };
  globalThis.fetch = async url => Response.json(String(url).endsWith("/exchange") ? { ...credentials(), expires_in: 900 } : { email: "test@qq.com", pro: true, ok: true });
  try {
    for (const importLocal of [true, false]) {
      const rows = fixture({ [CONTACTS]: [...guest, duplicate], "pearl.account.contacts.u_extension": { contacts: own, base: {}, lastSync: 1 } });
      await loginAccount(importLocal);
      assert.deepEqual(rows[CONTACTS], importLocal ? [...own, ...guest] : own);
      await logoutAccount();
      assert.deepEqual(rows[CONTACTS], [...guest, duplicate]);
    }
  } finally { globalThis.fetch = original; }
});
test("a first free-account login keeps local contacts even when cloud import is declined", async () => {
  const original = fetch, rows = fixture();
  globalThis.fetch = async url => Response.json(String(url).endsWith("/exchange") ? { ...credentials(), expires_in: 900 } : { email: "test@qq.com", pro: false, ok: true });
  try {
    const result = await loginAccount(false);
    assert.equal(result.connected, true); assert.equal(result.pro, false);
    assert.deepEqual(rows[CONTACTS], guest);
    assert.deepEqual((rows[CONTACT_LINK] as { localOnly?: string[] }).localOnly, ["guest"], "declined contacts are remembered so a later Pro sync skips them");
    assert.deepEqual(rows.wallet, { encrypted: "preserve-wallet" });
    await logoutAccount();
    assert.deepEqual((rows["pearl.account.contacts.u_extension"] as { localOnly?: string[] }).localOnly, ["guest"]);
  } finally { globalThis.fetch = original; }
});
