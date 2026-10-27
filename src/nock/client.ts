// The Nockchain public gRPC API over gRPC-web: plain HTTPS POSTs, as in the native app's
// NockClient.swift. Messages are encoded and decoded by the core (core.ts); this file frames them,
// reads the gRPC status the server puts in the trailer frame (or, for an early error, in the
// headers) and picks a node.
//
// Two public nodes, both reached straight from the device, never through Pearl Hub:
// - rpc.nockbox.org, Iris Wallet's node, HTTPS. First choice. It sends CORS headers for any
//   origin, so the extension and the Android app's wallet page fetch it directly.
// - 216.158.95.10:5556, the node the official nockchain-wallet CLI uses by default. Plain HTTP on
//   a bare IP without CORS headers. The Android app's shell posts to it for the wallet
//   (BRIDGE.md `nock.rpc`, cleartext allowed for that one address, like the native app's ATS
//   exception). The browser extension reaches it only once the person allowed it: an optional host
//   permission the NOCK page asks for after rpc.nockbox.org failed (nodes.ts). rpc.nockbox.org's
//   gateway answers 503 to some networks and not others, which is what the second node is for.
// A node that fails (unreachable, 5xx, its gateway's "upstream connect error") goes to the back
// of the line for five minutes. Everything sent is public chain data or an already-signed
// transaction, so a tampered reply can't redirect funds.
import { base64 } from "@scure/base";
import { nockCall, NockFailure } from "./core.ts";
import { nativeNockRpc } from "../android/native.ts";
import { NOCKBOX, CLI_NODE, CLI_NODE_PERMISSION } from "./nodes.ts";
// Defined per module (not imported) so the Chrome build folds it even across shared chunks.
declare const __PEARL_ANDROID__: boolean | undefined;
const ANDROID = typeof __PEARL_ANDROID__ !== "undefined" && __PEARL_ANDROID__ === true;

export { NOCKBOX, CLI_NODE };
/// Whether the extension may use the second node (the person granted the optional permission).
export async function secondNodeAllowed() {
  if (ANDROID) return true;
  try { return await chrome.permissions.contains(CLI_NODE_PERMISSION); } catch { return false; }
}
/// The nodes this build can reach now, in order of preference.
export const availableNodes = async (): Promise<string[]> => await secondNodeAllowed() ? [NOCKBOX, CLI_NODE] : [NOCKBOX];
/// Block explorer for "view in explorer" links.
export const explorerTx = (txId: string) => `https://nockscan.com/tx/${encodeURIComponent(txId)}`;

const WALLET = "nockchain.public.v2.NockchainService/", BLOCKS = "nockchain.public.v2.NockchainBlockService/";

export class NockRPCError extends Error {
  /// "http": the node answered with this HTTP status; "status": a non-OK gRPC status; "transport":
  /// no answer (offline, timeout, refused); "malformed": an answer that can't be read.
  kind: "http" | "status" | "transport" | "malformed";
  code: number;
  constructor(kind: NockRPCError["kind"], code = 0, message = "") { super(message || kind); this.kind = kind; this.code = code; }
}

/// Worth trying again shortly: the node or the path to it hiccuped (not a verdict).
export function isTransient(error: unknown) {
  if (!(error instanceof NockRPCError)) return false;
  if (error.kind === "transport") return true;
  if (error.kind === "http") return error.code === 429 || error.code >= 500;
  return error.kind === "status" && (error.code === 14 || error.code === 4);   // UNAVAILABLE, DEADLINE_EXCEEDED
}
/// The node answered "no": its error in the reply, or a gRPC / HTTP status that is decided before the
/// transaction is accepted (bad request, rate limit, auth). Anything else leaves a send's outcome open.
export function isRefusal(error: unknown) {
  if (error instanceof NockFailure) return error.code === "server";
  if (!(error instanceof NockRPCError)) return false;
  if (error.kind === "status") return [3, 7, 8, 9, 11, 12, 16].includes(error.code);
  return error.kind === "http" && error.code >= 400 && error.code < 500 && error.code !== 408;
}
/// The node already has this transaction (gRPC ALREADY_EXISTS).
export const isAlreadyKnown = (error: unknown) => error instanceof NockRPCError && error.kind === "status" && error.code === 6;

const decodeMessage = (s: string | null | undefined) => { if (!s) return ""; try { return decodeURIComponent(s); } catch { return s; } };

