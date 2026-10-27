import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { setModuleSource, moduleURL, NockFailure, deriveAccount } from "../src/nock/core.ts";
import { NICKS_PER_NOCK } from "../src/nock/units.ts";
import { NockClient, NockRPCError, NOCKBOX, CLI_NODE, type NockNote, type TxDetails } from "../src/nock/client.ts";
import { NockScan, parseScan, type ScanEntry, type ScanPage } from "../src/nock/scan.ts";

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
  service.setScanClient(new NockScan(async () => new Response(null, { status: 404 })));
  await local.clear(); await session.clear();
});

test("nockscan uses a simple GET, parses mined/sent rows and treats 404 as empty", async () => {
  const scan = new NockScan(async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin + url.pathname, "https://nockscan.com/api/v1/address");
    assert.deepEqual(Object.fromEntries(url.searchParams), { address: "address &", limit: "200", offset: "25" });
    assert.deepEqual(init?.headers, { Accept: "application/json" });
    assert.equal(init?.credentials, "omit");
    return new Response(null, { status: 404 });
  });
  assert.deepEqual(await scan.page("address &", 200, 25), { entries: [], hasMore: false, count: 0 });
  const page = parseScan({ transactions: [
    { txId: "coinbase-a", type: "received", isCoinbase: true, blockHeight: "10", timestamp: 100, amount: "9007199254740993" },
    { txId: "send", type: "sent", blockHeight: 11, timestamp: "110", amount: "15", fee: 2, counterparties: [RECIPIENT] },
    { txId: "bad", type: "received", blockHeight: -1, timestamp: 100, amount: 1 },
  ], pagination: { hasMore: true } });
  assert.equal(page.entries[0].kind, "mined"); assert.equal(page.entries[0].amount, "9007199254740993");
  assert.equal(page.entries[1].time, 110000); assert.equal(page.entries[1].fee, "2");
  assert.equal(page.count, 3); assert.equal(page.hasMore, true);
  assert.throws(() => parseScan({}), /malformed/);
  await assert.rejects(new NockScan(async () => new Response(null, { status: 503 })).page("a", 25, 0), /503/);
});

const scanEntry = (txId: string, kind: ScanEntry["kind"], amount: string, height = 100): ScanEntry => ({ txId, kind, amount, fee: "2", height, time: 1000, counterparties: [RECIPIENT] });
const noteRow = (id: string, amount: string, kind: "received" | "mined" = "received", height = 100): import("../src/nock/service.ts").NockTx => ({ id: `note:${id}`, kind, amount, height, time: 0, timeExact: false, status: "confirmed" });

test("nockscan merge: one note or the same-kind sum becomes its transaction, mismatches stay local", () => {
  const rows = [noteRow("a", "3"), noteRow("b", "4"), noteRow("reward", "10", "mined")];
  const merged = service.mergeScan(rows, [scanEntry("incoming", "received", "7"), scanEntry("coinbase-1", "mined", "10")]);
  assert.deepEqual(merged.map((r) => r.id), ["incoming", "coinbase-1"]);
  assert.equal(merged[0].txId, "incoming"); assert.equal(merged[1].txId, undefined);
  assert.equal(merged[0].timeExact, true);
  assert.deepEqual(service.mergeScan(rows, [scanEntry("mismatch", "received", "8")]), rows);
  assert.deepEqual(service.mergeScan(rows, [scanEntry("one", "received", "3")]).map((r) => r.id), ["note:b", "note:reward", "one"]);
  assert.equal(rows.length, 3, "merge does not mutate the saved rows");
});

test("nockscan merge: sends keep recipient amounts; external change isn't income; pending and failed stay", () => {
  const own = { ...noteRow("unused", "40"), id: "own", kind: "sent" as const, txId: "own", counterparty: "ours" };
  const pending = { ...own, id: "pending", status: "pending" as const };
  const failed = { ...own, id: "failed", status: "failed" as const };
  const entries = [scanEntry("own", "sent", "42"), scanEntry("external", "sent", "12", 101), scanEntry("pending", "sent", "42"), scanEntry("failed", "sent", "42")];
  const merged = service.mergeScan([own, pending, failed, noteRow("change", "8", "received", 101)], entries);
  assert.equal(merged.find((r) => r.id === "own")?.amount, "40");
  assert.equal(merged.find((r) => r.id === "own")?.fee, "2");
  assert.equal(merged.find((r) => r.id === "own")?.counterparty, "ours");
  assert.equal(merged.find((r) => r.id === "external")?.amount, "10");
  assert.ok(!merged.some((r) => r.id === "note:change"));
  assert.deepEqual(merged.find((r) => r.id === "pending"), pending);
  assert.deepEqual(merged.find((r) => r.id === "failed"), failed);
  assert.equal(service.mergeScan(merged, [...entries, entries[0]]).length, merged.length);
  assert.ok(service.scanCovers({ ...ownNote(), originPage: 101, kind: "simple" }, merged));
});

