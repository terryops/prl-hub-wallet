import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import qrcode from "qrcode-generator";
import { formatAmount, isAddress, parseAmount, type Network, type Pending } from "./wallet.ts";
import { origin, type Snapshot } from "./chain.ts";
import { detectLanguage, isLanguage, languageNames, languages, messageText, translate, type Lang, type TextKey } from "./i18n/index.ts";
import { currencies, isSecondary, loadMarket, dualFiat, type Market } from "./market.ts";
import { featureText } from "./feature-copy.ts";
import { CONTACTS, readContacts, contactName, type Contact, type ContactDraft } from "./contacts.ts";
import { DONATION_ADDRESS, DONATION_PRESETS, canDonate, addressHalves } from "./donation.ts";
import { webLink } from "./web-links.ts";
import { ACCOUNT, CONTACT_LINK } from "./account.ts";
import { accountCopy } from "../shared/account-copy.ts";
import { Icon } from "./Icons.tsx";
import { SecurityNotice } from "./SecurityNotice.tsx";
import { SecurityOverview } from "./SecurityOverview.tsx";
import { TxDetailView, type TxLoad, type TxResend } from "./TxDetail.tsx";
import { SendReceipt } from "./SendReceipt.tsx";
import { UpdateBanner, useAndroidUpdate } from "./android/UpdateBanner.tsx";
import { NockEntry, NockPage } from "./nock/NockView.tsx";
import { InfoTip } from "./InfoTip.tsx";
import { receiptAmount } from "./receipt.ts";
import { parseTxid } from "./transactions.ts";
import { securityCopy, extensionSecurity } from "../shared/security-overview.ts";
import { deviceSecret, forgetDeviceSecret, secureScreen, openSecuritySettings, walletCopy, publishWalletWidget, BridgeError, type AndroidWalletCopy } from "./android/native.ts";
import { pearlHost, walletRows, walletChangesEmpty, type WalletTarget } from "../shared/android-host.ts";
import { nativeCall } from "../shared/android-bridge.ts";
import "./style.css";
// Defined per module (not imported) so the Chrome build folds it even across shared chunks.
declare const __PEARL_ANDROID__: boolean | undefined;
const ANDROID = typeof __PEARL_ANDROID__ !== "undefined" && __PEARL_ANDROID__ === true;
type WalletInfo = { id: string; name: string; index: number; address: string; primaryAddress?: string; watch?: boolean };
type View = { exists: boolean; locked: boolean; network?: Network; selected?: string; wallets?: WalletInfo[]; pending?: Omit<Pending, "hex" | "inputs">[]; snapshot?: Snapshot };
type Review = { id: string; to: string; network: Network; amount: string; fee: string; change: string; changeAddress: string; expires: number; donation?: boolean };
// watch: 添加只读钱包; watchSend: 转账 on a read-only wallet; watchRemove: 移除只读钱包; nockClose: closing the NOCK line.
type Panel = "create" | "restore" | "receive" | "send" | "settings" | "wallets" | "backup" | "retry" | "discard" | "contact" | "donate" | "security" | "tx" | "lookup" | "recover" | "watch" | "watchSend" | "watchRemove" | "nockClose" | null;
type ContactLink = { connected: boolean; userId?: string; email?: string; pro?: boolean; lastSync?: number };
type Message = string | { text: string } | { account: "failed" | "expired" } | { android: "needLock" | "lockout" | "secretMissing" | "authFailed" };
async function rpc<T>(command: string, data: Record<string, unknown> = {}): Promise<T> {
  const response = await chrome.runtime.sendMessage({ command, ...data });
  if (!response?.ok) throw new Error(response?.error || "钱包服务暂时不可用，请重新打开插件。");
  return response.data;
}
function QR({ value, alt }: { value: string; alt: string }) {
  const code = qrcode(0, "M"); code.addData(value); code.make();
  return <img className="qr" src={code.createDataURL(5, 10)} alt={alt} />;
}
const amount = (value: string | bigint) => formatAmount(value);
function balanceParts(value: string, locale: string) {
  const atoms = BigInt(value);
  const [whole, fraction] = amount(atoms < 0n ? -atoms : atoms).split(".");
  const grouped = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(BigInt(whole));
  const decimal = new Intl.NumberFormat(locale).formatToParts(1.1).find((part) => part.type === "decimal")?.value || ".";
  return { head: `${atoms < 0n ? "−" : ""}${grouped}${decimal}${fraction.slice(0, 2)}`, tail: fraction.slice(2) };
}
const DONATION_PROMPTED = "donate.prompted";
const BALANCE = "android.lastBalance";
const NOCK_LINK_HIDDEN = "nock.linkHidden";
// iOS strings with positional slots ({0}, {1}) from extension/src/android/copy.json.
const fill = (template: string, ...values: (string | number)[]) => template.replace(/\{(\d)\}/g, (_, i) => String(values[Number(i)] ?? ""));
const FEE_RESERVE = 100_000n;        // iOS WalletStore.sendFeeReserve: 0.001 PRL
// iOS VerifyStep: three random positions in order, each with the right word and three others from the phrase.
function makeQuiz(words: string[]) {
  const pick = <T,>(xs: T[]) => xs[crypto.getRandomValues(new Uint32Array(1))[0] % xs.length];
  const positions: number[] = [];
  while (positions.length < 3) { const i = pick([...words.keys()]); if (!positions.includes(i)) positions.push(i); }
  positions.sort((a, b) => a - b);
  const options = positions.map((i) => {
    const set = new Set([words[i]]);
    for (let guard = 0; set.size < 4 && guard < 60; guard++) set.add(pick(words));
    return [...set].sort(() => crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32 - 0.5);
  });
  return { positions, options, chosen: {} as Record<number, string> };
}
const wordCount = (phrase: string) => phrase.trim() ? phrase.trim().split(/\s+/).length : 0;
function App() {
  const [lang, setLang] = useState<Lang>(() => detectLanguage([chrome.i18n.getUILanguage(), ...navigator.languages]));
  const [languageReady, setLanguageReady] = useState(false);
  const t = (key: TextKey, values?: Record<string, string | number>) => translate(lang, key, values);
  // Android-only pieces sit behind ANDROID at each use, so the Chrome build folds them away.
  const w = (ANDROID ? walletCopy(lang) : {}) as AndroidWalletCopy;
  const androidUpdate = ANDROID ? useAndroidUpdate() : null;
  useEffect(() => {
    let active = true;
    const changed = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === "local" && isLanguage(changes.language?.newValue)) setLang(changes.language.newValue);
    };
    chrome.storage.onChanged.addListener(changed);
    void chrome.storage.local.get("language").then(({ language }) => {
      if (active && isLanguage(language)) setLang(language);
    }).catch(() => setMessage("语言设置无法保存，请重试。")).finally(() => { if (active) setLanguageReady(true); });
    return () => { active = false; chrome.storage.onChanged.removeListener(changed); };
  }, []);
  useEffect(() => { document.documentElement.lang = lang; }, [lang]);
  async function changeLanguage(value: string) {
    if (!isLanguage(value)) return;
    try { await chrome.storage.local.set({ language: value }); setLang(value); }
    catch { setMessage("语言设置无法保存，请重试。"); }
  }
  const [view, setView] = useState<View | null>(null), [panel, setPanel] = useState<Panel>(null), [tab, setTab] = useState("wallet");
  const [busy, setBusy] = useState(false), [message, setMessage] = useState<Message>("");
  const [changeScan, setChangeScan] = useState<"" | "running" | "done">("");
  const [name, setName] = useState(""), [password, setPassword] = useState(""), [repeat, setRepeat] = useState(""), [nextPassword, setNextPassword] = useState("");
  const [mnemonic, setMnemonic] = useState(""), [quiz, setQuiz] = useState(false);
  const [to, setTo] = useState(""), [value, setValue] = useState(""), [fee, setFee] = useState(50000), [feeSource, setFeeSource] = useState<"default" | "estimated" | "manual">("default"), [maximum, setMaximum] = useState(false);
  const feeRequest = useRef(0), feeEdited = useRef(false);
  const [contactsRaw, setContactsRaw] = useState<unknown>([]);
  const [contactLink, setContactLink] = useState<ContactLink>({ connected: false });
  const [contactDraft, setContactDraft] = useState<ContactDraft>({ name: "", address: "", note: "" });
  const [contactReturn, setContactReturn] = useState(false);
  useEffect(() => {
    let active = true;
    const changed = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === "local" && CONTACTS in changes) setContactsRaw(changes[CONTACTS].newValue);
    };
    chrome.storage.onChanged.addListener(changed);
    void chrome.storage.local.get(CONTACTS).then((saved) => { if (active) setContactsRaw(saved[CONTACTS]); }).catch(() => setMessage("操作失败。"));
    return () => { active = false; chrome.storage.onChanged.removeListener(changed); };
  }, []);
  const contacts = readContacts(contactsRaw, view?.network || "mainnet");
  const payee = (address: string) => contactName(contacts, address);
  function editContact(contact?: Contact, fromSend = false) {
    if (running.current) { setMessage("更新中…"); return; }
    setContactDraft(contact ? { id: contact.id, name: contact.name, address: contact.address, note: contact.note } : { name: "", address: fromSend ? to : "", note: "" });
    setPassword(""); setContactReturn(fromSend); setPanel("contact");
  }
  const finishContact = () => { if (contactReturn) setPanel("send"); else close(); };
  const [review, setReview] = useState<Review | null>(null), [retry, setRetry] = useState("");
  const [recovery, setRecovery] = useState(false);
  // Android: iOS's phrase check (three random positions, pick each word) and 找回搁浅的找零's destination.
  const [lastBalance, setLastBalance] = useState<{ walletId: string; network: string; balance: string } | null>(null);
  useEffect(() => {
    if (!ANDROID) return;
    void chrome.storage.local.get(BALANCE).then((saved) => { const b = saved[BALANCE] as { walletId?: unknown; network?: unknown; balance?: unknown } | undefined; if (b && typeof b.walletId === "string" && typeof b.network === "string" && typeof b.balance === "string" && /^\d+$/.test(b.balance)) setLastBalance({ walletId: b.walletId, network: b.network, balance: b.balance }); }).catch(() => {});
  }, []);
  const [quizPick, setQuizPick] = useState<{ positions: number[]; options: string[][]; chosen: Record<number, string> } | null>(null);
  const [recoverDest, setRecoverDest] = useState<"main" | "custom">("main");
  const [recoverAddress, setRecoverAddress] = useState("");
  // 交易详情 (opened from 交易记录) and 交易查询.
  const [detailTxid, setDetailTxid] = useState(""), [lookupInput, setLookupInput] = useState(""), [lookupTxid, setLookupTxid] = useState(""), [lookupInvalid, setLookupInvalid] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null), running = useRef(false), epoch = useRef(0);
  const f = (key: Parameters<typeof featureText>[1]) => featureText(lang, key);
  const [secondary, setSecondary] = useState("__auto__"), [market, setMarket] = useState<Market>({});
  useEffect(() => {
    let active = true;
    const changed = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === "local" && isSecondary(changes["currency.secondary"]?.newValue)) setSecondary(changes["currency.secondary"].newValue);
    };
    chrome.storage.onChanged.addListener(changed);
    void chrome.storage.local.get("currency.secondary").then((saved) => {
      if (active && isSecondary(saved["currency.secondary"])) setSecondary(saved["currency.secondary"]);
    }).catch(() => {});
    return () => { active = false; chrome.storage.onChanged.removeListener(changed); };
  }, []);
  async function changeSecondary(value: string) {
    if (!isSecondary(value)) return;
    try { await chrome.storage.local.set({ "currency.secondary": value }); setSecondary(value); }
    catch { setMessage("操作失败。"); }
  }
  useEffect(() => {
    setMarket({});
    if (!view || view.locked || view.network !== "mainnet") return;
    const controller = new AbortController();
    const update = () => { if (document.visibilityState === "visible") void loadMarket(controller.signal).then((m) => { if (!controller.signal.aborted) setMarket(m); }); };
    update();
    const timer = setInterval(update, 60000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [view?.locked, view?.network]);
  const viewRef = useRef(view); viewRef.current = view;
  // The last chain refresh, and whether the periodic one failed (iOS: "无法连接区块浏览器，显示的是 HH:MM 的数据").
  const lastChain = useRef(0);
  const [syncFailed, setSyncFailed] = useState(false);
  function quietRefresh() {
    const v = viewRef.current;
    if (running.current || !v || v.locked || document.visibilityState !== "visible" || watchOff(v)) return;
    const at = epoch.current;
    lastChain.current = Date.now();
    rpc<View>("refresh", { expectedWalletId: v.selected, expectedNetwork: v.network })
      .then((next) => { if (at === epoch.current) { setView(next); setSyncFailed(false); } })
      .catch(() => { if (at === epoch.current) setSyncFailed(true); });
  }
  const wallet = view?.wallets?.find((w) => w.id === view.selected);
  // A read-only wallet (iOS isWatchOnly): only the address it watches, no seed, so it can't send.
  const readOnly = !!wallet?.watch;
  // …added on the other network, where it reads nothing (iOS: "这个只读钱包的地址不属于 Testnet 网络").
  const watchOff = (v: View | null | undefined) => { const sel = v?.wallets?.find((x) => x.id === v.selected); return !!sel?.watch && !!v?.network && !isAddress(sel.address, v.network); };
  const watchProblem = (reason: "watch-address" | "watch-network") => ({ text: reason === "watch-address"
    ? t("地址格式不正确（需为 {prefix} 开头的 Taproot 地址）", { prefix: (viewRef.current?.network || "mainnet") === "mainnet" ? "prl1" : "tprl1" })
    : t("这个只读钱包的地址不属于 {network} 网络", { network: (viewRef.current?.network || "mainnet") === "mainnet" ? "Mainnet" : "Testnet" }) });
  // 添加只读钱包 (iOS WatchWalletView): a name and the address, on the current network.
  const [watchAddress, setWatchAddress] = useState("");
  // The read-only wallet 移除只读钱包 is about (any wallet in the Android list, else the selected one).
  const [watchTarget, setWatchTarget] = useState<WalletInfo | null>(null);
  const clearSecrets = () => { feeRequest.current++; setPassword(""); setRepeat(""); setNextPassword(""); setMnemonic(""); setReview(null); setQuiz(false); setQuizPick(null); };
  const close = () => { setPanel(null); clearSecrets(); };
  async function act<T = View>(command: string, data: Record<string, unknown> = {}, after?: (result: T) => void) {
    if (running.current) { setMessage("更新中…"); return; }
    running.current = true; setBusy(true); setMessage("");
    const at = epoch.current;
    try {
      const result = await rpc<T>(command, {
        expectedWalletId: viewRef.current?.selected,
        expectedNetwork: viewRef.current?.network,
        ...data,
      });
      if (at !== epoch.current) return;
      if (result && typeof result === "object" && "exists" in result) setView(result as unknown as View);
      if (command === "refresh") { lastChain.current = Date.now(); setSyncFailed(false); }
      after?.(result);
    } catch (error) {
      if (at === epoch.current) {
        const reason = error instanceof Error ? error.message : "操作失败。";
        if (reason === "watch-address" || reason === "watch-network") { setMessage(watchProblem(reason)); return; }
        setMessage(/^(account_required|unauthorized|refresh_revoked)$/.test(reason) ? { account: "expired" } : /^(account_|bad_callback|invalid_authorization|refresh_)/.test(reason) ? { account: "failed" } : reason);
      }
    }
    finally { running.current = false; setBusy(false); }
  }
  async function lock() {
    epoch.current++; close(); setView((v) => ({ exists: v?.exists ?? true, locked: true }));
    try { await rpc("lock"); } catch { setMessage("锁定失败，请关闭浏览器。"); }
  }
  useEffect(() => {
    void act("status");
    const onLock = (message: {event?: string; state?: View}, sender: chrome.runtime.MessageSender) => {
      if (sender.id === chrome.runtime.id && message.event === "locked" && message.state) {
        epoch.current++; close(); setView(message.state);
      }
    };
    chrome.runtime.onMessage.addListener(onLock);
    const timer = setInterval(() => {
      if (running.current) return;
      const at = epoch.current;
      rpc<View>("status").then((v) => { if (at === epoch.current) setView(v); }).catch(() => {});
    }, 15000);
    // Like the contact sync, the periodic chain refresh stays silent: it neither disables buttons
    // nor clears a status the user is reading, such as an unconfirmed broadcast. In the Android app it
    // follows the iOS cadence: every 15 s while something is unconfirmed, otherwise every 60 s.
    const chainTimer = setInterval(() => {
      const v = viewRef.current;
      if (!v || v.locked) return;
      const unconfirmed = ANDROID && (!!v.pending?.length || !!v.snapshot && (BigInt(v.snapshot.pending) !== 0n || v.snapshot.history.some((tx) => !tx.confirmations)));
      if (Date.now() - lastChain.current >= (unconfirmed ? 15000 : 60000) - 500) quietRefresh();
    }, ANDROID ? 15000 : 60000);
    return () => { clearInterval(timer); clearInterval(chainTimer); chrome.runtime.onMessage.removeListener(onLock); };
  }, []);
  useEffect(() => { if (view?.locked) { close(); setNockOpen(false); } }, [view?.locked]);
  useEffect(() => {
    let active = true, revision = 0;
    const update = () => {
      const request = ++revision;
      void rpc<ContactLink>("contact-link").then((state) => {
        if (active && request === revision) setContactLink(state);
      }).catch(() => {});
    };
    const changed = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === "local" && (ACCOUNT in changes || CONTACT_LINK in changes)) update();
    };
    chrome.storage.onChanged.addListener(changed);
    update();
    return () => { active = false; revision++; chrome.storage.onChanged.removeListener(changed); };
  }, [view?.locked, panel]);
  // The periodic sync skips while another action runs and stays silent: it neither blocks clicks with
  // "更新中…" nor clears a status the user is reading. Only an expired sign-in is reported.
  useEffect(() => { if (!contactLink.connected || view?.locked) return; const timer = setInterval(() => { if (document.visibilityState === "visible" && !running.current) void rpc<ContactLink>("contact-sync").then(setContactLink).catch((e: Error) => { if (/^(account_required|unauthorized|refresh_revoked)$/.test(e.message)) setMessage({ account: "expired" }); }); }, 60000); return () => clearInterval(timer); }, [contactLink.connected, view?.locked]);
  useEffect(() => { close(); setChangeScan(""); }, [view?.selected, view?.network]);
  useEffect(() => {
    if (!view || view.locked || !view.selected || watchOff(view)) return;
    const timer = setTimeout(() => { void act("refresh"); }, 0);
    return () => clearTimeout(timer);
  }, [view?.selected, view?.network, view?.locked]);
  useEffect(() => {
    // A status left on the main view (e.g. after a send) would otherwise reappear at the top of every dialog.
    // showModal() focuses the first control; a panel that starts with a field to type in (交易查询) asks for it instead.
    if (panel) { setMessage(""); dialog.current?.showModal(); dialog.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus(); } else dialog.current?.close();
  }, [panel]);
  useEffect(() => {
    let last = 0;
    const touch = () => { if (!view?.locked && Date.now() - last > 15000) { last = Date.now(); void rpc("touch").catch(() => {}); } };
    document.addEventListener("pointerdown", touch); document.addEventListener("keydown", touch);
    return () => { document.removeEventListener("pointerdown", touch); document.removeEventListener("keydown", touch); };
  }, [view?.locked]);
  useEffect(() => {
    // A dialog first, then the NOCK page's own dialog, then the NOCK page itself.
    if (ANDROID) window.__pearlBack = () => { if (dialog.current?.open) { close(); return true; } if (nockBack.current?.()) return true; if (nockOpenRef.current) { setNockOpen(false); return true; } return false; };
  }, []);
  // No screenshots while a phrase is on screen: shown (create, backup) or typed (restore, as iOS redacts it).
  useEffect(() => { if (ANDROID) secureScreen(!!mnemonic && (panel === "create" || panel === "backup" || panel === "restore")); }, [mnemonic, panel]);
  // The app's 设置 → 钱包与安全 and Pearl 网络 pages (iOS SettingsPages.swift) drive the wallet through
  // window.__pearlWallet (web/src/android-host.ts).
  const hostListeners = useRef(new Set<() => void>());
  const hostActions = useRef<{ open(target: WalletTarget): void; lock(): void; refresh(): void; setNetwork(network: Network): Promise<boolean>; send(address: string): boolean; setNockLink(shown: boolean): void }>(null);
  // The 交易 tab's 从钱包转入 while the wallet was locked: opened once it is unlocked.
  const pendingSend = useRef<string | null>(null);
  const sendTo = (address: string) => { close(); setNockOpen(false); setTab("wallet"); startSend(); setTo(address); };
  hostActions.current = {
    open(target) {
      const v = viewRef.current;
      if (!v || v.locked || running.current) return;
      if (target === "contacts") { close(); setTab("contacts"); return; }
      // A read-only wallet has no phrase to show and no change to recover.
      if (wallet?.watch && (target === "backup" || target === "recover")) return;
      // iOS 找回搁浅的找零: scan the change addresses, list what is stranded, sweep it to an address.
      if (target === "recover") { close(); setTab("wallet"); startRecover(); return; }
      clearSecrets();
      if (target === "remove") { if (wallet?.watch) { setWatchTarget(wallet); setPanel("watchRemove"); return; } setName(wallet?.name || ""); setPanel("settings"); return; }
      setPanel(target);
    },
    lock() { void lock(); },
    setNockLink(shown) { setNockLink(shown); },
    refresh() { if (Date.now() - lastChain.current > 10000) quietRefresh(); },
    send(address) {
      const v = viewRef.current;
      if (!v || v.locked) { pendingSend.current = address; return false; }
      if (running.current || (v.network || "mainnet") !== "mainnet" || v.wallets?.find((x) => x.id === v.selected)?.watch) return false;
      sendTo(address);
      return true;
    },
    async setNetwork(network) {
      // The refresh a previous switch started may still run; the wallet takes one action at a time.
      for (let i = 0; i < 150 && running.current; i++) await new Promise((r) => setTimeout(r, 100));
      const v = viewRef.current;
      if (!v || v.locked || v.network === network) return v?.network === network;
      close();
      let ok = false;
      await act("network", { network }, () => { ok = true; });
      return ok;
    },
  };
  useEffect(() => {
    if (!ANDROID) return;
    window.__pearlWallet = {
      state: () => {
        const v = viewRef.current, w = v?.wallets?.find((x) => x.id === v.selected);
        return { exists: !!v?.exists, locked: !v || v.locked, count: v?.wallets?.length || 0, network: v && !v.locked ? v.network || "mainnet" : null,
          address: v && !v.locked && v.network === "mainnet" && w ? w.primaryAddress || w.address : null,
          readOnly: !!w?.watch, nockLink: nockState.current.available ? nockState.current.hidden ? "hidden" : "shown" : null };
      },
      open: (target) => hostActions.current?.open(target),
      lock: () => hostActions.current?.lock(),
      refresh: () => hostActions.current?.refresh(),
      setNetwork: (network) => hostActions.current?.setNetwork(network) ?? Promise.resolve(false),
      wallets: () => {
        const v = viewRef.current;
        if (!v || v.locked || (v.network || "mainnet") !== "mainnet") return [];
        return (v.wallets || []).filter((w) => !w.watch).map((w) => ({ name: w.name, address: w.primaryAddress || w.address }));
      },
      send: (address) => hostActions.current?.send(address) ?? false,
      setNockLink: (shown) => hostActions.current?.setNockLink(shown),
      subscribe: (listener) => { hostListeners.current.add(listener); return () => { hostListeners.current.delete(listener); }; },
    };
    return () => { delete window.__pearlWallet; };
  }, []);
  const notifyHost = () => { for (const listener of hostListeners.current) { try { listener(); } catch { /* The page went away. */ } } };
  useEffect(notifyHost, [view]);
  useEffect(() => {
    const address = pendingSend.current;
    if (!ANDROID || !address || !view || view.locked) return;
    pendingSend.current = null;
    if ((view.network || "mainnet") === "mainnet" && !view.wallets?.find((x) => x.id === view.selected)?.watch) sendTo(address);
  }, [view?.locked]);
  useEffect(() => {
    if (!ANDROID || !view?.snapshot || view.locked || !view.selected || !view.network) return;
    const next = { walletId: view.selected, network: view.network, balance: view.snapshot.balance };
    if (lastBalance && lastBalance.walletId === next.walletId && lastBalance.network === next.network && lastBalance.balance === next.balance) return;
    setLastBalance(next);
    void chrome.storage.local.set({ [BALANCE]: next }).catch(() => {});
  }, [view?.snapshot?.balance, view?.selected, view?.network]);
  // The app's view of itself (Pro, live alerts, a placed widget) for the one-line links; redrawn when it changes.
  const [, setHostTick] = useState(0);
  useEffect(() => ANDROID ? pearlHost()?.subscribe(() => setHostTick((n) => n + 1)) : undefined, []);
  // Like iOS, each launch receives on the main address again (#0); 换一个收款地址 rotates within the run.
  const mainOnLaunch = useRef(false);
  useEffect(() => {
    if (!ANDROID || mainOnLaunch.current || !view || view.locked || !wallet) return;
    mainOnLaunch.current = true;
    if (wallet.index > 0 && !running.current) void rpc<View>("receive-main", { expectedWalletId: view.selected, expectedNetwork: view.network }).then(setView).catch(() => {});
  }, [view]);
  // The iOS app's one-time donation ask (DonateView.swift DonationPrompt): after 10 launches over at least 5 days,
  // on the wallet's home view, with nothing unconfirmed and at least 1 PRL + the 0.001 PRL fee reserve to give.
  const donationAsked = useRef(false);
  useEffect(() => {
    if (!ANDROID || pearlHost()?.alerts?.().ready !== true || pearlHost()?.alerts?.().pro || donationAsked.current || !view || view.locked || view.network !== "mainnet" || panel || tab !== "wallet" || !wallet || busy) return;
    const snap = view.snapshot;
    if (!snap || view.pending?.length || BigInt(snap.pending) !== 0n || BigInt(snap.balance) < 100_100_000n) return;
    if (wallet.watch || !canDonate(view.network, wallet.primaryAddress || wallet.address, wallet.address) || !pearlHost()?.visible?.()) return;
    donationAsked.current = true;
    void (async () => {
      const saved = await chrome.storage.local.get(DONATION_PROMPTED).catch(() => ({ [DONATION_PROMPTED]: true }));
      if (saved[DONATION_PROMPTED]) return;
      const info = await nativeCall<{ launches?: number; firstLaunch?: number }>("info").catch(() => null);
      if (!info || (info.launches || 0) < 10 || !info.firstLaunch || Date.now() / 1000 - info.firstLaunch < 5 * 86400) return;
      await new Promise((r) => setTimeout(r, 1500));   // let the balance settle in first
      if (pearlHost()?.alerts?.().pro || viewRef.current?.selected !== view.selected || viewRef.current?.locked || dialog.current?.open || nockOpenRef.current || !pearlHost()?.visible?.()) { donationAsked.current = false; return; }
      await chrome.storage.local.set({ [DONATION_PROMPTED]: true }).catch(() => {});
      if (!pearlHost()?.alerts?.().pro && !viewRef.current?.locked && viewRef.current?.selected === view.selected && !dialog.current?.open && pearlHost()?.visible?.()) startDonation();
    })();
  }, [view, panel, tab, busy]);
  useEffect(() => {
    if (!ANDROID || !view) return;
    if (!view.exists) { publishWalletWidget(null); return; }
    const w = view.wallets?.find((x) => x.id === view.selected), snapshot = view.snapshot;
    if (view.locked || !w || !snapshot) return;
    void rpc<{ xpub: string; changeAddresses: string[] }>("widget-keys", { expectedWalletId: view.selected, expectedNetwork: view.network }).then((keys) => publishWalletWidget({
      name: w.name, network: view.network, xpub: keys.xpub, changeAddresses: keys.changeAddresses, balance: snapshot.balance, pending: snapshot.pending,
      recent: snapshot.history.slice(0, 5).map((tx) => ({ received: !(tx.sent ?? BigInt(tx.delta) <= 0n), amount: tx.amount ?? (BigInt(tx.delta) < 0n ? -BigInt(tx.delta) : BigInt(tx.delta)).toString(), time: tx.time })),
      at: Math.floor(Date.now() / 1000),
    })).catch(() => {});
  }, [view]);
  // The account's web 钱包 page (iOS WebSharedMerge.wallets), through the app page: this device's wallets go
  // there, and the read-only ones follow it back. Only while unlocked, as the list is in the vault.
  const syncingWallets = useRef(false);
  const walletsKey = JSON.stringify(view?.wallets?.map((x) => [x.id, x.name, x.watch]) || []);
  useEffect(() => {
    const host = ANDROID ? pearlHost() : undefined;
    if (!host?.syncWallets || !view?.exists || view.locked) return;
    const sync = async () => {
      const v = viewRef.current;
      if (syncingWallets.current || running.current || !v?.exists || v.locked) return;
      syncingWallets.current = true;
      try {
        const expected = { expectedWalletId: v.selected, expectedNetwork: v.network };
        const rows = await walletRows(await rpc<{ addr: string; label: string; watch: boolean }[]>("web-rows", expected));
        const sync = host.syncWallets?.(rows);
        // Not applied now (another action runs): not committed either, so the next round redoes it.
        if (!sync || walletChangesEmpty(sync.changes) || running.current) return;
        const next = await rpc<View & { skipped?: string[] }>("watch-apply", { changes: sync.changes, ...expected });
        sync.commit(next.skipped);
        setView(next);
        if (!next.exists) void forgetDeviceSecret();
      } catch { /* The next change or sync tries again. */ }
      finally { syncingWallets.current = false; }
    };
    void sync();
    return host.subscribe(() => void sync());
  }, [view?.exists, view?.locked, walletsKey]);
  // Android: the vault password comes from the shell after a fingerprint / screen-lock check.
  // One prompt at a time: a second tap before the system prompt shows must not start a second send.
  const asking = useRef(false);
  // The same seed's NOCK (Nockchain) side, nock/NockView.tsx: while open its page takes the PRL one's place.
  const [nockOpen, setNockOpen] = useState(false);
  const nockOpenRef = useRef(false); nockOpenRef.current = nockOpen;
  const nockBack = useRef<(() => boolean) | null>(null);
  const nockRpc = <T,>(command: string, data: Record<string, unknown> = {}) => rpc<T>(command, { expectedWalletId: viewRef.current?.selected, ...data });
  // The NOCK line's 关闭 (iOS NockInlineLink.hiddenKey): one setting for every wallet; 钱包设置 (Android:
  // 设置 → 钱包与安全) brings it back.
  const [nockLinkHidden, setNockLinkHidden] = useState(false);
  useEffect(() => {
    const changed = (changes: Record<string, chrome.storage.StorageChange>, area: string) => { if (area === "local" && NOCK_LINK_HIDDEN in changes) setNockLinkHidden(changes[NOCK_LINK_HIDDEN].newValue === true); };
    chrome.storage.onChanged.addListener(changed);
    void chrome.storage.local.get(NOCK_LINK_HIDDEN).then((saved) => setNockLinkHidden(saved[NOCK_LINK_HIDDEN] === true)).catch(() => {});
    return () => chrome.storage.onChanged.removeListener(changed);
  }, []);
  const setNockLink = (shown: boolean) => { setNockLinkHidden(!shown); void chrome.storage.local.set({ [NOCK_LINK_HIDDEN]: !shown }).catch(() => {}); };
  // Whether the open wallet uses NOCK: then its strip shows regardless, and the switch doesn't apply.
  const [nockInUse, setNockInUse] = useState<boolean | null>(null);
  useEffect(() => {
    setNockInUse(null);
    if (!view || view.locked || !view.selected || readOnly) return;
    let live = true;
    void nockRpc<{ inUse: boolean }>("nock-status").then((v) => { if (live) setNockInUse(v.inUse === true); }).catch(() => {});
    return () => { live = false; };
  }, [view?.selected, view?.locked, readOnly, nockOpen]);
  const nockSwitch = !!view && !view.locked && !!wallet && !readOnly && nockInUse === false;
  const nockState = useRef({ hidden: false, available: false }); nockState.current = { hidden: nockLinkHidden, available: nockSwitch };
  useEffect(() => { if (ANDROID) notifyHost(); }, [nockLinkHidden, nockSwitch]);
  const withSecret = (title: string, run: (secret: string) => void, create = false) => {
    if (!ANDROID) return;
    if (running.current || asking.current) { setMessage("更新中…"); return; }
    asking.current = true;
    void deviceSecret(title, create).then(run, (error) => {
      const code = error instanceof BridgeError ? error.code : "failed";
      if (code !== "cancelled") setMessage({ android: code === "no_lock_screen" ? "needLock" : code === "lockout" ? "lockout" : code === "no_secret" ? "secretMissing" : "authFailed" });
    }).finally(() => { asking.current = false; });
  };
  const confirmNote = ANDROID && <p className="android-confirm"><Icon name="lock" />{w.confirmNote}</p>;
  // A phrase pasted into 恢复钱包 leaves the clipboard once the wallet is saved, if nothing was copied
  // since (iOS clears it the same way).
  const pasted = useRef("");
  const forgetPasted = () => { if (ANDROID && pasted.current) void nativeCall("clipboard.clear", { text: pasted.current }).catch(() => {}); pasted.current = ""; };
  async function copy(text: string) {
    try { await navigator.clipboard.writeText(text); setMessage("已复制。"); } catch { setMessage("复制失败，请手动选择文字。"); }
  }
  function start(mode: "create" | "restore") {
    if (running.current) { setMessage("更新中…"); return; }
    // Android names wallets like iOS: "Pearl Wallet", then "Pearl Wallet 2", … — the first name no wallet uses.
    const used = new Set(view?.wallets?.map((x) => x.name));
    let suggested = "Pearl Wallet";
    for (let n = 2; used.has(suggested); n++) suggested = `Pearl Wallet ${n}`;
    clearSecrets(); setName(ANDROID ? suggested : view?.exists ? t("新钱包") : t("我的钱包")); setPanel(mode);
    if (mode === "create") void act<{ mnemonic: string }>("generate", {}, (r) => setMnemonic(r.mnemonic));
  }
  // iOS suggestedWatchName: "只读钱包", then "只读钱包 2", … — the first name no wallet uses.
  function startWatch() {
    if (running.current) { setMessage("更新中…"); return; }
    const used = new Set(view?.wallets?.map((x) => x.name));
    let suggested = t("只读钱包");
    for (let n = 2; used.has(suggested); n++) suggested = `${t("只读钱包")} ${n}`;
    clearSecrets(); setName(suggested); setWatchAddress(""); setPanel("watch");
  }
  function addWatch() {
    type Added = View & { existing?: string };
    const done = (r: Added) => { close(); if (r.existing) setMessage({ text: t("该钱包已在本机，已切换到「{name}」", { name: r.existing }) }); };
    const data = { name, address: watchAddress };
    if (view?.exists) { void act<Added>("watch-add", data, done); return; }
    // As the first wallet it makes the vault: Android's device key, or the extension's new password.
    if (ANDROID) { withSecret(t("添加只读钱包"), (secret) => void act<Added>("watch-add", { ...data, password: secret }, done), true); return; }
    if (password !== repeat) { setMessage("两次密码不一致。"); return; }
    void act<Added>("watch-add", { ...data, password }, done);
  }
  function removeWatch(target: WalletInfo) {
    void act<View>("watch-remove", { id: target.id }, (r) => { close(); if (ANDROID && !r.exists) void forgetDeviceSecret(); });
  }
  function startSend() {
    setRecovery(false);
    clearSecrets(); setTo(""); setValue(""); setMaximum(false); setPanel("send"); loadFee();
  }
  // 检查历史找零 used to rescan with no word on screen. In the app it opens the 找回搁浅的找零 sheet
  // (scanning, then what it found, as on iOS); the extension reports progress under the buttons.
  function scanChange() {
    if (ANDROID) { startRecover(); return; }
    setChangeScan("running");
    void act("refresh", { scan: true }, () => setChangeScan("done")).finally(() => setChangeScan((s) => s === "running" ? "" : s));
  }
  function startRecover() {
    if (running.current) { setMessage("更新中…"); return; }
    clearSecrets(); setRecoverDest("main"); setRecoverAddress(""); setPanel("recover"); loadFee();
    void act("refresh", { scan: true });
  }
  function sweepChange() {
    const dest = recoverDest === "custom" ? recoverAddress.trim().toLowerCase() : "";
    setRecovery(true); setTo(dest || wallet?.primaryAddress || wallet?.address || ""); setMaximum(true);
    void act<Review>("prepare", { to: dest, amount: "", fee, max: true, recovery: true, recoveryTo: dest }, (r) => { setReview(r); setPanel("send"); });
  }
  function startDonation() {
    if (running.current) { setMessage("更新中…"); return; }
    clearSecrets(); setTo(DONATION_ADDRESS); setValue(""); setMaximum(false); setPanel("donate"); loadFee();
  }
  function loadFee() {
    const request = ++feeRequest.current;
    feeEdited.current = false; setFee(50000); setFeeSource("default");
    void act<{ fee: number; estimated: boolean }>("fee", {}, (r) => {
      if (request !== feeRequest.current || feeEdited.current) return;
      setFee(r.fee); setFeeSource(r.estimated ? "estimated" : "default");
    });
  }
  function prepareDonation(value: string) { void act<Review>("prepare", { donation: true, amount: value, fee }, setReview); }
  const form = (callback: (data: FormData) => void, children: React.ReactNode) => <form onSubmit={(e) => { e.preventDefault(); callback(new FormData(e.currentTarget)); }}>{children}</form>;
  const passwordField = (label = t("解锁密码"), tip?: string) => <label>{tip ? <span className="label-row">{label}<InfoTip label={t("说明")} text={tip} /></span> : label}<input aria-label={label} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>;
  const explorer = (txid: string) => `${origin(view?.network || "mainnet")}/tx/${txid}`;
  const openTx = (txid: string) => { clearSecrets(); setDetailTxid(txid); setPanel("tx"); };
  const openLookup = () => { clearSecrets(); setLookupInput(""); setLookupTxid(""); setLookupInvalid(false); setPanel("lookup"); };
  // Names for addresses in 交易详情: this wallet's, another wallet's current or first address, or a contact's.
  const txLabel = (address: string, mine: boolean) => mine ? wallet?.name : payee(address) || view?.wallets?.find((x) => x.address === address || x.primaryAddress === address)?.name;
  const txLoad = (txid: string) => rpc<TxLoad>("tx-detail", { txid, expectedWalletId: viewRef.current?.selected, expectedNetwork: viewRef.current?.network });
  const txResend = (txid: string) => rpc<TxResend>("tx-rebroadcast", { txid, expectedWalletId: viewRef.current?.selected, expectedNetwork: viewRef.current?.network });
  const txView = (txid: string) => <TxDetailView key={txid} txid={txid} lang={lang} explorer={explorer(txid)} label={txLabel} copy={(text) => void copy(text)} load={txLoad} resend={txResend} />;
  // iOS shows last session's balance, dimmed, until the chain answers (balanceIsCached); the Android wallet
  // keeps the last confirmed figure per wallet and network for that.
  const cachedBalance = ANDROID && !view?.snapshot && lastBalance && lastBalance.walletId === view?.selected && lastBalance.network === view?.network ? lastBalance.balance : null;
  const balance = view?.snapshot ? balanceParts(view.snapshot.balance, lang) : cachedBalance ? balanceParts(cachedBalance, lang) : { head: "—", tail: "" };
  // The iOS send screen's checks, as the person types: address format, 8 decimals, the 0.001 PRL fee reserve.
  const sendIssue = (() => {
    if (!ANDROID || panel !== "send" || review || !view?.network) return { address: "", amount: "" };
    const address = !recovery && to.trim() && !isAddress(to.trim().toLowerCase(), view.network) ? fill(w.badAddress, view.network === "mainnet" ? "prl1" : "tprl1") : "";
    let issue = "";
    if (!maximum && value.trim()) {
      const fraction = value.trim().replace(",", ".").split(".")[1] || "";
      if (fraction.length > 8) issue = fill(w.decimals, 8);
      else if (view.snapshot) { try { if (parseAmount(value) + FEE_RESERVE > BigInt(view.snapshot.balance)) issue = fill(w.overBalance, "0.001"); } catch { /* the preview says what is wrong */ } }
    }
    return { address, amount: issue };
  })();
  // The iOS wallet home: the last three transfers, then 价格提醒 and 桌面小组件 as one quiet line each.
  const host = ANDROID ? pearlHost() : undefined;
  const ago = (time: number) => {
    const s = Math.max(0, Date.now() / 1000 - time), f = new Intl.RelativeTimeFormat(lang, { numeric: "auto", style: "short" });
    return s < 60 ? f.format(0, "second") : s < 3600 ? f.format(-Math.floor(s / 60), "minute") : s < 86400 ? f.format(-Math.floor(s / 3600), "hour") : f.format(-Math.floor(s / 86400), "day");
  };
  const recent = view?.snapshot?.history.filter((tx) => (tx.amount ?? tx.delta) !== "0").slice(0, 3) || [];
  const recentCard = ANDROID && <section className="recent-card">
    <div className="recent-head"><span>{w.recentTx}</span>{!!recent.length && <button className="text-button" onClick={() => setTab("history")}>{w.all}</button>}</div>
    {!view?.snapshot ? [0, 1, 2].map((i) => <div key={i} className="recent-row skeleton-row" />)
      : !recent.length ? <p className="recent-empty">{w.noTx}</p>
      : recent.map((tx) => { const received = !(tx.sent ?? BigInt(tx.delta) <= 0n), value = tx.amount ?? (BigInt(tx.delta) < 0n ? -BigInt(tx.delta) : BigInt(tx.delta)).toString(); return <button key={tx.txid} className="recent-row" onClick={() => openTx(tx.txid)}>
        <span className={received ? "recent-dir in" : "recent-dir"}><Icon name={received ? "received" : "sent"} /></span>
        <strong className={received ? "in" : ""}>{received ? "+" : "−"}{amount(value)} PRL</strong>
        {tx.confirmations < 100 && <span className={tx.confirmations ? "recent-conf" : "recent-conf pending"}>{tx.confirmations ? fill(w.confirmations, tx.confirmations) : w.unconfirmed}</span>}
        <small>{tx.time ? ago(tx.time) : ""}</small>
      </button>; })}
  </section>;
  // iOS Dashboard's shortcut card: 价格提醒 (with the live count once Pro has some), 桌面小组件 until a widget
  // is placed, and the NOCK line until NOCK is used or the line is closed: rows of one card, not loose links.
  const alertState = host?.alerts?.();
  const shortcuts = <section className="shortcut-card">
    {ANDROID && alertState && <button className="shortcut-row" onClick={() => host?.open?.("alerts")}><Icon name="alerts" /><span className="shortcut-title">{w.priceAlerts}</span>{alertState.pro && alertState.active > 0 && <small>{fill(w.alertsOn, alertState.active)}</small>}<Icon name="chevron" className="shortcut-chevron" /></button>}
    {ANDROID && host?.widgetPlaced && !host.widgetPlaced() && <button className="shortcut-row" onClick={() => host?.open?.("widgets")}><Icon name="app" /><span className="shortcut-title">{w.widgets}</span><Icon name="chevron" className="shortcut-chevron" /></button>}
    {wallet && !readOnly && !nockLinkHidden && <NockEntry key={`link-${wallet.id}`} slot="link" lang={lang} rpc={nockRpc} walletId={wallet.id} secondary={secondary} rates={market.rates} onOpen={() => { clearSecrets(); setNockOpen(true); }} onClose={() => { clearSecrets(); setPanel("nockClose"); }} />}
  </section>;
  // 添加只读钱包 under the welcome screen's two seed buttons: a quiet link, what it is in the ⓘ beside it.
  const watchLink = <div className="watch-link"><button type="button" disabled={busy} onClick={startWatch}><Icon name="eye" />{t("添加只读钱包")}</button><InfoTip label={t("只读钱包")} title={t("只读钱包")} text={t("只填一个地址，就能查看它的余额和交易记录。不需要助记词，也不能转账。")} /></div>;
  const notice = message && <div role="status" className="message">{typeof message === "string" ? messageText(lang, message) : "text" in message ? message.text : "account" in message ? accountCopy(lang)[message.account] : ANDROID && <span className="android-lock-help">{w[message.android]}{message.android === "needLock" && <button onClick={openSecuritySettings}>{w.openSettings}</button>}</span>}<button aria-label={t("关闭提示")} onClick={() => setMessage("")}>×</button></div>;
  return <div className="shell">
    <header><div className="brand"><img src="./icon.png" alt="" /><div><strong>Pearl Hub</strong><small>{t("PRL 钱包")}</small></div></div><div className="header-actions">
      {!ANDROID && <button className="icon-button" title={t("在完整页面打开")} aria-label={t("在完整页面打开")} onClick={() => void chrome.tabs.create({ url: chrome.runtime.getURL("index.html") })}><Icon name="external" /></button>}
      <button id="wallet-settings" className="icon-button" title={t("钱包设置")} aria-label={t("钱包设置")} aria-haspopup="dialog" aria-expanded={panel === "settings"} disabled={busy} onClick={() => { clearSecrets(); setName(wallet?.name || ""); setPanel("settings"); }}><Icon name="options" /></button>
      {view && !view.locked && <button className="icon-button header-lock" aria-label={t("锁定钱包")} title={t("锁定钱包")} onClick={() => void lock()}><Icon name="lock" /><span>{t("锁定")}</span></button>}
    </div></header>
    {!panel && notice}
    {!view ? <main className="welcome"><p>{t("正在打开钱包…")}</p></main> : !view.exists ? <main className="welcome">
      <div className="welcome-mark"><Icon name="wallet" /></div><h1 className="sr-only">{t("PRL 钱包")}</h1>
      <button className="primary" disabled={busy} onClick={() => start("create")}>{t("创建钱包")}</button><button disabled={busy} onClick={() => start("restore")}>{t("恢复已有钱包")}</button>
      {watchLink}
    </main> : view.locked ? <main className="welcome locked"><div className="welcome-mark"><Icon name="lock" /></div><h1>{t("钱包已锁定")}<InfoTip label={t("说明")} text={ANDROID ? w.autoLock : t("离开操作 5 分钟后自动锁定；重启浏览器后需重新解锁。")} /></h1>{form(() => { if (ANDROID) withSecret(t("解锁钱包"), (secret) => void act("unlock", { password: secret })); else void act("unlock", { password }, () => setPassword("")); }, <>{!ANDROID && passwordField()}<button className="primary" disabled={busy}>{busy ? t("正在解锁…") : t("解锁钱包")}</button></>)}</main> : <main>
      <div className="wallet-bar"><button id="wallet-switcher" className="wallet-switcher" aria-label={t("选择钱包")} aria-haspopup="dialog" aria-expanded={panel === "wallets"} disabled={busy} onClick={() => { clearSecrets(); setPanel("wallets"); }}>{readOnly && <Icon name="eye" className="switcher-watch" />}<span>{wallet?.name}</span><Icon name="chevron" /></button><span className="wallet-badges">{readOnly && <span className="network-badge watch-chip"><Icon name="eye" />{t("只读")}</span>}<span className={view.network === "testnet" ? "network-badge testnet" : "network-badge"}>{t(view.network === "testnet" ? "测试网" : "主网")}</span></span></div>
      {nockOpen && wallet ? <NockPage key={wallet.id} lang={lang} rpc={nockRpc} walletId={wallet.id} secondary={secondary} rates={market.rates} copy={(text) => void copy(text)} onBack={() => setNockOpen(false)} android={ANDROID} secret={(title, run) => withSecret(title, run)} confirmNote={confirmNote} backHandler={nockBack} /> : <>
      <nav className="wallet-nav"><button aria-pressed={tab === "wallet"} className={tab === "wallet" ? "selected" : ""} onClick={() => setTab("wallet")}>{t("钱包")}</button><button aria-pressed={tab === "history"} className={tab === "history" ? "selected" : ""} onClick={() => setTab("history")}>{t("交易记录")}</button><button aria-pressed={tab === "contacts"} className={tab === "contacts" ? "selected" : ""} onClick={() => setTab("contacts")}>{t("地址簿")}</button></nav>
      {ANDROID && tab === "wallet" && androidUpdate?.latest && <UpdateBanner lang={lang} latest={androidUpdate.latest} dismiss={androidUpdate.dismiss} />}
      <section className={tab === "wallet" ? "balance-card" : "balance-card compact"}>
        <div className="balance-topline">
          <div className="balance-heading"><span>{t("已确认余额")}</span><button title={busy ? t("更新中…") : t("刷新 ↻")} aria-label={busy ? t("更新中…") : t("刷新 ↻")} disabled={busy || watchOff(view)} onClick={() => void act("refresh")}><Icon name="refresh" /></button></div>
          {view.network === "mainnet" && <div className="price-chip" aria-label={`${f("price")} ${market.usd ? "$" + new Intl.NumberFormat(lang, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(market.usd) : "—"}`}><span>PRL</span><strong>{market.usd ? "$" + new Intl.NumberFormat(lang, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(market.usd) : "—"}</strong></div>}
        </div>
        <div className={cachedBalance ? "balance cached" : "balance"} data-long={balance.head.length > 12}>
          <span className="sr-only">{view.snapshot ? `${t("已确认余额")} ${balance.head}${balance.tail} PRL` : t("点击刷新获取链上余额")}</span>
          <span className="balance-number" aria-hidden="true"><span className="balance-head">{balance.head}</span><span className="balance-tail">{balance.tail}</span></span><small aria-hidden="true">PRL</small>
        </div>
        <div className="fiat-slot">{view.network === "mainnet" && market.usd && view.snapshot ? <div className="market-line"><span className="fiat">≈ {dualFiat(Number(view.snapshot.balance) / 1e8 * market.usd, secondary, lang, market.rates)}</span></div> : <span aria-hidden="true">—</span>}</div>
        <p className="balance-status">{watchOff(view) ? watchProblem("watch-network").text : view.snapshot ? t("未确认输出 {amount} PRL", { amount: amount(view.snapshot.pending) }) : t("点击刷新获取链上余额")}</p>
      </section>
      {ANDROID && syncFailed && <p className="sync-banner"><Icon name="warning" />{view.snapshot ? fill(w.syncErrorAt, w.syncError, new Date(view.snapshot.time).toLocaleTimeString(lang, { hour: "2-digit", minute: "2-digit" })) : fill(w.syncErrorRetry, w.syncError)}</p>}
      <div className={tab === "wallet" ? "balance-actions" : "balance-actions compact"}>
        <button aria-label={t("↓ 收款")} onClick={() => { clearSecrets(); setPanel("receive"); }}><span className="action-icon"><Icon name="qr" /></span><span>{t("↓ 收款").replace(/^↓\s*/, "")}</span></button>
        <button aria-label={t("↑ 转账")} disabled={busy} onClick={readOnly ? () => { clearSecrets(); setPanel("watchSend"); } : startSend}><span className="action-icon"><Icon name="send" /></span><span>{t("↑ 转账").replace(/^↑\s*/, "")}</span></button>
      </div>
      {view.network === "testnet" && <p className="notice">{t("当前为测试网，测试币不具有主网价值。")}</p>}
      {ANDROID && tab === "wallet" && recentCard}
      {ANDROID && tab === "wallet" && shortcuts}
      {!!view.pending?.length && <section className="section"><h2>{t("待确认转账")}</h2>{view.pending.map((p) => <article className="pending" key={p.txid}><div><strong>{amount(p.amount)} PRL</strong><span>{p.status === "rejected" ? t("节点拒绝了此交易") : p.status === "unknown" ? t("广播结果待核对") : t("已广播，等待确认")}</span></div><code>{p.txid}</code><small>{p.status === "unknown" ? t("网络回复丢失时，交易可能已经发出。核对状态或重试同一笔交易。") : t("确认前保留原交易，防止重复付款。")}</small><div className="actions"><button disabled={busy} onClick={() => void act("check", { txid: p.txid })}>{t("核对链上状态")}</button>{p.status !== "submitted" && <button disabled={busy} onClick={() => { clearSecrets(); setRetry(p.txid); setPanel("retry"); }}>{t("重试原交易")}</button>}<button disabled={busy} onClick={() => { clearSecrets(); setRetry(p.txid); setPanel("discard"); }}>{t("移除待确认记录")}</button><a href={explorer(p.txid)} target="_blank" rel="noreferrer">{t("浏览器 ↗")}</a></div></article>)}</section>}
      {tab === "contacts" ? <section className="section contacts"><div className="section-heading"><h2>{t("地址簿")}</h2><button disabled={busy} onClick={() => editContact()}>{t("添加")}</button></div>{!contacts.length && <p className="empty">{t("暂无联系人")}</p>}{contacts.map((c) => <article className="contact" key={c.id}><strong>{c.name}</strong>{c.note && <small>{c.note}</small>}<code>{c.address}</code><div className="actions"><button onClick={() => void copy(c.address)}>{t("复制地址")}</button><details><summary aria-label={t("编辑联系人")}><Icon name="more" /></summary><button disabled={busy} onClick={() => editContact(c)}>{t("编辑联系人")}</button><button className="danger-button" disabled={busy} onClick={() => void act("contact-remove", { id: c.id })}>{t("删除联系人")}</button></details></div></article>)}</section> : tab === "wallet" ? <section className="section"><h2 className="title-tip">{t("管理钱包")}{!readOnly && <InfoTip label={t("说明")} text={[t("助记词和私钥不会发送给链上查询服务。恢复原生钱包后，点击“检查历史找零”核对旧地址资金。"), t("已验证地址路径的输入均可签名；历史找零扫描只读取转出记录，支持分页和增量更新。"), t("旧记录未提供地址路径时，手动扫描最多核对前 10,000 个找零地址。")].join("\n\n")} />}</h2><div className="manage-grid"><button aria-label={t("＋ 创建钱包")} disabled={busy} onClick={() => start("create")}><Icon name="create" /><span>{t("创建钱包")}</span></button><button aria-label={t("恢复钱包")} disabled={busy} onClick={() => start("restore")}><Icon name="restore" /><span>{t("恢复钱包")}</span></button><button aria-label={t("添加只读钱包")} disabled={busy} onClick={startWatch}><Icon name="eye" /><span>{t("只读钱包")}</span></button>{!readOnly && <><button aria-label={t("备份助记词")} onClick={() => { clearSecrets(); setPanel("backup"); }}><Icon name="backup" /><span>{t("备份助记词")}</span></button><button aria-label={t("检查历史找零")} disabled={busy} onClick={scanChange}><Icon name="refresh" /><span>{t("检查历史找零")}</span></button><button aria-label={t("找零归集")} disabled={busy} onClick={() => { startSend(); setRecovery(true); setTo(wallet?.primaryAddress || wallet?.address || ""); setMaximum(true); }}><Icon name="change" /><span>{t("找零归集")}</span></button></>}</div>{changeScan && <p role="status" className="scan-status">{t(changeScan === "running" ? "正在检查历史找零…" : "历史找零已检查完毕，余额已更新。")}</p>}</section> : <section className="section"><div className="section-heading"><h2>{t("交易记录")}</h2><div className="section-tools">{view.snapshot && <small>{new Date(view.snapshot.time).toLocaleTimeString(lang)}</small>}<button className="icon-button" title={t("交易查询")} aria-label={t("交易查询")} onClick={openLookup}><Icon name="search" /></button></div></div>{!view.snapshot ? <p className="empty">{t("刷新后查看链上交易。")}</p> : !view.snapshot.history.length ? <p className="empty">{t("尚无交易记录。")}</p> : view.snapshot.history.map((tx) => <article className="transaction" key={tx.txid} onClick={(e) => { if (!(e.target as HTMLElement).closest("button, a")) openTx(tx.txid); }}><span className={!(tx.sent ?? BigInt(tx.delta) <= 0n) ? "tx-icon incoming" : "tx-icon"}>{!(tx.sent ?? BigInt(tx.delta) <= 0n) ? <Icon name="received" /> : <Icon name="sent" />}</span><div className="tx-main"><strong>{!(tx.sent ?? BigInt(tx.delta) <= 0n) ? t("收到 PRL") : t("转出或手续费")}</strong><small className="tx-meta"><span>{tx.time ? new Date(tx.time * 1000).toLocaleString(lang) : t("等待确认")}</span> · <span>{tx.confirmations ? t("{count} 次确认", { count: tx.confirmations }) : t("未确认")}</span></small></div><div className="tx-amount"><b>{tx.sent ? "−" : "+"}{amount(tx.amount ?? (BigInt(tx.delta) < 0n ? -BigInt(tx.delta) : BigInt(tx.delta)))}</b>{tx.sent && tx.fee != null && <small>{t("手续费")} · {amount(tx.fee)} PRL</small>}</div><button className="icon-button tx-open" aria-label={t("交易详情")} title={t("交易详情")} onClick={() => openTx(tx.txid)}><Icon name="chevron" /></button><div className="tx-id"><small>{t("交易 ID")}</small><code title={tx.txid}>{tx.txid.slice(0, 12)}…{tx.txid.slice(-8)}</code><button className="tx-copy" aria-label={t("复制交易 ID")} title={t("复制交易 ID")} onClick={() => void copy(tx.txid)}><Icon name="copy" /></button></div>{tx.address && <div className="peer"><small>{t(tx.sent ? "去向" : "来源")}{payee(tx.address) && <strong>{payee(tx.address)}</strong>}</small><div className="peer-address"><code title={tx.address}>{tx.address.slice(0, 12)}…{tx.address.slice(-8)}</code><button className="peer-copy" aria-label={t("复制地址")} onClick={() => void copy(tx.address!)}>{t("复制")}</button></div></div>}</article>)}{view.snapshot?.hasMore && <button className="wide" disabled={busy} onClick={() => void act("refresh", { page: view.snapshot!.page + 1 })}>{t("加载更多")}</button>}</section>}
      {tab === "wallet" && wallet && !readOnly && <NockEntry key={`strip-${wallet.id}`} slot="strip" lang={lang} rpc={nockRpc} walletId={wallet.id} secondary={secondary} rates={market.rates} onOpen={() => { clearSecrets(); setNockOpen(true); }} />}
      {view.network === "mainnet" && wallet && !readOnly && canDonate(view.network, wallet.primaryAddress || wallet.address, wallet.address) && <button className="wide donate-entry" disabled={busy} onClick={startDonation}>{t("支持开发者")}</button>}
      {wallet && view.network === "mainnet" && webLink("wallet", wallet.address, view.network) && (ANDROID
        // In the app the monitor form is a tab away: open it with this address filled in.
        ? <section className="web-links"><a href={`/#workers?addr=${wallet.address}`} onClick={(e) => { e.preventDefault(); pearlHost()?.openPage(`workers?addr=${wallet.address}`); }}>{t("用这个地址添加矿机监控")}</a></section>
        : <section className="web-links"><a href={webLink("workers", wallet.address, view.network)} target="_blank" rel="noreferrer">{t("用这个地址添加矿机监控")} ↗</a><span className="label-row"><a href={webLink("wallet", wallet.address, view.network)} target="_blank" rel="noreferrer">{t("在网页观察这个地址")} ↗</a><InfoTip label={t("说明")} text={t("仅预填地址，请在网页确认保存。")} /></span></section>)}
      {!ANDROID && tab === "wallet" && shortcuts}
      </>}
      <footer>{t("本机加密 · 本机签名")} · PRL Wallet {chrome.runtime.getManifest().version}</footer>
    </main>}
    <dialog ref={dialog} onCancel={close} onClick={(e) => { if (e.target === dialog.current && !busy) close(); }}><div className="dialog-inner"><div className="dialog-title"><h2>{({ create: t("创建钱包"), restore: t("恢复钱包"), receive: t("收款"), send: review ? t("确认转账") : t(recovery ? "找零归集" : "转账"), settings: t("钱包设置"), wallets: t("选择钱包"), backup: t("备份助记词"), retry: t("重试原交易"), discard: t("移除待确认记录"), contact: t(contactDraft.id ? "编辑联系人" : "新增联系人"), donate: t(review ? "确认捐赠" : "支持开发者"), security: securityCopy(lang).title, recover: ANDROID ? w.recoverTitle : "", tx: t("交易详情"), lookup: t("交易查询"), watch: t("只读钱包"), watchSend: t("只读钱包不能转账"), watchRemove: t("移除只读钱包"), nockClose: t("关闭 NOCK 钱包入口？") } as Record<string, string>)[panel || ""]}</h2><button className="icon-button" aria-label={t("关闭")} onClick={close}><Icon name="close" /></button></div>
      {panel && notice}
      {(panel === "create" || panel === "restore") && form((f) => {
        if (panel === "create" && !quiz) { if (ANDROID) setQuizPick(makeQuiz(mnemonic.split(" "))); setQuiz(true); return; }
        if (panel === "create" && ANDROID && quizPick) { const words = mnemonic.split(" "); if (quizPick.positions.some((i) => quizPick.chosen[i] !== words[i])) { setMessage(w.chooseWrong); return; } }
        else if (panel === "create") { const words = mnemonic.split(" "); if ([2, 6, 10].some((i) => String(f.get(`word${i}`) || "").trim().toLowerCase() !== words[i])) { setMessage("备份核对未通过，请检查第 3、7、11 个单词。"); return; } }
        if (ANDROID) { withSecret(t("保存钱包"), (secret) => void act("create", { name, mnemonic, password: secret }, () => { forgetPasted(); close(); }), !view?.exists); return; }
        if (!view?.exists && password !== repeat) { setMessage("两次密码不一致。"); return; }
        void act("create", { name, mnemonic, password }, () => close());
      }, <><label>{t("钱包名称")}<input value={name} maxLength={40} onChange={(e) => setName(e.target.value)} required /></label>{panel === "create" ? <>{!quiz ? <div className="words">{mnemonic.split(" ").map((word, i) => <div key={i}><small>{i + 1}</small>{word}</div>)}</div> : ANDROID && quizPick ? <div className="quiz quiz-choices">{quizPick.positions.map((i, n) => <fieldset key={i}><legend>{fill(w.wordN, i + 1)}</legend><div>{quizPick.options[n].map((word) => <button type="button" key={word} aria-pressed={quizPick.chosen[i] === word} className={quizPick.chosen[i] === word ? "selected" : ""} onClick={() => setQuizPick((q) => q && { ...q, chosen: { ...q.chosen, [i]: word } })}>{word}</button>)}</div></fieldset>)}</div> : <div className="quiz">{[2, 6, 10].map((i) => <label key={i}>{t("第 {number} 个单词", { number: i + 1 })}<input name={`word${i}`} autoComplete="off" spellCheck={false} required /></label>)}</div>}{!quiz && <p className="notice seed-warning"><Icon name="warning" />{t("请离线手抄，切勿截图、拍照或复制——任何人拿到它都能转走你的资产。")}</p>}</> : <><label>{t("12 或 24 个英文助记词")}<textarea aria-label={t("助记词")} value={mnemonic} autoComplete="off" spellCheck={false} rows={4} onChange={(e) => setMnemonic(e.target.value)} required /></label>{ANDROID && <div className="phrase-tools"><small className={[12, 24].includes(wordCount(mnemonic)) ? "muted" : "phrase-count-off"}>{w.wordsEntered.replace("{count}", String(wordCount(mnemonic)))}</small><button type="button" onClick={() => void navigator.clipboard.readText().then((text) => { pasted.current = text; setMnemonic(text.trim()); }).catch(() => {})}><Icon name="copy" />{w.paste}</button></div>}</>}{(panel === "restore" || quiz) && ANDROID && confirmNote}{(panel === "restore" || quiz) && !ANDROID && <>{passwordField(view?.exists ? t("当前解锁密码") : t("设置解锁密码"), view?.exists ? undefined : t("请保存助记词。忘记密码后，需要助记词恢复钱包。"))}{!view?.exists && <label>{t("再次输入密码")}<input aria-label={t("再次输入密码")} type="password" autoComplete="new-password" minLength={10} value={repeat} onChange={(e) => setRepeat(e.target.value)} required /><small>{t("至少 10 个字符，用于加密本机钱包。")}</small></label>}</>}<button className="primary wide" disabled={busy || panel === "create" && !mnemonic || ANDROID && panel === "restore" && ![12, 24].includes(wordCount(mnemonic)) || ANDROID && panel === "create" && quiz && !!quizPick && quizPick.positions.some((i) => !quizPick.chosen[i])}>{busy ? t("正在保存…") : panel === "create" && !quiz ? t("我已保存，核对备份") : t("保存钱包")}</button></>)}
      {panel === "wallets" && <div className="wallet-list">{view?.wallets?.map((item) => <div className={ANDROID ? "wallet-row" : undefined} key={item.id}><button className={item.id === view.selected ? "wallet-choice selected" : "wallet-choice"} data-wallet-id={item.id} aria-pressed={item.id === view.selected} disabled={busy} onClick={() => { close(); if (item.id !== view.selected) void act("select", { id: item.id }); }}><Icon name={item.watch ? "eye" : "wallet"} /><span><strong>{item.name}</strong><small>{item.watch && `${t("只读")} · `}{item.address.slice(0, 12)}…{item.address.slice(-6)}</small></span>{item.id === view.selected && <Icon name="check" />}</button>
        {/* iOS 管理钱包: rename or delete any wallet without switching to it first (delete keeps the confirmation flow). */}
        {ANDROID && <details className="wallet-row-menu"><summary aria-label={w.rename}><Icon name="more" /></summary><button disabled={busy} onClick={() => { const name = prompt(w.rename, item.name)?.trim(); if (name) void act("rename", { id: item.id, name }); }}>{w.rename}</button><button className="danger-button" disabled={busy} onClick={() => { if (item.watch) { clearSecrets(); setWatchTarget(item); setPanel("watchRemove"); return; } close(); const open = () => { setName(item.name); setPanel("settings"); }; if (item.id === view.selected) open(); else void act("select", { id: item.id }, open); }}>{w.delete}</button></details>}
      </div>)}</div>}
      {panel === "receive" && wallet && <div className="receive"><QR value={wallet.address} alt={t("收款地址二维码")} /><code>{wallet.address}</code><p>{t("仅接收 {network} PRL。", { network: view?.network === "mainnet" ? t("主网") : t("测试网") })}</p><button className="primary wide" onClick={() => void copy(wallet.address)}>{t("复制收款地址")}</button>{!wallet.watch && <><div className="receive-rotate"><button className="wide" disabled={busy} onClick={() => void act("receive")}>{t("换一个收款地址")}</button><InfoTip label={t("说明")} text={t("轮换地址仍属于同一个钱包，余额会合并统计。")} /></div>{ANDROID && !!wallet.index && <button className="wide" disabled={busy} onClick={() => void act("receive-main")}><Icon name="wallet" />{w.mainAddress}</button>}</>}</div>}
      {panel === "contact" && form(() => { void act("contact-save", contactDraft, finishContact); }, <><label>{t("名称")}<input aria-label={t("名称")} value={contactDraft.name} onChange={(e) => setContactDraft({ ...contactDraft, name: e.target.value })} /></label><label>{t("地址")}<input aria-label={t("地址")} value={contactDraft.address} autoComplete="off" spellCheck={false} onChange={(e) => setContactDraft({ ...contactDraft, address: e.target.value })} required placeholder={view?.network === "mainnet" ? "prl1…" : "tprl1…"} /></label><label>{t("备注（可选）")}<textarea aria-label={t("备注（可选）")} value={contactDraft.note} onChange={(e) => setContactDraft({ ...contactDraft, note: e.target.value })} /></label><button className="primary wide" disabled={busy}>{t("保存")}</button><button type="button" className="wide" disabled={busy} onClick={finishContact}>{t("取消")}</button>{contactDraft.id && <button type="button" className="danger-button wide" disabled={busy} onClick={() => void act("contact-remove", { id: contactDraft.id }, finishContact)}>{t("删除联系人")}</button>}</>)}
      {panel === "send" && !review && form(() => { void act<Review>("prepare", { to, amount: value, fee, max: maximum, recovery }, setReview); }, <>{!recovery && contacts.length > 0 && <label>{t("地址簿")}<select aria-label={t("地址簿")} value="" onChange={(e) => { if (e.target.value) setTo(e.target.value); }}><option value="">{t("选择联系人")}</option>{contacts.map((c) => <option key={c.id} value={c.address}>{c.name} · {c.address.slice(0, 10)}…{c.address.slice(-6)}</option>)}</select></label>}<label>{t("收款地址")}<input aria-label={t("收款地址")} readOnly={recovery} value={to} autoComplete="off" spellCheck={false} onChange={(e) => setTo(e.target.value)} required placeholder={view?.network === "mainnet" ? "prl1…" : "tprl1…"} /></label>{sendIssue.address && <small className="field-error">{sendIssue.address}</small>}{payee(to) && <p className="payee">{payee(to)}</p>}{!recovery && !payee(to) && isAddress(to.trim().toLowerCase(), view?.network || "mainnet") && <button type="button" className="save-contact" disabled={busy} onClick={() => editContact(undefined, true)}>{t("保存到地址簿")}</button>}<label><span className="label-row">{t("转账金额（PRL）")}<InfoTip label={t("说明")} text={t("预览会重新获取可用输入。仅使用已确认、未被待确认交易占用的资金。")} /></span><div className="input-action"><input aria-label={t("转账金额")} inputMode="decimal" value={maximum ? "" : value} disabled={maximum} placeholder={maximum ? t("使用全部可用已确认输入") : "0.00"} onChange={(e) => setValue(e.target.value)} required={!maximum} /><button type="button" disabled={recovery} onClick={() => setMaximum(!maximum)}>{maximum ? t("取消全部") : t("全部")}</button></div></label>{ANDROID && view?.snapshot && <small className="field-note">{fill(w.available, amount(view.snapshot.balance))}</small>}{sendIssue.amount && <small className="field-error">{sendIssue.amount}</small>}<label>{t("手续费率（原子单位／kB）")}<input aria-label={t("手续费率")} type="number" min={1000} max={10000000} step={1} value={fee} onChange={(e) => { feeEdited.current = true; setFeeSource("manual"); setFee(Number(e.target.value)); }} required /><small>{feeSource === "manual" ? t("已使用手动填写的手续费率。") : feeSource === "estimated" ? t("已读取链上建议值，可手动调整。") : t("当前为默认值，请核对手续费。")}</small></label><button className="primary wide" disabled={busy || !!sendIssue.address || !!sendIssue.amount}>{busy ? t("正在生成预览…") : t("预览转账")}</button></>)}
      {ANDROID && panel === "recover" && (() => {
        const snap = view?.snapshot, change = new Set(snap?.changeAddresses || []);
        const byAddress = new Map<string, bigint>();
        for (const u of snap?.utxos || []) if ((u.confirmations || 0) > 0 && u.address && change.has(u.address)) byAddress.set(u.address, (byAddress.get(u.address) || 0n) + BigInt(u.value));
        const total = [...byAddress.values()].reduce((n, v) => n + v, 0n);
        const custom = recoverDest === "custom", bad = custom && recoverAddress.trim() !== "" && !isAddress(recoverAddress.trim().toLowerCase(), view?.network || "mainnet");
        return <div className="recover">
          {busy && !byAddress.size ? <p className="muted">{w.recoverScanning}</p> : !byAddress.size ? <p className="recover-none">{w.recoverNone}</p> : <>
            <div className="recover-list">{[...byAddress].map(([address, value]) => <div key={address}><code>{address.slice(0, 12)}…{address.slice(-8)}</code><b>{amount(value)} PRL</b></div>)}</div>
            <p className="recover-total">{fill(w.recoverable, amount(total))}<InfoTip label={w.recoverTitle} title={w.recoverTitle} text={w.recoverIntro} /></p>
            <fieldset className="recover-dest"><legend>{w.recoverTo}</legend>
              <label><input type="radio" checked={!custom} onChange={() => setRecoverDest("main")} />{w.myMain}</label>
              <label><input type="radio" checked={custom} onChange={() => setRecoverDest("custom")} />{w.address}</label>
              {custom && <input aria-label={w.address} value={recoverAddress} autoComplete="off" spellCheck={false} placeholder={view?.network === "mainnet" ? "prl1…" : "tprl1…"} onChange={(e) => setRecoverAddress(e.target.value)} />}
              {bad && <small className="field-error">{fill(w.badAddress, view?.network === "mainnet" ? "prl1" : "tprl1")}</small>}
            </fieldset>
            <button className="primary wide" disabled={busy || bad || custom && !recoverAddress.trim()} onClick={sweepChange}>{fill(w.recoverBtn, amount(total))}</button>
          </>}
          <button className="wide" disabled={busy} onClick={() => void act("refresh", { scan: true })}><Icon name="refresh" />{w.rescan}</button>
        </div>;
      })()}
      {panel === "donate" && !review && <><p className="donation-intro">{t("喜欢 Pearl Hub？请开发者喝杯咖啡")}<InfoTip label={t("支持开发者")} title={t("支持开发者")} text={t("Pearl Hub 是开源项目，全部代码公开在 GitHub，没有广告和追踪。基础功能一直免费，捐赠和高级版的收入用来支付服务器和节点费用、维持更新。")} /></p><div className="donation-presets">{DONATION_PRESETS.map((preset) => <button key={preset} disabled={busy || ANDROID && !!view?.snapshot && parseAmount(preset) + FEE_RESERVE > BigInt(view.snapshot.balance)} onClick={() => prepareDonation(preset)}>{preset} PRL</button>)}</div>{ANDROID && view?.snapshot && <small className="field-note">{fill(w.available, amount(view.snapshot.balance))}</small>}{form(() => prepareDonation(value), <><label>{t("自定义金额")}<input aria-label={t("自定义金额")} inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} required placeholder="1 PRL" /></label><small>{t("自定义金额最少 1 PRL。")}</small><button className="primary wide" disabled={busy}>{busy ? t("正在生成预览…") : t("捐赠")}</button></>)}<label><span className="label-row">{t("开发者")}<InfoTip label={t("说明")} text={t("捐赠会从当前钱包直接转到开发者地址，在本机签名并广播，手续费从余额扣除。")} /></span><code className="donation-address">{addressHalves(DONATION_ADDRESS).map((half, i) => <span key={i}>{half}</span>)}</code></label>{ANDROID && <a className="donation-source" href="https://github.com/terryops/prl-hub-web" target="_blank" rel="noreferrer">{w.viewSource}</a>}</>}
      {(panel === "send" || panel === "donate") && review && form(() => { const sent = (password: string) => void act<View & { outcome: string; sent: string }>("send", { id: review.id, password }, (r) => { close(); setMessage(ANDROID && review.donation && r.outcome === "submitted" ? w.thanks : r.outcome === "submitted" ? "已广播，等待链上确认。" : r.outcome === "rejected" ? "节点拒绝了此交易" : "广播结果待核对，请查看待确认转账。不要重复创建付款。"); }); if (ANDROID) withSecret(t(review.donation ? "确认捐赠" : "确认并发送"), sent); else sent(password); }, <><SendReceipt review={review} lang={lang} payee={review.donation ? undefined : payee(review.to)} copy={(text) => void copy(text)} />{ANDROID ? confirmNote : passwordField(t("再次输入密码确认"))}<div className="receipt-actions"><button className="primary wide" disabled={busy}>{busy ? t("正在签名与广播…") : review.donation ? t("确认捐赠") : <>{t("确认发送 {amount} PRL", { amount: receiptAmount(review.amount, lang) })}<Icon name="send" /></>}</button></div><button type="button" className="wide" disabled={busy} onClick={() => { setReview(null); setPassword(""); }}>{t("返回修改")}</button></>)}
      {panel === "backup" && (mnemonic ? <><p className="notice">{t("按顺序离线保存。关闭窗口后不再显示。")}</p><div className="words">{mnemonic.split(" ").map((word, i) => <div key={i}><small>{i + 1}</small>{word}</div>)}</div><button className="wide" onClick={close}>{t("已保存，关闭")}</button></> : form(() => { const reveal = (password: string) => void act<{ mnemonic: string }>("backup", { password }, (r) => { setPassword(""); setMnemonic(r.mnemonic); }); if (ANDROID) withSecret(t("查看助记词"), reveal); else reveal(password); }, <>{!ANDROID && passwordField()}<button className="primary wide" disabled={busy}>{t("查看助记词")}</button></>))}
      {panel === "discard" && form((f) => { const acknowledge = f.get("acknowledge") === "on", discard = (password: string) => void act("discard", { txid: retry, password, acknowledge }, close); if (ANDROID) withSecret(t("移除待确认记录"), discard); else discard(password); }, <><p className="notice">{t("移除记录不会撤销链上交易。请先核对交易和收款方；再次付款可能造成重复付款。")}</p><code>{retry}</code>{ANDROID ? confirmNote : passwordField()}<label className="checkbox-row"><input type="checkbox" name="acknowledge" required /><span>{t("我已核对并了解重复付款风险")}</span></label><button className="primary wide" disabled={busy}>{t("移除待确认记录")}</button></>)}
      {panel === "retry" && form(() => { const resend = (password: string) => void act("retry", { txid: retry, password }, () => { close(); setMessage("已重试原交易，请核对链上状态。"); }); if (ANDROID) withSecret(t("重试原交易"), resend); else resend(password); }, <><p>{t("只重发此前签好的同一笔交易，金额和收款地址不会改变。")}</p><code>{retry}</code>{ANDROID ? confirmNote : passwordField()}<button className="primary wide" disabled={busy}>{t("重试原交易")}</button></>)}
      {panel === "tx" && detailTxid && txView(detailTxid)}
      {panel === "lookup" && <>{form(() => {
        const txid = parseTxid(lookupInput);
        if (!txid) { setLookupInvalid(true); setLookupTxid(""); return; }
        setLookupInvalid(false); setLookupInput(txid); setLookupTxid(txid);
      }, <><label>{t("交易 ID（txid）或区块浏览器链接")}<input aria-label={t("交易 ID（txid）或区块浏览器链接")} className="txid-input" data-autofocus value={lookupInput} autoComplete="off" spellCheck={false} onChange={(e) => { setLookupInput(e.target.value); setLookupInvalid(false); }} required /></label>{lookupInvalid && <p className="notice">{t("请输入交易 ID：64 位，由 0–9 和 a–f 组成。")}</p>}<div className="actions">{ANDROID && <button type="button" onClick={() => void nativeCall<{ text: string }>("clipboard.read").then((r) => { setLookupInput(r.text.trim()); setLookupInvalid(false); }).catch(() => {})}>{w.paste}</button>}<button className="primary wide" disabled={!lookupInput.trim()}>{t("查询")}</button></div></>)}{lookupTxid && txView(lookupTxid)}</>}
      {panel === "security" && <><button className="security-back" onClick={() => { dialog.current?.scrollTo({ top: 0 }); setPanel("settings"); }}><Icon name="chevron" />{securityCopy(lang).back}</button><SecurityOverview lang={lang} sections={extensionSecurity} /></>}
      {panel === "watch" && form(addWatch, <>
        <label>{t("钱包名称")}<input value={name} maxLength={40} onChange={(e) => setName(e.target.value)} /></label>
        <label><span className="label-row">{t("地址")}<InfoTip label={t("只读钱包")} title={t("只读钱包")} text={t("只填一个地址，就能查看它的余额和交易记录。不需要助记词，也不能转账。")} /></span><textarea aria-label={t("地址")} className="watch-address" data-autofocus rows={2} value={watchAddress} autoComplete="off" spellCheck={false} placeholder={view?.network === "testnet" ? "tprl1…" : "prl1…"} onChange={(e) => setWatchAddress(e.target.value)} required /></label>
        {ANDROID && <div className="phrase-tools"><span /><button type="button" onClick={() => void nativeCall<{ text: string }>("clipboard.read").then((r) => setWatchAddress(r.text.trim())).catch(() => {})}><Icon name="copy" />{t("粘贴")}</button></div>}
        {watchAddress.trim() && !isAddress(watchAddress.trim().toLowerCase(), view?.network || "mainnet") && <small className="field-error">{watchProblem("watch-address").text}</small>}
        {!view?.exists && !ANDROID && <>{passwordField(t("设置解锁密码"))}<label>{t("再次输入密码")}<input aria-label={t("再次输入密码")} type="password" autoComplete="new-password" minLength={10} value={repeat} onChange={(e) => setRepeat(e.target.value)} required /><small>{t("至少 10 个字符，用于加密本机钱包。")}</small></label></>}
        <button className="primary wide" disabled={busy || !isAddress(watchAddress.trim().toLowerCase(), view?.network || "mainnet")}><Icon name="eye" />{t("添加只读钱包")}</button>
      </>)}
      {panel === "watchSend" && <div className="alert-panel"><p>{t("只读钱包只保存地址，没有私钥。要从这个地址转账，请用它所属钱包的助记词恢复。")}</p><button className="primary wide" onClick={() => start("restore")}>{t("用助记词恢复钱包")}</button><button className="wide" onClick={close}>{t("知道了")}</button></div>}
      {panel === "watchRemove" && watchTarget && <div className="alert-panel"><p><strong>{watchTarget.name}</strong></p><p>{t("只从本机删除这个地址，不影响链上资产，之后可以再添加。")}</p><button className="danger-button wide" disabled={busy} onClick={() => removeWatch(watchTarget)}>{t("移除只读钱包")}</button><button className="wide" disabled={busy} onClick={close}>{t("取消")}</button></div>}
      {panel === "nockClose" && <div className="alert-panel"><p>{t(ANDROID ? "钱包页不再显示 NOCK 钱包，之后可以在「设置 → 钱包与安全」重新打开。" : "钱包页不再显示 NOCK 钱包，之后可以在「钱包设置」重新打开。")}</p><button className="primary wide" onClick={() => { setNockLink(false); close(); }}>{t("关闭")}</button><button className="wide" onClick={close}>{t("取消")}</button></div>}
      {panel === "settings" && <>
        <section className="setting preferences-setting">
          {!ANDROID && <div className="preferences-grid">
            <div className="preference"><label htmlFor="language">{t("语言")}</label><select id="language" value={lang} disabled={!languageReady} onChange={(e) => void changeLanguage(e.target.value)}>{languages.map((l) => <option key={l} value={l}>{languageNames[l]}</option>)}</select></div>
            <div className="preference"><label htmlFor="secondary">{f("secondary")}</label><select id="secondary" value={secondary} onChange={(e) => void changeSecondary(e.target.value)}><option value="__auto__">{f("auto")}</option><option value="">{f("none")}</option>{currencies.map((c) => <option key={c.code} value={c.code}>{c.code}</option>)}</select></div>
          </div>}
          {view?.exists && !view.locked && <label>{t("钱包网络")}<select aria-label={t("钱包网络")} value={view.network} disabled={busy} onChange={(e) => { close(); void act("network", { network: e.target.value }); }}><option value="mainnet">{t("主网")}</option><option value="testnet">{t("测试网")}</option></select></label>}
        </section>
        {!ANDROID && <section className="setting account-setting"><h3 className="title-tip">{accountCopy(lang).account}<InfoTip label={accountCopy(lang).account} title={accountCopy(lang).account} text={`${accountCopy(lang).intro}\n\n${accountCopy(lang).privacy}`} /></h3>{contactLink.connected ? <><p className="account-email">{contactLink.email}</p>{!contactLink.pro && <p className="muted">{accountCopy(lang).syncRequiresPro}</p>}<div className="account-actions"><button disabled={busy || view?.locked || !contactLink.pro} onClick={() => void act<typeof contactLink>("contact-sync", {}, setContactLink)}>{t("立即同步")}</button><button disabled={busy} onClick={() => void act<typeof contactLink>("account-logout", {}, setContactLink)}>{accountCopy(lang).logout}</button></div><div className="account-links"><a href="https://pearlhub.net/?account=manage#market" target="_blank" rel="noreferrer">{accountCopy(lang).devices}</a><a href="https://pearlhub.net/?account=manage#market" target="_blank" rel="noreferrer">{accountCopy(lang).rights}</a></div>{contactLink.lastSync && <small className="account-sync-time">{new Date(contactLink.lastSync).toLocaleString(lang)}</small>}</> : <button disabled={busy} onClick={() => void act<typeof contactLink>("account-login", { importLocal: confirm(accountCopy(lang).import) }, setContactLink)}>{accountCopy(lang).login}</button>}</section>}{view?.exists && !view.locked && wallet && <><section className="setting">{form(() => { void act("rename", { name }, () => setMessage("钱包名称已更新。")); }, <><label>{t("钱包名称")}<input value={name} maxLength={40} onChange={(e) => setName(e.target.value)} required /></label><button disabled={busy}>{t("保存名称")}</button></>)}{!ANDROID && nockSwitch && <label className="switch-row"><span>{t("在钱包页显示 NOCK 钱包")}</span><input type="checkbox" role="switch" checked={!nockLinkHidden} onChange={(e) => setNockLink(e.target.checked)} /></label>}</section>{!ANDROID && <section className="setting"><h3>{t("更换解锁密码")}</h3>{form(() => { if (nextPassword !== repeat) { setMessage("两次新密码不一致。"); return; } void act("password", { password, nextPassword }, () => { clearSecrets(); setMessage("密码已更新。此密码保护插件中的所有钱包。"); }); }, <>{passwordField(t("当前解锁密码"))}<label>{t("新密码")}<input type="password" minLength={10} autoComplete="new-password" value={nextPassword} onChange={(e) => setNextPassword(e.target.value)} required /></label><label>{t("再次输入新密码")}<input type="password" value={repeat} onChange={(e) => setRepeat(e.target.value)} required /></label><button disabled={busy}>{t("更新密码")}</button></>)}</section>}</>}{!ANDROID && <section className="setting security-setting"><h3>{securityCopy(lang).group}</h3><button className="security-entry" onClick={() => { clearSecrets(); dialog.current?.scrollTo({ top: 0 }); setPanel("security"); }}><Icon name="shield" /><span>{securityCopy(lang).title}</span><Icon name="chevron" className="security-entry-chevron" /></button></section>}{!ANDROID && <SecurityNotice lang={lang} />}{view?.exists && !view.locked && wallet && readOnly && <section className="setting"><button className="danger-button wide" disabled={busy} onClick={() => { clearSecrets(); setWatchTarget(wallet); setPanel("watchRemove"); }}>{t("移除只读钱包")}</button></section>}{view?.exists && !view.locked && wallet && !readOnly && <details className="setting danger"><summary>{ANDROID ? w.removeTitle : t("从这台浏览器移除当前钱包")}</summary><p>{t("移除只删除本机记录。请先备份助记词，链上资金不会自动转出。")}</p>{form((f) => { const name = String(f.get("name") || ""), remove = (password: string) => void act<View>("delete", { password, name }, (r) => { close(); if (ANDROID && !r.exists) void forgetDeviceSecret(); }); if (ANDROID) withSecret(t("移除钱包"), remove); else remove(String(f.get("password") || "")); }, <><label>{t("输入钱包名称“{name}”", { name: wallet?.name ?? "" })}<input name="name" autoComplete="off" required /></label>{ANDROID ? confirmNote : <label>{t("解锁密码")}<input name="password" type="password" autoComplete="current-password" required /></label>}<button className="danger-button" disabled={busy}>{t("移除钱包")}</button></>)}</details>}</>}
    </div></dialog>
  </div>;
}
createRoot(document.getElementById("root")!).render(<App />);