/// gRPC-web body: frames of [flag:1][length:4 BE][payload]; flag 0x80 = trailers. The first data frame.
export function parseFrames(bytes: Uint8Array): Uint8Array {
  let i = 0, message: Uint8Array | undefined, status: number | undefined, statusMessage = "";
  while (i + 5 <= bytes.length) {
    const flag = bytes[i], length = ((bytes[i + 1] << 24) | (bytes[i + 2] << 16) | (bytes[i + 3] << 8) | bytes[i + 4]) >>> 0;
    const start = i + 5, end = start + length;
    if (end > bytes.length) throw new NockRPCError("malformed");
    const payload = bytes.subarray(start, end);
    if (flag & 0x80) {
      for (const line of new TextDecoder().decode(payload).split(/\r?\n/)) {
        const at = line.indexOf(":");
        if (at < 0) continue;
        const key = line.slice(0, at).trim().toLowerCase(), value = line.slice(at + 1).trim();
        if (key === "grpc-status") status = Number(value);
        else if (key === "grpc-message") statusMessage = decodeMessage(value);
      }
    } else if (!message) message = payload;
    i = end;
  }
  if (status !== undefined && status !== 0) throw status === 14 ? new NockRPCError("http", 503) : new NockRPCError("status", status, statusMessage);
  if (!message) throw new NockRPCError("malformed");
  return message;
}

function frame(message: Uint8Array) {
  const out = new Uint8Array(5 + message.length);
  new DataView(out.buffer).setUint32(1, message.length);
  out.set(message, 5);
  return out;
}

type Reply = { status: number; body: Uint8Array; grpcStatus: string | null; grpcMessage: string | null };
/// One POST. Tests replace it.
export type Transport = (node: string, path: string, body: Uint8Array, timeout: number) => Promise<Reply>;
const fetchTransport: Transport = async (node, path, body, timeout) => {
  if (ANDROID && node === CLI_NODE) {
    const r = await nativeNockRpc(node, path, base64.encode(body), timeout);
    return { status: r.status, body: r.body ? base64.decode(r.body) : new Uint8Array(), grpcStatus: r.grpcStatus, grpcMessage: r.grpcMessage };
  }
  const response = await fetch(`${node}/${path}`, {
    method: "POST", body: body as BodyInit, credentials: "omit", redirect: "error", cache: "no-store", referrerPolicy: "no-referrer",
    headers: { "Content-Type": "application/grpc-web+proto", Accept: "application/grpc-web+proto", "X-Grpc-Web": "1" },
    signal: AbortSignal.timeout(timeout),
  });
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > 16 * 1024 * 1024) throw new NockRPCError("malformed");
  return { status: response.status, body: bytes, grpcStatus: response.headers.get("grpc-status"), grpcMessage: response.headers.get("grpc-message") };
};

/// How long a node that failed sits at the back of the line. Measured 2026-10-21: rpc.nockbox.org's
/// "upstream connect error" follows the client's IP, so it won't clear in a minute.
export const BENCH_MS = 5 * 60000;

export class NockClient {
  nodes: string[];
  transport: Transport;
  /// Paused between the two rounds of `withNode`.
  retryPause: number;
  private benchedUntil = new Map<string, number>();
  /// Fixed nodes (tests), or the ones this build can reach, checked again before each use.
  private fixed: boolean;
  constructor(nodes?: string[], transport: Transport = fetchTransport, retryPause = 1500) { this.fixed = !!nodes; this.nodes = nodes || [NOCKBOX]; this.transport = transport; this.retryPause = retryPause; }
  /// Picks up a permission granted (or taken back) since the last request.
  async ready() { if (!this.fixed) this.nodes = await availableNodes(); }

  /// The nodes, healthy first.
  order(now = Date.now()) {
    const benched = (n: string) => (this.benchedUntil.get(n) ?? 0) > now;
    return [...this.nodes.filter((n) => !benched(n)), ...this.nodes.filter(benched)];
  }
  bench(node: string) { this.benchedUntil.set(node, Date.now() + BENCH_MS); }

  /// One unary gRPC-web call to `node`: the response message's bytes.
  async unary(path: string, message: Uint8Array, node: string, timeout = 20000): Promise<Uint8Array> {
    let reply: Reply;
    try { reply = await this.transport(node, path, frame(message), timeout); }
    catch (error) { throw error instanceof NockRPCError ? error : new NockRPCError("transport"); }
    // Trailers-only replies (an error before any message) put the status in the headers.
    const status = reply.grpcStatus == null ? NaN : Number(reply.grpcStatus);
    if (Number.isInteger(status) && status !== 0) {
      // 14 UNAVAILABLE: the node's gateway couldn't reach the node ("upstream connect error").
      if (status === 14) throw new NockRPCError("http", 503);
      throw new NockRPCError("status", status, decodeMessage(reply.grpcMessage));
    }
    if (reply.status !== 200) throw new NockRPCError("http", reply.status);
    return parseFrames(reply.body);
  }

