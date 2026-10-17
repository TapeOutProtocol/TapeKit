// Offline unit tests for where the extension opens the hub (hub-link.js, hub-host.js; design §10, 2026-10-16).
// OKX Wallet refuses connect, transaction and chain-switch calls from a popup-type window, and from any tab that
// is not the active tab of the focused normal window (research/manual-test.md). So those requests open the hub
// as a tab next to the site's tab; the no-click notice, chain switches and revokes may use the small notice
// window. Message signatures use a small focused window (2026-10-17): ext-hub-window.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, site, hub, lastOpened, flush, A, B, X, HUB_URL } from './ext-harness.mjs';

const TX = [{ from: X, to: X }];   // a transaction: always a hub tab
const granted = (origins, chainId = '0x38') => ({ perms: Object.fromEntries(origins.map((o) => [o, { accounts: [X], chainId, grantedAt: 5, holder: null, container: null }])), accounts: [X] });

test('a hub tab next to the site tab for no gesture, the first wallet connection and transactions; chain switches use the notice window', async () => {
  const cases = [
    [{ perms: {}, accounts: [X] }, 'eth_requestAccounts', false, 'tab'],    // site dialog
    [null, 'eth_requestAccounts', true, 'tab'],                             // one-time wallet connection
    [granted([A]), 'eth_sendTransaction', false, 'tab'],                    // the card, then the wallet
    [granted([A]), 'wallet_switchEthereumChain', false, 'window'],          // TapeKit's own record only
  ];
  for (const [snapshot, method, gesture, how] of cases) {
    const { chrome } = setup({ snapshot });
    chrome.tabs.ensure({ id: 6, windowId: 1 });
    site(chrome, { tabId: 7 }).ask(1, method, method === 'eth_sendTransaction' ? TX : [], gesture);
    await flush();
    const opened = lastOpened(chrome);
    assert.equal(opened.how, how, method);
    if (how === 'window') continue;
    assert.deepEqual(opened.opts, { url: HUB_URL, active: true, windowId: 1, index: 2, openerTabId: 7 }, method);
    assert.deepEqual(chrome.log.updated.at(-1), { id: 1, focused: true }, 'its window is the focused one');
    const h = hub(chrome, opened);
    await flush();
    assert.deepEqual(h.got[0], { type: 'hello', managed: true, popup: false });
  }
});

test('a site tab outside a normal window: the hub tab goes to the last focused normal window, or a new normal window', async () => {
  const { chrome } = setup({ snapshot: granted([A]) });
  const pop = await chrome.windows.create({ type: 'popup', url: A + '/', focused: true });
  chrome.log.opened.length = 0;
  site(chrome, { tabId: pop.tabs[0].id, windowId: pop.id }).ask(1, 'eth_sendTransaction', TX);
  await flush();
  assert.deepEqual(lastOpened(chrome).opts, { url: HUB_URL, active: true, windowId: 1 });
  const lone = setup({ snapshot: granted([A]) });
  await lone.chrome.windows.remove(1);
  const w = await lone.chrome.windows.create({ type: 'popup', url: A + '/', focused: true });
  lone.chrome.log.opened.length = 0;
  site(lone.chrome, { tabId: w.tabs[0].id, windowId: w.id }).ask(1, 'eth_sendTransaction', TX);
  await flush();
  assert.deepEqual(lastOpened(lone.chrome).opts, { type: 'normal', url: HUB_URL, focused: true });
});

