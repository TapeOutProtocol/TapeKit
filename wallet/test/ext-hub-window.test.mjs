// Offline unit tests for message signatures in the extension channel (decision D-i, design §10.3, 2026-10-17).
// OKX Wallet's focus rule lets a plain personal_sign and eth_signTypedData_v4 through from a popup-type window
// (research/manual-test.md), so these open the hub in the small window (focused: the card needs the user) instead
// of switching the user to a new tab. Typed data on another chain needs a chain switch, which OKX fakes there:
// the window's hub answers 'needs-tab' and the request moves to a hub tab, once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, site, hub, lastOpened, flush, A, X, HUB_URL } from './ext-harness.mjs';
import { hubPlace, needsTab } from '../extension/snapshot.js';

const granted = (origins) => ({ perms: Object.fromEntries(origins.map((o) => [o, { accounts: [X], chainId: '0x38', grantedAt: 5, holder: null, container: null }])), accounts: [X] });
const SIGN = ['0x00', X];
const TYPED = [X, JSON.stringify({ domain: { chainId: 56 } })];
const tabError = { code: 4900, message: 'tab', data: { reason: 'needs-tab', messages: { zh: 'z', en: 'e' } } };

test('hubPlace: message signatures in the small window, transactions and wallet connections in a tab, the rest in the notice window', () => {
  const connected = granted([A]);
  assert.equal(hubPlace('personal_sign', false, connected, A), 'window');
  assert.equal(hubPlace('eth_signTypedData_v4', true, null, A), 'window');
  assert.equal(hubPlace('eth_sendTransaction', false, connected, A), 'tab');
  assert.equal(hubPlace('eth_requestAccounts', true, null, A), 'tab');
  assert.equal(hubPlace('eth_requestAccounts', false, { perms: {}, accounts: [X] }, A), 'tab');
  assert.equal(hubPlace('eth_requestAccounts', true, { perms: {}, accounts: [X] }, A), 'notice');
  assert.equal(hubPlace('wallet_switchEthereumChain', false, connected, A), 'notice');
  assert.equal(hubPlace('wallet_revokePermissions', false, connected, A), 'notice');
  for (const m of ['personal_sign', 'eth_signTypedData_v4', 'eth_sendTransaction', 'eth_requestAccounts', 'wallet_switchEthereumChain']) {
    assert.equal(needsTab(m, false, connected, A), hubPlace(m, false, connected, A) === 'tab', m);
  }
});

test('personal_sign and typed data open the hub in the small window, focused, the old 400×640 size; the hub is told it is a popup', async () => {
  for (const [method, params] of [['personal_sign', SIGN], ['eth_signTypedData_v4', TYPED]]) {
    const { chrome } = setup({ snapshot: granted([A]) });
    site(chrome, { tabId: 7 }).ask(1, method, params);
    await flush();
    const opened = lastOpened(chrome);
    assert.equal(opened.how, 'window', method);
    assert.deepEqual(opened.opts, { type: 'popup', width: 400, height: 640, url: HUB_URL, focused: true }, method);
    const h = hub(chrome, opened);
    await flush();
    assert.deepEqual(h.got[0], { type: 'hello', managed: true, popup: true });
    assert.deepEqual(h.requests().map((r) => r.method), [method]);
  }
});

test('the sign window closes when done, and the site gets the signature', async () => {
  const { chrome } = setup({ snapshot: granted([A]) });
  const a = site(chrome);
  a.ask(1, 'personal_sign', SIGN);
  await flush();
  const opened = lastOpened(chrome);
  const h = hub(chrome, opened);
  await flush();
  h.answer(h.requests()[0].id, '0xsig');
  h.send({ type: 'close' });
  await flush();
  assert.equal(a.reply(1).result, '0xsig');
  assert.deepEqual(chrome.log.removed, [opened.windowId]);
  assert.deepEqual(chrome.log.tabsRemoved, []);
});

test('an open hub tab takes a message signature and comes to the front: never a second hub', async () => {
  const { chrome } = setup({ snapshot: granted([A]) });
  const a = site(chrome, { tabId: 7 });
  a.ask(1, 'eth_sendTransaction', [{ from: X, to: X }]);
  await flush();
  const tab = hub(chrome, lastOpened(chrome));
  await flush();
  await chrome.tabs.update(7, { active: true });   // the user went back to the site
  a.ask(2, 'personal_sign', SIGN);
  await flush();
  assert.deepEqual(chrome.log.opened.map((o) => o.how), ['tab']);
  assert.deepEqual(tab.requests().map((r) => r.method), ['eth_sendTransaction', 'personal_sign']);
  assert.ok(chrome.tabs.all().find((t) => t.id === lastOpened(chrome).tabId).active);
});

test('the open small window takes a message signature too (the notice window and the sign window are one host)', async () => {
  const { chrome } = setup({ snapshot: granted([A]) });
  const a = site(chrome);
  a.ask(1, 'wallet_switchEthereumChain', [{ chainId: '0xc4' }]);
  await flush();
  const win = hub(chrome, lastOpened(chrome));
  await flush();
  a.ask(2, 'personal_sign', SIGN);
  await flush();
  assert.deepEqual(chrome.log.opened.map((o) => o.how), ['window']);
  assert.deepEqual(win.requests().map((r) => r.method), ['wallet_switchEthereumChain', 'personal_sign']);
  win.send({ type: 'focus' });   // the hub shows the card: the window gets focus
  await flush();
  assert.deepEqual(chrome.log.updated.at(-1), { id: lastOpened(chrome).windowId, focused: true });
});

test('typed data on another chain: the window\'s hub answers needs-tab, the request moves to a hub tab once, the window closes', async () => {
  const { chrome } = setup({ snapshot: granted([A]) });
  const a = site(chrome, { tabId: 7 });
  a.ask('t1', 'eth_signTypedData_v4', TYPED);
  await flush();
  const opened = lastOpened(chrome);
  const win = hub(chrome, opened);
  await flush();
  win.fail(win.requests()[0].id, tabError);
  await flush();
  assert.equal(a.reply('t1'), null, 'not delivered: it moves');
  assert.deepEqual(chrome.log.opened.map((o) => o.how), ['window', 'tab']);
  assert.deepEqual(lastOpened(chrome).opts, { url: HUB_URL, active: true, windowId: 1, index: 1, openerTabId: 7 });
  const tab = hub(chrome, lastOpened(chrome));
  await flush();
  assert.deepEqual(tab.got[0], { type: 'hello', managed: true, popup: false });
  const [moved] = tab.requests();
  assert.deepEqual({ method: moved.method, params: moved.params, origin: moved.origin }, { method: 'eth_signTypedData_v4', params: TYPED, origin: A });
  win.send({ type: 'close' });
  await flush();
  assert.deepEqual(chrome.log.removed, [opened.windowId], 'the window has nothing left: it closes');
  tab.fail(moved.id, tabError);   // never twice: the error goes to the site
  await flush();
  assert.equal(a.reply('t1').error.data.reason, 'needs-tab');
  assert.equal(chrome.log.opened.length, 2);
});