  /// `body` against one node at a time, healthiest first, until one gets through. A transient failure
  /// benches that node and moves on; any other error is that node's answer and ends it. When every node
  /// failed, one more round after a short pause. `body` gets the per-request timeout: shorter while
  /// another node is still left to try.
  async withNode<T>(body: (node: string, timeout: number) => Promise<T>): Promise<T> {
    await this.ready();
    let last: unknown = new NockRPCError("malformed");
    for (let round = 0; round < 2; round++) {
      if (round > 0) await new Promise((resolve) => setTimeout(resolve, this.retryPause));
      const order = this.order();
      for (const [i, node] of order.entries()) {
        try { return await body(node, i < order.length - 1 ? 12000 : 20000); }
        catch (error) {
          if (!isTransient(error)) throw error;
          this.bench(node);
          last = error;
        }
      }
    }
    throw last;
  }

  /// Encode with the core, call `node`, decode with the core.
  private async rpcOn(path: string, encode: string, params: Record<string, unknown>, decode: string, node: string, timeout: number, extra: Record<string, unknown> = {}) {
    const request = await nockCall<{ body?: string }>(encode, params);
    if (typeof request.body !== "string") throw new NockRPCError("malformed");
    const reply = await this.unary(path, base64.decode(request.body), node, timeout);
    return nockCall<Record<string, unknown>>(decode, { ...extra, data: base64.encode(reply) });
  }
  private rpc(path: string, encode: string, params: Record<string, unknown>, decode: string, extra: Record<string, unknown> = {}) {
    return this.withNode((node, timeout) => this.rpcOn(path, encode, params, decode, node, timeout, extra));
  }

  /// Every note under one first-name (all pages), from one chain snapshot of one node: when the tip moves
  /// between pages the read starts over, so a balance never mixes two heights (page tokens are that node's
  /// own, so a switch to another node starts over too).
  async notes(firstName: string, owner: string): Promise<{ height: number; blockId: string | null; notes: NockNote[] }> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const page = await this.withNode(async (node, timeout) => {
        let token = "", height: number | undefined, blockId: string | null | undefined;
        const notes: NockNote[] = [];
        for (let i = 0; i < 200; i++) {   // far beyond any wallet: a loop guard, not a limit
          const p = await this.rpcOn(WALLET + "WalletGetBalance", "balanceRequest", { firstName, pageToken: token }, "decodeBalance", node, timeout, { address: owner });
          const h = typeof p.height === "number" ? p.height : undefined, b = typeof p.blockId === "string" ? p.blockId : null;
          if (height === undefined) { height = h; blockId = b; } else if (h !== height || b !== blockId) return null;
          for (const n of Array.isArray(p.notes) ? p.notes : []) { const note = readNote(n); if (note) notes.push(note); }
          token = typeof p.nextPageToken === "string" ? p.nextPageToken : "";
          if (!token) break;
        }
        if (height === undefined) throw new NockRPCError("malformed");
        return { height, blockId: blockId ?? null, notes };
      });
      if (page) return page;
    }
    throw new NockRPCError("transport", 0, "链上数据在变化，请稍后重试");
  }

  /// Hands a signed transaction to every node at once (the same transaction twice is harmless: one copy is
  /// "already known"). Resolves when any node acknowledged it. Otherwise rejects with an "already known" if
  /// a node had it, a refusal only when every node refused, and else an error that leaves the outcome open.
  async send(body: Uint8Array): Promise<void> {
    await this.ready();
    const errors = await new Promise<unknown[]>((resolve) => {
      const out: unknown[] = [];
      let left = this.nodes.length;
      for (const node of this.nodes) {
        void (async () => {
          const reply = await this.unary(WALLET + "WalletSendTransaction", body, node, 30000);
          await nockCall("decodeSend", { data: base64.encode(reply) });
        })().then(() => resolve([]), (error) => { out.push(error); if (--left === 0) resolve(out); });
      }
    });
    if (!errors.length) return;
    const known = errors.find(isAlreadyKnown);
    if (known) throw known;
    if (errors.every(isRefusal)) throw errors[0];
    throw errors.find((e) => !isRefusal(e)) ?? errors[0];
  }

  /// Whether any node holds the transaction (mempool or chain). All are asked: a "no" from one isn't final
  /// while another may have it. Rejects only when no node answered.
  async accepted(txId: string): Promise<boolean> {
    await this.ready();
    const answers = await new Promise<({ ok: boolean } | { error: unknown })[]>((resolve) => {
      const out: ({ ok: boolean } | { error: unknown })[] = [];
      let left = this.nodes.length;
      for (const node of this.nodes) {
        this.rpcOn(WALLET + "TransactionAccepted", "acceptedRequest", { txId }, "decodeAccepted", node, 20000)
          .then((r) => ({ ok: r.accepted === true }), (error) => ({ error }))
          .then((answer) => { out.push(answer); if ("ok" in answer && answer.ok) resolve([answer]); else if (--left === 0) resolve(out); });
      }
    });
    if (answers.some((a) => "ok" in a && a.ok)) return true;
    if (answers.some((a) => "ok" in a)) return false;
    throw (answers[0] as { error: unknown } | undefined)?.error ?? new NockRPCError("malformed");
  }

  /// The transaction as the nodes know it; null only when every node answered "not found" (one that is
  /// behind mustn't turn a mined send into a lost one). Rejects when no node had it and one couldn't be asked.
  async txDetails(txId: string): Promise<TxDetails | null> {
    await this.ready();
    let failure: unknown, pending: TxDetails | undefined;
    for (const node of this.order()) {
      try {
        const d = await this.txDetailsOn(txId, node);
        if (!d) continue;
        if (!d.pending) return d;
        pending = d;
      } catch (error) {
        if (isTransient(error)) this.bench(node);
        failure ??= error;
      }
    }
    if (pending) return pending;
    if (failure) throw failure;
    return null;
  }
  private async txDetailsOn(txId: string, node: string): Promise<TxDetails | null> {
    let r: Record<string, unknown>;
    try { r = await this.rpcOn(BLOCKS + "GetTransactionDetails", "txDetailsRequest", { txId }, "decodeTxDetails", node, 20000); }
    catch (error) {
      if (error instanceof NockFailure && error.code === "server" && /not found/i.test(error.message)) return null;
      if (error instanceof NockRPCError && error.kind === "status" && error.code === 5) return null;   // NOT_FOUND
      throw error;
    }
    if (r.pending === true) return { pending: true };
    const nicks = (v: unknown) => typeof v === "string" && /^\d+$/.test(v) ? v : undefined;
    return { pending: false, height: typeof r.height === "number" ? r.height : undefined, time: typeof r.time === "number" ? r.time * 1000 : undefined, fee: nicks(r.fee) };
  }

  /// Block timestamps (ms) from the tip down to `minHeight`, a page (500 blocks, ~21 h) per round trip, at
  /// most `maxPages` pages: heights older than that are left out. One node for all pages (page tokens are
  /// that node's own).
  blockTimes(minHeight: number, maxPages = 4): Promise<Map<number, number>> {
    return this.withNode(async (node, timeout) => {
      const out = new Map<number, number>();
      let token = "";
      for (let i = 0; i < maxPages; i++) {
        const r = await this.rpcOn(BLOCKS + "GetBlocks", "blocksRequest", { limit: 500, pageToken: token }, "decodeBlocks", node, timeout);
        let lowest = Infinity;
        for (const b of Array.isArray(r.blocks) ? r.blocks as { height?: unknown; time?: unknown }[] : []) {
          if (typeof b.height !== "number" || typeof b.time !== "number") continue;
          out.set(b.height, b.time * 1000);
          lowest = Math.min(lowest, b.height);
        }
        token = typeof r.nextPageToken === "string" ? r.nextPageToken : "";
        if (lowest <= minHeight || !token) break;
      }
      return out;
    });
  }
}

