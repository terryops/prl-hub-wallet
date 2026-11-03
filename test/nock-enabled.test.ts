import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

let items: Record<string, unknown> = {};
const local = {
  async get(keys?: string | string[] | null) { return structuredClone(keys == null ? items : Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter((k) => k in items).map((k) => [k, items[k]]))); },
  async set(next: Record<string, unknown>) { Object.assign(items, structuredClone(next)); },
  async remove(keys: string | string[]) { for (const k of Array.isArray(keys) ? keys : [keys]) delete items[k]; },
};
Object.assign(globalThis, { chrome: { storage: { local } } });
const { loadNockEnabled, saveNockEnabled, usesNock, NOCK_ENABLED, NOCK_LINK_HIDDEN } = await import("../src/nock/enabled.ts");

beforeEach(() => { items = {}; });

test("a stored state uses NOCK once its address was shown, or it holds or has held NOCK (iOS State.usesNock)", () => {
  assert.equal(usesNock(undefined), false);
  assert.equal(usesNock({ history: [], seen: {}, pending: [] }), false);
  assert.equal(usesNock({ history: [], balance: { total: "0", available: "0", locked: "0" } }), false);
  assert.equal(usesNock({ addressShown: true, history: [] }), true);
  assert.equal(usesNock({ history: [{ txId: "a" }] }), true);
  assert.equal(usesNock({ history: [], balance: { total: "65536" } }), true);
  assert.equal(usesNock({ history: [], balance: { total: "not a number" } }), false);
});

test("first run of the opt-in build: off where no wallet here uses NOCK, and that answer is kept", async () => {
  items = { "nock.state.w1": { history: [], addressShown: false }, [NOCK_LINK_HIDDEN]: true, other: 1 };
  assert.equal(await loadNockEnabled(), false);
  assert.equal(items[NOCK_ENABLED], false);
  assert.equal(NOCK_LINK_HIDDEN in items, false, "the old closed-line flag goes");
  // A wallet that starts using NOCK later doesn't switch it on by itself.
  items["nock.state.w2"] = { history: [{ txId: "a" }] };
  assert.equal(await loadNockEnabled(), false);
});

test("first run: on where a wallet on this device already uses NOCK, so nobody loses sight of it", async () => {
  items = { "nock.state.w1": { history: [] }, "nock.state.w2": { history: [], balance: { total: "1" } } };
  assert.equal(await loadNockEnabled(), true);
  assert.equal(items[NOCK_ENABLED], true);
});

test("the switch is kept as set", async () => {
  items = { "nock.state.w1": { addressShown: true } };
  await saveNockEnabled(false);
  assert.equal(await loadNockEnabled(), false);
  await saveNockEnabled(true);
  assert.equal(await loadNockEnabled(), true);
});
