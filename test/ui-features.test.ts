import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as wallet from "../src/wallet.ts";
import * as market from "../src/market.ts";
import * as contacts from "../src/contacts.ts";
import * as donation from "../src/donation.ts";
import * as webLinks from "../src/web-links.ts";
import * as featureCopy from "../src/feature-copy.ts";
import * as securityOverview from "../shared/security-overview.ts";
import * as accountCopy from "../shared/account-copy.ts";
import * as i18n from "../src/i18n/index.ts";
import * as transactions from "../src/transactions.ts";
const vectors = JSON.parse(readFileSync(new URL("./native-vectors.json", import.meta.url), "utf8"));
const compiled = ts.transpileModule(readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
const base = { exists: true, locked: false, selected: "one", network: "mainnet", wallets: [{ id: "one", name: "A", address: vectors.addresses[0], primaryAddress: vectors.addresses[0], index: 0 }], pending: [] };
type Element = { type: any; props: any };
function mount(view: any = base, raw: any[] = []) {
  const hooks: any[] = []; let cursor = 0, root: Element;
  const calls: any[] = [];
  const React = {
    createElement: (type: any, props: any, ...children: any[]) => ({ type, props: { ...props, children } }),
    useState(initial: any) { const at = cursor++; if (!(at in hooks)) hooks[at] = at === 2 ? view : Array.isArray(initial) ? raw : typeof initial === "function" ? initial() : initial; return [hooks[at], (value: any) => { hooks[at] = typeof value === "function" ? value(hooks[at]) : value; }]; },
    useRef(initial: any) { const at = cursor++; return hooks[at] ||= { current: initial }; }, useEffect() {},
  };
  vm.runInNewContext(compiled, {
    exports: {}, URLSearchParams, FormData: class { get() { return null; } }, document: { getElementById: () => ({}) }, navigator: { languages: ["zh-CN"] },
    chrome: { i18n: { getUILanguage: () => "zh-CN" }, runtime: { getManifest: () => ({ version: "0.2.0" }), async sendMessage(message: any) {
      calls.push(message); return { ok: true, data: message.command === "fee" ? { fee: 50000, estimated: true } : { id: "review", to: donation.DONATION_ADDRESS, donation: true, network: "mainnet", amount: "500000000", fee: "12300", change: "1000" } };
    } } },
    require: (name: string) => name === "react" ? React : name === "react-dom/client" ? { createRoot: () => ({ render: (element: Element) => { root = element; } }) } : name.includes("wallet.ts") ? wallet : name.includes("chain.ts") ? { origin: () => "https://unused.invalid" } : name.includes("i18n/") ? i18n : name.includes("market.ts") ? market : name.includes("feature-copy.ts") ? featureCopy : name.includes("contacts.ts") ? contacts : name.includes("donation.ts") ? donation : name.includes("web-links.ts") ? webLinks : name.includes("security-overview.ts") ? securityOverview : name.includes("account-copy.ts") ? accountCopy : name.includes("transactions.ts") ? transactions : {},
  });
  return { render: () => { cursor = 0; return root.type(); }, calls };
}
function all(tree: Element, predicate: (e: Element) => boolean): Element[] {
  if (!tree || typeof tree !== "object") return [];
  return [...(predicate(tree) ? [tree] : []), ...[tree.props?.children].flat(Infinity).flatMap((child) => all(child, predicate))];
}
const content = (tree: Element): string => [tree?.props?.children].flat(Infinity).map((child) => typeof child === "object" ? content(child) : child ?? "").join("");
const button = (tree: Element, text: string) => all(tree, (e) => e.type === "button" && content(e) === text)[0];
const tick = () => new Promise((resolve) => setImmediate(resolve));
test("donation UI stays closed until clicked; receipt has exact two-line address, fee/total and no fiat", async () => {
  const app = mount(); assert.equal(app.calls.length, 0);
  button(app.render(), "支持开发者").props.onClick(); await tick();
  assert.deepEqual(app.calls.map((m) => m.command), ["fee"]);
  button(app.render(), "5 PRL").props.onClick(); await tick();
  assert.equal(app.calls[1].command, "prepare"); assert.equal(app.calls[1].donation, true); assert.equal(app.calls[1].amount, "5");
  const receipt = all(app.render(), (e) => e.props?.className === "donation-address")[0];
  assert.equal(all(receipt, (e) => e.type === "span").length, 2); assert.equal(content(receipt), donation.DONATION_ADDRESS);
  assert.ok(button(app.render(), "确认捐赠")); assert.equal(content(app.render()).includes("合计支出"), true);
  assert.equal(all(app.render(), (e) => e.type === "dialog").some((e) => content(e).includes("$")), false);
  assert.equal(app.calls.some((m) => m.command === "send"), false);
});
test("testnet/developer wallets hide donation; testnet hides invalid web deep links", () => {
  assert.equal(button(mount({ ...base, network: "testnet" }).render(), "支持开发者"), undefined);
  assert.equal(all(mount({ ...base, network: "testnet" }).render(), (e) => e.props?.className === "web-links").length, 0);
  assert.equal(button(mount({ ...base, wallets: [{ ...base.wallets[0], primaryAddress: donation.DONATION_ADDRESS }] }).render(), "支持开发者"), undefined);
});
const historyView = { ...base, snapshot: { balance: "100000000", pending: "0", time: 1, history: [{ txid: "11".repeat(32), delta: "100000000", address: vectors.cases[0].to, sent: false, time: 1, confirmations: 2 }, { txid: "22".repeat(32), delta: "-1000", address: "", sent: true, time: 1, confirmations: 1 }] } };
const dialogTitle = (tree: Element) => content(all(all(tree, (e) => e.props?.className === "dialog-title")[0], (e) => e.type === "h2")[0]);
test("history renders contact names and copy controls separately from opening the transaction details", () => {
  const app = mount(historyView, [{ id: "contact", name: "Saved name", address: vectors.cases[0].to, note: "" }]);
  button(app.render(), "交易记录").props.onClick();
  const tree = app.render(); assert.equal(all(tree, (e) => e.props?.className === "peer").length, 1);
  assert.equal(content(tree).includes("Saved name"), true);
  assert.ok(button(tree, "复制"));
  // Each row shows its txid with its own copy button and opens 交易详情; explorer links live in the details.
  assert.equal(all(tree, (e) => e.type === "button" && e.props?.["aria-label"] === "复制交易 ID").length, 2);
  assert.equal(all(tree, (e) => e.type === "button" && e.props?.["aria-label"] === "交易详情").length, 2);
  assert.equal(all(tree, (e) => e.type === "a" && e.props?.href?.includes("/tx/")).length, 0);
});
test("a history row opens its details; the lookup takes a txid or explorer link and refuses anything else", () => {
  const app = mount(historyView);
  button(app.render(), "交易记录").props.onClick();
  const rows = all(app.render(), (e) => e.type === "article" && e.props?.className === "transaction");
  // A click on the row opens it; one on its copy buttons doesn't.
  rows[1].props.onClick({ target: { closest: () => ({}) } }); assert.equal(dialogTitle(app.render()), "");
  rows[1].props.onClick({ target: { closest: () => null } });
  const tree = app.render(); assert.equal(dialogTitle(tree), "交易详情");
  const detail = () => all(app.render(), (e) => typeof e.props?.txid === "string" && typeof e.props?.load === "function");
  assert.deepEqual(detail().map((e) => [e.props.txid, e.props.explorer]), [["22".repeat(32), "https://unused.invalid/tx/" + "22".repeat(32)]]);
  assert.equal(detail()[0].props.label(vectors.addresses[0], true), "A");
  all(tree, (e) => e.props?.["aria-label"] === "关闭")[0].props.onClick();
  all(app.render(), (e) => e.props?.["aria-label"] === "交易查询")[0].props.onClick();
  assert.equal(dialogTitle(app.render()), "交易查询"); assert.equal(detail().length, 0);
  const input = () => all(app.render(), (e) => e.type === "input" && e.props?.["aria-label"] === "交易 ID（txid）或区块浏览器链接")[0];
  const submit = () => all(all(app.render(), (e) => e.type === "dialog")[0], (e) => e.type === "form")[0].props.onSubmit({ preventDefault() {}, currentTarget: {} });
  input().props.onChange({ target: { value: "not a txid" } }); submit();
  assert.equal(content(app.render()).includes("请输入交易 ID：64 位，由 0–9 和 a–f 组成。"), true); assert.equal(detail().length, 0);
  input().props.onChange({ target: { value: ` https://blockbook.pearlresearch.ai/tx/${"AB".repeat(32)} ` } }); submit();
  assert.equal(content(app.render()).includes("请输入交易 ID"), false);
  assert.equal(input().props.value, "ab".repeat(32)); assert.deepEqual(detail().map((e) => e.props.txid), ["ab".repeat(32)]);
  assert.equal(app.calls.length, 0, "the details component does its own loading");
});
test("settings open the Security Overview, which returns to settings and lists the public repositories", () => {
  const app = mount();
  const title = () => content(all(all(app.render(), (e) => e.props?.className === "dialog-title")[0], (e) => e.type === "h2")[0]);
  all(app.render(), (e) => e.props?.id === "wallet-settings")[0].props.onClick();
  assert.equal(title(), "钱包设置");
  button(app.render(), "安全性说明").props.onClick();
  assert.equal(title(), "安全性说明");
  const overview = all(app.render(), (e) => e.props?.sections !== undefined)[0];
  assert.equal(overview.props.sections, securityOverview.extensionSecurity);
  assert.equal(overview.props.lang, "zh-Hans");
  assert.equal(button(app.render(), "安全性说明"), undefined);
  button(app.render(), "返回设置").props.onClick();
  assert.equal(title(), "钱包设置");
  const repos = securityOverview.extensionSecurity.flatMap((s) => s.repos || []);
  assert.deepEqual(repos.map((r) => r.url), ["https://github.com/terryops/prl-hub-wallet", "https://github.com/terryops/prl-hub", "https://github.com/terryops/prl-hub-web", "https://github.com/terryops/prl-hub-server"]);
});