export type TxDetails = { pending: true } | { pending: false; height?: number; time?: number; fee?: string };

/// One unspent NOCK note (UTXO) of the wallet, as the node reported it. Amounts in nicks, as strings.
export type NockNote = {
  nameFirst: string; nameLast: string;
  /// Height of the block that created it.
  originPage: number;
  assets: string;
  /// "simple" (a payment), "coinbase" (block reward, 100-block lock), "timelock", "legacy" (pre-v1),
  /// "foreign" (not ours: shouldn't happen under our first-names).
  kind: string;
  /// First height it can be spent at (0: no lock).
  unlockHeight: number;
  spendable: boolean;
  /// base64 `common.v2.Note`, handed back to the core to spend it.
  raw: string;
};
export const noteId = (n: Pick<NockNote, "nameFirst" | "nameLast">) => `${n.nameFirst}/${n.nameLast}`;
export const isMiningReward = (n: Pick<NockNote, "kind">) => n.kind === "coinbase" || n.kind === "timelock";
function readNote(j: unknown): NockNote | null {
  const n = j as Record<string, unknown>;
  if (!n || typeof n.nameFirst !== "string" || typeof n.nameLast !== "string" || typeof n.assets !== "string" || !/^\d+$/.test(n.assets) || typeof n.raw !== "string") return null;
  return { nameFirst: n.nameFirst, nameLast: n.nameLast, assets: n.assets, raw: n.raw, originPage: typeof n.originPage === "number" ? n.originPage : 0, kind: typeof n.kind === "string" ? n.kind : "foreign", unlockHeight: typeof n.unlockHeight === "number" ? n.unlockHeight : 0, spendable: n.spendable === true };
}
