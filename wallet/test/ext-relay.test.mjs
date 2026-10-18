// Offline unit tests for the extension's site-page content scripts (design §6, §10.1): inpage.js (MAIN world,
// the provider) and relay.js (ISOLATED world, page ⇄ background, the user gesture). Both run on one fake window,
// as the two worlds of a real page share its messages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installInpage, isSitePage } from '../extension/inpage.js';
import { startRelay, RECONNECT_GAP_MS } from '../extension/relay.js';
import { PAGE_CHANNEL, DIR, EVENT_MESSAGE, SITE_PORT } from '../src/ext-protocol.js';
import { fakeWindow, fakeRuntime } from './fake-window.mjs';
import { flush, EXT_ID } from './fake-chrome.mjs';

const A = 'https://4246-0.tapekit.org';
const page = (win, msg) => win.deliver({ source: win, origin: win.location.origin, data: { channel: PAGE_CHANNEL, dir: DIR.toRelay, msg } });
const toPage = (win) => win.posted.filter((p) => p.data.dir === DIR.toPage).map((p) => p.data.msg);

function pair({ href = A + '/', userActive = false, broken = false } = {}) {
  const win = fakeWindow(href, { userActive });
  const rt = fakeRuntime({ broken });
  let now = 0;
  const timers = [];
  const relay = startRelay({ win, runtime: rt.runtime, now: () => now, setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimer: () => {} });
  const provider = installInpage(win);
  return { win, rt, relay, provider, timers, tick: (ms) => { now += ms; } };
}

test('inpage: only top-level gateway site pages, never /.tape/*, frames or other hosts', () => {
  assert.equal(isSitePage(fakeWindow(A + '/app?x#y')), true);
  assert.equal(isSitePage(fakeWindow('http://1-2-344.localhost:8096/')), true);
  for (const href of ['https://tapekit.org/', A + '/.tape/status', 'https://www.tapekit.org/', 'https://evil.com/', 'https://01-0.tapekit.org/']) {
    assert.equal(isSitePage(fakeWindow(href)), false, href);
  }
  assert.equal(isSitePage(fakeWindow(A + '/', { top: false })), false);
});

test('inpage: window.tapekit.wallet plus one EIP-6963 announcement; never window.ethereum; never twice', () => {
  const win = fakeWindow(A + '/');
  const seen = [];
  win.addEventListener('eip6963:announceProvider', (e) => seen.push(e.detail.info));
  const provider = installInpage(win);
  assert.equal(win.tapekit.wallet, provider);
  assert.equal(win.ethereum, undefined);
  assert.deepEqual(seen.map((i) => [i.name, i.rdns]), [['TapeKit', 'org.tapekit']]);
  assert.equal(installInpage(win), null);   // the fallback client or a second injection sees it and steps aside
  assert.equal(installInpage(fakeWindow('https://tapekit.org/')), null);
});

test('a request goes page → relay → port with only id, method, params and the relay\'s own gesture reading', async () => {
  const { win, rt, provider } = pair({ userActive: false });
  const p = provider.request({ method: 'eth_chainId' });
  await flush();
  const bg = rt.last();
  assert.equal(bg.port.name, SITE_PORT);
  assert.deepEqual(bg.got, [{ type: 'request', id: 1, method: 'eth_chainId', params: undefined, gesture: false }]);
  bg.port.postMessage({ type: 'response', id: 1, result: '0x38' });
  assert.equal(await p, '0x38');
  // Forged fields from the page are dropped; another window's messages are ignored.
  page(win, { channel: 'tapekit-wallet/1', type: 'request', id: 9, method: 'eth_requestAccounts', params: [], origin: 'https://1-0.tapekit.org', gesture: true });
  win.deliver({ source: { other: 1 }, origin: A, data: { channel: PAGE_CHANNEL, dir: DIR.toRelay, msg: { channel: 'tapekit-wallet/1', type: 'request', id: 10, method: 'eth_chainId' } } });
  await flush();
  assert.deepEqual(bg.got.slice(1), [{ type: 'request', id: 9, method: 'eth_requestAccounts', params: [], gesture: false }]);
});

test('gesture: true for any request while the isolated world sees user activation (a connect is granted on it; front.js lets a click open a card)', async () => {
  const { win, rt, provider } = pair({ userActive: true });
  provider.request({ method: 'eth_requestAccounts', params: [] });
  provider.request({ method: 'personal_sign', params: ['0x00', '0x' + 'aa'.repeat(20)] });
  await flush();   // the relay reads the activation when the message arrives
  win.navigator.userActivation.isActive = false;
  provider.request({ method: 'wallet_requestPermissions', params: [{ eth_accounts: {} }] });
  provider.request({ method: 'personal_sign', params: ['0x00', '0x' + 'aa'.repeat(20)] });
  await flush();
  assert.deepEqual(rt.last().got.map((m) => [m.method, m.gesture]), [['eth_requestAccounts', true], ['personal_sign', true], ['wallet_requestPermissions', false], ['personal_sign', false]]);
});