function ownNote() { return own[0]; }

test("nockscan history: full first/daily, incremental after five minutes, force and new notes immediately", async (t) => {
  let now = 1_800_000_000_000;
  t.mock.method(Date, "now", () => now);
  const calls: { limit: number; offset: number }[] = [];
  class Scan extends NockScan {
    override async page(_address: string, limit: number, offset: number): Promise<ScanPage> {
      calls.push({ limit, offset });
      return { entries: [scanEntry("historic", "received", "7", 1)], hasMore: offset === 0, count: 1 };
    }
  }
  service.setScanClient(new Scan());
  await service.nockRefresh(W, ABANDON, service.STALE_MS, true);
  assert.deepEqual(calls, [{ limit: 200, offset: 0 }, { limit: 200, offset: 1 }]);
  now += 60000; await service.nockRefresh(W, ABANDON, service.STALE_MS);
  assert.equal(calls.length, 2);
  now += service.SCAN_EVERY_MS; await service.nockRefresh(W, ABANDON, service.STALE_MS);
  assert.deepEqual(calls.at(-1), { limit: 25, offset: 0 });
  now += 60000; await service.nockRefresh(W, ABANDON);
  assert.equal(calls.length, 4, "manual refresh forces an incremental read");
  node.notesNow = [...own, { ...own[0], nameFirst: "new-note", originPage: 169001 }];
  now += 60000; await service.nockRefresh(W, ABANDON, service.STALE_MS);
  assert.equal(calls.length, 5, "new note forces history before the five-minute interval");
  now += service.FULL_SCAN_EVERY_MS; await service.nockRefresh(W, ABANDON, service.STALE_MS);
  assert.equal(calls.at(-1)?.limit, 200);
});

test("opening the NOCK page reads history even for an empty account; failures preserve local history", async () => {
  node.notesNow = [];
  let calls = 0;
  service.setScanClient(new NockScan(async () => { calls++; throw new Error("offline"); }));
  await service.nockRefresh(W, ABANDON, service.STALE_MS);
  assert.equal(calls, 0);
  const v = await service.nockRefresh(W, ABANDON, service.STALE_MS, true);
  assert.equal(calls, 1); assert.equal(v.backendReady, true); assert.equal(v.syncError, undefined);
  await service.nockRefresh(W, ABANDON);
  assert.equal(calls, 2, "failed history reads retry without breaking balance reads");
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

test("send: signed before the password, held before broadcast, settled when mined, change isn't income", async (t) => {
  let now = Date.now(), scans = 0;
  t.mock.method(Date, "now", () => now);
  service.setScanClient(new NockScan(async () => { scans++; return new Response(null, { status: 404 }); }));
  await service.nockRefresh(W, ABANDON);
  assert.equal(scans, 1);
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
  now += 60000;
  v = await service.nockRefresh(W, ABANDON, service.STALE_MS);
  assert.equal(scans, 2, "a settled send immediately reads nockscan even before five minutes, with no new income note");
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

test("nockscan: without a stand-in, the global fetch is looked up at each call (a stored fetch called as a method throws in browsers)", async () => {
  const original = globalThis.fetch, seen: string[] = [];
  const scan = new NockScan();
  globalThis.fetch = (async function (this: unknown, url: string | URL | Request) {
    assert.ok(this === undefined || this === globalThis, "fetch called on another object");
    seen.push(String(url));
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  try { assert.deepEqual(await scan.page("addr", 25, 0), { entries: [], hasMore: false, count: 0 }); }
  finally { globalThis.fetch = original; }
  assert.deepEqual(seen, ["https://nockscan.com/api/v1/address?address=addr&limit=25&offset=0"]);
});
