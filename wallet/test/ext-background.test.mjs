// Offline unit tests for wallet/extension/background.js and hub-link.js (design §10.1): who counts as a site,
// local answers, reads, opening the hub (focused or not), events, snapshots and the popup's revoke.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, site, hub, lastWindow, flush, A, B, X, HUB_URL, EXT_ID } from './ext-harness.mjs';
import { SNAPSHOT_KEY } from '../extension/snapshot.js';
import { HUB_KEY } from '../extension/hub-link.js';
import { REVOKE_MESSAGE, EVENT_MESSAGE } from '../src/ext-protocol.js';

const Y = '0x' + 'bb'.repeat(20);
const granted = (origins, chainId = '0x38') => ({ perms: Object.fromEntries(origins.map((o) => [o, { accounts: [X], chainId, grantedAt: 5, holder: null, container: null }])), accounts: [X] });

test('only a top-frame page of a gateway site of the configured gateway is served (identity from MessageSender)', async () => {
  const { chrome } = setup();
  const cases = [
    { frameId: 3 },                                         // a frame
    { origin: 'https://evil.com', url: 'https://evil.com/' },
    { origin: 'https://4246-0.tapekit.org.evil.com', url: 'https://4246-0.tapekit.org.evil.com/' },
    { origin: 'https://tapekit.org', url: 'https://tapekit.org/' },   // the root
    { origin: 'https://4246-0.tapekit.org:8443', url: 'https://4246-0.tapekit.org:8443/' },   // another port
    { url: A + '/.tape/status' },                           // a gateway status page
    { documentId: null },
  ];
  for (const c of cases) {
    const s = site(chrome, c);
    s.ask(1, 'eth_chainId');
    await flush();
    assert.equal(s.reply(1).error.code, 4100, JSON.stringify(c));
  }
  const ok = site(chrome);
  ok.remote.postMessage({ type: 'request', id: 2, method: 'eth_chainId', params: [], origin: B, gesture: true });
  await flush();
  assert.equal(ok.reply(2).result, '0x38');   // A's chain: the message's own "origin" is ignored
  assert.equal(chrome.log.created.length, 0);
});

test('routing switched off, or switched on for another gateway, serves nothing', async () => {
  const off = setup({ routing: false });
  const s = site(off.chrome);
  s.ask(1, 'eth_accounts');
  await flush();
  assert.equal(s.reply(1).error.code, 4100);
  const moved = setup();
  await moved.chrome.storage.sync.set({ gateway: 'other.org' });
  const t = site(moved.chrome);
  t.ask(1, 'eth_accounts');
  await flush();
  assert.equal(t.reply(1).error.code, 4100);
});

test('local answers come from the hub snapshot: per-site chain and granted accounts, no window', async () => {
  const snap = granted([A], '0xc4');
  const { chrome } = setup({ snapshot: snap });
  const a = site(chrome);
  const b = site(chrome, { origin: B });
  a.ask(1, 'eth_chainId'); a.ask(2, 'eth_accounts'); a.ask(3, 'net_version'); a.ask(4, 'wallet_getPermissions');
  b.ask(1, 'eth_chainId'); b.ask(2, 'eth_accounts');
  await flush();
  assert.equal(a.reply(1).result, '0xc4');
  assert.deepEqual(a.reply(2).result, [X]);
  assert.equal(a.reply(3).result, '196');
  assert.equal(a.reply(4).result[0].invoker, A);
  assert.equal(b.reply(1).result, '0xc4');      // B's home chain is X Layer (area 2)
  assert.deepEqual(b.reply(2).result, []);      // A's grant is not B's
  assert.equal(chrome.log.created.length, 0);
});

test('a snapshot written for another gateway is not used', async () => {
  const { chrome } = setup({ snapshot: granted([A]) });
  const stored = (await chrome.storage.local.get(SNAPSHOT_KEY))[SNAPSHOT_KEY];
  await chrome.storage.local.set({ [SNAPSHOT_KEY]: { ...stored, hub: 'https://other.org' } });
  const a = site(chrome);
  a.ask(1, 'eth_accounts');
  await flush();
  assert.deepEqual(a.reply(1).result, []);
});

