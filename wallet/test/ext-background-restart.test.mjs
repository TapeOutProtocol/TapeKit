// Offline unit tests for the extension background's pending requests (design §10.1): Chrome stops an idle
// service worker after 30 s while a signature can wait for minutes, so requests live in chrome.storage.session.
// A "restart" here is a second background instance on the same fake chrome storage, with fresh ports.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, site, hub, lastOpened, flush, A, X } from './ext-harness.mjs';
import { fakeChrome } from './fake-chrome.mjs';
import { ROUTING_KEY } from '../extension/routing.js';
import { SNAPSHOT_KEY } from '../extension/snapshot.js';
import { PENDING_KEY } from '../extension/pending.js';

const SNAP = { perms: { [A]: { accounts: [X], chainId: '0x38', grantedAt: 5, holder: null, container: null } }, accounts: [X] };

/** A new worker on the same browser: same storage, new listeners (the old ones die with the old worker). */
function restart(chrome, tag) {
  const next = fakeChrome({ gateway: 'tapekit.org' });
  for (const area of ['local', 'session', 'sync']) next.storage[area].load(chrome.storage[area].peek());
  next.windows = chrome.windows;   // windows and tabs outlive the worker
  next.tabs = chrome.tabs;
  return setup({ chrome: next, tag });
}

async function signing(chrome) {
  const a = site(chrome, { documentId: 'doc-1' });
  a.ask('s1', 'personal_sign', ['0x00', X]);
  await flush();
  const opened = lastOpened(chrome);   // a hub tab
  const h = hub(chrome, opened);
  await flush();
  return { a, h, opened, id: h.requests()[0].id };
}

test('requests waiting on the hub are kept in chrome.storage.session', async () => {
  const { chrome } = setup({ snapshot: SNAP });
  const { id } = await signing(chrome);
  const table = (await chrome.storage.session.get(PENDING_KEY))[PENDING_KEY];
  assert.deepEqual(Object.keys(table), [id]);
  assert.equal(table[id].state, 'sent');
  assert.equal(table[id].origin, A);
  assert.equal(table[id].documentId, 'doc-1');
});

test('a restarted worker still delivers the hub\'s answer once relay.js resumes', async () => {
  const first = setup({ snapshot: SNAP });
  const { id, opened } = await signing(first.chrome);
  const second = restart(first.chrome, 'b');
  const h = hub(second.chrome, { ...opened, fresh: false });     // hub-relay reconnects
  await flush();
  assert.deepEqual(h.got, [{ type: 'hello', managed: true, popup: false }]);
  assert.equal(h.requests().length, 0);                           // nothing is sent twice
  h.answer(id, '0xsig');
  await flush();
  const a = site(second.chrome, { documentId: 'doc-1' });         // relay.js reconnects
  a.remote.postMessage({ type: 'resume', ids: ['s1', 'gone'] });
  await flush();
  assert.equal(a.reply('s1').result, '0xsig');
  assert.equal(a.reply('gone').error.code, 4900);                 // never seen: dropped while the page was away
  assert.deepEqual((await second.chrome.storage.session.get(PENDING_KEY))[PENDING_KEY], {});
});

test('a restarted worker sends the answer at once when relay.js reconnected first', async () => {
  const first = setup({ snapshot: SNAP });
  const { id, opened } = await signing(first.chrome);
  const second = restart(first.chrome, 'b');
  const a = site(second.chrome, { documentId: 'doc-1' });
  a.remote.postMessage({ type: 'resume', ids: ['s1'] });
  await flush();
  assert.equal(a.reply('s1'), null);                              // still with the hub
  const h = hub(second.chrome, { ...opened, fresh: false });
  await flush();
  h.answer(id, '0xsig');
  await flush();
  assert.equal(a.reply('s1').result, '0xsig');
});

test('closing the hub tab rejects what waits on it with 4001 and zh/en texts', async () => {
  const { chrome } = setup({ snapshot: SNAP });
  const { a, opened } = await signing(chrome);
  await chrome.tabs.remove(opened.tabId);
  await flush();
  const err = a.reply('s1').error;
  assert.equal(err.code, 4001);
  assert.equal(err.data.reason, 'closed');
  assert.match(err.data.messages.zh, /TapeKit/);
  assert.match(err.data.messages.en, /closed/);
});

test('closing the notice window rejects what waits on it with 4001', async () => {
  const { chrome } = setup({ snapshot: SNAP });
  const a = site(chrome);
  a.ask('w1', 'wallet_switchEthereumChain', [{ chainId: '0xc4' }]);
  await flush();
  const opened = lastOpened(chrome);
  assert.equal(opened.how, 'window');
  hub(chrome, opened);
  await flush();
  await chrome.windows.remove(opened.windowId);
  await flush();
  assert.equal(a.reply('w1').error.code, 4001);
});

