import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { setModuleSource, moduleURL, NockFailure, deriveAccount } from "../src/nock/core.ts";
import { NICKS_PER_NOCK } from "../src/nock/units.ts";
import { NockClient, NockRPCError, NOCKBOX, CLI_NODE, type NockNote, type TxDetails } from "../src/nock/client.ts";

setModuleSource(() => readFile(moduleURL()));
const area = () => {
  let items: Record<string, unknown> = {};
  return {
    async get(keys?: string | string[] | null) { return structuredClone(keys == null ? items : Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter((k) => k in items).map((k) => [k, items[k]]))); },
    async set(next: Record<string, unknown>) { Object.assign(items, structuredClone(next)); },
    async remove(keys: string | string[]) { for (const k of Array.isArray(keys) ? keys : [keys]) delete items[k]; },
    async clear() { items = {}; },
  };
};
const local = area(), session = area();
// The second node's optional permission (extension only).
const permissions = { granted: false, async contains() { return permissions.granted; } };
Object.assign(globalThis, { chrome: { storage: { local, session }, permissions } });
const service = await import("../src/nock/service.ts");

const ABANDON = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const RECIPIENT = "3b3eG8WgWHfXTeAMJzNDWxM3b6WFadxQiiJRQrY6zPJ4J2F5QtHjZRQ";
const NOCK = NICKS_PER_NOCK;
// The abandon wallet's notes as the core decodes a node's page (native vectors): 30 + 5 NOCK payments,
// a mature 50 NOCK block reward, a 70 NOCK one still locked (until 169,050), and someone else's note.
const vectors = JSON.parse(readFileSync(new URL("./nock-vectors.json", import.meta.url), "utf8"));
const decoded = vectors.pairs.find((p: any) => p.request.op === "decodeBalance" && p.request.address).reply.ok;
const own: NockNote[] = decoded.notes.filter((n: NockNote) => n.kind !== "foreign");
const account = await deriveAccount(ABANDON);

class FakeNode extends NockClient {
  tip = 169000; notesNow = own; sent: string[] = [];
  sendResult: () => Promise<void> = async () => {};
  acceptedResult: () => Promise<boolean> = async () => true;
  details = new Map<string, TxDetails | null>();
  constructor() { super(["fake"], async () => { throw new Error("no network in tests"); }); }
  override async notes(firstName: string) {
    const plain = firstName === account.simpleFirstName;
    return { height: this.tip, blockId: null, notes: this.notesNow.filter((n) => (n.kind === "simple") === plain) };
  }
  override async send(body: Uint8Array) { this.sent.push(Buffer.from(body).toString("base64")); return this.sendResult(); }
  override async accepted() { return this.acceptedResult(); }
  override async txDetails(txId: string) { return this.details.get(txId) ?? null; }
  override async blockTimes() { return new Map([[168000, 1_790_000_000_000]]); }
}
let node: FakeNode;
const W = "wallet-a";
const ok = async () => {};
beforeEach(async () => {
  permissions.granted = false;
  node = new FakeNode(); service.setClient(node);
  await local.clear(); await session.clear();
});

test("a first read: balance with locked rewards apart, a row per note, the strip shows", async () => {
  assert.equal((await service.nockStatus(W)).inUse, false);
  const v = await service.nockRefresh(W, ABANDON);
  assert.equal(v.address, "3zxKWhhd8HY9pT2ZCZNUSEz2XWwSk15P2sD3atnnnxRtHa2Ta1H4jRy");
  assert.deepEqual(v.balance, { total: String(155n * NOCK), available: String(85n * NOCK), locked: String(70n * NOCK) });
  assert.equal(v.blocksUntilNextUnlock, 50);
  assert.equal(v.history.length, 4);
  assert.deepEqual(v.history.map((t) => t.kind).sort(), ["mined", "mined", "received", "received"]);
  assert.ok(v.history.filter((t) => t.height === 168000).every((t) => t.timeExact && t.time === 1_790_000_000_000), "block times filled in");
  assert.equal(v.inUse, true);
  assert.equal(v.backendReady, true);
  // A second read adds no rows for the same notes.
  assert.equal((await service.nockRefresh(W, ABANDON)).history.length, 4);
});

