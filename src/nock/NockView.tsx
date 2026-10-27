// The NOCK (Nockchain) side of a wallet: same seed as PRL, its own address, balance, history and sends,
// as in the native app (prl-hub Sources/Wallet/NockWallet.swift). Reached from the wallet page: a
// one-line link at the bottom, or a small strip under the wallet's tools once the wallet uses NOCK.
// Everything chain-related runs in the background (nock/service.ts); this file only shows it.
import { useEffect, useRef, useState, type ReactNode } from "react";
import qrcode from "qrcode-generator";
import { Icon } from "../Icons.tsx";
import { dictionaries, messageText, translate, type Lang, type TextKey } from "../i18n/index.ts";
import { dualFiat } from "../market.ts";
import { addressGroups } from "../receipt.ts";
import { formatNock, nockNumber, parseNock, TYPED_DECIMALS } from "./units.ts";
import { loadNockPrice } from "./price.ts";
import { CLI_NODE_PERMISSION } from "./nodes.ts";
import type { NockView, PreparedView } from "./service.ts";
import type { NockText } from "./errors.ts";

type Rpc = <T>(command: string, data?: Record<string, unknown>) => Promise<T>;
type Common = { lang: Lang; rpc: Rpc; walletId: string; secondary: string; rates?: Record<string, number> };
type Row = NockView["history"][number];
const STALE_MS = 30000;
const explorer = (txId: string) => `https://nockscan.com/tx/${encodeURIComponent(txId)}`;

function useText(lang: Lang) {
  const t = (key: TextKey, values?: Record<string, string | number>) => translate(lang, key, values);
  /// A message from the background, in this language (its values can be messages too).
  const text = (m: NockText): string => {
    const values = Object.fromEntries(Object.entries(m.values || {}).map(([k, v]) => [k, typeof v === "object" ? text(v) : v]));
    return Object.hasOwn(dictionaries.en, m.key) ? t(m.key as TextKey, values) : messageText(lang, m.key);
  };
  const nock = (nicks: string | bigint, decimals = 6) => `${formatNock(nicks, lang, decimals)} NOCK`;
  return { t, text, nock };
}
const usdText = (usd: number, lang: Lang) => "$" + new Intl.NumberFormat(lang, { minimumFractionDigits: usd < 1 ? 4 : 2, maximumFractionDigits: usd < 1 ? 4 : 2 }).format(usd);

/// The NOCK mark: a hexagon on a warm badge. `muted` where it sits beside PRL and mustn't outshine it.
export const NockBadge = ({ muted = false, size = "" }: { muted?: boolean; size?: "" | "small" | "large" }) =>
  <span className={`nock-badge${muted ? " muted" : ""}${size ? ` ${size}` : ""}`} aria-hidden="true"><Icon name="hexagon" /></span>;

/// Where NOCK shows on the wallet page. A wallet that uses NOCK gets the strip (`slot` "strip"), with its
/// balance, kept fresh only while it is on screen; any other only the quiet link at the very bottom
/// (`slot` "link"), which reads nothing from the network.
export function NockEntry({ lang, rpc, walletId, secondary, rates, slot, onOpen }: Common & { slot: "strip" | "link"; onOpen: () => void }) {
  const { t, nock } = useText(lang);
  const [status, setStatus] = useState<NockView | null>(null), [usd, setUsd] = useState<number>();
  useEffect(() => {
    let live = true, timer: ReturnType<typeof setTimeout> | undefined;
    setStatus(null); setUsd(undefined);
    const read = (command: string, data: Record<string, unknown> = {}) => rpc<NockView>(command, data).then((v) => { if (live) setStatus(v); return v; });
    void read("nock-status").then((v) => {
      if (!live || slot !== "strip" || !v.inUse) return;
      const poll = (wait: number) => { timer = setTimeout(() => {
        if (!live) return;
        if (document.visibilityState !== "visible") { poll(wait); return; }
        void loadNockPrice().then((p) => { if (live) setUsd(p); });
        void read("nock-refresh", { stale: STALE_MS }).then((next) => poll(next.pollMs), () => poll(60000));
      }, wait); };
      poll(0);
    }, () => {});
    return () => { live = false; clearTimeout(timer); };
  }, [walletId, slot]);
  if (!status) return null;
  if (slot === "link") return status.inUse ? null : <button className="nock-link" onClick={onOpen}><NockBadge size="small" /><span className="nock-link-name">{t("NOCK 钱包")}</span><Icon name="chevron" className="nock-chevron" /></button>;
  if (!status.inUse) return null;
  const total = status.balance.total;
  return <button className="nock-strip" aria-label={status.hasBalance ? t("NOCK 余额 {amount}", { amount: nock(total) }) : t("NOCK 钱包")} onClick={onOpen}>
    <NockBadge muted /><span className="nock-strip-name">NOCK</span>
    <span className="nock-strip-value">{status.hasBalance ? <><b data-cached={status.balanceIsCached}>{formatNock(total, lang, 2)}</b>{usd !== undefined && <small>≈ {dualFiat(nockNumber(total) * usd, "", lang)}</small>}</> : status.syncError ? <Icon name="warning" /> : <span className="nock-spinner" />}</span>
    <Icon name="chevron" className="nock-chevron" />
  </button>;
}

