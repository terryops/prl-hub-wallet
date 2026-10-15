import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createVault, open, bytes64 } from '../src/vault.ts';
import { derived, type VaultData } from '../src/wallet.ts';
import { DONATION_ADDRESS } from '../src/donation.ts';
const vectors = JSON.parse(readFileSync(new URL('./native-vectors.json', import.meta.url), 'utf8'));
const password = 'public-test-password';
const data: VaultData = { network: 'mainnet', selected: 'wallet-a', wallets: [{id: 'wallet-a', name: 'A', mnemonic: vectors.mnemonic, receiveIndex: 0}], pending: [{ walletId: 'wallet-a', network: 'mainnet', txid: '11'.repeat(32), hex: '00', to: vectors.cases[0].to, amount: '1', fee: '1', inputs: [], time: 1, status: 'unknown' }] };
const seed = await createVault(data, password);
const area = () => {
  let items: Record<string, unknown> = {};
  return {
    async get(keys?: string | string[] | null) { return structuredClone(keys == null ? items : Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(k => k in items).map(k => [k, items[k]]))); },
    async set(next: Record<string, unknown>) { Object.assign(items, structuredClone(next)); },
    async remove(keys: string | string[]) { for (const k of Array.isArray(keys) ? keys : [keys]) delete items[k]; },
    async clear() { items = {}; }, async setAccessLevel() {},
  };
};
let listener: (message: unknown, sender: unknown, reply: (data: any) => void) => boolean;
const local = area(), session = area();
const chromeMock = { storage: {local, session}, runtime: {id:'test', getURL: (p: string) => `chrome-extension://test/${p}`, sendMessage: async () => {}, onMessage: {addListener(fn: typeof listener) { listener = fn; }}, onInstalled: {addListener() {}}, onStartup: {addListener() {}}}, sidePanel: {setPanelBehavior: async () => {}}, alarms: {get: async () => true, create: async () => {}, onAlarm: {addListener() {}}} };
Object.assign(globalThis, {chrome:chromeMock});
await import('../src/background.ts');
const rpc = (command: string, fields: Record<string, unknown> = {}) => new Promise<any>(resolve => listener({command,...fields}, {id:'test',url:'chrome-extension://test/index.html'}, resolve));
async function reset(next = data) {
  await rpc('lock');
  const sealed = next === data ? seed : await createVault(next, password);
  await local.set({'pearl.wallet.v1':sealed.envelope});
  await session.set({'wallet.session':{key:bytes64.encode(sealed.key),active:Date.now()}});
}
async function lockDuringPassword(command: string, fields: Record<string, unknown>, beforeLock = () => {}) {
  const original = crypto.subtle.deriveBits.bind(crypto.subtle);
  let reached!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => reached = resolve), barrier = new Promise<void>(resolve => release = resolve);
  crypto.subtle.deriveBits = (async (...args: Parameters<typeof original>) => { reached(); await barrier; return original(...args); }) as typeof crypto.subtle.deriveBits;
  try {
    const operation = rpc(command, {password,...fields});
    await started;
    beforeLock();
    await rpc('lock');
    release();
    return await operation;
  } finally { release(); crypto.subtle.deriveBits = original; }
}
test('contact edits serialize across windows, validate network and never touch encrypted keys', async () => {
  await reset(); await local.remove('wallet.contacts');
  const before = await local.get('pearl.wallet.v1');
  const results = await Promise.all([rpc('contact-save', {name:'A',address:vectors.addresses[0],note:'one'}), rpc('contact-save', {name:'B',address:vectors.addresses[1],note:'two'})]);
  assert.ok(results.every(r => r.ok));
  const contacts = (await local.get('wallet.contacts'))['wallet.contacts'] as any[];
  assert.equal(contacts.length, 2);
  assert.deepEqual(await local.get('pearl.wallet.v1'), before);
  assert.equal((await rpc('contact-save', {name:'Wrong',address:vectors.testnet.address})).ok, false);
  assert.equal((await rpc('contact-remove', {id:contacts[0].id,expectedNetwork:'testnet'})).ok, false);
  await rpc('lock'); assert.equal((await rpc('contact-remove', {id:contacts[0].id})).ok, false);
  assert.equal(((await local.get('wallet.contacts'))['wallet.contacts'] as any[]).length, 2);
});
test('donation preview fixes recipient, enforces minimum/mainnet and uses existing password/sign/broadcast path', async () => {
  await reset({...data,pending:[]});
  const original = globalThis.fetch; let broadcasts = 0;
  globalThis.fetch = async url => {
    const path = new URL(String(url)).pathname;
    if (path.includes('/sendtx/')) { broadcasts++; throw new Error('Fixture lost response'); }
    if (path.includes('/utxo/')) return Response.json(path.includes('/zpub') ? [{txid:'aa'.repeat(32),vout:0,value:'3000000000',address:vectors.addresses[0],confirmations:10}] : []);
    return Response.json({balance:'3000000000',transactions:[]});
  };
  try {
    assert.equal((await rpc('prepare', {donation:true,amount:'0.9',fee:50000})).ok, false);
    const review = await rpc('prepare', {donation:true,to:vectors.cases[0].to,amount:'5',fee:50000,max:true});
    assert.equal(review.ok, true); assert.equal(review.data.to, DONATION_ADDRESS); assert.equal(review.data.amount, '500000000'); assert.equal(review.data.donation, true);
    assert.equal(broadcasts, 0);
    assert.equal((await rpc('send', {id:review.data.id,password:'wrong-password'})).ok, false); assert.equal(broadcasts, 0);
    const sent = await rpc('send', {id:review.data.id,password});
    assert.equal(sent.ok, true); assert.equal(sent.data.outcome, 'unknown'); assert.equal(broadcasts, 1);
    assert.equal(sent.data.pending[0].to, DONATION_ADDRESS);
    await rpc('network', {network:'testnet'});
    assert.equal((await rpc('prepare', {donation:true,amount:'5',fee:50000})).ok, false);
  } finally { globalThis.fetch = original; }
});
test('locking while retry password is being verified prevents broadcast', async () => {
  await reset();
  const original = globalThis.fetch; let broadcasts = 0;
  globalThis.fetch = async () => { broadcasts++; return Response.json({result:data.pending[0].txid}); };
  try {
    const result = await lockDuringPassword('retry', {txid:data.pending[0].txid});
    assert.equal(result.ok, false);
    assert.equal(broadcasts, 0, 'locked wallet must not broadcast');
    assert.deepEqual(await session.get(null), {});
  } finally { globalThis.fetch = original; }
});
test('locking while last-wallet deletion is being verified preserves the vault', async () => {
  await reset({...data,pending:[]});
  const result = await lockDuringPassword('delete', {name:'A'});
  assert.equal(result.ok, false);
  assert.ok((await local.get('pearl.wallet.v1'))['pearl.wallet.v1']);
});
test('a stale second window cannot rename the newly selected wallet', async () => {
  await reset();
  const result = await rpc('rename', {name:'Wrong wallet', expectedWalletId:'other-wallet', expectedNetwork:'mainnet'});
  assert.equal(result.ok, false);
  assert.equal((await rpc('rename', {name:'Wrong network', expectedWalletId:'wallet-a', expectedNetwork:'testnet'})).ok, false);
  const persisted = await open((await local.get('pearl.wallet.v1'))['pearl.wallet.v1'] as any, seed.key);
  assert.equal(persisted.wallets[0].name, 'A');
});
test('locking cancels an unlock request that was queued before the lock', async () => {
  await reset();
  let queued!: Promise<any>;
  const active = await lockDuringPassword('backup', {}, () => { queued = rpc('unlock', {password}); });
  assert.equal(active.ok, false);
  assert.equal((await queued).ok, false);
  assert.deepEqual(await session.get(null), {});
});
test('prepare and send spend real address-less internal/70 UTXOs without changing ownership', async () => {
  const address = derived(vectors.xpub, 'mainnet', 1, 70).address!;
  await reset({ ...data, wallets: [{ ...data.wallets[0], changeAddresses: { mainnet: [address] } }], pending: [] });
  const original = globalThis.fetch; let sent = false;
  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    if (path.includes('/sendtx/')) { sent = true; return Response.json({ error: 'min relay fee not met' }, { status: 400 }); }
    if (path.includes('/utxo/')) return Response.json(path.endsWith(address) ? [{ txid: 'aa'.repeat(32), vout: 0, value: '100000000', confirmations: 2 }] : []);
    return Response.json({ balance: '0', transactions: [] });
  };
  try {
    const review = await rpc('prepare', { to: vectors.cases[0].to, amount: '0.1', fee: 20000 });
    assert.equal(review.ok, true, review.error);
    const inputs = (await session.get('wallet.review'))['wallet.review'] as any;
    assert.equal(inputs.utxos[0].address, address);
    const result = await rpc('send', { id: review.data.id, password });
    assert.equal(result.ok, true, result.error); assert.equal(sent, true);
    assert.equal(result.data.outcome, 'rejected');
  } finally { globalThis.fetch = original; }
});
test('rejected or ambiguous pending entries can be deliberately discarded after reauthentication', async () => {
  await reset({ ...data, pending: [{ ...data.pending[0], inputs: ['aa'.repeat(32) + ':0'] }] });
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    if (path.includes('/sendtx/')) return Response.json({ error: 'bad-txns-inputs-missingorspent' }, { status: 400 });
    if (path.includes('/tx/')) return Response.json({ error: 'Transaction not found' }, { status: 404 });
    if (path.includes('/utxo/')) return Response.json(path.includes('/zpub') ? [{ txid: 'aa'.repeat(32), vout: 0, value: '100000000', address: vectors.addresses[0], confirmations: 2 }] : []);
    return Response.json({ balance: '0', transactions: [] });
  };
  try {
    const retry = await rpc('retry', { txid: data.pending[0].txid, password });
    assert.equal(retry.data.pending[0].status, 'rejected');
    assert.equal((await rpc('check', { txid: data.pending[0].txid })).ok, true);
    assert.equal((await rpc('prepare', { to: vectors.cases[0].to, amount: '0.1', fee: 20000 })).ok, false, 'reserved until explicitly discarded');
    assert.equal((await rpc('discard', { txid: data.pending[0].txid, password })).ok, false);
    assert.equal((await rpc('discard', { txid: data.pending[0].txid, password: 'wrong', acknowledge: true })).ok, false);
    const result = await rpc('discard', { txid: data.pending[0].txid, password, acknowledge: true });
    assert.equal(result.ok, true, result.error); assert.equal(result.data.pending.length, 0);
    assert.equal((await rpc('prepare', { to: vectors.cases[0].to, amount: '0.1', fee: 20000 })).ok, true, 'discard releases the reservation');
    assert.equal((await rpc('delete', { name: 'A', password })).ok, true);
  } finally { globalThis.fetch = original; }
});
test('change consolidation previews only confirmed unreserved internal funds to the primary address', async () => {
  const change = derived(vectors.xpub, 'mainnet', 1, 0).address!;
  await reset({ ...data, wallets: [{ ...data.wallets[0], changeAddresses: { mainnet: [change] } }], pending: [] });
  const original = fetch; let broadcasts = 0;
  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    if (path.includes('/sendtx/')) { broadcasts++; throw new Error('broadcast forbidden'); }
    if (path.includes('/utxo/')) return Response.json(path.endsWith(change) ? [{ txid: 'aa'.repeat(32), vout: 0, value: '100000000', confirmations: 2 }, { txid: 'bb'.repeat(32), vout: 0, value: '90000000', confirmations: 0 }] : [{ txid: 'cc'.repeat(32), vout: 0, value: '500000000', confirmations: 2, address: vectors.addresses[0] }]);
    return Response.json({ balance: '0', transactions: [] });
  };
  try {
    const result = await rpc('prepare', { recovery: true, to: vectors.cases[0].to, amount: '9999', fee: 20000 });
    assert.equal(result.ok, true, result.error); assert.equal(result.data.to, vectors.addresses[0]);
    assert.ok(BigInt(result.data.amount) < 100000000n); assert.equal(result.data.change, '0');
    const review = (await session.get('wallet.review'))['wallet.review'] as any;
    assert.equal(review.utxos.length, 1); assert.equal(review.utxos[0].address, change); assert.equal(broadcasts, 0);
    assert.equal((await rpc('send', { id: result.data.id, password: 'wrong-password' })).ok, false); assert.equal(broadcasts, 0);
  } finally { globalThis.fetch = original; }
});
test('transport failure remains ambiguous and keeps pending inputs reserved', async () => {
  await reset();
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('reply lost'); };
  try {
    const result = await rpc('retry', { txid: data.pending[0].txid, password });
    assert.equal(result.data.pending[0].status, 'unknown');
    assert.equal((await rpc('delete', { name: 'A', password })).ok, false);
    const discarded = await rpc('discard', { txid: data.pending[0].txid, password, acknowledge: true });
    assert.equal(discarded.ok, true, discarded.error);
    assert.equal(discarded.data.pending.length, 0);
  } finally { globalThis.fetch = original; }
});
test('refresh clears confirmed pending entries in the current wallet/network only', async () => {
  const original = fetch, p = data.pending[0];
  await reset({ ...data, pending: [{ ...p, status: 'submitted' }, { ...p, network: 'testnet' }, { ...p, walletId: 'wallet-b' }] });
  globalThis.fetch = async url => {
    const path = new URL(String(url)).pathname;
    return Response.json(path.includes('/utxo/') ? [] : { balance: '0', transactions: [{ txid: p.txid, confirmations: 6 }] });
  };
  try {
    const refreshed = await rpc('refresh');
    assert.equal(refreshed.ok, true, refreshed.error); assert.equal(refreshed.data.pending.length, 0);
    const persisted = await passwordVault();
    assert.equal(persisted.pending.length, 2);
    assert.ok(persisted.pending.every(x => x.network === 'testnet' || x.walletId === 'wallet-b'));
  } finally { globalThis.fetch = original; }
});
async function passwordVault() {
  const envelope = (await local.get('pearl.wallet.v1'))['pearl.wallet.v1'] as any;
  const key = bytes64.decode(((await session.get('wallet.session'))['wallet.session'] as any).key);
  return open(envelope, key);
}
test('refresh can confirm an older pending transaction outside the current history page', async () => {
  await reset(); const original = fetch, p = data.pending[0]; let checks = 0;
  globalThis.fetch = async url => {
    const path = new URL(String(url)).pathname;
    if (path.includes('/tx/')) { checks++; return Response.json({ txid: p.txid, confirmations: 2 }); }
    return Response.json(path.includes('/utxo/') ? [] : { balance: '0', transactions: [] });
  };
  try {
    assert.equal((await rpc('refresh')).data.pending.length, 0); assert.equal(checks, 1);
    assert.equal((await rpc('delete', { name: 'A', password })).ok, true);
  } finally { globalThis.fetch = original; }
});
test('fee command distinguishes an invalid estimate from a valid network estimate', async () => {
  await reset(); const original = fetch;
  try {
    globalThis.fetch = async () => Response.json({ result: '-1' });
    assert.deepEqual((await rpc('fee')).data, { fee: 50000, estimated: false });
    globalThis.fetch = async () => Response.json({ result: '0.0005' });
    assert.deepEqual((await rpc('fee')).data, { fee: 50000, estimated: true });
  } finally { globalThis.fetch = original; }
});
test('refresh preserves reservations on offline, missing, mismatched or invalid transaction responses', async () => {
  const original = fetch, p = data.pending[0]; let broadcasts = 0;
  try {
    for (const status of ['unknown', 'rejected'] as const) for (const mode of ['offline', 'missing', 'mismatch', 'invalid']) {
      await reset({ ...data, pending: [{ ...p, status, inputs: ['aa'.repeat(32) + ':0'] }] });
      globalThis.fetch = async url => {
        const path = new URL(String(url)).pathname;
        if (path.includes('/sendtx/')) { broadcasts++; throw new Error('unexpected broadcast'); }
        if (path.includes('/tx/')) {
          if (mode === 'offline') throw new Error('offline');
          if (mode === 'missing') return Response.json({ error: 'Transaction not found' }, { status: 404 });
          return Response.json({ txid: mode === 'mismatch' ? 'ee'.repeat(32) : p.txid, confirmations: mode === 'invalid' ? '6' : 6 });
        }
        return Response.json(path.includes('/utxo/') ? path.includes('/zpub') ? [{ txid: 'aa'.repeat(32), vout: 0, value: '100000000', address: vectors.addresses[0], confirmations: 6 }] : [] : { balance: '100000000', transactions: [] });
      };
      const refreshed = await rpc('refresh');
      assert.equal(refreshed.ok, true, refreshed.error); assert.equal(refreshed.data.snapshot.balance, '100000000');
      assert.equal(refreshed.data.pending[0].status, status);
      assert.equal((await rpc('prepare', { to: vectors.cases[0].to, amount: '0.1', fee: 50000 })).ok, false, mode + ' must keep the reservation');
      assert.equal((await rpc('delete', { name: 'A', password })).ok, false);
    }
    assert.equal(broadcasts, 0);
  } finally { globalThis.fetch = original; }
});
test('prepare uses refreshed pending state after a confirmed reservation is released', async () => {
  const original = fetch, p = data.pending[0];
  await reset({ ...data, pending: [{ ...p, inputs: ['aa'.repeat(32) + ':0'] }] });
  globalThis.fetch = async url => {
    const path = new URL(String(url)).pathname;
    if (path.includes('/tx/')) return Response.json({ txid: p.txid, confirmations: 6 });
    return Response.json(path.includes('/utxo/') ? path.includes('/zpub') ? [{ txid: 'aa'.repeat(32), vout: 0, value: '100000000', address: vectors.addresses[0], confirmations: 6 }] : [] : { balance: '100000000', transactions: [] });
  };
  try {
    const result = await rpc('prepare', { to: vectors.cases[0].to, amount: '0.1', fee: 50000 });
    assert.equal(result.ok, true, result.error); assert.equal((await passwordVault()).pending.length, 0);
  } finally { globalThis.fetch = original; }
});
test('locking during pending reconciliation cancels the refresh without saving unlocked state', async () => {
  await reset(); const original = fetch;
  let release!: () => void, reached!: () => void;
  const barrier = new Promise<void>(resolve => release = resolve), started = new Promise<void>(resolve => reached = resolve);
  const before = await local.get('pearl.wallet.v1');
  globalThis.fetch = async url => {
    const path = new URL(String(url)).pathname;
    if (path.includes('/tx/')) { reached(); await barrier; return Response.json({ txid: data.pending[0].txid, confirmations: 6 }); }
    return Response.json(path.includes('/utxo/') ? [] : { balance: '0', transactions: [] });
  };
  try {
    const refreshing = rpc('refresh'); await started; await rpc('lock'); release();
    assert.equal((await refreshing).ok, false); assert.deepEqual(await session.get(null), {});
    assert.deepEqual(await local.get('pearl.wallet.v1'), before);
  } finally { release(); globalThis.fetch = original; }
});
test('manual confirmation clears only the matching wallet/network pending entry', async () => {
  const original = fetch, p = data.pending[0];
  await reset({ ...data, pending: [p, { ...p, network: 'testnet' }, { ...p, walletId: 'wallet-b' }] });
  globalThis.fetch = async () => Response.json({ txid: p.txid, confirmations: 6 });
  try {
    const checked = await rpc('check', { txid: p.txid }); assert.equal(checked.ok, true, checked.error);
    assert.equal(checked.data.pending.length, 0); assert.equal((await passwordVault()).pending.length, 2);
  } finally { globalThis.fetch = original; }
});
test('manual checks cannot release reservations using malformed confirmation data', async () => {
  const original = fetch, p = data.pending[0];
  try {
    for (const confirmations of ['6', -1, 1.5, undefined]) {
      await reset(); globalThis.fetch = async () => Response.json({ txid: p.txid, confirmations });
      assert.equal((await rpc('check', { txid: p.txid })).ok, false);
      assert.deepEqual((await passwordVault()).pending, data.pending);
    }
  } finally { globalThis.fetch = original; }
});
