import { useEffect, useRef, useState } from "react";
import { formatAmount } from "./wallet.ts";
import { ownFirst, type TxDetail, type TxRow } from "./transactions.ts";
import { translate, type Lang, type TextKey } from "./i18n/index.ts";
import { Icon } from "./Icons.tsx";

// 交易详情, also the result of 交易查询: status and txid, block facts, what the transaction did to
// this wallet, 重新广播 while unconfirmed, then inputs and outputs with the wallet's own first.
// Same content as the native app's TxDetailSections.

export type TxLoad = { found: false } | { found: true; tx: TxDetail };
export type TxResend = { outcome: "sent" | "known" | "rejected" | "unknown" | "notSent"; reason?: string };
type Props = {
  txid: string;
  lang: Lang;
  explorer: string;
  /// A name for an address: this wallet's (`mine`), another wallet's or a contact's.
  label: (address: string, mine: boolean) => string | undefined;
  copy: (text: string) => void;
  load: (txid: string) => Promise<TxLoad>;
  resend: (txid: string) => Promise<TxResend>;
};
type Phase = { kind: "loading" } | { kind: "found"; tx: TxDetail } | { kind: "missing" } | { kind: "failed" };
/// Rows per side before 显示全部: a pool payout lists up to a thousand outputs.
const FIRST_ROWS = 10, REFRESH_MS = 30000;
const short = (s: string) => `${s.slice(0, 12)}…${s.slice(-8)}`;

