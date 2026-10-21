// The NOCK (Nockchain) wallet core: nock_core.wasm, built from nock-core/ (the native app's
// tools/nock-mobile Rust crate, scripts/build-nock.sh). Key derivation, protobuf encoding and
// decoding for the public gRPC API, note matching, and building + signing transactions all run in
// it; this file only crosses into it, like the native app's NockCore.swift. One call, JSON in and
// JSON out. It never touches the network or storage.
//
// The same 12-word seed that opens the PRL wallet opens a NOCK account, derived the way the
// official nockchain-wallet and Iris do it, so the address is the one those wallets show.

type Exports = {
  memory: WebAssembly.Memory;
  nock_call(request: number): number;
  nock_free(reply: number): void;
  nock_alloc(length: number): number;
  nock_dealloc(pointer: number, length: number): void;
};

/// A failure reported by the core. `code` is stable: "insufficient", "no_funds", "invalid_address",
/// "legacy_address", "zero_amount", "invalid_mnemonic", "server" (the node's own error), "decode", …
export class NockFailure extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

// Vite emits the module next to the bundle and rewrites this URL; tests read the file itself.
const MODULE_URL = new URL("./nock_core.wasm", import.meta.url);
let load = async (): Promise<BufferSource> => {
  const response = await fetch(MODULE_URL, { cache: "no-store" });
  if (!response.ok) throw new NockFailure("unavailable", `module ${response.status}`);
  return response.arrayBuffer();
};
/// Tests (Node has no fetch for files): where the module's bytes come from.
export function setModuleSource(source: () => Promise<BufferSource>) { load = source; instance = undefined; }
export const moduleURL = () => MODULE_URL;

let instance: Promise<Exports> | undefined;
function core(): Promise<Exports> {
  instance ||= load().then((bytes) => WebAssembly.instantiate(bytes, {})).then(({ instance }) => instance.exports as unknown as Exports);
  // A failed load is tried again on the next call rather than remembered.
  instance.catch(() => { instance = undefined; });
  return instance;
}

const encoder = new TextEncoder(), decoder = new TextDecoder();

/// Runs one operation of the core. Resolves with its `ok` value, rejects with a NockFailure.
export async function nockCall<T = Record<string, unknown>>(op: string, params: Record<string, unknown> = {}): Promise<T> {
  let x: Exports;
  try { x = await core(); }
  catch (error) { throw error instanceof NockFailure ? error : new NockFailure("unavailable", "the NOCK core could not be loaded"); }
  // JSON.stringify escapes U+0000, so the terminating NUL is the only one.
  const request = encoder.encode(JSON.stringify({ ...params, op }) + "\0");
  let text: string;
  try {
    const pointer = x.nock_alloc(request.length);
    if (!pointer) throw new NockFailure("ffi", "out of memory");
    new Uint8Array(x.memory.buffer, pointer, request.length).set(request);
    const reply = x.nock_call(pointer);
    // The call may have grown the memory: views are made after it.
    new Uint8Array(x.memory.buffer, pointer, request.length).fill(0);   // the request can hold the recovery phrase
    x.nock_dealloc(pointer, request.length);
    if (!reply) throw new NockFailure("ffi", "no reply");
    const memory = new Uint8Array(x.memory.buffer), end = memory.indexOf(0, reply);
    text = decoder.decode(memory.subarray(reply, end < 0 ? memory.length : end));
    x.nock_free(reply);
  } catch (error) {
    // A Rust panic traps on wasm32 (no unwinding): this instance is done, load a fresh one next time.
    if (error instanceof WebAssembly.RuntimeError) { instance = undefined; throw new NockFailure("panic", "internal error"); }
    throw error;
  } finally { request.fill(0); }
  let out: { ok?: T; error?: string; code?: string };
  try { out = JSON.parse(text); } catch { throw new NockFailure("ffi", "malformed reply"); }
  if (out && typeof out === "object" && "ok" in out) return out.ok as T;
  throw new NockFailure(typeof out?.code === "string" ? out.code : "ffi", typeof out?.error === "string" ? out.error : "malformed reply");
}

export type NockAccount = { address: string; simpleFirstName: string; coinbaseFirstName: string };

function account(r: { address?: unknown; firstNames?: { simple?: unknown; coinbase?: unknown } }): NockAccount {
  if (typeof r.address !== "string" || typeof r.firstNames?.simple !== "string" || typeof r.firstNames?.coinbase !== "string") throw new NockFailure("ffi", "malformed derive reply");
  return { address: r.address, simpleFirstName: r.firstNames.simple, coinbaseFirstName: r.firstNames.coinbase };
}

/// The NOCK account for a seed. Account 0 is the master key: the official wallet's default address
/// and Iris's first account.
export const deriveAccount = async (mnemonic: string) => account(await nockCall("derive", { mnemonic, account: 0 }));
/// Read-only view of any address (no key: balance and history only).
export const watchAccount = async (address: string) => account(await nockCall("watch", { address: address.trim() }));

/// Why `address` can't be paid (a NockFailure code), or null when it is a valid v1 address. A v1
/// address has no checksum: a typo that stays in range still validates, which is why the
/// confirmation shows the address in groups to check.
export async function addressProblem(address: string): Promise<string | null> {
  const a = address.trim();
  if (!a) return "invalid_address";
  try {
    const r = await nockCall<{ valid?: boolean; reason?: string }>("checkAddress", { address: a });
    return r.valid === true ? null : r.reason || "invalid_address";
  } catch { return "invalid_address"; }
}