test('answers reach the page only for ids it waits for; errors become ProviderRpcError', async () => {
  const { win, rt, provider } = pair();
  const p = provider.request({ method: 'personal_sign', params: ['0x00', '0x' + 'aa'.repeat(20)] });
  await flush();
  const bg = rt.last();
  bg.port.postMessage({ type: 'response', id: 77, result: 'stray' });
  bg.port.postMessage({ type: 'response', id: 1, error: { code: 4001, message: 'no', data: { reason: 'closed' } } });
  await assert.rejects(p, (e) => e.code === 4001 && e.data.reason === 'closed' && e.name === 'ProviderRpcError');
  assert.deepEqual(toPage(win).map((m) => m.id), [1]);
  assert.ok(win.posted.every((x) => x.targetOrigin === A));   // never '*'
});

test('events: from this extension only, for this origin only', async () => {
  const { rt, provider } = pair();
  const got = [];
  provider.on('accountsChanged', (a) => got.push(a));
  const send = (msg, sender) => rt.runtime.onMessage.fire(msg, sender, () => {});
  const X = '0x' + 'aa'.repeat(20);
  send({ type: EVENT_MESSAGE, origin: A, event: 'accountsChanged', data: [X] }, { id: EXT_ID });
  send({ type: EVENT_MESSAGE, origin: 'https://1-0.tapekit.org', event: 'accountsChanged', data: ['x'] }, { id: EXT_ID });
  send({ type: EVENT_MESSAGE, origin: A, event: 'accountsChanged', data: ['y'] }, { id: 'another-extension' });
  send({ type: EVENT_MESSAGE, origin: A, event: 'notAnEvent', data: 1 }, { id: EXT_ID });
  await flush();
  assert.deepEqual(got, [[X]]);
});

test('events that repeat what the page already knows are dropped (a new hub window re-announces accounts)', async () => {
  const { rt, provider } = pair();
  const got = [];
  provider.on('accountsChanged', (a) => got.push(['acc', a]));
  provider.on('chainChanged', (c) => got.push(['chain', c]));
  const X = '0x' + 'aa'.repeat(20);
  const event = (ev, data) => rt.runtime.onMessage.fire({ type: EVENT_MESSAGE, origin: A, event: ev, data }, { id: EXT_ID }, () => {});
  event('accountsChanged', [X]);                 // nothing learned yet: passed on
  event('accountsChanged', [X]);                 // the same again: dropped
  const p = provider.request({ method: 'eth_chainId' });
  await flush();
  rt.last().port.postMessage({ type: 'response', id: 1, result: '0x38' });
  await p;
  event('chainChanged', '0x38');                 // equal to the answer the page has: dropped
  event('chainChanged', '0xc4');
  event('accountsChanged', []);
  await flush();
  assert.deepEqual(got, [['acc', [X]], ['chain', '0xc4'], ['acc', []]]);
});

test('a connect gives exactly one accountsChanged: from the answer, then the router\'s own event is a repeat', async () => {
  const { rt, provider } = pair({ userActive: true });
  const got = [];
  provider.on('accountsChanged', (a) => got.push(a));
  const X = '0x' + 'aa'.repeat(20);
  const p = provider.request({ method: 'eth_requestAccounts', params: [] });
  await flush();
  rt.last().port.postMessage({ type: 'response', id: 1, result: [X] });
  assert.deepEqual(await p, [X]);
  rt.runtime.onMessage.fire({ type: EVENT_MESSAGE, origin: A, event: 'accountsChanged', data: [X] }, { id: EXT_ID }, () => {});
  await flush();
  assert.deepEqual(got, [[X]]);
});

test('the port opens on the first request only; when Chrome stops the background it reconnects and resumes', async () => {
  const { rt, provider, timers, tick } = pair();
  assert.equal(rt.runtime.connects, 0);
  const p = provider.request({ method: 'personal_sign', params: ['0x00', '0x' + 'aa'.repeat(20)] });
  await flush();
  rt.last().port.disconnect();                    // the worker stopped
  await flush();
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, RECONNECT_GAP_MS);   // at most once a second
  tick(RECONNECT_GAP_MS);
  timers[0].fn();
  await flush();
  assert.equal(rt.runtime.connects, 2);
  assert.deepEqual(rt.last().got, [{ type: 'resume', ids: [1] }]);
  rt.last().port.postMessage({ type: 'response', id: 1, result: '0xsig' });
  assert.equal(await p, '0xsig');
});

test('an idle page does not reconnect (no waking the background for nothing)', async () => {
  const { rt, provider, timers } = pair();
  const p = provider.request({ method: 'eth_chainId' });
  await flush();
  rt.last().port.postMessage({ type: 'response', id: 1, result: '0x38' });
  await p;
  rt.last().port.disconnect();
  await flush();
  assert.equal(timers.length, 0);
  assert.equal(rt.runtime.connects, 1);
});

test('the extension is gone (disabled or updated): waiting and later requests fail 4900', async () => {
  const { rt, provider, timers } = pair();
  const p = provider.request({ method: 'personal_sign', params: ['0x00', '0x' + 'aa'.repeat(20)] });
  await flush();
  rt.runtime.broken = true;
  rt.last().port.disconnect();
  await flush();
  timers[0].fn();
  await assert.rejects(p, (e) => e.code === 4900);
  await assert.rejects(provider.request({ method: 'eth_chainId' }), (e) => e.code === 4900);
});

test('the relay runs in the top frame only', () => {
  const win = fakeWindow(A + '/', { top: false });
  assert.equal(startRelay({ win, runtime: fakeRuntime().runtime }), null);
  assert.equal(win.listenerCount(), 0);
});
