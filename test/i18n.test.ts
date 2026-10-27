import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { detectLanguage, dictionaries, languages, messageText, translate, type TextKey } from '../src/i18n/index.ts';

test('all wallet translations preserve keys, placeholders and security warnings', () => {
  const keys = Object.keys(dictionaries.en).sort() as TextKey[];
  for (const lang of languages) {
    assert.deepEqual(Object.keys(dictionaries[lang]).sort(), keys);
    for (const key of keys) {
      const text = dictionaries[lang][key];
      assert.ok(text.trim(), `${lang}: ${key}`);
      assert.doesNotMatch(text, /^0{3,5}(?:\s|[。:.：])/, `${lang}: translation marker in ${key}`);
      assert.deepEqual(text.match(/\{\w+\}/g)?.sort(), key.match(/\{\w+\}/g)?.sort(), `${lang}: ${key}`);
      if (!lang.startsWith('zh') && lang !== 'ja') assert.ok(!/\p{Script=Han}/u.test(text), `${lang}: ${key}`);
    }
    assert.equal(translate(lang, '输入钱包名称“{name}”', { name: 'My {amount} $& 钱包' }).includes('My {amount} $& 钱包'), true);
    assert.equal(messageText(lang, '密码错误或钱包文件损坏。'), dictionaries[lang]['密码错误或钱包文件损坏。']);
    assert.equal(messageText(lang, 'TypeError: fetch failed'), dictionaries[lang]['操作失败。']);
  }
});

test('language detection handles regions, scripts, unsupported preferences and fallback', () => {
  for (const [locale, expected] of [['en-GB','en'],['ru-RU','ru'],['zh-CN','zh-Hans'],['zh_SG','zh-Hans'],['zh-Hant','zh-Hant'],['zh-TW','zh-Hant'],['zh-HK','zh-Hant'],['zh-Hans-HK','zh-Hans'],['vi-VN','vi'],['id-ID','id']]) {
    assert.equal(detectLanguage([locale]), expected);
  }
  assert.equal(detectLanguage(['fr-FR','vi-VN','en']), 'fr');
  assert.equal(detectLanguage(['ja-JP']), 'ja');
  assert.equal(detectLanguage(['nl-NL','vi-VN']), 'vi');
  assert.equal(detectLanguage(['pt-PT']), 'pt-BR');
  assert.equal(detectLanguage([]), 'en');
});

test('wallet service errors and UI source strings all have translations', () => {
  for (const file of ['main.tsx','TxDetail.tsx','SendReceipt.tsx','receipt.ts','transactions.ts','background.ts','chain.ts','wallet.ts','vault.ts','contacts.ts','donation.ts','contact-sync.ts','nock/NockView.tsx','nock/service.ts','nock/errors.ts','nock/client.ts']) {
    const source = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    function visit(node: ts.Node) {
      if (ts.isStringLiteral(node) && /\p{Script=Han}/u.test(node.text)) {
        assert.ok(Object.hasOwn(dictionaries.en, node.text), `${file}: ${node.text}`);
      }
      if (ts.isJsxText(node)) assert.ok(!/\p{Script=Han}/u.test(node.text), `untranslated JSX: ${node.text}`);
      ts.forEachChild(node, visit);
    }
    visit(ast);
  }
});
test("the NOCK page's All link is not the send form's Max", () => {
  // 0.1.8 first reused 全部 (the send form's MAX button), so the recent card's link read "Max" in English.
  const view = readFileSync(new URL("../src/nock/NockView.tsx", import.meta.url), "utf8");
  assert.ok(!view.includes('t("全部")')); assert.ok(view.includes('t("全部交易")'));
  // The native app's 全部 (Sources/*.lproj/Localizable.strings). Turkish and Korean say the same for Max.
  const all: Record<string, string> = { en: "All", ru: "Все", "zh-Hans": "全部", "zh-Hant": "全部", vi: "Tất cả", id: "Semua", es: "Todo", "pt-BR": "Tudo", fr: "Tout", de: "Alle", it: "Tutto", tr: "Tümü", ja: "すべて", ko: "전체", hi: "सभी", th: "ทั้งหมด" };
  for (const lang of languages) assert.equal(dictionaries[lang]["全部交易" as TextKey], all[lang], lang);
});
