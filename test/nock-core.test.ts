import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { nockCall, setModuleSource, moduleURL, NockFailure, deriveAccount, addressProblem } from "../src/nock/core.ts";
import { parseNock, plainNock, formatNock, NICKS_PER_NOCK } from "../src/nock/units.ts";

setModuleSource(() => readFile(moduleURL()));
// The native build's replies (nock-core/tests/vectors.rs, run on the host) to fixed requests.
const vectors = JSON.parse(readFileSync(new URL("./nock-vectors.json", import.meta.url), "utf8")) as { pairs: { request: Record<string, unknown>; reply: { ok?: unknown; error?: string; code?: string } }[] };

test("the WebAssembly core answers every request exactly as the native build does", async () => {
  assert.ok(vectors.pairs.length >= 25);
  for (const { request, reply } of vectors.pairs) {
    const { op, ...params } = request;
    if ("ok" in reply) assert.deepEqual(await nockCall(op as string, params), reply.ok, `${op} ${JSON.stringify(params).slice(0, 80)}`);
    else await assert.rejects(nockCall(op as string, params), (e: unknown) => e instanceof NockFailure && e.code === reply.code && e.message === reply.error, String(op));
  }
});

test("the same seed opens the address the official NOCK wallet shows", async () => {
  const abandon = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
  const a = await deriveAccount(abandon);
  assert.equal(a.address, "3zxKWhhd8HY9pT2ZCZNUSEz2XWwSk15P2sD3atnnnxRtHa2Ta1H4jRy");
  assert.notEqual(a.simpleFirstName, a.coinbaseFirstName);
  // Logged by `nockchain-wallet keygen`.
  assert.equal((await deriveAccount("pass destroy hub reject cricket flight camp garden scale liquid increase pool miracle fly tower file door cage vault tone night zero push crime")).address, "AyzPiJoqcqmdZdjxZ9aGLnVsbYcCphidHERKBWVXyKhNqTirshTmicG");
  await assert.rejects(deriveAccount("abandon abandon abandon"), (e: unknown) => e instanceof NockFailure && e.code === "invalid_mnemonic");
});

test("address checks", async () => {
  const good = "3zxKWhhd8HY9pT2ZCZNUSEz2XWwSk15P2sD3atnnnxRtHa2Ta1H4jRy";
  assert.equal(await addressProblem(good), null);
  assert.equal(await addressProblem(` ${good}\n`), null);
  assert.equal(await addressProblem(good.slice(0, 30)), "invalid_address");
  assert.equal(await addressProblem("prl1pqvwgxsx2qxlz0q9m"), "invalid_address");
  assert.equal(await addressProblem(""), "invalid_address");
  assert.equal(await addressProblem("z".repeat(132)), "legacy_address");
});

test("a signed send from the native app's fixture: deterministic, balanced, only mature own notes", async () => {
  const fx = JSON.parse(readFileSync(new URL("./nock-notes.json", import.meta.url), "utf8"));
  const send = (extra: Record<string, unknown>) => nockCall<Record<string, string & unknown>>("buildSend", { mnemonic: fx.mnemonic, notes: fx.notes, recipient: fx.recipient, height: fx.height, ...extra });
  const a = await send({ amount: String(40n * NICKS_PER_NOCK) }), b = await send({ amount: String(40n * NICKS_PER_NOCK) });
  assert.equal(a.txId, b.txId);
  assert.equal(a.body, b.body);
  assert.equal(a.spendableTotal, String(85n * NICKS_PER_NOCK));
  assert.equal(BigInt(a.inputTotal), BigInt(a.amount) + BigInt(a.fee) + BigInt(a.change));
  const sweep = await send({ sweep: true });
  assert.equal(BigInt(sweep.amount) + BigInt(sweep.fee), 85n * NICKS_PER_NOCK);
  assert.equal(sweep.change, "0");
});

test("amounts: typed NOCK to nicks and back, as the native app's NockCore", () => {
  assert.equal(parseNock("1"), 65536n);
  assert.equal(parseNock("1.5"), 98304n);
  assert.equal(parseNock("1,5"), 98304n);
  assert.equal(parseNock("0.000001"), 0n);
  assert.equal(parseNock("0.000008"), 1n);   // 0.524 nick rounds up
  assert.equal(parseNock(".5"), 32768n);
  assert.equal(parseNock("5."), 327680n);
  assert.notEqual(parseNock("12.123456"), null);
  assert.equal(parseNock("12.1234567"), null);
  assert.equal(parseNock("1.2.3"), null);
  assert.equal(parseNock("abc"), null);
  assert.equal(parseNock(""), null);
  assert.equal(parseNock("-1"), null);
  // MAX fills the form with something the form accepts.
  assert.equal(plainNock(2802626000123n), "42764678.956954");
  assert.notEqual(parseNock(plainNock(2802626000123n)), null);
  assert.equal(plainNock(65536n), "1");
  assert.equal(formatNock(2802626000123n, "en", 4), "42,764,678.9569");
  assert.equal(formatNock(65536n * 1234n + 32768n, "de", 2), "1.234,5");
  assert.equal(formatNock(0n, "en"), "0");
});
