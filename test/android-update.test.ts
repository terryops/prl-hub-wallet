import { test } from "node:test";
import assert from "node:assert/strict";
import { UpdateChecker, parseLatest, updateNotice, LATEST_URL, UPDATE_KEY, UPDATE_INTERVAL } from "../src/android/update.ts";

const latest = { versionCode: 2, versionName: "2.1.6", minSdk: 26, url: "https://pearlhub.net/downloads/pearl-hub-2.1.6.apk" };
const info = { flavor: "direct" as const, versionCode: 1, sdkInt: 36 };
test("direct update notices require a newer installable version and respect dismissal/channel", () => {
  assert.deepEqual(updateNotice(info, { latest }), latest);
  assert.equal(updateNotice({ ...info, flavor: "play" }, { latest }), undefined);
  assert.equal(updateNotice({ ...info, versionCode: 2 }, { latest }), undefined);
  assert.equal(updateNotice({ ...info, sdkInt: 25 }, { latest }), undefined);
  assert.equal(updateNotice(info, { latest, dismissed: 2 }), undefined);
  assert.deepEqual(updateNotice(info, { latest: { ...latest, versionCode: 3 }, dismissed: 2 })?.versionCode, 3);
  for (const url of ["http://pearlhub.net/downloads/a.apk", "https://evil.test/a.apk", "https://pearlhub.net/downloads/a.html", "https://pearlhub.net/downloads/a.apk?redirect=1"]) assert.equal(parseLatest({ ...latest, url }), undefined);
  assert.equal(parseLatest({ ...latest, versionCode: "2" }), undefined);
  assert.equal(parseLatest({ ...latest, minSdk: -1 }), undefined);
});

test("launch/foreground checks share the six-hour gate; missing JSON stays harmless; play never fetches", async (t) => {
  let now = 1_800_000_000_000, calls = 0, exists = false;
  t.mock.method(Date, "now", () => now);
  const items: Record<string, unknown> = {};
  const storage = { async get(key: string) { return structuredClone({ [key]: items[key] }); }, async set(value: Record<string, unknown>) { Object.assign(items, structuredClone(value)); } };
  const checker = new UpdateChecker(storage, async (url, init) => {
    calls++; assert.equal(url, LATEST_URL); assert.equal(init?.credentials, "omit");
    assert.deepEqual(init?.headers, { Accept: "application/json" });
    return exists ? Response.json(latest) : new Response(null, { status: 404 });
  });
  assert.equal(await checker.check(info), undefined);
  assert.equal(await checker.check(info), undefined); assert.equal(calls, 1);
  exists = true; now += UPDATE_INTERVAL;
  assert.deepEqual(await checker.check(info), latest); assert.equal(calls, 2);
  await checker.dismiss(2); assert.equal(await checker.check(info), undefined);
  now += UPDATE_INTERVAL;
  assert.equal(await checker.check({ ...info, flavor: "play" }), undefined); assert.equal(calls, 2);
  assert.equal((items[UPDATE_KEY] as { dismissed: number }).dismissed, 2);
});

test("play asks Google Play through the shell: newer code only, no name or link, dismissal per version", async () => {
  const items: Record<string, unknown> = {};
  const storage = { async get(key: string) { return structuredClone({ [key]: items[key] }); }, async set(value: Record<string, unknown>) { Object.assign(items, structuredClone(value)); } };
  let reply: { available: boolean; versionCode: number } | Error = { available: false, versionCode: 0 }, fetched = 0;
  const checker = new UpdateChecker(storage, async () => { fetched++; return new Response(null, { status: 404 }); }, async () => { if (reply instanceof Error) throw reply; return reply; });
  const play = { flavor: "play" as const, versionCode: 3, sdkInt: 36 };
  assert.equal(await checker.check(play), undefined);
  reply = { available: true, versionCode: 3 };
  assert.equal(await checker.check(play), undefined, "same version is not news");
  reply = { available: true, versionCode: 4 };
  assert.deepEqual(await checker.check(play), { versionCode: 4 });
  await checker.dismiss(4);
  assert.equal(await checker.check(play), undefined);
  reply = { available: true, versionCode: 5 };
  assert.deepEqual(await checker.check(play), { versionCode: 5 });
  reply = new Error("not installed from Play");
  assert.equal(await checker.check(play), undefined, "a failed lookup stays quiet");
  assert.equal(fetched, 0, "play never reads latest.json");
  assert.equal(await new UpdateChecker(storage).check(play), undefined, "no shell lookup, no notice");
});

test("direct: without a stand-in, the global fetch is looked up at each call (a stored fetch called as a method throws in browsers)", async () => {
  const items: Record<string, unknown> = {};
  const storage = { async get(key: string) { return structuredClone({ [key]: items[key] }); }, async set(value: Record<string, unknown>) { Object.assign(items, structuredClone(value)); } };
  const original = globalThis.fetch; let called = 0;
  const checker = new UpdateChecker(storage);
  globalThis.fetch = (async function (this: unknown) { assert.ok(this === undefined || this === globalThis, "fetch called on another object"); called++; return Response.json(latest); }) as typeof fetch;
  try { assert.deepEqual(await checker.check(info), latest); } finally { globalThis.fetch = original; }
  assert.equal(called, 1);
});
