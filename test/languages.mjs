import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { readFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { browserOptions, publicMarketFixture } from "./qa-support.mjs";
const langs = ['en', 'ru', 'zh-Hans', 'zh-Hant', 'vi', 'id', 'es', 'pt-BR', 'fr', 'de', 'it', 'tr', 'ja', 'ko', 'hi', 'th'];
const texts = Object.fromEntries(await Promise.all(langs.map(async l => [l, JSON.parse(await readFile(`src/i18n/${l}.json`, 'utf8'))])));
const vectors = JSON.parse(await readFile('test/native-vectors.json', 'utf8'));
const output = resolve('out/multilang'); await mkdir(output, { recursive: true });
const profile = await mkdtemp(`${output}/languages-`);
const context = await chromium.launchPersistentContext(profile, browserOptions({locale:"en-US",viewport:{width:320,height:920}}));
await publicMarketFixture(context);
const errors = [];
try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  await worker.evaluate(({address, change, to}) => {
    // Isolated public fixture: no requests or broadcasts leave the test browser.
    globalThis.fetch = async url => {
      const p = new URL(String(url)).pathname;
      if (p.includes('/sendtx')) throw new Error('Broadcast forbidden in language tests');
      if (p.includes('/estimatefee')) return Response.json({result:'0.0005'});
      if (p.includes('/utxo')) return Response.json(p.includes('/zpub') ? [{txid:'11'.repeat(32),vout:0,value:'2500000000',address,confirmations:10}] : []);
      return Response.json({balance:'2500000000',unconfirmedBalance:'0',page:1,totalPages:1,transactions:p.includes('/xpub')?[{txid:'44'.repeat(32),blockTime:1700000000,confirmations:10,vin:[{addresses:[to],value:'100000000'}],vout:[{addresses:[address],value:'100000000'}]}]:[],tokens:[{name:address,path:"m/86'/808276'/0'/0/0"},{name:change,path:"m/86'/808276'/0'/1/0"}]});
    };
  },{address:vectors.addresses[0],change:"prl1puwagcza86exfh3cx6ur08wq7njc32e66ep0zje7le6c7cak8lqeq655gqa",to:vectors.cases[0].to});
  const url = `chrome-extension://${worker.url().split('/')[2]}/index.html`;
  const page=await context.newPage(); page.on('pageerror',e=>errors.push(e.message));
  await page.goto(url); await page.getByRole('button',{name:'Create wallet',exact:true}).waitFor();
  const other=await context.newPage(); other.on('pageerror',e=>errors.push(e.message)); await other.goto(url);
  async function language(l){
    await page.locator('#wallet-settings').click();
    await page.locator('#language').selectOption(l);
    for(const p of [page,other])await p.waitForFunction(l=>document.documentElement.lang===l,l);
    assert.equal(await worker.evaluate(()=>chrome.storage.local.get('language')).then(x=>x.language),l);
    await fits(`${l}: preferences`);
    await button(l,'关闭').click();
  }
  async function fits(label){
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true, label);
    assert.equal(await page.locator('dialog').evaluate(d=>!d.open||d.scrollWidth<=d.clientWidth),true,`${label}: dialog`);
  }
  const button=(l,key,root=page)=>root.getByRole('button',{name:texts[l][key],exact:true});
  for(const l of langs){
    await language(l);await button(l,'创建钱包').waitFor();await fits(`${l}: welcome`);
    await button(l,'创建钱包').click();await page.waitForFunction(()=>document.querySelectorAll('.words>div').length===12);
    const phrase=(await page.locator('.words>div').allTextContents()).map(x=>x.replace(/^\d+/,''));
    assert.equal(phrase.length,12);assert.ok(phrase.every(w=>/^[a-z]+$/.test(w)));
    await button(l,'我已保存，核对备份').click();await fits(`${l}: backup quiz`);
    await button(l,'关闭').click();
    await button(l,'恢复已有钱包').click();
    await page.getByLabel(texts[l]['助记词'],{exact:true}).fill('not a valid phrase');
    await page.getByLabel(texts[l]['设置解锁密码'],{exact:true}).fill('public-test-password');
    await page.getByLabel(texts[l]['再次输入密码'],{exact:true}).fill('public-test-password');
    await button(l,'保存钱包').click();
    // Modal errors stay inside the active dialog and use the chosen language.
    await page.locator('dialog').getByRole('status').filter({hasText:texts[l]['助记词无效，请检查单词和顺序。']}).waitFor();
    await button(l,'关闭').click();await fits(`${l}: invalid restore`);
  }
  const create=await page.evaluate(({mnemonic})=>chrome.runtime.sendMessage({command:'create',name:'My 钱包 {amount}',mnemonic,password:'public-test-password'}),{mnemonic:vectors.mnemonic});
  assert.equal(create.ok,true);await page.reload();await page.locator('.balance').filter({hasText:'25.00'}).waitFor();
  assert.equal((await page.evaluate(address=>chrome.runtime.sendMessage({command:'contact-save',name:'QA Exchange',address,note:'Public fixture'}),vectors.cases[0].to)).ok,true);
  const vaultBefore=await worker.evaluate(()=>chrome.storage.local.get(null));
  for(const l of langs){
    await language(l);
    for (const theme of ['light','dark']) { await page.emulateMedia({colorScheme:theme});await fits(`${l}: wallet ${theme}`); }
    await button(l,'地址簿').click();await page.locator('.contact strong').filter({hasText:'QA Exchange'}).waitFor();await fits(`${l}: contacts`);
    await page.locator('.contact summary').click();await button(l,'编辑联系人').click();await fits(`${l}: contact editor`);await button(l,'取消').click();
    await button(l,'交易记录').click();await page.locator('.peer strong').filter({hasText:'QA Exchange'}).waitFor();await fits(`${l}: counterparty`);
    await button(l,'钱包').click();
    assert.equal(await page.locator('.wallet-switcher > span:not(.icon)').textContent(),'My 钱包 {amount}');
    await button(l,'↓ 收款').click();await page.getByAltText(texts[l]['收款地址二维码']).waitFor();
    assert.equal(await page.locator('.receive code').textContent(),vectors.addresses[0]);await fits(`${l}: receive`);await button(l,'关闭').click();
    await button(l,'↑ 转账').click();await page.getByLabel(texts[l]['地址簿'],{exact:true}).selectOption(vectors.cases[0].to);
    await page.getByLabel(texts[l]['转账金额'],{exact:true}).fill('1');await button(l,'预览转账').click();await page.getByRole('button',{name:texts[l]['确认发送 {amount} PRL'].replace('{amount}','1'),exact:true}).waitFor();await fits(`${l}: review`);
    assert.ok((await page.locator('dialog').innerText()).includes(texts[l]['预览在 3 分钟后失效。确认时在本机签名，再发送已签名交易。']));
    if(l==='ru')await page.screenshot({path:`${output}/extension-ru-send-320.png`,fullPage:true});
    await button(l,'关闭').click();
    await button(l,'支持开发者').click();
    await page.getByRole('button',{name:'5 PRL',exact:true}).click();await button(l,'确认捐赠').waitFor();await fits(`${l}: donation`);
    assert.equal(await page.locator('dialog .grouped-address span').count(),16);assert.equal(await page.locator('dialog .fiat').count(),0);
    for (const theme of ['light','dark']) {await page.emulateMedia({colorScheme:theme});await fits(`${l}: donation ${theme}`);}
    await page.screenshot({path:`${output}/${l}-donation-320.png`,fullPage:true});await button(l,'关闭').click();
    assert.equal(await page.locator('.web-links a').count(),2);
    await button(l,'钱包设置').click();await fits(`${l}: settings`);await button(l,'关闭').click();
    await button(l,'备份助记词').click();await page.getByLabel(texts[l]['解锁密码'],{exact:true}).fill('public-test-password');await button(l,'查看助记词').click();await page.waitForFunction(()=>document.querySelectorAll('.words>div').length===12);
    assert.equal((await page.locator('.words>div').allTextContents()).map(x=>x.replace(/^\d+/,'')).join(' '),vectors.mnemonic);await button(l,'已保存，关闭').click();
    await button(l,'锁定钱包').click();await page.getByRole('heading',{name:texts[l]['钱包已锁定'],exact:true}).waitFor();await fits(`${l}: locked`);
    await page.reload();await page.waitForFunction(l=>document.documentElement.lang===l,l);
    await page.getByLabel(texts[l]['解锁密码'],{exact:true}).fill('wrong-password');await button(l,'解锁钱包').click();await page.getByRole('status').filter({hasText:texts[l]['密码错误或钱包文件损坏。']}).waitFor();
    await page.getByLabel(texts[l]['解锁密码'],{exact:true}).fill('public-test-password');await button(l,'解锁钱包').click();await page.locator('.balance').waitFor();
    console.log('PASS',l,'welcome/create/restore/receive/send/backup/settings/lock/errors, persistent and cross-window language, 320px');
  }
  const vaultAfter=await worker.evaluate(()=>chrome.storage.local.get(null));
  assert.deepEqual(Object.keys(vaultBefore).filter(k=>k!=='language'),Object.keys(vaultAfter).filter(k=>k!=='language'));
  assert.deepEqual(errors,[]); console.log('PASS no page errors; public mnemonic and user-defined name unchanged');
} finally {await context.close();await rm(profile,{recursive:true,force:true});}
