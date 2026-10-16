// The chrome.* surface the wallet uses, inside the Android app's WebView. The service worker
// (background.ts) and the panel (main.tsx) run in one page here, so messages are delivered in
// place. Storage keeps the extension's semantics: `local` persists (WebView localStorage, app-
// private), `session` lives in memory and is gone when the app process ends, like a browser
// restart. The app owns three keys: language and secondary currency follow its settings, and
// the address book is its `contacts` configuration (android-host.ts).
import { pearlHost } from "../../shared/android-host.ts";
import { nativeCall } from "../../shared/android-bridge.ts";
import { CONTACTS } from "../contacts.ts";

type Change = { oldValue?: unknown; newValue?: unknown };
type ChangeListener = (changes: Record<string, Change>, area: string) => void;
type MessageListener = (message: unknown, sender: { id: string; url: string }, reply: (response: unknown) => void) => unknown;
const clone = <T>(value: T): T => value === undefined ? value : JSON.parse(JSON.stringify(value));
const changeListeners = new Set<ChangeListener>();
function emit(changes: Record<string, Change>, area: string) {
  if (!Object.keys(changes).length) return;
  for (const listener of [...changeListeners]) {
    try { listener(clone(changes), area); } catch { /* Like Chrome, one listener cannot stop another. */ }
  }
}

type Backend = { keys(): string[]; read(key: string): unknown; write(key: string, value: unknown): void; remove(key: string): void };
const PREFIX = "pearl.wallet.local.";
const host = pearlHost();
const hostKeys: Record<string, { get(): unknown; set?(value: unknown): void }> = {
  language: { get: () => host?.prefs().lang },
  "currency.secondary": { get: () => host?.prefs().secondary },
  [CONTACTS]: { get: () => host?.contacts() ?? [], set: (value) => host?.setContacts(Array.isArray(value) ? value : []) },
};
const localBackend: Backend = {
  keys: () => [...Object.keys(hostKeys), ...Object.keys(localStorage).filter((k) => k.startsWith(PREFIX)).map((k) => k.slice(PREFIX.length))],
  read(key) {
    if (key in hostKeys) return clone(hostKeys[key].get());
    const raw = localStorage.getItem(PREFIX + key);
    return raw == null ? undefined : JSON.parse(raw);
  },
  write(key, value) {
    if (key in hostKeys) hostKeys[key].set?.(clone(value));
    else localStorage.setItem(PREFIX + key, JSON.stringify(value));
  },
  remove(key) { if (!(key in hostKeys)) localStorage.removeItem(PREFIX + key); },
};
const memory = new Map<string, string>();
const sessionBackend: Backend = {
  keys: () => [...memory.keys()],
  read: (key) => memory.has(key) ? JSON.parse(memory.get(key)!) : undefined,
  write: (key, value) => { memory.set(key, JSON.stringify(value)); },
  remove: (key) => { memory.delete(key); },
};

function area(name: "local" | "session", backend: Backend) {
  const pick = (keys?: string | string[] | Record<string, unknown> | null) => {
    if (keys == null) return Object.fromEntries(backend.keys().map((k) => [k, backend.read(k)]).filter(([, v]) => v !== undefined));
    const defaults = typeof keys === "string" ? { [keys]: undefined } : Array.isArray(keys) ? Object.fromEntries(keys.map((k) => [k, undefined])) : keys;
    const out: Record<string, unknown> = {};
    for (const [key, fallback] of Object.entries(defaults)) {
      const value = backend.read(key);
      if (value !== undefined) out[key] = value;
      else if (fallback !== undefined) out[key] = fallback;
    }
    return out;
  };
  const change = (keys: string[], work: () => void) => {
    const before = Object.fromEntries(keys.map((k) => [k, backend.read(k)]));
    work();
    const changes: Record<string, Change> = {};
    for (const key of keys) {
      const after = backend.read(key);
      if (JSON.stringify(after) !== JSON.stringify(before[key])) changes[key] = { ...(before[key] === undefined ? {} : { oldValue: before[key] }), ...(after === undefined ? {} : { newValue: after }) };
    }
    emit(changes, name);
  };
  return {
    get: async (keys?: string | string[] | Record<string, unknown> | null) => pick(keys),
    set: async (items: Record<string, unknown>) => change(Object.keys(items), () => { for (const [k, v] of Object.entries(items)) backend.write(k, v); }),
    remove: async (keys: string | string[]) => { const list = typeof keys === "string" ? [keys] : keys; change(list, () => list.forEach((k) => backend.remove(k))); },
    clear: async () => { const list = backend.keys().filter((k) => !(name === "local" && k in hostKeys)); change(list, () => list.forEach((k) => backend.remove(k))); },
    setAccessLevel: async () => {},
  };
}

