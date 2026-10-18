// Offline unit tests for wallet/extension/front.js through the background (audit 2026-10-18 issue 4): which site
// requests may open TapeKit's card or the wallet in front of the user, and the pause after a Reject.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, site, hub, lastOpened, flush, A, B, X } from './ext-harness.mjs';
import { REJECT_COOLDOWN_MS } from '../extension/front.js';

const msg = '0x' + Buffer.from('hello').toString('hex');
const granted = (origins, accounts = [X]) => ({ perms: Object.fromEntries(origins.map((o) => [o, { accounts: [X], chainId: '0x38', grantedAt: 5, holder: null, container: null }])), accounts });
const reasonOf = (r) => r && r.error && r.error.data && r.error.data.reason;

test('a connected site in a background tab cannot open a signing card without a click: 4100 not-active (zh + en), nothing opens', async () => {
  const { chrome } = setup({ snapshot: granted([A]) });
  const a = site(chrome);                                       // tab 7, window 1
  chrome.tabs.ensure({ id: 8, windowId: 1, active: true });     // the user is on another tab
  a.ask(1, 'personal_sign', [msg, X]);
  a.ask(2, 'eth_sendTransaction', [{ from: X, to: X }]);
  await flush();
  for (const id of [1, 2]) {
    assert.equal(a.reply(id).error.code, 4100);
    assert.equal(reasonOf(a.reply(id)), 'not-active');
    assert.match(a.reply(id).error.data.messages.zh, /标签页/);
  }
  assert.equal(chrome.log.opened.length, 0);
});

test('a site in a normal window the user is not using cannot open the site dialog without a click', async () => {
  const { chrome } = setup({ snapshot: granted([A]) });
  const b = site(chrome, { origin: B, tabId: 9, windowId: 2 });   // active in window 2, but window 1 was focused last
  b.ask(1, 'eth_requestAccounts', []);
  await flush();
  assert.equal(reasonOf(b.reply(1)), 'not-active');
  assert.equal(chrome.log.opened.length, 0);
});

test('the same requests with a click on the site, or from the tab in front, open the hub', async () => {
  const { chrome } = setup({ snapshot: granted([A]) });
  const a = site(chrome);
  chrome.tabs.ensure({ id: 8, windowId: 1, active: true });
  a.ask(1, 'personal_sign', [msg, X], true);                    // a click or key press on the site just now
  await flush();
  assert.equal(chrome.log.opened.length, 1);
  assert.equal(a.reply(1), null, 'waiting for the hub');
  const { chrome: c2 } = setup({ snapshot: granted([A]) });
  const a2 = site(c2);                                          // the active tab of the focused normal window
  a2.ask(1, 'personal_sign', [msg, X]);
  await flush();
  assert.equal(c2.log.opened.length, 1);
});

test('TapeKit\'s own small window having focus does not make the site tab "background"', async () => {
  const { chrome } = setup({ snapshot: granted([A]) });
  const a = site(chrome);
  a.ask(1, 'personal_sign', [msg, X], true);
  await flush();
  const h = hub(chrome, lastOpened(chrome));                    // the focused signing window
  await flush();
  h.answer(h.requests()[0].id, '0xsig');
  await flush();
  a.ask(2, 'personal_sign', [msg, X]);                          // a second signature right after, no new click
  await flush();
  assert.equal(h.requests().length, 2);
});

test('while the hub tab opened for a site is in front, that site may ask again; another background site may not', async () => {
  const { chrome } = setup({ snapshot: granted([A], []) });     // the wallet has no account yet: connects open a tab
  const a = site(chrome);
  const b = site(chrome, { origin: B, tabId: 8 });              // B's tab is behind A's
  chrome.tabs.ensure({ id: 7, windowId: 1, active: true });
  await chrome.tabs.update(7, { active: true });
  a.ask(1, 'eth_requestAccounts', [], true);
  await flush();
  const opened = lastOpened(chrome);
  assert.equal(opened.how, 'tab');
  const h = hub(chrome, opened);                                // the hub tab is now the active tab of window 1
  await flush();
  h.answer(h.requests()[0].id, [X]);
  await flush();
  a.ask(2, 'personal_sign', [msg, X]);                          // e.g. sign-in right after the connect
  b.ask(3, 'personal_sign', [msg, X]);
  await flush();
  assert.equal(h.requests().length, 2, 'A\'s signature goes to the hub tab');
  assert.equal(reasonOf(b.reply(3)), 'not-active');
});

test('the no-click notice window, chain switches and revokes are not held back (no focus is taken)', async () => {
  const { chrome } = setup({ snapshot: granted([A]) });
  const a = site(chrome);
  chrome.tabs.ensure({ id: 8, windowId: 1, active: true });
  a.ask(1, 'wallet_switchEthereumChain', [{ chainId: '0xc4' }]);
  a.ask(2, 'wallet_revokePermissions', [{ eth_accounts: {} }]);
  await flush();
  assert.equal(a.reply(1), null);
  assert.equal(chrome.log.opened.length, 1);
  assert.equal(chrome.log.created[0].focused, false);
});

test('after a Reject, the site\'s next request without a click fails at once (4001 rejected) until a click or the pause ends', async () => {
  let t = 1_000_000;
  const { chrome } = setup({ snapshot: granted([A]), now: () => t });
  const a = site(chrome);
  a.ask(1, 'personal_sign', [msg, X]);
  await flush();
  const h = hub(chrome, lastOpened(chrome));
  await flush();
  h.fail(h.requests()[0].id, { code: 4001, message: 'User rejected the request.' });
  await flush();
  assert.equal(a.reply(1).error.code, 4001);
  a.ask(2, 'personal_sign', [msg, X]);
  a.ask(3, 'eth_requestAccounts', [], false);                   // connected: answered from the snapshot, no UI
  await flush();
  assert.equal(a.reply(2).error.code, 4001);
  assert.equal(reasonOf(a.reply(2)), 'rejected');
  assert.match(a.reply(2).error.data.messages.zh, /拒绝/);
  assert.deepEqual(a.reply(3).result, [X]);
  assert.equal(h.requests().length, 1, 'nothing new reached the hub');
  t += REJECT_COOLDOWN_MS - 1;
  a.ask(4, 'personal_sign', [msg, X]);
  await flush();
  assert.equal(reasonOf(a.reply(4)), 'rejected');
  t += 1;
  a.ask(5, 'personal_sign', [msg, X]);
  await flush();
  assert.equal(a.reply(5), null, 'the pause is over: the card opens again');
});

test('a click ends the pause; another site is not affected; closing the hub counts as a Reject', async () => {
  const { chrome } = setup({ snapshot: granted([A, B]) });
  const a = site(chrome);
  a.ask(1, 'personal_sign', [msg, X]);
  await flush();
  const h = hub(chrome, lastOpened(chrome));
  await flush();
  h.fail(h.requests()[0].id, { code: 4001, message: 'closed', data: { reason: 'closed' } });
  await flush();
  a.ask(2, 'personal_sign', [msg, X], true);                    // the user clicks "Sign" again
  await flush();
  assert.equal(a.reply(2), null);
  assert.equal(h.requests().length, 2);
  h.answer(h.requests()[1].id, '0xsig');
  await flush();
  a.ask(3, 'personal_sign', [msg, X]);                          // the pause was ended by the click
  await flush();
  assert.equal(h.requests().length, 3);
  const b = site(chrome, { origin: B, tabId: 7, documentId: 'doc-b' });
  b.ask(1, 'personal_sign', [msg, X]);
  await flush();
  assert.notEqual(reasonOf(b.reply(1)), 'rejected');
});