/// rpc.nockbox.org didn't answer: the extension may use the second node once the person allows it (an
/// optional permission; Chrome shows its own confirmation, which needs this click).
function SecondNodeOffer({ t, onAllowed }: { t: (key: TextKey) => string; onAllowed: () => void }) {
  const [asking, setAsking] = useState(false);
  return <div className="nock-info nock-offer"><Icon name="server" /><div>
    <p>{t("rpc.nockbox.org 现在连不上。可以允许插件在它连不上时改用 Nockchain 官方钱包默认使用的节点（216.158.95.10）；这个节点走明文 HTTP，网络路径上的其他人能看到这些请求。浏览器会请你确认。")}</p>
    <button type="button" disabled={asking} onClick={() => {
      setAsking(true);
      chrome.permissions.request(CLI_NODE_PERMISSION).then((granted) => { if (granted) onAllowed(); }, () => {}).finally(() => setAsking(false));
    }}>{t("允许使用备用节点")}</button>
  </div></div>;
}

function QR({ value, alt }: { value: string; alt: string }) {
  const code = qrcode(0, "M"); code.addData(value); code.make();
  return <img className="qr" src={code.createDataURL(5, 10)} alt={alt} />;
}

type Panel = "receive" | "send" | "history" | "tx" | null;
type Props = Common & {
  copy: (text: string) => void;
  onBack: () => void;
  /// Android: the vault secret comes from the lock screen instead of a typed password.
  android: boolean;
  secret: (title: string, run: (secret: string) => void) => void;
  confirmNote: ReactNode;
  /// Set to what the Android back button does on this page: true when it closed something.
  backHandler: { current: (() => boolean) | null };
};

