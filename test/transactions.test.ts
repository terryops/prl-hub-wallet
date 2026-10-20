import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseTxid, rawTxid, txDetail, ownFirst } from "../src/transactions.ts";
// Real answers of the official indexer (mainnet block 130692).
const fixtures = JSON.parse(readFileSync(new URL("./tx-fixtures.json", import.meta.url), "utf8"));
const normal = fixtures.normal, coinbase = fixtures.coinbase;
const [payee, change] = normal.vout.map((o: any) => o.addresses[0]), spender = normal.vin[0].addresses[0];

test("a txid is accepted as typed or pasted, or inside an explorer link, and nothing else", () => {
  const id = normal.txid;
  assert.equal(parseTxid(id), id);
  assert.equal(parseTxid(`  ${id.toUpperCase()}\n`), id);
  assert.equal(parseTxid(`https://blockbook.pearlresearch.ai/tx/${id}`), id);
  assert.equal(parseTxid(`https://blockbook.testnet.pearlresearch.ai/tx/${id}?x=1#top`), id);
  for (const bad of ["", id.slice(1), id + "0", `${id.slice(0, 63)}g`, `https://x/tx/${id}0`, `https://x/address/${id}`, "１".repeat(64)]) assert.equal(parseTxid(bad), null, bad);
});
test("the raw transaction's own txid is recomputed, for a normal and a coinbase transaction", () => {
  assert.equal(rawTxid(normal.hex), normal.txid);
  assert.equal(rawTxid(coinbase.hex), coinbase.txid);
  for (const bad of ["", "zz", "0", "00"]) assert.equal(rawTxid(bad), null);
});
test("transaction details: facts, own rows first, net for this wallet, and no rebroadcast once confirmed", () => {
  const tx = txDetail(normal, normal.txid, new Set([change, spender]))!;
  assert.equal(tx.confirmations, 1); assert.equal(tx.height, 130692); assert.equal(tx.time, 1792490389);
  assert.equal(tx.value, "3042492294"); assert.equal(tx.fee, "368131"); assert.equal(tx.coinbase, false);
  assert.deepEqual(tx.inputs.map((r) => [r.address, r.value, r.mine]), [[spender, "3042860425", true]]);
  assert.deepEqual(ownFirst(tx.outputs).map((r) => [r.address, r.mine]), [[change, true], [payee, false]]);
  // Change back minus the input spent: what the payment and its fee cost this wallet.
  assert.equal(tx.net, (53131n - 3042860425n).toString());
  assert.equal(tx.rebroadcast, false);
  assert.equal(txDetail(normal, normal.txid, new Set())!.net, null);
  assert.equal(txDetail(normal, normal.txid, new Set([payee]))!.net, "3042439163");
});
test("an unconfirmed transaction may be rebroadcast only with signed bytes that are this transaction", () => {
  const mempool = { ...normal, confirmations: 0, blockHeight: -1 };
  const tx = txDetail(mempool, normal.txid, new Set())!;
  assert.equal(tx.height, null); assert.equal(tx.rebroadcast, true);
  assert.equal(txDetail({ ...mempool, hex: undefined }, normal.txid, new Set())!.rebroadcast, false);
  assert.equal(txDetail({ ...mempool, hex: coinbase.hex }, normal.txid, new Set())!.rebroadcast, false);
});
test("a coinbase has no inputs, its OP_RETURN output is data, and other answers are refused", () => {
  const tx = txDetail(coinbase, coinbase.txid, new Set())!;
  assert.equal(tx.coinbase, true); assert.deepEqual(tx.inputs, []); assert.equal(tx.rebroadcast, false);
  assert.deepEqual(tx.outputs.map((r) => [r.address == null, r.data]), [[false, false], [true, true]]);
  const nonstandard = txDetail({ ...normal, vout: [{ value: "5", hex: "51", isAddress: false, addresses: ["OP_TRUE"] }] }, normal.txid, new Set())!;
  assert.deepEqual(nonstandard.outputs, [{ address: null, value: "5", data: false, mine: false }]);
  assert.equal(nonstandard.value, normal.value);
  assert.equal(txDetail(normal, coinbase.txid, new Set()), null);
  for (const bad of [null, "x", {}, { ...normal, vin: null }, { ...normal, vout: "x" }]) assert.equal(txDetail(bad, normal.txid, new Set()), null);
  const odd = txDetail({ ...normal, confirmations: -3, blockTime: "x", fees: "-1", value: 7 }, normal.txid, new Set())!;
  assert.equal(odd.confirmations, 0); assert.equal(odd.time, null); assert.equal(odd.fee, "0"); assert.equal(odd.value, "3042492294");
});
