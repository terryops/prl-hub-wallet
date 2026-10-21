// What went wrong on the NOCK side, as a translation key (the Chinese source text, src/i18n) and its
// values, so the background can say it and the page can show it in the reader's language. A value can
// itself be a message (the reason inside "网络异常，无法确认转账是否已发出（…）").
import { NockFailure } from "./core.ts";
import { NockRPCError } from "./client.ts";

export type NockText = { key: string; values?: Record<string, string | number | NockText> };

/// A message this file or the NOCK service raised on purpose (its text is a translation key).
export class NockError extends Error {
  text: NockText;
  constructor(key: string, values?: NockText["values"]) { super(key); this.text = { key, values }; }
}

export function errorText(error: unknown): NockText {
  if (error instanceof NockError) return error.text;
  if (error instanceof NockFailure) {
    switch (error.code) {
      case "insufficient": return { key: "余额不足以支付金额和手续费" };
      case "no_funds": return { key: "没有可用的 NOCK（挖矿收入要过 100 个区块才能使用）" };
      case "invalid_address": return { key: "收款地址格式不正确" };
      case "legacy_address": return { key: "这是旧版（v0）NOCK 地址，已不能收款，请向对方要新地址" };
      case "zero_amount": return { key: "请输入金额" };
      case "invalid_mnemonic": return { key: "助记词无效" };
      case "unavailable": return { key: "NOCK 钱包组件缺失，无法使用" };
      case "server": return { key: "节点拒绝了请求：{message}", values: { message: error.message.slice(0, 200) } };
      default: return { key: "NOCK 钱包出错：{message}", values: { message: `${error.code}: ${error.message}`.slice(0, 200) } };
    }
  }
  if (error instanceof NockRPCError) {
    switch (error.kind) {
      case "http": return { key: "Nockchain 节点暂时不可用（HTTP {code}）", values: { code: error.code } };
      case "status": return { key: "Nockchain 节点返回错误：{message}", values: { message: (error.message || `gRPC ${error.code}`).slice(0, 200) } };
      // notes() says why in its own words.
      case "transport": return { key: error.message === "链上数据在变化，请稍后重试" ? error.message : "无法连接 Nockchain 节点" };
      default: return { key: "Nockchain 节点返回的数据无法解析" };
    }
  }
  return { key: "操作失败。" };
}
