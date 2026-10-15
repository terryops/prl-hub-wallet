import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as wallet from "../src/wallet.ts";
import * as market from "../src/market.ts";
import * as webLinks from "../src/web-links.ts";
import * as donation from "../src/donation.ts";
import * as contacts from "../src/contacts.ts";
import * as featureCopy from "../src/feature-copy.ts";
import * as securityOverview from "../shared/security-overview.ts";
import * as i18n from "../src/i18n/index.ts";

test("create wallet during refresh leaves the panel closed, then generates all words when idle", async () => {
  // Execute the actual component and handlers with a small React hook renderer.
  // This tests the click race without needing a desktop browser in the sandbox.
  const hooks: any[] = []; let cursor = 0, root: any, release!: (v: unknown) => void;
  const view = { exists: true, locked: false, selected: "one", network: "mainnet", wallets: [{ id: "one", name: "A", address: "prl1" + "a".repeat(38), index: 0 }], pending: [] };
  const words = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
  const calls: string[] = [];
  const React = {
    createElement: (type: unknown, props: any, ...children: any[]) => ({ type, props: { ...props, children } }),
    useState(initial: any) {
      const at = cursor++;
      if (!(at in hooks)) hooks[at] = at === 2 ? view : typeof initial === "function" ? initial() : initial;
      return [hooks[at], (value: any) => { hooks[at] = typeof value === "function" ? value(hooks[at]) : value; }];
    },
    useRef(initial: any) { const at = cursor++; return hooks[at] ||= { current: initial }; },
    useEffect() {},
  };
  const compiled = ts.transpileModule(readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(compiled, {
    exports: {}, document: { getElementById: () => ({}) }, navigator: { languages: ["zh-CN"] },
    chrome: { i18n: { getUILanguage: () => "zh-CN" }, runtime: {
      getManifest: () => ({ version: "test" }),
      async sendMessage({ command }: { command: string }) {
        calls.push(command);
        if (command === "refresh") return new Promise((resolve) => { release = (data) => resolve({ ok: true, data }); });
        return { ok: true, data: { mnemonic: words } };
      },
    } },
    require: (name: string) => name === "react" ? React : name === "react-dom/client" ? { createRoot: () => ({ render: (element: any) => { root = element; } }) } : name.includes("wallet.ts") ? wallet : name.includes("chain.ts") ? { origin: () => "https://unused.invalid" } : name.includes("i18n/") ? i18n : name.includes("market.ts") ? market : name.includes("feature-copy.ts") ? featureCopy : name.includes("contacts.ts") ? contacts : name.includes("donation.ts") ? donation : name.includes("web-links.ts") ? webLinks : name.includes("security-overview.ts") ? securityOverview : {},
  });
  const render = () => { cursor = 0; return root.type(); };
  const find = (tree: any, label: string): any => {
    if (tree?.type === "button" && (tree.props["aria-label"] === label || tree.props.children.flat(Infinity).includes(label))) return tree;
    for (const child of [tree?.props?.children].flat(Infinity)) { const result = child && typeof child === "object" ? find(child, label) : undefined; if (result) return result; }
  };
  const opened = (tree: any) => tree?.type === "h2" && tree.props.children.flat(Infinity).includes("创建钱包") || [tree?.props?.children].flat(Infinity).some((child) => child && typeof child === "object" && opened(child));
  const initial = render();
  const refreshing = find(initial, "刷新 ↻").props.onClick();
  // An event can reach the old enabled element before React commits busy=true.
  find(initial, "＋ 创建钱包").props.onClick();
  assert.equal(opened(render()), false);
  assert.equal(find(render(), "＋ 创建钱包").props.disabled, true);
  assert.deepEqual(calls, ["refresh"]);
  release(view); await refreshing;
  await new Promise((resolve) => setImmediate(resolve));
  find(render(), "＋ 创建钱包").props.onClick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(opened(render()), true);
  assert.ok(hooks.includes(words));
  const wordGrid = (tree: any): any => tree?.props?.className === "words" ? tree : [tree?.props?.children].flat(Infinity).map((child) => child && typeof child === "object" ? wordGrid(child) : undefined).find(Boolean);
  assert.equal(wordGrid(render()).props.children.flat(Infinity).length, 12);
  assert.deepEqual(calls, ["refresh", "generate"]);
});