// The app's settings changed: report the keys it owns as storage changes.
let seen = Object.fromEntries(Object.keys(hostKeys).map((k) => [k, JSON.stringify(localBackend.read(k))]));
host?.subscribe(() => {
  const changes: Record<string, Change> = {};
  for (const key of Object.keys(hostKeys)) {
    const now = JSON.stringify(localBackend.read(key));
    if (now !== seen[key]) changes[key] = { oldValue: seen[key] === undefined ? undefined : JSON.parse(seen[key]), newValue: localBackend.read(key) };
  }
  seen = Object.fromEntries(Object.keys(hostKeys).map((k) => [k, JSON.stringify(localBackend.read(k))]));
  emit(changes, "local");
});

const messageListeners = new Set<MessageListener>();
let version = "";
export const setVersion = (value: string) => { version = value; };
const runtime = {
  id: "pearl-hub-android",
  getURL: (path: string) => new URL(path, `${location.origin}/wallet/`).href,
  getManifest: () => ({ version }),
  sendMessage(message: unknown) {
    // Delivered after the caller's turn and serialized, as between extension contexts.
    return new Promise((resolve) => queueMicrotask(() => {
      const sender = { id: runtime.id, url: runtime.getURL("index.html") };
      let waiting = false, done = false;
      const reply = (response: unknown) => { if (!done) { done = true; resolve(clone(response)); } };
      for (const listener of [...messageListeners]) {
        try { if (listener(clone(message), sender, reply) === true) waiting = true; } catch { /* Next listener. */ }
      }
      if (!waiting && !done) resolve(undefined);
    }));
  },
  onMessage: { addListener: (l: MessageListener) => { messageListeners.add(l); }, removeListener: (l: MessageListener) => { messageListeners.delete(l); } },
  onInstalled: { addListener: () => {} },
  onStartup: { addListener: () => {} },
};
const alarmListeners = new Set<(alarm: { name: string }) => void>();
const alarms = new Map<string, ReturnType<typeof setInterval>>();

const shim = {
  runtime,
  storage: {
    local: area("local", localBackend),
    session: area("session", sessionBackend),
    onChanged: { addListener: (l: ChangeListener) => { changeListeners.add(l); }, removeListener: (l: ChangeListener) => { changeListeners.delete(l); } },
  },
  alarms: {
    get: async (name: string) => alarms.has(name) ? { name } : undefined,
    create: async (name: string, info: { periodInMinutes: number }) => {
      clearInterval(alarms.get(name));
      alarms.set(name, setInterval(() => alarmListeners.forEach((l) => l({ name })), info.periodInMinutes * 60000));
    },
    onAlarm: { addListener: (l: (alarm: { name: string }) => void) => { alarmListeners.add(l); } },
  },
  sidePanel: { setPanelBehavior: async () => {} },
  i18n: { getUILanguage: () => navigator.language },
  tabs: { create: async ({ url }: { url: string }) => { await nativeCall("openExternal", { url }).catch(() => {}); } },
};
(globalThis as unknown as { chrome: unknown }).chrome = shim;
