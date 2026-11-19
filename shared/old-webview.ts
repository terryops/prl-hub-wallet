// The Android app runs on the phone's own System WebView, which can be as old as Chrome 82 where Google Play
// doesn't update it (ANDROID_WEBVIEW in vite.config.ts). The build compiles syntax down to that; these are the
// newer built-ins the app and the wallet call. Without them WebView before Chrome 103 threw on the first
// AbortSignal.timeout and the 挖矿监控 tab went blank. Imported first by main.tsx and by prl-hub-wallet's Android
// entry (shared/); the website build drops it.
declare const __PEARL_ANDROID__: boolean | undefined;

const define = (target: object, name: string, value: unknown) => {
  if (!(name in target)) Object.defineProperty(target, name, { value, writable: true, configurable: true });
};

function at(this: ArrayLike<unknown>, index: number) {
  const n = Math.trunc(index) || 0;
  const i = n < 0 ? this.length + n : n;
  return i < 0 || i >= this.length ? undefined : this[i];
}

function replaceAll(this: string, search: string | RegExp, replacement: string | ((match: string, ...rest: unknown[]) => string)) {
  if (search instanceof RegExp) {
    if (!search.flags.includes("g")) throw new TypeError("replaceAll must be called with a global RegExp");
    return this.replace(search, replacement as string);
  }
  return this.replace(new RegExp(String(search).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), replacement as string);
}

export function installOldWebViewSupport() {
  define(String.prototype, "replaceAll", replaceAll);
  define(Array.prototype, "at", at);
  define(String.prototype, "at", at);
  define(Object.getPrototypeOf(Int8Array.prototype), "at", at);
  define(Object, "hasOwn", (object: object, key: PropertyKey) => Object.prototype.hasOwnProperty.call(object, key));
  define(AbortSignal, "timeout", (ms: number) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException("signal timed out", "TimeoutError")), ms);
    return controller.signal;
  });
  define(AbortSignal, "any", (signals: AbortSignal[]) => {
    const controller = new AbortController();
    for (const signal of signals) {
      if (signal.aborted) {
        controller.abort(signal.reason);
        break;
      }
      signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
    }
    return controller.signal;
  });
  if (globalThis.crypto) {
    define(globalThis.crypto, "randomUUID", () => {
      const b = crypto.getRandomValues(new Uint8Array(16));
      b[6] = (b[6] & 0x0f) | 0x40;
      b[8] = (b[8] & 0x3f) | 0x80;
      const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
    });
  }
}

if (typeof __PEARL_ANDROID__ !== "undefined" && __PEARL_ANDROID__ === true) installOldWebViewSupport();
