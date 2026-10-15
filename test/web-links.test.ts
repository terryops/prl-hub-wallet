import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { webLink } from "../src/web-links.ts";
const vectors = JSON.parse(readFileSync(new URL("./native-vectors.json", import.meta.url), "utf8"));
test("web links contain valid mainnet address only in fragment and never imply saving", () => {
  for (const page of ["wallet", "workers"] as const) {
    const link = new URL(webLink(page, vectors.addresses[0].toUpperCase(), "mainnet")!);
    assert.equal(link.origin, "https://pearlhub.net"); assert.equal(link.pathname, "/"); assert.equal(link.search, "");
    assert.equal(link.hash, `#${page}?addr=${vectors.addresses[0]}`);
  }
  assert.equal(webLink("wallet", vectors.testnet.address, "testnet"), undefined);
  assert.equal(webLink("workers", "bad&addr=other", "mainnet"), undefined);
});
