import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as receipt from "../src/receipt.ts";
import * as i18n from "../src/i18n/index.ts";
import { DONATION_ADDRESS } from "../src/donation.ts";
const { HIGH_FEE, feeIsHigh, addressGroups, receiptAmount } = receipt;
const vectors = JSON.parse(readFileSync(new URL("./native-vectors.json", import.meta.url), "utf8"));

test("the fee warning starts above 5 × the native app's 0.001 PRL send reserve", () => {
  assert.equal(HIGH_FEE, 500000n);
  assert.equal(feeIsHigh("500000"), false);
  assert.equal(feeIsHigh("500001"), true);
  assert.equal(feeIsHigh(15400n), false);
});

test("addresses split into 4-character groups that join back to the address", () => {
  const address = vectors.cases[0].to as string, groups = addressGroups(address);
  assert.equal(groups.join(""), address);
  assert.ok(groups.slice(0, -1).every((g) => g.length === 4));
  assert.ok(groups.at(-1)!.length >= 1 && groups.at(-1)!.length <= 4);
  assert.deepEqual(addressGroups("prl1abcdef"), ["prl1", "abcd", "ef"]);
  assert.deepEqual(addressGroups(""), []);
});

test("amounts are grouped like the balance, with up to 8 decimals and no trailing zeros", () => {
  assert.equal(receiptAmount("100000000", "en"), "1");
  assert.equal(receiptAmount("10000000", "en"), "0.1");
  assert.equal(receiptAmount("1", "en"), "0.00000001");
  assert.equal(receiptAmount("123456789000", "en"), "1,234.56789");
  assert.equal(receiptAmount("123456789000", "de"), "1.234,56789");
  assert.equal(receiptAmount("12345678900000000", "hi"), "12,34,56,789");
  assert.equal(receiptAmount(922337203685477580n, "en"), "9,223,372,036.8547758");
  assert.equal(receiptAmount("-150000000", "en"), "−1.5");
});

// Renders SendReceipt with a stand-in React that keeps the element tree.
type Element = { type: unknown; props: Record<string, unknown> & { children?: unknown[] } };
const compiled = ts.transpileModule(readFileSync(new URL("../src/SendReceipt.tsx", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
const React = { createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => ({ type, props: { ...props, children } }) };
const exports: { SendReceipt?: (props: unknown) => Element } = {};
vm.runInNewContext(compiled, { exports, React, require: (name: string) => name === "react" ? React : name.includes("Icons.tsx") ? { Icon: "Icon" } : name.includes("i18n/") ? i18n : name.includes("receipt.ts") ? receipt : {} });
const all = (tree: unknown, match: (e: Element) => boolean): Element[] => {
  if (!tree || typeof tree !== "object") return [];
  const e = tree as Element;
  return [...(match(e) ? [e] : []), ...[e.props?.children].flat(Infinity).flatMap((child) => all(child, match))];
};
const text = (tree: unknown): string => !tree || typeof tree !== "object" ? String(tree ?? "") : [(tree as Element).props?.children].flat(Infinity).map(text).join("");
const byClass = (tree: Element, name: string) => all(tree, (e) => e.props?.className === name);
const render = (review: Record<string, unknown>, options: { lang?: string; payee?: string } = {}) => {
  const copied: string[] = [];
  const tree = exports.SendReceipt!({ review: { network: "mainnet", change: "0", ...review }, lang: options.lang || "zh-Hans", payee: options.payee, copy: (t: string) => copied.push(t) });
  return { tree, copied };
};
const rows = (tree: Element) => byClass(tree, "receipt-row").concat(byClass(tree, "receipt-row high"), byClass(tree, "receipt-row total"));

test("the receipt: amount and contact up top, grouped address with a raw copy, then amount + network fee = total", () => {
  const to = vectors.cases[0].to as string;
  const { tree, copied } = render({ to, amount: "123456789000", fee: "15400", change: "250000000" }, { payee: "Saved name" });
  assert.equal(text(byClass(tree, "review-amount")[0]), "1,234.56789PRL");
  assert.equal(text(byClass(tree, "receipt-payee")[0]), "发送至 Saved name");
  assert.equal(byClass(tree, "fee-warning").length, 0);
  assert.deepEqual(all(tree, (e) => e.type === "h3").map(text), ["收款信息", "金额"]);
  // The address: 4-character groups, the first and last set apart, joined with no spaces.
  const address = byClass(tree, "grouped-address")[0], groups = all(address, (e) => e.type === "span");
  assert.equal(text(address), to); assert.equal(groups.length, Math.ceil(to.length / 4));
  assert.deepEqual(groups.map((g) => g.props.className === "edge"), groups.map((_, i) => i === 0 || i === groups.length - 1));
  all(tree, (e) => e.type === "button" && e.props["aria-label"] === "复制地址")[0].props.onClick();
  assert.deepEqual(copied, [to]);
  assert.match(text(byClass(tree, "receipt-address-label")[0]), /^收款地址/);
  // Mainnet shows no network row; the amounts add up; change back to this wallet is noted under the total.
  assert.deepEqual(rows(tree).map((r) => [text((r.props.children as unknown[])[0]), text((r.props.children as unknown[])[1])]), [["发送", "1,234.56789 PRL"], ["网络手续费", "0.000154 PRL"], ["合计", "1,234.568044 PRL"]]);
  assert.equal(text(byClass(tree, "receipt-change")[0]), "返回自己的找零2.5 PRL");
  assert.equal(text(byClass(tree, "receipt-info")[0]), "在本机签名，上链后不可撤销");
});

test("a high fee gets the warning and its row stands out; testnet adds the network; no change, no change line", () => {
  const { tree } = render({ to: vectors.testnet.address, network: "testnet", amount: "100000000", fee: "600000" }, { lang: "en" });
  assert.equal(text(byClass(tree, "fee-warning")[0]), "This fee is much higher than usual — please double-check.");
  assert.equal(byClass(tree, "fee-warning")[0].props.role, "alert");
  assert.equal(text(byClass(tree, "receipt-row high")[0]), "Network fee0.006 PRL");
  assert.equal(text(byClass(tree, "receipt-row total")[0]), "Total1.006 PRL");
  assert.ok(byClass(tree, "receipt-row").some((r) => text(r) === "Network" + i18n.translate("en", "PRL 测试网")));
  assert.equal(byClass(tree, "receipt-change").length, 0);
  assert.equal(byClass(tree, "receipt-payee").length, 0);
});

test("a donation's receipt names the developer instead of a recipient", () => {
  const { tree } = render({ to: DONATION_ADDRESS, amount: "500000000", fee: "15400", donation: true });
  assert.match(text(byClass(tree, "receipt-address-label")[0]), /^开发者/);
  assert.equal(text(byClass(tree, "grouped-address")[0]), DONATION_ADDRESS);
});