test('unknown methods 4200, oversized params -32602, reads go to a public node of the site\'s chain', async () => {
  const { chrome, fetched } = setup({ snapshot: granted([A], '0x2105') });
  const a = site(chrome);
  a.ask(1, 'eth_sign', [X, '0x00']);
  a.ask(2, 'personal_sign', ['0x' + '00'.repeat(140_000), X]);
  a.ask(3, 'eth_blockNumber');
  await flush();
  assert.equal(a.reply(1).error.code, 4200);
  assert.equal(a.reply(2).error.code, -32602);
  assert.equal(a.reply(3).result, '0xread');
  assert.equal(fetched.length, 1);
  assert.match(fetched[0].url, /base/i);   // Base node: the site's current chain
  assert.equal(chrome.log.created.length, 0);
});

test('a connect with a gesture, wallet already connected: unfocused hub window, sent once the hub is ready', async () => {
  const { chrome } = setup({ snapshot: { perms: {}, accounts: [X] } });
  const a = site(chrome);
  a.ask('c1', 'eth_requestAccounts', [], true);
  await flush();
  assert.equal(chrome.log.created.length, 1);
  assert.deepEqual(chrome.log.created[0], { type: 'popup', width: 400, height: 640, url: HUB_URL, focused: false });
  const h = hub(chrome, { windowId: lastWindow(chrome) });
  await flush();
  assert.deepEqual(h.got[0], { type: 'hello', managed: true });
  const [req] = h.requests();
  assert.deepEqual({ ...req, id: undefined }, { type: 'request', id: undefined, origin: A, method: 'eth_requestAccounts', params: [], gesture: true });
  h.answer(req.id, [X]);
  await flush();
  assert.deepEqual(a.reply('c1').result, [X]);
  assert.deepEqual((await chrome.storage.session.get('tapekit-wallet:pending:v1'))['tapekit-wallet:pending:v1'], {});
});

test('focus: no gesture, first wallet connection and signing open focused; chain switches do not', async () => {
  const cases = [
    [{ perms: {}, accounts: [X] }, 'eth_requestAccounts', false, true],    // site dialog
    [null, 'eth_requestAccounts', true, true],                             // one-time wallet connection
    [granted([A]), 'personal_sign', false, true],                          // the card
    [granted([A]), 'wallet_switchEthereumChain', false, false],
  ];
  for (const [snapshot, method, gesture, focused] of cases) {
    const { chrome } = setup({ snapshot });
    site(chrome).ask(1, method, method === 'personal_sign' ? ['0x00', X] : [], gesture);
    await flush();
    assert.equal(chrome.log.created[0].focused, focused, method);
  }
});

test('a connected site\'s connect is answered from the snapshot: no window, with or without a gesture', async () => {
  const { chrome } = setup({ snapshot: granted([A]) });
  const a = site(chrome);
  a.ask(1, 'eth_requestAccounts', [], false);
  a.ask(2, 'eth_requestAccounts', [], true);
  a.ask(3, 'wallet_requestPermissions', [{ eth_accounts: {} }]);
  a.ask(4, 'wallet_requestPermissions', [{ eth_accounts: {}, other: {} }]);
  await flush();
  assert.deepEqual(a.reply(1).result, [X]);
  assert.deepEqual(a.reply(2).result, [X]);
  assert.deepEqual(a.reply(3).result, [{ parentCapability: 'eth_accounts', invoker: A, caveats: [{ type: 'restrictReturnedAccounts', value: [X] }], date: 5 }]);
  assert.equal(a.reply(4).error.code, -32602);
  assert.equal(chrome.log.created.length, 0);
});

