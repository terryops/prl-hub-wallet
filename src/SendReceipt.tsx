import { Icon } from "./Icons.tsx";
import { translate, type Lang, type TextKey } from "./i18n/index.ts";
import { addressGroups, feeIsHigh, receiptAmount } from "./receipt.ts";
import type { Network } from "./wallet.ts";

export type Receipt = { to: string; network: Network; amount: string; fee: string; change: string; donation?: boolean };

/// Last look at a send, laid out like the native app's receipt (prl-hub Sources/Wallet/SendConfirmSheet.swift):
/// the amount up top (with the contact's name when the address is saved), a warning when the fee is unusually
/// high, the full address in 4-character groups, then amount + network fee = total. The transaction is already
/// built, so the fee is the real one. Change going back to this wallet is noted under the total.
export function SendReceipt({ review, lang, payee, copy }: { review: Receipt; lang: Lang; payee?: string; copy: (text: string) => void }) {
  const t = (key: TextKey, values?: Record<string, string | number>) => translate(lang, key, values);
  const prl = (atoms: string | bigint) => `${receiptAmount(atoms, lang)} PRL`;
  const high = feeIsHigh(review.fee), groups = addressGroups(review.to);
  return <div className="receipt">
    <div className="receipt-hero">
      <span className="receipt-badge"><Icon name="send" /></span>
      <div className="review-amount"><span>{receiptAmount(review.amount, lang)}</span><small>PRL</small></div>
      {payee && <p className="receipt-payee"><Icon name="account" /><span>{t("发送至 {name}", { name: payee })}</span></p>}
    </div>
    {high && <p className="fee-warning" role="alert"><Icon name="warning" /><span>{t("本笔手续费明显高于平常，请确认。")}</span></p>}
    <section className="receipt-section">
      <h3>{t("收款信息")}</h3>
      <div className="receipt-card">
        <div className="receipt-address">
          <div className="receipt-address-label"><span>{t(review.donation ? "开发者" : "收款地址")}</span><button type="button" className="icon-button" aria-label={t("复制地址")} title={t("复制地址")} onClick={() => copy(review.to)}><Icon name="copy" /></button></div>
          {/* Groups are spaced by CSS, not by spaces, so selecting and copying still gives the address itself. */}
          <code className="grouped-address" aria-label={review.to}>{groups.map((group, i) => <span key={i} className={i === 0 || i === groups.length - 1 ? "edge" : undefined}>{group}</span>)}</code>
        </div>
        {review.network === "testnet" && <div className="receipt-row"><span>{t("网络")}</span><span>{t("PRL 测试网")}</span></div>}
      </div>
    </section>
    <section className="receipt-section">
      <h3>{t("金额")}</h3>
      <div className="receipt-card">
        <div className="receipt-row"><span>{t("发送")}</span><span>{prl(review.amount)}</span></div>
        <div className={high ? "receipt-row high" : "receipt-row"}><span>{t("网络手续费")}</span><span>{prl(review.fee)}</span></div>
        <div className="receipt-row total"><span>{t("合计")}</span><span>{prl(BigInt(review.amount) + BigInt(review.fee))}</span></div>
      </div>
      {BigInt(review.change) > 0n && <p className="receipt-change"><span>{t("返回自己的找零")}</span><span>{prl(review.change)}</span></p>}
    </section>
    <p className="receipt-info"><Icon name="shield" /><span>{t("在本机签名，上链后不可撤销")}</span></p>
  </div>;
}