test("send: signed before the password, held before broadcast, settled when mined, change isn't income", async () => {
  await service.nockRefresh(W, ABANDON);
  const r = await service.nockPrepare(W, ABANDON, RECIPIENT, "40", false);
  assert.ok("prepared" in r && r.prepared, JSON.stringify(r));
  const p = r.prepared!;
  assert.equal(p.amount, String(40n * NOCK));
  assert.equal(node.sent.length, 0, "nothing leaves before confirmation");
  // A wrong password is the background's own message, not a NOCK error.
  await assert.rejects(service.nockSend(W, p.id, async () => { throw new Error("密码错误或钱包文件损坏。"); }, () => {}), /密码错误/);
  const s = await service.nockSend(W, p.id, ok, () => {});
  assert.equal(s.outcome, "sent");
  assert.equal(node.sent.length, 1);
  let v = await service.nockStatus(W);
  assert.equal(v.hasPendingSend, true); assert.equal(v.hasUnverifiedSend, false);
  assert.equal(v.history[0].kind, "sent"); assert.equal(v.history[0].status, "pending");
  // The 50 NOCK note is spent as far as the wallet is concerned; its change is on the way back.
  assert.equal(v.balance.available, String(35n * NOCK));
  assert.equal(BigInt(v.balance.total), 105n * NOCK + 10n * NOCK - BigInt(p.fee));
  // The same prepared send can't go twice.
  assert.equal((await service.nockSend(W, p.id, ok, () => {})).error?.key, "钱包或网络已切换，已取消本次转账");
  // Mined: the input is gone, the change note arrives, the explorer has it.
  const spent = own.find((n) => n.kind === "coinbase" && n.spendable)!;
  // The change arrives under the name the signed transaction gave it.
  const state = (await local.get("nock.state." + W))["nock.state." + W] as any;
  assert.equal(state.pending[0].changeNotes.length, 1);
  const [first, last] = state.pending[0].changeNotes[0].split("/");
  const change: NockNote = { ...own[0], nameFirst: first, nameLast: last, assets: (10n * NOCK - BigInt(p.fee)).toString(), originPage: 169001 };
  node.notesNow = [...own.filter((n) => n !== spent), change]; node.tip = 169002;
  node.details.set(p.id, { pending: false, height: 169001, time: 1_790_000_500_000, fee: p.fee });
  v = await service.nockRefresh(W, ABANDON);
  assert.equal(v.hasPendingSend, false);
  const row = v.history.find((t) => t.id === p.id)!;
  assert.equal(row.status, "confirmed"); assert.equal(row.confirmations, 2); assert.equal(row.time, 1_790_000_500_000);
  assert.equal(v.history.filter((t) => t.kind === "received").length, 2, "the change note is not a new receipt");
});

test("a broadcast nobody confirmed blocks the next send; only the node's refusal frees the notes", async () => {
  await service.nockRefresh(W, ABANDON);
  let p = (await service.nockPrepare(W, ABANDON, RECIPIENT, "1", false)).prepared!;
  node.sendResult = async () => { throw new NockRPCError("transport"); };
  node.acceptedResult = async () => { throw new NockRPCError("transport"); };
  const s = await service.nockSend(W, p.id, ok, () => {});
  assert.equal(s.outcome, "unverified");
  assert.equal(s.error?.key, "网络异常，无法确认转账是否已发出（{message}）。请先查看交易记录，切勿重复发送。");
  assert.equal((await service.nockStatus(W)).hasUnverifiedSend, true);
  assert.equal((await service.nockPrepare(W, ABANDON, RECIPIENT, "1", false)).error?.key, "上一笔转账是否发出尚未确认，请先查看交易记录，稍后再试");
  // A node turns out to hold it: verified, and sends are possible again.
  node.acceptedResult = async () => true;
  assert.equal((await service.nockRefresh(W, ABANDON)).hasUnverifiedSend, false);

  // A refusal: the send and its row go, the notes are free again.
  await local.clear(); service.setClient(node = new FakeNode());
  await service.nockRefresh(W, ABANDON);
  p = (await service.nockPrepare(W, ABANDON, RECIPIENT, "1", false)).prepared!;
  node.sendResult = async () => { throw new NockFailure("server", "invalid transaction"); };
  node.acceptedResult = async () => false;
  const refused = await service.nockSend(W, p.id, ok, () => {});
  assert.equal(refused.outcome, "failed");
  assert.deepEqual(refused.error, { key: "节点拒绝了请求：{message}", values: { message: "invalid transaction" } });
  const v = await service.nockStatus(W);
  assert.equal(v.hasPendingSend, false); assert.ok(!v.history.some((t) => t.kind === "sent"));
});