test('a connect without a visible grant still goes to the hub: another site, or the wallet now on another account', async () => {
  for (const [snapshot, origin] of [[granted([A]), B], [{ ...granted([A]), accounts: [Y] }, A]]) {
    const { chrome } = setup({ snapshot });
    const s = site(chrome, { origin });
    s.ask(1, 'eth_requestAccounts', [], true);
    await flush();
    assert.equal(chrome.log.created.length, 1, origin);
    assert.equal(s.reply(1), null);
  }
});

test('a second request reuses the open window; a focus request from the hub focuses it', async () => {
  const { chrome } = setup({ snapshot: granted([A]) });
  const a = site(chrome);
  a.ask(1, 'wallet_switchEthereumChain', [{ chainId: '0xc4' }]);
  await flush();
  const h = hub(chrome, { windowId: lastWindow(chrome) });
  await flush();
  a.ask(2, 'personal_sign', ['0x00', X]);
  await flush();
  assert.equal(chrome.log.created.length, 1);
  assert.deepEqual(chrome.log.updated.at(-1), { id: lastWindow(chrome), focused: true });   // signing needs the user
  assert.equal(h.requests().length, 2);
  h.send({ type: 'focus' });
  await flush();
  assert.equal(chrome.log.updated.length, 2);
});

test('the hub answers only through the window this worker opened; other hub pages give events and snapshots only', async () => {
  const { chrome } = setup({ snapshot: granted([A]) });
  const a = site(chrome);
  a.ask(1, 'wallet_switchEthereumChain', [{ chainId: '0xc4' }]);
  await flush();
  const tab = hub(chrome, { windowId: 999 });   // a hub tab the user opened
  await flush();
  assert.deepEqual(tab.got, [{ type: 'hello', managed: false }]);
  tab.answer('a-1', null);
  await flush();
  assert.equal(a.reply(1), null);
  const fake = hub(chrome, { windowId: lastWindow(chrome), origin: A, url: A + '/.tape/wallet/' });   // not the root
  await flush();
  assert.deepEqual(fake.got, []);
  tab.send({ type: 'snapshot', perms: {}, accounts: [] });
  await flush();
  assert.deepEqual((await chrome.storage.local.get(SNAPSHOT_KEY))[SNAPSHOT_KEY].perms, {});
});

test('the snapshot is cleaned: only this gateway\'s sites, valid accounts; never written for a site page', async () => {
  const { chrome } = setup();
  const s = site(chrome);
  s.remote.postMessage({ type: 'snapshot', perms: { [A]: { accounts: [X], chainId: '0x38' } }, accounts: [X] });
  await flush();
  assert.equal((await chrome.storage.local.get(SNAPSHOT_KEY))[SNAPSHOT_KEY], undefined);
  const h = hub(chrome, { windowId: 5 });
  h.send({ type: 'snapshot', accounts: [X, 'nope'], perms: {
    [A]: { accounts: [X.toUpperCase().replace('0X', '0x')], chainId: '0x2105', grantedAt: 9 },
    'https://4246-0.tapekit.org.evil.com': { accounts: [X], chainId: '0x38' },
    [B]: { accounts: ['bad'], chainId: '0x1' },
  } });
  await flush();
  const snap = (await chrome.storage.local.get(SNAPSHOT_KEY))[SNAPSHOT_KEY];
  assert.deepEqual(Object.keys(snap.perms), [A]);
  assert.deepEqual(snap.perms[A].accounts, [X]);
  assert.equal(snap.perms[A].chainId, '0x2105');
  assert.deepEqual(snap.accounts, [X]);
  assert.equal(snap.hub, 'https://tapekit.org');
});

