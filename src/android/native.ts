// The wallet's calls into the Android shell (BRIDGE.md in the prl-hub-android repository).
import { nativeCall, BridgeError } from "../../shared/android-bridge.ts";
import copy from "./copy.json" with { type: "json" };
import type { Lang } from "../i18n/index.ts";
// Defined per module (not imported) so the Chrome build folds it even across shared chunks.
declare const __PEARL_ANDROID__: boolean | undefined;
const ANDROID = typeof __PEARL_ANDROID__ !== "undefined" && __PEARL_ANDROID__ === true;

export type AndroidWalletCopy = typeof copy.en;
// The Chrome build folds this to an empty object, which keeps the strings out of its bundle.
export const walletCopy = (lang: Lang): AndroidWalletCopy => ANDROID ? copy[lang] || copy.en : {} as AndroidWalletCopy;

// The vault password on Android: a random secret the shell keeps under an Android Keystore key
// and hands over only after a fingerprint, face or screen-lock check (the iOS app's Face ID /
// passcode gate). `create` makes it on the first wallet.
export async function deviceSecret(title: string, create = false): Promise<string> {
  const result = await nativeCall<{ secret: string }>("wallet.secret", { title, create }, 0);
  if (typeof result.secret !== "string" || result.secret.length < 32) throw new BridgeError("failed");
  return result.secret;
}
export const forgetDeviceSecret = () => nativeCall("wallet.clear").then(() => undefined, () => undefined);
// No screenshots or recents thumbnail while a recovery phrase is on screen.
export const secureScreen = (on: boolean) => void nativeCall("ui.secure", { on }).catch(() => {});
export const openSecuritySettings = () => void nativeCall("settings.security").catch(() => {});

// Broadcast: shouldInterceptRequest cannot see POST bodies, so the shell posts for us.
export async function nativePost(url: string, body: string, contentType: string) {
  const result = await nativeCall<{ status: number; body: string }>("net.post", { url, body, contentType }, 30000);
  return { ok: result.status >= 200 && result.status < 300, status: result.status, json: async () => JSON.parse(result.body) };
}

// The second Nockchain node is plain HTTP without CORS headers: the shell posts the framed gRPC-web
// request for us (BRIDGE.md `nock.rpc`). Bodies cross as base64; grpcMessage arrives percent-encoded.
export function nativeNockRpc(node: string, path: string, body: string, timeout: number) {
  return nativeCall<{ status: number; body: string; grpcStatus: string | null; grpcMessage: string | null }>("nock.rpc", { node, path, body, timeout }, timeout + 5000);
}

export { BridgeError };

// The wallet half of the widget snapshot (BRIDGE.md "Widget snapshot"): sent when it changed, and
// unchanged at most once a minute so the widget's "updated" stamp stays current.
const RESTAMP_MS = 60_000;
let publishedWallet = "", publishedAt = 0;
export function publishWalletWidget(data: unknown) {
  const key = JSON.stringify(data, (k, v) => k === "at" ? undefined : v), now = Date.now();
  if (key === publishedWallet && now - publishedAt < RESTAMP_MS) return;
  publishedWallet = key;
  publishedAt = now;
  void nativeCall("widgets.update", { part: "wallet", data }).catch(() => { publishedWallet = ""; });
}
