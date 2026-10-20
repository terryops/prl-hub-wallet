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
    assert.equal(sent.ok, true); assert.equal(sent.data.outcome, 'unknown'); assert.equal(broadcasts, 2, 'one to each mainnet indexer');
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
    assert.equal((await rpc('refresh')).data.pending.length, 0); assert.equal(checks, 2, 'both indexers are asked');
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
test('retrying a transaction that was already mined reports it submitted, not rejected', async () => {
  const original = fetch, p = data.pending[0];
  try {
    for (const [lookup, expected] of [['mined', 'submitted'], ['missing', 'rejected'], ['offline', 'unknown']] as const) {
      await reset({ ...data, pending: [{ ...p, inputs: ['aa'.repeat(32) + ':0'] }] });
      globalThis.fetch = async url => {
        const path = new URL(String(url)).pathname;
        if (path.includes('/sendtx/')) return Response.json({ error: 'bad-txns-inputs-missingorspent' }, { status: 400 });
        if (path.includes('/tx/')) {
          if (lookup === 'offline') throw new Error('offline');
          return lookup === 'mined' ? Response.json({ txid: p.txid, confirmations: 1 }) : Response.json({ error: 'Transaction not found' }, { status: 404 });
        }
        throw new Error('unexpected request ' + path);
      };
      const retry = await rpc('retry', { txid: p.txid, password });
      assert.equal(retry.ok, true, retry.error); assert.equal(retry.data.pending[0].status, expected, lookup);
    }
  } finally { globalThis.fetch = original; }
});
test('a first-page refresh keeps history pages loaded with load-more unless it would leave a gap', async () => {
  await reset({ ...data, pending: [] }); const original = fetch;
  const tx = (n: number, confirmations = 3) => ({ txid: n.toString(16).padStart(64, '0'), blockTime: 1000 + n, confirmations });
  let pages: ReturnType<typeof tx>[][] = [[tx(30, 0), tx(29), tx(28)], [tx(20), tx(19)]];
  globalThis.fetch = async url => {
    const u = new URL(String(url));
    if (u.pathname.includes('/utxo/')) return Response.json([]);
    if (u.pathname.includes('/address/') || u.searchParams.get('filter') === 'inputs') return Response.json({ balance: '0', transactions: [], totalPages: 1 });
    const page = Number(u.searchParams.get('page'));
    return Response.json({ balance: '0', page, totalPages: pages.length, transactions: pages[page - 1] || [] });
  };
  const ids = (r: any) => r.data.snapshot.history.map((h: any) => parseInt(h.txid, 16));
  try {
    assert.deepEqual(ids(await rpc('refresh')), [30, 29, 28]);
    const more = await rpc('refresh', { page: 2 });
    assert.deepEqual(ids(more), [30, 29, 28, 20, 19]); assert.equal(more.data.snapshot.hasMore, false);
    // The unconfirmed transaction left the mempool and a new one arrived.
    pages = [[tx(31), tx(29), tx(28)], [tx(20), tx(19)]];
    const kept = await rpc('refresh');
    assert.deepEqual(ids(kept), [31, 29, 28, 20, 19]); assert.equal(kept.data.snapshot.page, 2); assert.equal(kept.data.snapshot.hasMore, false);
    // A whole new first page: older pages may now hide unseen transactions, so start over.
    pages = [[tx(42), tx(41), tx(40)], [tx(39), tx(31)], [tx(29), tx(28)]];
    const reset1 = await rpc('refresh');
    assert.deepEqual(ids(reset1), [42, 41, 40]); assert.equal(reset1.data.snapshot.page, 1); assert.equal(reset1.data.snapshot.hasMore, true);
  } finally { globalThis.fetch = original; }
});
test('contact sync after sign-in waits for a contact save instead of overwriting it', async () => {
  await reset({ ...data, pending: [] }); await local.remove('wallet.contacts');
  const original = fetch, originalGet = local.get, redirect = 'https://test.chromiumapp.org/account';
  Object.assign(chromeMock, { identity: { getRedirectURL: () => redirect, launchWebAuthFlow: async ({ url }: { url: string }) => redirect + '?code=' + 'C'.repeat(43) + '&state=' + new URL(url).searchParams.get('state') } });
  globalThis.fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith('/exchange')) return Response.json({ user_id: 'u_login-race', device_id: 'd', access_token: 'A'.repeat(43), refresh_token: 'B'.repeat(43), expires_in: 900 });
    if (path.endsWith('/v1/account')) return Response.json({ email: 'race@example.com', pro: true });
    if (path.endsWith('/v1/account/config')) return Response.json(init?.method === 'PUT' ? {} : { schema_version: 1, rev: 0, data: null });
    if (path.endsWith('/logout')) return Response.json({ ok: true });
    throw new Error('unexpected request ' + path);
  };
  // Pause the sync right after it has checked that the local list is unchanged, before it writes.
  let contactReads = 0, paused = false, reached!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => reached = resolve), barrier = new Promise<void>(resolve => release = resolve);
  local.get = async (keys?: string | string[] | null) => {
    if (keys === 'wallet.contacts') contactReads++;
    else if (contactReads === 3 && !paused) { paused = true; reached(); await barrier; }
    return originalGet(keys);
  };
  try {
    const login = rpc('account-login', { importLocal: true });
    await started;
    const save = rpc('contact-save', { name: 'Saved during sync', address: vectors.addresses[2], note: '' });
    await new Promise(resolve => setTimeout(resolve, 20)); release();
    assert.equal((await login).ok, true); assert.equal((await save).ok, true);
    const contacts = (await originalGet('wallet.contacts'))['wallet.contacts'] as { name: string }[];
    assert.deepEqual(contacts.map(c => c.name), ['Saved during sync']);
  } finally {
    release(); local.get = originalGet;
    await rpc('account-logout'); globalThis.fetch = original;
  }
});
// Real answers of the official indexer (mainnet block 130692), see transactions.test.ts.
const txFixtures = JSON.parse(readFileSync(new URL('./tx-fixtures.json', import.meta.url), 'utf8'));
test('transaction details flag this wallet\'s addresses and tell a missing transaction from a failed lookup', async () => {
  await reset(); const original = fetch, tx = txFixtures.normal;
  const ours = { ...tx, vout: [{ ...tx.vout[0], addresses: [vectors.addresses[0]] }, tx.vout[1]] };
  try {
    globalThis.fetch = async () => Response.json(ours);
    const found = await rpc('tx-detail', { txid: tx.txid });
    assert.equal(found.ok, true, found.error); assert.equal(found.data.found, true);
    assert.deepEqual(found.data.tx.outputs.map((r: any) => r.mine), [true, false]); assert.equal(found.data.tx.net, tx.vout[0].value);
    globalThis.fetch = async () => Response.json({ error: `Transaction '${tx.txid}' not found` }, { status: 400 });
    assert.deepEqual((await rpc('tx-detail', { txid: tx.txid })).data, { found: false });
    globalThis.fetch = async () => { throw new Error('offline'); };
    assert.equal((await rpc('tx-detail', { txid: tx.txid })).ok, false);
    globalThis.fetch = async () => Response.json({ ...tx, txid: 'ee'.repeat(32) });
    assert.equal((await rpc('tx-detail', { txid: tx.txid })).ok, false);
    assert.equal((await rpc('tx-detail', { txid: tx.txid.toUpperCase() })).ok, false);
    assert.equal((await rpc('tx-detail', { txid: tx.txid, expectedNetwork: 'testnet' })).ok, false);
    await rpc('lock'); assert.equal((await rpc('tx-detail', { txid: tx.txid })).ok, false);
  } finally { globalThis.fetch = original; }
});
test('rebroadcast resends the indexer\'s copy of an unconfirmed transaction and reports what the node said', async () => {
  await reset(); const original = fetch, tx = { ...txFixtures.normal, confirmations: 0, blockHeight: -1 };
  const posted: string[] = [];
  const serve = (send: () => Response, lookup: unknown = tx) => (async (url: string, init?: RequestInit) => {
    if (new URL(String(url)).pathname.includes('/sendtx/')) { posted.push(String(init?.body)); return send(); }
    return Response.json(lookup);
  }) as typeof fetch;
  try {
    for (const [reply, expected] of [
      [() => Response.json({ result: tx.txid }), { outcome: 'sent' }],
      [() => Response.json({ error: 'already have transaction ' + tx.txid }, { status: 400 }), { outcome: 'known' }],
      [() => Response.json({ error: '-26: min relay fee not met' }, { status: 400 }), { outcome: 'rejected', reason: '-26: min relay fee not met' }],
      [() => new Response('Too Many Requests', { status: 429 }), { outcome: 'notSent' }],
      [() => new Response('<html>bad gateway</html>', { status: 502 }), { outcome: 'unknown' }],
      [() => { throw new Error('reply lost'); }, { outcome: 'unknown' }],
    ] as const) {
      globalThis.fetch = serve(reply as () => Response);
      const r = await rpc('tx-rebroadcast', { txid: tx.txid });
      assert.equal(r.ok, true, r.error); assert.deepEqual(r.data, expected);
    }
    assert.equal(posted.length, 12, 'each attempt goes to both indexers'); assert.ok(posted.every((body) => body === tx.hex));
    posted.length = 0;
    globalThis.fetch = serve(() => Response.json({ result: tx.txid }), { ...tx, confirmations: 3, blockHeight: 130692 });
    assert.deepEqual((await rpc('tx-rebroadcast', { txid: tx.txid })).data, { outcome: 'known' });
    globalThis.fetch = serve(() => Response.json({ result: tx.txid }), { ...tx, hex: txFixtures.coinbase.hex });
    assert.equal((await rpc('tx-rebroadcast', { txid: tx.txid })).ok, false);
    assert.equal(posted.length, 0, 'never posts a mined transaction or bytes that are another transaction');
  } finally { globalThis.fetch = original; }
});
test('the indexer\'s real not-found answer keeps a manual check inconclusive and makes a spent retry a rejection', async () => {
  const original = fetch, p = data.pending[0], missing = () => Response.json({ error: `Transaction '${p.txid}' not found` }, { status: 400 });
  try {
    await reset();
    globalThis.fetch = async () => missing();
    const checked = await rpc('check', { txid: p.txid });
    assert.equal(checked.ok, true, checked.error); assert.equal(checked.data.pending[0].status, 'unknown');
    await reset({ ...data, pending: [{ ...p, inputs: ['aa'.repeat(32) + ':0'] }] });
    globalThis.fetch = async (url) => new URL(String(url)).pathname.includes('/sendtx/') ? Response.json({ error: 'bad-txns-inputs-missingorspent' }, { status: 400 }) : missing();
    const retried = await rpc('retry', { txid: p.txid, password });
    assert.equal(retried.ok, true, retried.error); assert.equal(retried.data.pending[0].status, 'rejected');
    await reset();
    globalThis.fetch = async () => Response.json({ error: `already have transaction ${p.txid}` }, { status: 400 });
    assert.equal((await rpc('retry', { txid: p.txid, password })).data.pending[0].status, 'submitted', 'the Pearl node already has it');
  } finally { globalThis.fetch = original; }
});
// Two mainnet indexers: Pearl Hub's own (pearlhub.net/node) and the official one.
const perIndexer = (answer: (own: boolean, path: string) => Response | Promise<Response>) => (async (url: string | URL | Request) => {
  const u = new URL(String(url)), own = u.hostname === 'pearlhub.net';
  return answer(own, (own ? u.pathname.replace(/^\/node\//, '/') : u.pathname) + u.search);
}) as typeof fetch;
test('a broadcast is sent when either node takes it, and refused only when every node that saw it refused it', async () => {
  const original = fetch, p = data.pending[0];
  const ok = () => Response.json({ result: p.txid }), refused = () => Response.json({ error: '-26: min relay fee not met' }, { status: 400 });
  const lost = () => { throw new Error('reply lost'); }, limited = () => Response.json({ error: 'rate limited' }, { status: 429 });
  const known = () => Response.json({ error: `already have transaction ${p.txid}` }, { status: 400 });
  try {
    for (const [own, official, expected] of [
      [ok, lost, 'submitted'], [lost, ok, 'submitted'], [known, refused, 'submitted'],
      [refused, refused, 'rejected'], [limited, refused, 'rejected'],
      [refused, lost, 'unknown'], [limited, limited, 'unknown'], [lost, lost, 'unknown'],
    ] as const) {
      await reset();
      globalThis.fetch = perIndexer((isOwn, path) => path.includes('/sendtx/') ? (isOwn ? own : official)() : Response.json({ balance: '0', transactions: [] }));
      const retry = await rpc('retry', { txid: p.txid, password });
      assert.equal(retry.ok, true, retry.error); assert.equal(retry.data.pending[0].status, expected, `${own.name} + ${official.name}`);
    }
  } finally { globalThis.fetch = original; }
});
test('pending checks ask both indexers: the copy furthest along counts, and not found needs both to say so', async () => {
  const original = fetch, p = data.pending[0];
  const tx = (confirmations: number) => () => Response.json({ txid: p.txid, confirmations });
  const missing = () => Response.json({ error: `Transaction '${p.txid}' not found` }, { status: 400 }), down = () => Response.json({ error: 'node unhealthy' }, { status: 503 });
  try {
    for (const [own, official, expected] of [
      // On 2026-10-20 the official indexer kept a mined transaction unconfirmed for hours.
      [tx(3), tx(0), 'confirmed'], [missing, tx(1), 'confirmed'], [tx(0), missing, 'submitted'],
      [missing, missing, 'unknown'], [down, missing, 'error'], [down, down, 'error'],
    ] as const) {
      await reset();
      globalThis.fetch = perIndexer((isOwn, path) => path.includes('/tx/') ? (isOwn ? own : official)() : Response.json({ balance: '0', transactions: [] }));
      const checked = await rpc('check', { txid: p.txid });
      if (expected === 'error') { assert.equal(checked.ok, false); assert.deepEqual((await passwordVault()).pending, data.pending); continue; }
      assert.equal(checked.ok, true, checked.error);
      assert.deepEqual(checked.data.pending.map((x: any) => x.status), expected === 'confirmed' ? [] : [expected]);
    }
  } finally { globalThis.fetch = original; }
});
test('transaction details show the copy furthest along; not found when one index says so and none has it', async () => {
  await reset(); const original = fetch, tx = txFixtures.normal;
  const at = (confirmations: number) => () => Response.json({ ...tx, confirmations });
  const missing = () => Response.json({ error: `Transaction '${tx.txid}' not found` }, { status: 400 }), down = () => Response.json({ error: 'node unhealthy' }, { status: 503 });
  try {
    for (const [own, official, expected] of [[at(2), at(0), 2], [at(1), at(1), 1], [missing, at(4), 4], [down, at(0), 0], [down, missing, 'missing'], [down, down, 'error']] as const) {
      globalThis.fetch = perIndexer((isOwn) => (isOwn ? own : official)());
      const r = await rpc('tx-detail', { txid: tx.txid });
      if (expected === 'error') assert.equal(r.ok, false);
      else if (expected === 'missing') assert.deepEqual(r.data, { found: false });
      else { assert.equal(r.ok, true, r.error); assert.equal(r.data.tx.confirmations, expected); }
    }
  } finally { globalThis.fetch = original; }
});
test('加载更多 reads from the index page 1 came from, and a refresh from another index starts the pages over', async () => {
  await reset({ ...data, pending: [] }); const original = fetch;
  const page = (p: number, from: string) => ({ balance: '0', unconfirmedBalance: '0', page: p, totalPages: 3, transactions: [{ txid: String(p).repeat(64), blockTime: 100 - p, confirmations: 5, vin: [], vout: [{ addresses: [vectors.addresses[0]], value: '1' }] }], tokens: [], from });
  const asked: string[] = [];
  let ownUp = true;
  globalThis.fetch = perIndexer((own, path) => {
    asked.push(own ? 'own' : 'official');
    if (own && !ownUp) return Response.json({ error: 'node unhealthy' }, { status: 503 });
    if (path.includes('/utxo/')) return Response.json([]);
    const p = Number(new URL('https://x' + path).searchParams.get('page') || 1);
    return Response.json(page(p, own ? 'own' : 'official'));
  });
  try {
    const first = await rpc('refresh'); assert.equal(first.ok, true, first.error);
    assert.equal(first.data.snapshot.indexer, 'https://pearlhub.net/node');
    ownUp = false; asked.length = 0;
    // Our index went down after page 1: page 2 doesn't silently continue on the other index.
    assert.equal((await rpc('refresh', { page: 2 })).ok, false); assert.ok(asked.every((x) => x === 'own'));
    ownUp = true;
    assert.equal((await rpc('refresh', { page: 2 })).data.snapshot.history.length, 2);
    // Page 1 from the official index now: the pages loaded from ours are dropped.
    ownUp = false;
    const switched = await rpc('refresh'); assert.equal(switched.ok, true, switched.error);
    assert.equal(switched.data.snapshot.indexer, 'https://blockbook.pearlresearch.ai'); assert.equal(switched.data.snapshot.history.length, 1);
  } finally { globalThis.fetch = original; }
});