test('one hub port is handled in order: a snapshot sent before an answer is stored before the site gets the answer', async () => {
  const { chrome } = setup({ snapshot: { perms: {}, accounts: [X] } });
  const a = site(chrome);
  a.ask('c1', 'eth_requestAccounts', [], true);
  await flush();
  const h = hub(chrome, { windowId: lastWindow(chrome) });
  await flush();
  const [req] = h.requests();
  const realSet = chrome.storage.local.set;
  let release = null;
  const gate = new Promise((r) => { release = r; });
  chrome.storage.local.set = async (items) => { await gate; return realSet(items); };   // a slow write
  h.send({ type: 'snapshot', perms: granted([A]).perms, accounts: [X] });
  h.answer(req.id, [X]);
  await flush();
  assert.equal(a.reply('c1'), null);   // the answer waits for the snapshot before it
  release();
  await flush();
  assert.deepEqual(a.reply('c1').result, [X]);
  a.ask(2, 'eth_accounts');
  await flush();
  assert.deepEqual(a.reply(2).result, [X]);
});

test('router events go only to the tabs of that origin', async () => {
  const { chrome } = setup();
  chrome.tabs.list = [{ id: 1, url: A + '/page' }, { id: 2, url: B + '/' }, { id: 3, url: A + '.evil.com/' }];
  const h = hub(chrome, { windowId: 5 });
  h.send({ type: 'event', origin: A, event: 'accountsChanged', data: [] });
  h.send({ type: 'event', origin: 'https://evil.com', event: 'accountsChanged', data: [] });
  await flush();
  assert.deepEqual(chrome.log.sentToTabs, [{ tabId: 1, msg: { type: EVENT_MESSAGE, origin: A, event: 'accountsChanged', data: [] }, opts: { frameId: 0 } }]);
});

test('the popup\'s revoke goes to the hub (no focus); only the extension\'s own popup page may ask', async () => {
  const { chrome } = setup({ snapshot: granted([A]) });
  const answers = [];
  const ask = (sender) => chrome.runtime.onMessage.fire({ type: REVOKE_MESSAGE, origin: A }, sender, (r) => answers.push(r));
  const results = ask({ id: EXT_ID, url: A + '/', tab: { id: 1 } });           // a content script
  assert.deepEqual(results, [false]);
  ask({ id: EXT_ID, url: `chrome-extension://${EXT_ID}/popup/popup.html` });
  await flush();
  assert.equal(chrome.log.created.length, 1);
  assert.equal(chrome.log.created[0].focused, false);
  const h = hub(chrome, { windowId: lastWindow(chrome) });
  await flush();
  assert.deepEqual(h.requests().map((r) => ({ type: r.type, origin: r.origin })), [{ type: 'revoke', origin: A }]);
  assert.deepEqual(answers, [{ ok: true }]);
});

test('at most 4 requests per site wait for the hub (-32005)', async () => {
  const { chrome } = setup({ snapshot: granted([A]) });
  const a = site(chrome);
  for (let i = 1; i <= 5; i++) a.ask(i, 'personal_sign', ['0x00', X]);
  await flush(20);
  assert.equal(a.reply(5).error.code, -32005);
  assert.equal(a.reply(4), null);
});

test('the hub asks to close when idle: the window closes, unless something is still waiting for it', async () => {
  const { chrome } = setup({ snapshot: granted([A]) });
  const a = site(chrome);
  a.ask(1, 'wallet_switchEthereumChain', [{ chainId: '0xc4' }]);
  await flush();
  const id = lastWindow(chrome);
  const h = hub(chrome, { windowId: id });
  await flush();
  h.send({ type: 'close' });   // crossed with request 1: keep the window
  await flush();
  assert.deepEqual(chrome.log.removed, []);
  h.answer(h.requests()[0].id, null);
  await flush();
  h.send({ type: 'close' });
  await flush();
  assert.deepEqual(chrome.log.removed, [id]);
  assert.equal((await chrome.storage.session.get(HUB_KEY))[HUB_KEY], undefined);
});

test('local storage is restricted to trusted contexts at start-up', async () => {
  const { chrome } = setup();
  await flush();
  assert.equal(chrome.storage.local.accessLevel, 'TRUSTED_CONTEXTS');
});