test('a request that needs a tab never goes to the notice window; an open hub tab takes later requests and comes to the front', async () => {
  const { chrome } = setup({ snapshot: granted([A]) });
  const a = site(chrome);
  a.ask(1, 'wallet_switchEthereumChain', [{ chainId: '0xc4' }]);
  await flush();
  const notice = hub(chrome, lastOpened(chrome));
  await flush();
  a.ask(2, 'eth_sendTransaction', TX);
  await flush();
  assert.deepEqual(chrome.log.opened.map((o) => o.how), ['window', 'tab']);
  assert.deepEqual(notice.requests().map((r) => r.method), ['wallet_switchEthereumChain']);
  const tab = hub(chrome, lastOpened(chrome));
  await flush();
  assert.deepEqual(tab.requests().map((r) => r.method), ['eth_sendTransaction']);
  notice.answer(notice.requests()[0].id, null);
  tab.answer(tab.requests()[0].id, '0xsig');   // at most 4 waiting per site
  a.ask(3, 'wallet_switchEthereumChain', [{ chainId: '0x38' }]);   // the hub tab is in front: it takes this too
  await flush();
  await chrome.tabs.update(7, { active: true });   // the user goes back to the site
  a.ask(4, 'wallet_switchEthereumChain', [{ chainId: '0xc4' }]);   // no tab needed: the notice window
  a.ask(5, 'eth_signTypedData_v4', [X, '{}']);   // a message signature reuses the open hub tab (no second hub)
  await flush();
  assert.equal(chrome.log.opened.length, 2, 'no new host');
  assert.deepEqual(tab.requests().map((r) => r.method), ['eth_sendTransaction', 'wallet_switchEthereumChain', 'eth_signTypedData_v4']);
  assert.deepEqual(notice.requests().map((r) => r.method), ['wallet_switchEthereumChain', 'wallet_switchEthereumChain']);
  assert.ok(chrome.tabs.all().find((t) => t.id === lastOpened(chrome).tabId).active, 'the signature brought the hub tab back');
  tab.send({ type: 'focus' });
  await flush();
  assert.deepEqual(chrome.log.updated.at(-1), { id: 1, focused: true });
});

test('a notice goes to the hub tab only while that tab is the one shown; otherwise to the notice window', async () => {
  const { chrome } = setup({ snapshot: granted([A]) });
  const a = site(chrome, { tabId: 7 });
  const b = site(chrome, { origin: B, tabId: 9 });
  a.ask(1, 'eth_sendTransaction', TX);
  await flush();
  const tab = hub(chrome, lastOpened(chrome));
  await flush();
  b.ask(1, 'eth_requestAccounts', [], true);   // the user is on the hub tab: the notice shows there
  await flush();
  assert.deepEqual(chrome.log.opened.map((o) => o.how), ['tab']);
  assert.deepEqual(tab.requests().map((r) => r.origin), [A, B]);
  await chrome.tabs.update(9, { active: true });   // the user went back to a site
  b.ask(2, 'eth_requestAccounts', [], true);
  await flush();
  assert.deepEqual(chrome.log.opened.map((o) => o.how), ['tab', 'window']);
  assert.equal(tab.requests().length, 2);
});

test('safety net: the notice window\'s hub needs the wallet after all (needs-tab): the request moves to a hub tab, once', async () => {
  const { chrome } = setup({ snapshot: { perms: {}, accounts: [X] } });   // the snapshot says the wallet is connected
  const a = site(chrome);
  a.ask('c1', 'eth_requestAccounts', [], true);
  await flush();
  const notice = hub(chrome, lastOpened(chrome));
  await flush();
  const tabError = { code: 4900, message: 'tab', data: { reason: 'needs-tab', messages: { zh: 'z', en: 'e' } } };
  notice.fail(notice.requests()[0].id, tabError);
  await flush();
  assert.equal(a.reply('c1'), null, 'not delivered: it moves');
  assert.deepEqual(chrome.log.opened.map((o) => o.how), ['window', 'tab']);
  assert.deepEqual(lastOpened(chrome).opts, { url: HUB_URL, active: true, windowId: 1, index: 1, openerTabId: 7 });
  const tab = hub(chrome, lastOpened(chrome));
  await flush();
  const [moved] = tab.requests();
  assert.deepEqual({ method: moved.method, gesture: moved.gesture, origin: moved.origin }, { method: 'eth_requestAccounts', gesture: true, origin: A });
  tab.fail(moved.id, tabError);   // never twice: the error goes to the site
  await flush();
  assert.equal(a.reply('c1').error.data.reason, 'needs-tab');
  assert.equal(chrome.log.opened.length, 2);
});