export function TxDetailView({ txid, lang, explorer, label, copy, load, resend }: Props) {
  const t = (key: TextKey) => translate(lang, key);
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [sending, setSending] = useState(false), [result, setResult] = useState<TxResend | null>(null);
  const [allInputs, setAllInputs] = useState(false), [allOutputs, setAllOutputs] = useState(false);
  const live = useRef(true), shown = useRef<Phase>(phase); shown.current = phase;
  /// `quiet`: a background refresh. A failed one leaves what's on screen alone.
  async function reload(quiet: boolean) {
    try {
      const r = await load(txid);
      if (live.current) setPhase(r.found ? { kind: "found", tx: r.tx } : { kind: "missing" });
    } catch { if (live.current && (!quiet || shown.current.kind === "loading")) setPhase({ kind: "failed" }); }
  }
  // Loads once, then every 30 s while the transaction is unconfirmed or not indexed yet.
  useEffect(() => {
    live.current = true; void reload(false);
    const timer = setInterval(() => {
      const p = shown.current;
      if (document.visibilityState === "visible" && !(p.kind === "found" && p.tx.confirmations > 0)) void reload(true);
    }, REFRESH_MS);
    return () => { live.current = false; clearInterval(timer); };
  }, [txid]);
  async function rebroadcast() {
    setSending(true); setResult(null);
    let r: TxResend;
    try { r = await resend(txid); } catch { r = { outcome: "notSent" }; }
    if (!live.current) return;
    setSending(false); setResult(r);
    if (r.outcome === "sent" || r.outcome === "known") void reload(true);
  }
  const number = (n: number) => new Intl.NumberFormat(lang).format(n);
  const prl = (value: string, signed = false) => `${signed && BigInt(value) > 0n ? "+" : ""}${formatAmount(value)} PRL`;
  const tx = phase.kind === "found" ? phase.tx : null, confirmed = !!tx && tx.confirmations > 0;
  const rows = (title: string, list: TxRow[], all: boolean, setAll: (v: boolean) => void, coinbase = false) => <section className="tx-rows">
    <h3><span>{title}</span>{!coinbase && <small>{number(list.length)}</small>}</h3>
    {coinbase ? <p className="muted">{t("Coinbase：新挖出的币")}</p> : <ul>{(all ? list : list.slice(0, FIRST_ROWS)).map((r, i) => {
      const name = r.address ? label(r.address, r.mine) : undefined;
      return <li key={i} className={r.mine ? "mine" : undefined}>
        <div className="tx-row-who">{name && <strong>{name}</strong>}{r.address ? <code title={r.address}>{short(r.address)}</code> : <small>{r.data ? "OP_RETURN" : t("非标准脚本")}</small>}</div>
        <b>{prl(r.value)}</b>
        {r.address && <button type="button" className="tx-copy" aria-label={t("复制地址")} onClick={() => copy(r.address!)}><Icon name="copy" /></button>}
      </li>;
    })}</ul>}
    {!coinbase && list.length > FIRST_ROWS && <button type="button" className="tx-more" onClick={() => setAll(!all)}>{all ? t("收起") : `${t("显示全部")} (${number(list.length)})`}</button>}
  </section>;
  return <div className="tx-detail">
    <div className="tx-detail-head">
      {tx ? <span className={confirmed ? "tx-status confirmed" : "tx-status"}>{confirmed && <Icon name="check" />}{t(confirmed ? "已确认" : "待确认")}</span> : <span />}
      <a href={explorer} target="_blank" rel="noreferrer">{t("区块浏览器")} ↗</a>
    </div>
    <div className="tx-detail-id"><small>{t("交易 ID")}</small><code>{txid}</code><button type="button" onClick={() => copy(txid)}><Icon name="copy" />{t("复制交易 ID")}</button></div>
    {phase.kind === "loading" && <p className="muted tx-loading">{t("更新中…")}</p>}
    {phase.kind === "missing" && <p className="notice">{t("没有找到这笔交易。刚发出的交易可能要稍等片刻才能查到。")}</p>}
    {phase.kind === "failed" && <div className="tx-failed"><p className="notice">{t("操作未完成，请重试。")}</p><button type="button" onClick={() => { setPhase({ kind: "loading" }); void reload(false); }}>{t("重试")}</button></div>}
    {tx && <>
      <dl className="tx-facts">
        <div><dt>{t("确认数")}</dt><dd>{number(tx.confirmations)}</dd></div>
        <div><dt>{t("区块")}</dt><dd>{tx.height ?? "—"}</dd></div>
        <div><dt>{t("时间")}</dt><dd>{tx.time ? new Date(tx.time * 1000).toLocaleString(lang) : "—"}</dd></div>
        <div><dt>{t("输出总额")}</dt><dd>{prl(tx.value)}</dd></div>
        <div><dt>{t("网络手续费")}</dt><dd>{prl(tx.fee)}</dd></div>
        {tx.net != null && <div><dt>{t("你的地址净收支")}</dt><dd className={BigInt(tx.net) > 0n ? "tx-net incoming" : "tx-net"}>{prl(tx.net, true)}</dd></div>}
      </dl>
      {tx.rebroadcast && <section className="tx-resend">
        {result?.outcome === "sent" && <p className="tx-ok">{t("已重新广播，交易再次发往网络。")}</p>}
        {result?.outcome === "known" && <p className="tx-ok">{t("网络中已有这笔交易。")}</p>}
        {result?.outcome === "rejected" && <div className="notice"><p>{t("网络拒绝了这笔交易：")}</p>{result.reason && <code>{result.reason}</code>}</div>}
        {result?.outcome === "unknown" && <p className="notice">{t("网络没有回应，无法确定交易是否已发出。可以先查询，或再广播一次：同一笔交易重复广播是安全的。")}</p>}
        {result?.outcome === "notSent" && <p className="notice">{t("操作未完成，请重试。")}</p>}
        {result?.outcome !== "sent" && result?.outcome !== "known" && <button type="button" className="wide" disabled={sending} onClick={() => void rebroadcast()}><Icon name="send" />{sending ? t("正在广播…") : t("重新广播")}</button>}
      </section>}
      {rows(t("输入"), ownFirst(tx.inputs), allInputs, setAllInputs, tx.coinbase)}
      {rows(t("输出"), ownFirst(tx.outputs), allOutputs, setAllOutputs)}
    </>}
  </div>;
}