test("a send the nodes dropped is marked after 30 minutes; checks, MAX and expiry", async () => {
  await service.nockRefresh(W, ABANDON);
  const p = (await service.nockPrepare(W, ABANDON, RECIPIENT, "2", false)).prepared!;
  await service.nockSend(W, p.id, ok, () => {});
  const state = (await local.get("nock.state." + W))["nock.state." + W] as any;
  state.pending[0].createdAt -= 31 * 60000;
  await local.set({ ["nock.state." + W]: state });
  node.acceptedResult = async () => false;
  const v = await service.nockRefresh(W, ABANDON);
  assert.equal(v.history.find((t) => t.id === p.id)?.status, "failed");
  assert.equal(v.balance.available, String(85n * NOCK), "its notes count again");

  assert.deepEqual(await service.nockCheck(W, ABANDON, RECIPIENT), { problem: null, own: false });
  assert.deepEqual(await service.nockCheck(W, ABANDON, v.address!), { problem: null, own: true });
  assert.equal((await service.nockCheck(W, ABANDON, "z".repeat(132))).problem, "legacy_address");
  const max = await service.nockMax(W, ABANDON, "");
  assert.ok(max.amount && BigInt(max.fee!) > 0n);
  assert.equal(await service.nockPrepare(W, ABANDON, RECIPIENT, "0", false).then((r) => r.error?.key), "请输入金额");
  assert.equal(await service.nockPrepare(W, ABANDON, "nope", "1", false).then((r) => r.error?.key), "收款地址格式不正确");
  assert.equal(await service.nockPrepare(W, ABANDON, RECIPIENT, "9999", false).then((r) => r.error?.key), "余额不足以支付金额和手续费");
  const late = (await service.nockPrepare(W, ABANDON, RECIPIENT, "1", false)).prepared!;
  const review = (await session.get("nock.review"))["nock.review"] as any;
  await session.set({ "nock.review": { ...review, createdAt: Date.now() - 11 * 60000 } });
  assert.equal((await service.nockSend(W, late.id, ok, () => {})).error?.key, "确认超时，请重新发送");
});

test("removing the wallet removes its NOCK state, and a read in flight doesn't bring it back", async () => {
  await service.nockRefresh(W, ABANDON);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const original = node.notes.bind(node);
  node.notes = async (...args) => { await gate; return original(...args); };
  service.setClient(node);
  const reading = service.nockRefresh(W, ABANDON);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await service.nockForget(W);
  release(); await reading;
  assert.deepEqual(await local.get("nock.state." + W), {});
});

test("the extension's second node: used once its permission is granted, offered only when no node answered", async () => {
  // The client as shipped follows the permission before every request.
  const shipped = new NockClient();
  await shipped.ready(); assert.deepEqual(shipped.nodes, [NOCKBOX]);
  permissions.granted = true;
  await shipped.ready(); assert.deepEqual(shipped.nodes, [NOCKBOX, CLI_NODE]);
  permissions.granted = false;

  node.notes = async () => { throw new NockRPCError("http", 503); };
  let v = await service.nockRefresh(W, ABANDON);
  assert.equal(v.offerSecondNode, true);
  assert.deepEqual(v.syncError, { key: "Nockchain 节点暂时不可用（HTTP {code}）", values: { code: 503 } });
  permissions.granted = true;
  assert.equal((await service.nockStatus(W)).offerSecondNode, false, "nothing to offer once it is allowed");
  permissions.granted = false;
  // A node's own verdict isn't a reason to offer another node.
  node.notes = async () => { throw new NockRPCError("status", 3, "invalid"); };
  v = await service.nockRefresh(W, ABANDON);
  assert.equal(v.offerSecondNode, false);
  // An answer clears it.
  node = new FakeNode(); service.setClient(node);
  node.notes = async () => { throw new NockRPCError("transport"); };
  await service.nockRefresh(W, ABANDON);
  assert.equal((await service.nockStatus(W)).offerSecondNode, true);
  node.notes = FakeNode.prototype.notes.bind(node);
  assert.equal((await service.nockRefresh(W, ABANDON)).offerSecondNode, false);
});