/// The NOCK page: balance, receive, send and the merged nockscan/local history.
export function NockPage({ lang, rpc, walletId, secondary, rates, copy, onBack, android, secret, confirmNote, backHandler }: Props) {
  const { t, text, nock } = useText(lang);
  const [status, setStatus] = useState<NockView | null>(null), [usd, setUsd] = useState<number>();
  const [refreshing, setRefreshing] = useState(false), [toast, setToast] = useState(""), [panel, setPanel] = useState<Panel>(null), [txId, setTxId] = useState("");
  // Send form.
  const [address, setAddress] = useState(""), [amount, setAmount] = useState(""), [maxText, setMaxText] = useState<string | null>(null);
  const [check, setCheck] = useState<{ address: string; problem: string | null; own: boolean } | null>(null);
  const [preparing, setPreparing] = useState(false), [sending, setSending] = useState(false), [quoting, setQuoting] = useState(false);
  const [result, setResult] = useState<{ text: string; warning: boolean } | null>(null), [prepared, setPrepared] = useState<PreparedView | null>(null), [password, setPassword] = useState("");
  const dialog = useRef<HTMLDialogElement>(null), live = useRef(true);

  const read = (command: string, data: Record<string, unknown> = {}) => rpc<NockView>(command, data).then((v) => { if (live.current) setStatus(v); return v; });
  async function refresh() {
    setRefreshing(true);
    try { await read("nock-refresh", { history: true }); void loadNockPrice().then((p) => { if (live.current) setUsd(p); }); }
    catch { /* The status shows the problem; the next poll tries again. */ }
    finally { if (live.current) setRefreshing(false); }
  }
  useEffect(() => {
    live.current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = (wait: number) => { timer = setTimeout(() => {
      if (!live.current) return;
      if (document.visibilityState !== "visible") { poll(wait); return; }
      void loadNockPrice().then((p) => { if (live.current) setUsd(p); });
      void read("nock-refresh", { stale: STALE_MS, history: true }).then((v) => poll(v.pollMs), () => poll(60000));
    }, wait); };
    void read("nock-status").catch(() => {}).finally(() => poll(0));
    return () => { live.current = false; clearTimeout(timer); };
  }, [walletId]);
  useEffect(() => { if (panel) dialog.current?.showModal(); else dialog.current?.close(); }, [panel]);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(""), 2500); return () => clearTimeout(timer); }, [toast]);
  // Getting the address counts as starting to use NOCK: the wallet page then shows the strip.
  useEffect(() => { if (panel === "receive") void read("nock-shown").catch(() => {}); }, [panel]);
  // The recipient is checked by the core, a moment after typing stops.
  const recipient = address.trim();
  useEffect(() => {
    if (!recipient) { setCheck(null); return; }
    const timer = setTimeout(() => void rpc<{ problem: string | null; own: boolean }>("nock-check", { address: recipient }).then((r) => { if (live.current) setCheck({ address: recipient, ...r }); }, () => {}), 200);
    return () => clearTimeout(timer);
  }, [recipient]);
  const closePanel = () => { setPanel(null); setPrepared(null); setPassword(""); setResult(null); };
  backHandler.current = () => { if (panel) { closePanel(); return true; } return false; };
  const openSend = () => { setAddress(""); setAmount(""); setMaxText(null); setResult(null); setPrepared(null); setPassword(""); setPanel("send"); };

  if (!status) return <section className="nock-page"><BackRow t={t} onBack={onBack} /><p className="empty">{t("同步中…")}</p></section>;
  const { balance } = status;
  const available = BigInt(balance.available);
  const problemLine = status.syncError && (status.syncedAt
    ? t("{problem}，显示的是 {time} 的数据", { problem: text(status.syncError), time: new Date(status.syncedAt).toLocaleTimeString(lang, { hour: "2-digit", minute: "2-digit" }) })
    : t("{problem}，稍后自动重试", { problem: text(status.syncError) }));
  // Block rewards wait 100 blocks (~4 hours) before they can be spent.
  const lockHours = Math.round(100 * 150 / 3600);

  // Send form state.
  const nicks = parseNock(amount), isMax = maxText !== null && amount === maxText;
  const overBalance = !isMax && (nicks ?? 0n) > available;
  const checked = check?.address === recipient ? check : null;
  const canSend = !preparing && !sending && !!recipient && checked?.problem === null && (nicks ?? 0n) > 0n && !overBalance;
  const problemText = (code: string) => text(code === "legacy_address" ? { key: "这是旧版（v0）NOCK 地址，已不能收款，请向对方要新地址" } : { key: "收款地址格式不正确" });

  async function quoteMax() {
    setQuoting(true); setResult(null);
    try {
      const r = await rpc<{ amount?: string; error?: NockText }>("nock-max", { to: recipient });
      if (!live.current) return;
      if (r.amount) { setAmount(r.amount); setMaxText(r.amount); } else if (r.error) setResult({ text: text(r.error), warning: false });
    } catch (error) { if (live.current) setResult({ text: messageText(lang, error instanceof Error ? error.message : "操作失败。"), warning: false }); }
    finally { if (live.current) setQuoting(false); }
  }
  async function prepare() {
    if (!canSend) return;
    setPreparing(true); setResult(null);
    try {
      const r = await rpc<{ prepared?: PreparedView; error?: NockText }>("nock-prepare", { to: recipient, amount, max: isMax });
      if (!live.current) return;
      if (r.prepared) { setPrepared(r.prepared); setPassword(""); } else if (r.error) setResult({ text: text(r.error), warning: false });
    } catch (error) { if (live.current) setResult({ text: messageText(lang, error instanceof Error ? error.message : "操作失败。"), warning: false }); }
    finally { if (live.current) setPreparing(false); }
  }
  async function send(p: PreparedView, password: string) {
    if (sending) return;
    setSending(true); setResult(null);
    try {
      const r = await rpc<{ outcome?: "sent" | "failed" | "unverified"; error?: NockText }>("nock-send", { id: p.id, password });
      if (!live.current) return;
      setPrepared(null); setPassword("");
      if (r.outcome === "sent") { closePanel(); setToast(t("已发送 ✓")); }
      else if (r.error) setResult({ text: text(r.error), warning: r.outcome === "unverified" });
      void read("nock-status").catch(() => {});
    } catch (error) {
      // A wrong password or a locked wallet: nothing was sent; the receipt stays for another try.
      if (live.current) setResult({ text: messageText(lang, error instanceof Error ? error.message : "操作失败。"), warning: false });
    } finally { if (live.current) setSending(false); }
  }

  const row = (tx: Row) => {
    const incoming = tx.kind !== "sent";
    return <article className={`transaction nock-row${tx.status === "failed" ? " failed" : ""}`} key={tx.id} onClick={() => { setTxId(tx.id); setPanel("tx"); }}>
      <span className="tx-icon"><Icon name={tx.kind === "mined" ? "cube" : incoming ? "received" : "sent"} /></span>
      <div className="tx-main"><strong>{t(tx.kind === "received" ? "收到" : tx.kind === "mined" ? "挖矿收入" : "发出")}</strong><small className="tx-meta"><span>{new Date(tx.time).toLocaleString(lang, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span></small></div>
      <div className="tx-amount"><b>{incoming ? "+" : "−"}{formatNock(tx.amount, lang, 4)} <small>NOCK</small></b>{statusLine(tx)}</div>
      <button className="icon-button tx-open" aria-label={t("交易详情")} title={t("交易详情")} onClick={(e) => { e.stopPropagation(); setTxId(tx.id); setPanel("tx"); }}><Icon name="chevron" /></button>
    </article>;
  };
  const statusLine = (tx: Row) => tx.status === "pending" ? <small className="nock-pending">{t("待确认")}</small> : tx.status === "failed" ? <small>{t("未上链")}</small> : tx.confirmations !== undefined && tx.confirmations < 10 ? <small>{t("{count} 确认", { count: tx.confirmations })}</small> : null;
  const detail = panel === "tx" ? status.history.find((x) => x.id === txId) : undefined;

  return <section className="nock-page">
    <BackRow t={t} onBack={onBack} />
    {toast && <div role="status" className="message nock-toast"><span>{toast}</span></div>}
    <h1 className="nock-title">{t("NOCK 钱包")}</h1>
    <section className="nock-summary">
      <div className="balance-topline">
        <div className="balance-heading"><NockBadge size="small" muted /><span>NOCK</span><button title={t("刷新 ↻")} aria-label={t("刷新 ↻")} disabled={refreshing} onClick={() => void refresh()}><Icon name="refresh" /></button></div>
        <span className="nock-price">{usd !== undefined ? usdText(usd, lang) : "—"}</span>
      </div>
      <div className="balance" data-cached={status.balanceIsCached}>
        <span className="sr-only">{status.hasBalance ? t("NOCK 余额 {amount}", { amount: nock(balance.total) }) : t("同步余额…")}</span>
        <span className="balance-number" aria-hidden="true">{status.hasBalance ? formatNock(balance.total, lang, 4) : "——"}</span><small aria-hidden="true">NOCK</small>
      </div>
      <div className="fiat-slot">{status.hasBalance ? usd !== undefined ? <span className="fiat">≈ {dualFiat(nockNumber(balance.total) * usd, secondary, lang, rates)}</span> : <span aria-hidden="true">—</span> : t("同步余额…")}</div>
      {BigInt(balance.locked) > 0n && <dl className="nock-locked">
        <div><dt>{t("可用")}</dt><dd>{nock(balance.available, 2)}</dd></div>
        <div><dt>{t("锁定 · 挖矿收入约 {count} 小时后可用", { count: lockHours })}</dt><dd>{nock(balance.locked, 2)}</dd></div>
      </dl>}
    </section>
    {problemLine && <p className="notice nock-problem" role="status"><Icon name="warning" /><span>{problemLine}</span></p>}
    {status.offerSecondNode && <SecondNodeOffer t={t} onAllowed={() => void refresh()} />}
    <div className="nock-actions">
      <button aria-label={t("收 NOCK")} onClick={() => { setResult(null); setPanel("receive"); }}><span className="action-icon"><Icon name="qr" /></span><span>{t("收款")}</span></button>
      <button aria-label={t("转 NOCK")} onClick={openSend}><span className="action-icon"><Icon name="send" /></span><span>{t("转账")}</span></button>
      <button aria-label={t("NOCK 记录")} onClick={() => setPanel("history")}><Icon name="history" /><span>{t("记录")}</span></button>
    </div>
    {/* iOS NockWalletView.recent: a small card with the last three, 全部 once there are any. */}
    <section className="nock-recent">
      <div className="nock-recent-head"><span>{t("最近交易")}</span>{status.history.length > 0 && <button className="text-button" onClick={() => setPanel("history")}>{t("全部交易")}</button>}</div>
      {!status.history.length ? <p className="nock-recent-empty">{status.backendReady ? t("暂无交易记录") : problemLine || t("同步中…")}</p> : status.history.slice(0, 3).map(row)}
    </section>
    <footer className="nock-seed-note"><span><Icon name="key" />{t("和 PRL 共用助记词")}</span><small>{t("用的是同一套助记词：在 Nockchain 官方钱包或 Iris 钱包导入它，会看到同一个 NOCK 地址。")}</small></footer>

    <dialog ref={dialog} className="nock-dialog" onCancel={(e) => { e.preventDefault(); if (!sending) closePanel(); }} onClick={(e) => { if (e.target === dialog.current && !sending && !preparing) closePanel(); }}><div className="dialog-inner">
      <div className="dialog-title"><h2>{panel === "history" ? t("NOCK 记录") : panel === "receive" ? t("收 NOCK") : panel === "send" ? prepared ? t("确认转账") : t("转 NOCK") : t("交易详情")}</h2><button className="icon-button" aria-label={t("关闭")} disabled={sending} onClick={closePanel}><Icon name="close" /></button></div>
      {panel === "history" && <section className="nock-history">{status.history.length ? status.history.map(row) : <p className="empty">{t("暂无交易记录")}</p>}<small className="nock-footnote">{t("记录从区块浏览器 nockscan.com 读取，换设备或重装后也能看到。")}</small></section>}

      {panel === "receive" && <div className="receive">
        {status.address ? <><QR value={status.address} alt={t("NOCK 收款地址 · Nockchain 主网")} /><p className="nock-receive-label">{t("NOCK 收款地址 · Nockchain 主网")}</p><code>{status.address}</code>
          <button className="primary wide" onClick={() => copy(status.address!)}><Icon name="copy" />{t("复制地址")}</button>
          <p>{t("这个地址只收 NOCK，别往这里转 PRL。")}</p></> : <p>{t("派生地址…")}</p>}
      </div>}

      {panel === "send" && !prepared && <form onSubmit={(e) => { e.preventDefault(); void prepare(); }}>
        <p className="nock-available">{status.hasBalance ? t("可用余额 {amount}", { amount: nock(balance.available) }) : t("同步余额…")}</p>
        <label>{t("收款地址")}<textarea className="nock-address-input" rows={2} aria-label={t("收款地址")} placeholder={t("NOCK 地址")} value={address} autoComplete="off" spellCheck={false} onChange={(e) => { setAddress(e.target.value); setResult(null); }} /></label>
        {checked?.problem ? <p className="field-note error">{problemText(checked.problem)}</p> : checked?.own ? <p className="field-note warn">{t("这是你自己的 NOCK 地址")}</p> : null}
        <label>{t("金额 (NOCK)")}<div className="input-action"><input aria-label={t("金额 (NOCK)")} inputMode="decimal" placeholder="0.0" value={amount} onChange={(e) => { setAmount(e.target.value); setResult(null); }} /><button type="button" disabled={quoting || preparing || sending || available === 0n} onClick={() => void quoteMax()}>{quoting ? <span className="nock-spinner" /> : "MAX"}</button></div></label>
        {overBalance ? <p className="field-note error">{t("超过可用余额（手续费另计）")}</p> : amount && nicks === null ? <p className="field-note error">{t("金额最多支持 {count} 位小数", { count: TYPED_DECIMALS })}</p> : null}
        {status.offerSecondNode && <SecondNodeOffer t={t} onAllowed={() => void refresh()} />}
        <button className="primary wide" disabled={!canSend}>{preparing ? t("正在构建交易…") : t("发送")}<Icon name="send" /></button>
        {result && <p className={result.warning ? "fee-warning" : "field-note error"} role="alert">{result.warning && <Icon name="warning" />}<span>{result.text}</span></p>}
        <p className="receipt-info"><Icon name="shield" /><span>{t("交易在本机签名（私钥不离开设备），经 Nockchain 公共节点广播。手续费按交易大小计算，确认前会显示。")}</span></p>
      </form>}

      {panel === "send" && prepared && <form onSubmit={(e) => { e.preventDefault(); if (android) secret(t("确认转账"), (s) => void send(prepared, s)); else void send(prepared, password); }}>
        <NockReceipt p={prepared} t={t} nock={nock} lang={lang} copy={copy} />
        {result && <p className={result.warning ? "fee-warning" : "field-note error"} role="alert">{result.warning && <Icon name="warning" />}<span>{result.text}</span></p>}
        {android ? confirmNote : <label>{t("再次输入密码确认")}<input aria-label={t("再次输入密码确认")} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>}
        <div className="receipt-actions"><button className="primary wide" disabled={sending}>{sending ? t("签名并广播…") : <>{t("确认发送 {amount}", { amount: nock(prepared.amount, 4) })}<Icon name="send" /></>}</button></div>
        <button type="button" className="wide" disabled={sending} onClick={() => { setPrepared(null); setPassword(""); setResult(null); }}>{t("返回修改")}</button>
      </form>}

      {panel === "tx" && (detail ? <TxView tx={detail} t={t} nock={nock} lang={lang} copy={copy} /> : <p className="empty">{t("找不到这笔记录")}</p>)}
    </div></dialog>
  </section>;
}

const BackRow = ({ t, onBack }: { t: (key: TextKey) => string; onBack: () => void }) =>
  <div className="nock-nav"><button className="nock-back" onClick={onBack}><Icon name="chevron" /><span>{t("PRL 钱包")}</span></button></div>;

/// The receipt before a send leaves, as the native app's NockSendConfirmSheet: the amount, the address in
/// groups to check, then amount + fee = total.
function NockReceipt({ p, t, nock, lang, copy }: { p: PreparedView; t: (key: TextKey, values?: Record<string, string | number>) => string; nock: (n: string | bigint, d?: number) => string; lang: Lang; copy: (text: string) => void }) {
  const groups = addressGroups(p.recipient);
  return <div className="receipt">
    <div className="receipt-hero"><NockBadge size="large" /><div className="review-amount"><span>{formatNock(p.amount, lang)}</span><small>NOCK</small></div></div>
    {p.feeIsHigh && <p className="fee-warning" role="alert"><Icon name="warning" /><span>{t("手续费占这笔金额的一成以上，请确认。")}</span></p>}
    <section className="receipt-section">
      <h3>{t("收款信息")}</h3>
      <div className="receipt-card">
        <div className="receipt-address">
          <div className="receipt-address-label"><span>{t("收款地址")}</span><button type="button" className="icon-button" aria-label={t("复制地址")} title={t("复制地址")} onClick={() => copy(p.recipient)}><Icon name="copy" /></button></div>
          <code className="grouped-address" aria-label={p.recipient}>{groups.map((group, i) => <span key={i} className={i === 0 || i === groups.length - 1 ? "edge" : undefined}>{group}</span>)}</code>
        </div>
        <div className="receipt-row"><span>{t("网络")}</span><span>Nockchain</span></div>
      </div>
    </section>
    <section className="receipt-section">
      <h3>{t("金额")}</h3>
      <div className="receipt-card">
        <div className="receipt-row"><span>{t("发送")}</span><span>{nock(p.amount)}</span></div>
        <div className={p.feeIsHigh ? "receipt-row high" : "receipt-row"}><span>{t("网络手续费")}</span><span>{nock(p.fee)}</span></div>
        <div className="receipt-row total"><span>{t("合计")}</span><span>{nock(BigInt(p.amount) + BigInt(p.fee))}</span></div>
      </div>
    </section>
    <div className="nock-info"><Icon name="search" /><div><strong>{t("请核对地址")}</strong><p>{t("NOCK 地址没有校验码，输错一位也可能是有效地址。请逐段核对收款地址。")}</p></div></div>
    <p className="receipt-info"><Icon name="shield" /><span>{t("在本机签名，上链后不可撤销")}</span></p>
  </div>;
}

function TxView({ tx, t, nock, lang, copy }: { tx: Row; t: (key: TextKey, values?: Record<string, string | number>) => string; nock: (n: string | bigint, d?: number) => string; lang: Lang; copy: (text: string) => void }) {
  const sent = tx.kind === "sent", groups = tx.counterparty ? addressGroups(tx.counterparty) : [];
  const state = tx.status === "pending" ? t("待确认") : tx.status === "failed" ? t("未上链：节点已丢弃这笔交易，金额已退回余额") : tx.confirmations !== undefined ? t("{count} 确认", { count: tx.confirmations }) : t("已确认");
  return <div className="nock-detail">
    <div className="receipt-hero"><div className="review-amount"><span>{sent ? "−" : "+"}{formatNock(tx.amount, lang)}</span><small>NOCK</small></div><p className={tx.status === "pending" ? "tx-status" : "muted"}>{state}</p></div>
    <section className="receipt-section">
      <h3>{t("详情")}</h3>
      <div className="receipt-card">
        <div className="receipt-row"><span>{t("类型")}</span><span>{t(tx.kind === "received" ? "收到" : tx.kind === "mined" ? "挖矿收入" : "发出")}</span></div>
        <div className="receipt-row"><span>{t("时间")}</span><span>{new Date(tx.time).toLocaleString(lang, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}{tx.timeExact ? "" : " " + t("（估算）")}</span></div>
        {tx.height !== undefined && <div className="receipt-row"><span>{t("区块高度")}</span><span>{tx.height}</span></div>}
        {tx.fee !== undefined && <div className="receipt-row"><span>{t("网络手续费")}</span><span>{nock(tx.fee)}</span></div>}
      </div>
    </section>
    {tx.counterparty && <section className="receipt-section">
      <h3>{t("收款信息")}</h3>
      <div className="receipt-card"><div className="receipt-address">
        <div className="receipt-address-label"><span>{t("发送至")}</span><button type="button" className="icon-button" aria-label={t("复制地址")} title={t("复制地址")} onClick={() => copy(tx.counterparty!)}><Icon name="copy" /></button></div>
        <code className="grouped-address" aria-label={tx.counterparty}>{groups.map((group, i) => <span key={i} className={i === 0 || i === groups.length - 1 ? "edge" : undefined}>{group}</span>)}</code>
      </div></div>
    </section>}
    {tx.txId && <section className="receipt-section">
      <h3>{t("交易 ID")}</h3>
      <div className="receipt-card"><code className="nock-txid">{tx.txId}</code></div>
      <div className="actions nock-tx-actions"><button type="button" onClick={() => copy(tx.txId!)}><Icon name="copy" />{t("复制交易 ID")}</button><a href={explorer(tx.txId)} target="_blank" rel="noreferrer">{t("在浏览器中查看")} ↗</a></div>
    </section>}
  </div>;
}
