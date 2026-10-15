import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { saveContact, readContacts, removeContact, contactName } from "../src/contacts.ts";
const vectors = JSON.parse(readFileSync(new URL("./native-vectors.json", import.meta.url), "utf8"));
test("contacts normalize, reject wrong network/duplicates and preserve identity and unknown fields", () => {
  const added = saveContact(undefined, { name: " Friend ", address: " " + vectors.addresses[0].toUpperCase(), note: "Exchange" }, "mainnet") as any[];
  assert.equal(added[0].address, vectors.addresses[0]);
  assert.equal(contactName(readContacts(added, "mainnet"), vectors.addresses[0].toUpperCase()), "Friend");
  assert.throws(() => saveContact(added, { name: "duplicate", address: vectors.addresses[0], note: "" }, "mainnet"), /已经/);
  assert.throws(() => saveContact(added, { name: "test", address: vectors.testnet.address, note: "" }, "mainnet"), /网络/);
  added[0].future = { keep: true };
  const both = saveContact(added, { name: "Test", address: vectors.testnet.address, note: "" }, "testnet");
  const edited = saveContact(both, { id: added[0].id, name: "Renamed", address: vectors.addresses[1], note: "New note" }, "mainnet") as any[];
  assert.equal(edited[0].id, added[0].id); assert.deepEqual(edited[0].future, { keep: true });
  assert.equal(readContacts(edited, "mainnet").length, 1); assert.equal(readContacts(edited, "testnet").length, 1);
  assert.deepEqual(removeContact(edited, added[0].id), [edited[1]]);
  assert.throws(() => saveContact({}, { name: "", address: vectors.addresses[0], note: "" }, "mainnet"), /无效/);
  assert.throws(() => saveContact([], { id: "missing", name: "", address: vectors.addresses[0], note: "" }, "mainnet"), /不存在/);
});
test("unnamed contact uses native shortened address and local list sorts by name", () => {
  const all = saveContact([], { name: " ", address: vectors.addresses[0], note: "" }, "mainnet");
  const first = readContacts(all, "mainnet")[0];
  assert.equal(first.name, vectors.addresses[0].slice(0, 10) + "…" + vectors.addresses[0].slice(-6));
  assert.deepEqual(readContacts(null, "mainnet"), []);
});
