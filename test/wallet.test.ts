import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { xpub, derived, isAddress, planTransaction, signTransaction, parseAmount, formatAmount, maxAmount } from "../src/wallet.ts";
import { createVault, open, seal, keyFromPassword, bytes64 } from "../src/vault.ts";
import * as btc from "@scure/btc-signer";
import { hex } from "@scure/base";
import { schnorr } from "@noble/curves/secp256k1.js";
const v = JSON.parse(readFileSync(new URL("./native-vectors.json", import.meta.url), "utf8"));
test("native BIP86 addresses, zpub/vpub and both network parameters", () => {
  const publicKey = xpub(v.mnemonic, "mainnet");
  assert.equal(publicKey, v.xpub);
  v.addresses.forEach((address: string, i: number) => assert.equal(derived(publicKey, "mainnet", 0, i).address, address));
  assert.equal(derived(publicKey, "mainnet", 0, 150).address, v.address150);
  assert.equal(derived(publicKey, "mainnet", 1, 0).address, "prl1puwagcza86exfh3cx6ur08wq7njc32e66ep0zje7le6c7cak8lqeq655gqa");
  assert.equal(xpub(v.mnemonic, "testnet"), v.testnet.xpub);
  assert.equal(derived(v.testnet.xpub, "testnet").address, v.testnet.address);
  assert.equal(isAddress(v.addresses[0], "mainnet"), true);
  assert.equal(isAddress(v.addresses[0].toUpperCase(), "mainnet"), true);
  assert.equal(isAddress("prl1" + v.addresses[0].slice(4).toUpperCase(), "mainnet"), false);
  assert.equal(isAddress(v.addresses[0], "testnet"), false);
  assert.equal(isAddress(v.addresses[0].slice(0, -1) + "q", "mainnet"), false);
});
for (const [index, c] of v.cases.entries()) test(`native transaction ${index + 1}: ${c.expected ? "same transaction and valid Schnorr signatures" : "rejects invalid input"}`, () => {
  // Native vector 7 intentionally exercises its legacy external/0 fallback.
  // The extension requires the queried address to be attached before planning.
  const utxos = c.utxos.map((u: { address: string }) => ({ ...u, address: u.address || v.addresses[0] }));
  if (c.expected && c.utxos.some((u: { address: string }) => !u.address))
    assert.throws(() => planTransaction(v.xpub, "mainnet", c.to, BigInt(c.amount), c.fee, c.utxos), /不属于/);
  const build = () => signTransaction(v.mnemonic, "mainnet", planTransaction(v.xpub, "mainnet", c.to, BigInt(c.amount), c.fee, utxos));
  if (c.expected) {
    const signed = build();
    const tx = btc.Transaction.fromRaw(hex.decode(signed.hex));
    const reference = btc.Transaction.fromRaw(hex.decode(c.expected));
    // Go uses RFC6979 nonces; scure uses BIP340 auxiliary nonces. Valid signatures
    // differ, while every input, output, fee, change and transaction ID must agree.
    assert.equal(tx.id, reference.id);
    assert.equal(hex.encode(tx.toBytes(true, false)), hex.encode(reference.toBytes(true, false)));
    const plan = planTransaction(v.xpub, "mainnet", c.to, BigInt(c.amount), c.fee, utxos);
    const scripts = plan.selected.map((u) => u.d.script), amounts = plan.selected.map((u) => BigInt(u.value));
    plan.selected.forEach((u, i) => {
      const digest = tx.preimageWitnessV1(i, scripts, 0, amounts);
      assert.equal(schnorr.verify(tx.getInput(i).finalScriptWitness![0], digest, u.d.script.slice(2)), true);
      assert.equal(schnorr.verify(reference.getInput(i).finalScriptWitness![0], digest, u.d.script.slice(2)), true);
    });
  }
  else assert.throws(build);
});
test("decimal amounts and MAX never lose precision", () => {
  assert.equal(parseAmount("1.00000001"), 100000001n);
  assert.equal(parseAmount("0,00000001"), 1n);
  for (const value of ["1e3", "-1", "1.000000001", "Infinity", "1,2.3"]) assert.throws(() => parseAmount(value));
  assert.equal(formatAmount(100000001n), "1.00000001");
  const u = v.cases[0].utxos;
  const max = maxAmount(u, 20000);
  const plan = planTransaction(v.xpub, "mainnet", v.cases[0].to, max, 20000, u);
  assert.equal(plan.change, 0n);
  assert.equal(plan.amount + plan.fee, u.reduce((s: bigint, x: {value:string}) => s + BigInt(x.value), 0n));
});
test("duplicate and foreign UTXOs cannot be signed", () => {
  const c = v.cases[0];
  assert.throws(() => planTransaction(v.xpub, "mainnet", c.to, 10000000n, c.fee, [c.utxos[0], c.utxos[0]]));
  assert.throws(() => planTransaction(v.xpub, "mainnet", c.to, 10000000n, c.fee, [{ ...c.utxos[0], address: c.to }]));
});
const coin = (i: number, value: string) => ({ txid: i.toString(16).padStart(64, "0"), vout: 0, value, address: v.addresses[0], confirmations: 6 });
test("large UTXO pools allow small transfers and cap actual transaction inputs", () => {
  const pool = Array.from({ length: 1001 }, (_, i) => coin(i + 1, "100000"));
  const plan = planTransaction(v.xpub, "mainnet", v.cases[0].to, 1000000n, 50000, pool);
  assert.ok(plan.selected.length < 1000);
  assert.equal(plan.selected.reduce((n, u) => n + BigInt(u.value), 0n), plan.amount + plan.fee + plan.change);
  const largeLast = [...pool, coin(1002, "1000000000")];
  assert.equal(planTransaction(v.xpub, "mainnet", plan.to, 500000000n, 50000, largeLast).selected.length, 1);
  const limit = planTransaction(v.xpub, "mainnet", plan.to, 97097300n, 50000, pool);
  assert.equal(limit.selected.length, 1000); assert.equal(limit.change, 0n);
  assert.throws(() => planTransaction(v.xpub, "mainnet", plan.to, 97100000n, 50000, pool), /输入数量/);
  assert.throws(() => maxAmount(pool, 50000), /输入数量/);
  assert.throws(() => planTransaction(v.xpub, "mainnet", plan.to, 1000000n, 50000, [...pool, { ...coin(1002, "100000"), address: plan.to }]), /不属于/);
});
test("uneconomic dust cannot prevent an affordable send or reduce MAX", () => {
  const good = coin(1, "10006000"), dust = coin(2, "330");
  for (const pool of [[good, dust], [dust, good]]) {
    const plan = planTransaction(v.xpub, "mainnet", v.cases[0].to, 10000000n, 50000, pool);
    assert.equal(plan.selected.length, 1); assert.equal(plan.selected[0].txid, good.txid);
    assert.equal(plan.fee, 6000n); assert.equal(plan.change, 0n);
    assert.equal(maxAmount(pool, 50000), maxAmount([good], 50000));
    const max = planTransaction(v.xpub, "mainnet", plan.to, maxAmount(pool, 50000), 50000, pool);
    assert.equal(max.amount + max.fee, BigInt(good.value)); assert.equal(max.change, 0n);
    assert.ok(signTransaction(v.mnemonic, "mainnet", plan).hex);
  }
  assert.equal(maxAmount([dust], 50000), 0n);
});
test("vault encryption, wrong password, corruption and unique nonces", async () => {
  const data = { wallets: [{ id: "test", name: "Test", mnemonic: v.mnemonic, receiveIndex: 0 }], selected: "test", network: "mainnet" as const, pending: [] };
  const { envelope, key } = await createVault(data, "public-test-password");
  assert.equal(JSON.stringify(envelope).includes("abandon"), false);
  assert.deepEqual(await open(envelope, key), data);
  const wrong = await keyFromPassword("another-test-password", bytes64.decode(envelope.salt));
  await assert.rejects(open(envelope, wrong));
  const again = await seal(data, key, envelope.salt);
  assert.notEqual(envelope.iv, again.iv);
  const bytes = bytes64.decode(envelope.ciphertext); bytes[10] ^= 1;
  await assert.rejects(open({ ...envelope, ciphertext: bytes64.encode(bytes) }, key));
});