test('an idle hub tab closes; if the user is still on it, the site tab is shown again first', async () => {
  for (const userLeft of [false, true]) {
    const { chrome } = setup({ snapshot: granted([A]) });
    const a = site(chrome, { tabId: 7 });
    a.ask(1, 'eth_sendTransaction', TX);
    await flush();
    const opened = lastOpened(chrome);
    const h = hub(chrome, opened);
    await flush();
    h.answer(h.requests()[0].id, '0xsig');
    await flush();
    if (userLeft) await chrome.tabs.update(chrome.tabs.ensure({ id: 8, windowId: 1, active: false }).id, { active: true });
    chrome.log.tabsUpdated.length = 0;
    h.send({ type: 'close' });
    await flush();
    assert.deepEqual(chrome.log.tabsRemoved, [opened.tabId]);
    assert.deepEqual(chrome.log.tabsUpdated, userLeft ? [] : [{ id: 7, active: true }]);
    assert.equal(chrome.tabs.all().find((t) => t.active && t.windowId === 1).id, userLeft ? 8 : 7);
    assert.equal(a.reply(1).result, '0xsig');
  }
});

test('a hub tab the user took to another page is no longer a host: the next request opens a new tab, not that page', async () => {
  const { chrome } = setup({ snapshot: granted([A]) });
  const a = site(chrome, { tabId: 7 });
  a.ask(1, 'eth_sendTransaction', TX);
  await flush();
  const first = lastOpened(chrome);
  const h = hub(chrome, first);
  await flush();
  await chrome.tabs.update(first.tabId, { url: 'https://example.com/' });   // typed into the hub tab's address bar
  h.remote.disconnect();                                                    // the hub page unloads
  await flush();
  assert.equal(a.reply(1).error.code, 4001);
  a.ask(2, 'eth_sendTransaction', TX);
  await flush();
  assert.deepEqual(chrome.log.opened.map((o) => o.how), ['tab', 'tab'], 'a new hub tab');
  const h2 = hub(chrome, lastOpened(chrome));
  await flush();
  assert.deepEqual(h2.requests().map((r) => r.method), ['eth_sendTransaction']);
  h2.answer(h2.requests()[0].id, '0xsig');
  h2.send({ type: 'close' });
  await flush();
  assert.equal(a.reply(2).result, '0xsig');
  assert.deepEqual(chrome.log.tabsRemoved, [lastOpened(chrome).tabId], 'the other page stays open');
});

test('a hub tab taken to another page before it was ready is not closed by the ready timeout', async () => {
  const { chrome, timers } = setup({ snapshot: granted([A]) });
  const a = site(chrome);
  a.ask(1, 'eth_sendTransaction', TX);
  await flush();
  await chrome.tabs.update(lastOpened(chrome).tabId, { url: 'https://example.com/' });
  timers.fireAll();
  await flush();
  assert.equal(a.reply(1).error.data.reason, 'load');
  assert.deepEqual(chrome.log.tabsRemoved, []);
});

test('a hub tab dragged to another window lives on when its first window closes', async () => {
  const { chrome } = setup({ snapshot: granted([A]) });
  const pop = await chrome.windows.create({ type: 'popup', url: A + '/', focused: true });   // the site lives on
  const a = site(chrome, { tabId: pop.tabs[0].id, windowId: pop.id });
  a.ask(1, 'eth_sendTransaction', TX);
  await flush();
  const opened = lastOpened(chrome);
  assert.equal(opened.windowId, 1);
  const h = hub(chrome, opened);
  await flush();
  const other = await chrome.windows.create({ type: 'normal', url: 'https://example.com/', focused: true });
  await chrome.tabs.move(opened.tabId, { windowId: other.id });
  await chrome.windows.remove(1);
  await flush();
  assert.equal(a.reply(1), null, 'still with the hub');
  h.answer(h.requests()[0].id, '0xsig');
  await flush();
  assert.equal(a.reply(1).result, '0xsig');
});