test('the hub page reloading loses what it held (4001); requests it never got are sent to the new page', async () => {
  const { chrome } = setup({ snapshot: SNAP });
  const { a, h, opened } = await signing(chrome);
  h.remote.disconnect();                                          // the page unloads while this worker runs
  await flush();
  assert.equal(a.reply('s1').error.code, 4001);
  a.ask('s2', 'wallet_switchEthereumChain', [{ chainId: '0xc4' }]);
  await flush();
  const again = hub(chrome, { ...opened, fresh: true });
  await flush();
  assert.deepEqual(again.requests().map((r) => r.method), ['wallet_switchEthereumChain']);
});

test('after a restart, a hub page that is new (fresh) cannot answer for the old one: 4001', async () => {
  const first = setup({ snapshot: SNAP });
  const { opened } = await signing(first.chrome);
  const second = restart(first.chrome, 'b');
  hub(second.chrome, { ...opened, fresh: true });
  await flush();
  const a = site(second.chrome, { documentId: 'doc-1' });
  a.remote.postMessage({ type: 'resume', ids: ['s1'] });
  await flush();
  assert.equal(a.reply('s1').error.code, 4001);
});

test('a site port that closes while this worker runs drops its unsent requests; resuming them gives 4900', async () => {
  const { chrome } = setup({ snapshot: SNAP });
  const a = site(chrome, { documentId: 'doc-1' });
  a.ask('q1', 'personal_sign', ['0x00', X]);
  await flush();
  a.remote.disconnect();
  await flush();
  assert.deepEqual((await chrome.storage.session.get(PENDING_KEY))[PENDING_KEY], {});
  const h = hub(chrome, lastOpened(chrome));
  await flush();
  assert.equal(h.requests().length, 0);                           // never shown to the user
  const back = site(chrome, { documentId: 'doc-1' });             // e.g. back from the back/forward cache
  back.remote.postMessage({ type: 'resume', ids: ['q1'] });
  await flush();
  assert.equal(back.reply('q1').error.code, 4900);
});

test('a hub that never says ready: 4900 after the timeout, and its tab is closed', async () => {
  const { chrome, timers } = setup({ snapshot: SNAP });
  const a = site(chrome);
  a.ask(1, 'personal_sign', ['0x00', X]);
  await flush();
  const { tabId } = lastOpened(chrome);
  assert.equal(timers.count(), 1);
  timers.fireAll();
  await flush();
  assert.equal(a.reply(1).error.code, 4900);
  assert.equal(a.reply(1).error.data.reason, 'load');
  assert.deepEqual(chrome.log.tabsRemoved, [tabId]);
});

test('a ready hub cancels the timeout', async () => {
  const { chrome, timers } = setup({ snapshot: SNAP });
  await signing(chrome);
  assert.equal(timers.count(), 0);
});

test('closing the site\'s tab drops its entries; old entries are dropped on load', async () => {
  const { chrome } = setup({ snapshot: SNAP });
  const a = site(chrome, { documentId: 'doc-1', tabId: 42 });
  a.ask('q1', 'personal_sign', ['0x00', X]);
  await flush();
  chrome.tabs.onRemoved.fire(42);
  await flush();
  assert.deepEqual((await chrome.storage.session.get(PENDING_KEY))[PENDING_KEY], {});
  const stale = fakeChrome();
  stale.storage.local.load({ [ROUTING_KEY]: { gateway: 'tapekit.org' }, [SNAPSHOT_KEY]: { hub: 'https://tapekit.org', ...SNAP } });
  stale.storage.session.load({ [PENDING_KEY]: { old: { hubId: 'old', state: 'done', at: 0, documentId: 'd', siteId: 1 }, bad: { nope: 1 } } });
  const { bg } = setup({ chrome: stale });
  await bg.ready;
  const s = site(stale, { documentId: 'd' });
  s.remote.postMessage({ type: 'resume', ids: [1] });
  await flush();
  assert.equal(s.reply(1).error.code, 4900);
});

test('after a restart, a stored hub tab that is no longer the hub fails what waited on it (4001) and is not reused', async () => {
  const first = setup({ snapshot: SNAP });
  const a = site(first.chrome, { documentId: 'doc-1' });
  a.ask('s1', 'personal_sign', ['0x00', X]);
  await flush();
  const opened = lastOpened(first.chrome);                        // the hub has not loaded yet: s1 is queued
  await first.chrome.tabs.update(opened.tabId, { url: 'https://example.com/' });
  const second = restart(first.chrome, 'b');                      // the ready timer died with the old worker
  const back = site(second.chrome, { documentId: 'doc-1' });
  back.remote.postMessage({ type: 'resume', ids: ['s1'] });
  await flush();
  assert.equal(back.reply('s1'), null);
  back.ask('s2', 'personal_sign', ['0x00', X]);
  await flush();
  assert.equal(back.reply('s1').error.code, 4001);
  const fresh = lastOpened(first.chrome);                         // tabs (and their log) outlive the worker
  assert.notEqual(fresh.tabId, opened.tabId);
  const h = hub(second.chrome, fresh);
  await flush();
  assert.deepEqual(h.requests().map((r) => r.method), ['personal_sign']);
});
