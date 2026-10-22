// Offline unit tests for the hub page's end of the extension channel (design §10.1): hub-relay.js (ISOLATED
// world, extension ⇄ hub) and wallet/src/ext-channel.js (the hub's listener), on one fake hub window.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startHubRelay, HUB_RECONNECT_GAP_MS } from '../extension/hub-relay.js';
import { createExtChannel } from '../src/ext-channel.js';
import { HUB_CHANNEL, DIR, HUB_PORT } from '../src/ext-protocol.js';
import { fakeWindow, fakeRuntime } from './fake-window.mjs';
import { flush } from './fake-chrome.mjs';

const HUB = 'https://tapekit.org/.tape/wallet/';
const A = 'https://4246-0.tapekit.org';
const toHub = (win, msg, source = win, origin = win.location.origin) => win.deliver({ source, origin, data: { channel: HUB_CHANNEL, dir: DIR.toHub, msg } });

function setup({ handle = async () => '0x38', revoke = async () => null, relay = true, beforeReply } = {}) {
  const win = fakeWindow(HUB);
  const rt = fakeRuntime();
  const timers = [];
  if (relay) startHubRelay({ win, runtime: rt.runtime, now: () => 0, setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimer: () => {} });
  const calls = { handle: [], revoke: [], hello: [], done: [], pending: [], errors: [] };
  const channel = createExtChannel({
    win, hubLocation: HUB,
    handle: async (req) => { calls.handle.push(req); return handle(req); },
    revoke: async (origin) => { calls.revoke.push(origin); return revoke(origin); },
    onHello: (info) => calls.hello.push(info),
    onRequestDone: (info) => calls.done.push(info),
    onPendingChange: (n) => calls.pending.push(n),
    onError: (e, where) => calls.errors.push(where),
    ...(beforeReply ? { beforeReply } : {}),
  });
  return { win, rt, timers, channel, calls };
}

test('hub-relay connects only once the hub says hub-ready, with fresh: true', async () => {
  const quiet = fakeWindow(HUB);
  const rt0 = fakeRuntime();
  startHubRelay({ win: quiet, runtime: rt0.runtime });
  await flush();
  assert.equal(rt0.runtime.connects, 0);   // no hub page listening: the extension is never woken
  const { rt } = setup();
  await flush();
  assert.equal(rt.runtime.connects, 1);
  assert.equal(rt.last().port.name, HUB_PORT);
  assert.deepEqual(rt.last().got, [{ type: 'ready', fresh: true }]);
});

test('a request from the extension reaches the router with its origin and gesture; the answer goes back', async () => {
  const { rt, calls } = setup({ handle: async () => ['0xabc'] });
  await flush();
  const bg = rt.last();
  bg.port.postMessage({ type: 'hello', managed: true });
  bg.port.postMessage({ type: 'request', id: 'h1', origin: A, method: 'eth_requestAccounts', params: [], gesture: true, extra: 'dropped' });
  await flush();
  assert.deepEqual(calls.hello, [{ managed: true, popup: false }]);
  assert.deepEqual(calls.handle, [{ origin: A, method: 'eth_requestAccounts', params: [], gesture: true }]);
  assert.deepEqual(bg.got.at(-1), { type: 'response', id: 'h1', result: ['0xabc'] });
  assert.deepEqual(calls.pending, [1, 0]);
  assert.equal(calls.done[0].origin, A);
});

test('the background says whether the hub is in a popup-type window; only its word counts', async () => {
  const { rt, win, channel, calls } = setup();
  await flush();
  assert.equal(channel.inPopupWindow(), false);
  toHub(win, { type: 'hello', managed: true, popup: true }, { other: 1 });   // not from this window
  await flush();
  assert.equal(channel.inPopupWindow(), false);
  rt.last().port.postMessage({ type: 'hello', managed: true, popup: 'yes' });   // only literal true
  await flush();
  assert.equal(channel.inPopupWindow(), false);
  rt.last().port.postMessage({ type: 'hello', managed: true, popup: true });
  await flush();
  assert.equal(channel.inPopupWindow(), true);
  assert.deepEqual(calls.hello.at(-1), { managed: true, popup: true });
});

test('nothing is accepted before hello, and only from this window, this origin, this tag and direction', async () => {
  const { win, calls } = setup({ relay: false });
  const req = { type: 'request', id: 'h1', origin: A, method: 'eth_chainId', params: [], gesture: true };
  toHub(win, req);
  await flush();
  assert.equal(calls.handle.length, 0);   // no hello yet
  toHub(win, { type: 'hello', managed: false });
  toHub(win, { ...req, id: 'other-window' }, { other: 1 });
  toHub(win, { ...req, id: 'other-origin' }, win, A);
  win.deliver({ source: win, origin: win.location.origin, data: { channel: HUB_CHANNEL, dir: DIR.fromHub, msg: req } });
  win.deliver({ source: win, origin: win.location.origin, data: { channel: 'tapekit-wallet/1', dir: DIR.toHub, msg: req } });
  await flush();
  assert.equal(calls.handle.length, 0);
  toHub(win, req);
  await flush();
  assert.equal(calls.handle.length, 1);
});

test('a request for an origin that is not a gateway site is refused with 4100 without reaching the router', async () => {
  const { rt, calls } = setup();
  await flush();
  const bg = rt.last();
  bg.port.postMessage({ type: 'hello', managed: true });
  bg.port.postMessage({ type: 'request', id: 'h1', origin: 'https://evil.com', method: 'eth_requestAccounts', params: [], gesture: true });
  await flush();
  assert.equal(calls.handle.length, 0);
  assert.equal(bg.got.at(-1).error.code, 4100);
});

test('revoke from the extension popup calls the hub\'s revoke for that origin', async () => {
  const { rt, calls } = setup();
  await flush();
  const bg = rt.last();
  bg.port.postMessage({ type: 'hello', managed: true });
  bg.port.postMessage({ type: 'revoke', id: 'r1', origin: A });
  await flush();
  assert.deepEqual(calls.revoke, [A]);
  assert.deepEqual(bg.got.at(-1), { type: 'response', id: 'r1', result: null });
});

test('events, snapshots, close and focus reach the extension only after hello; close and focus only when managed', async () => {
  const { rt, channel } = setup();
  await flush();
  const bg = rt.last();
  assert.equal(channel.emit(A, 'accountsChanged', []), false);
  assert.equal(channel.publish({ perms: {}, accounts: [] }), false);
  bg.port.postMessage({ type: 'hello', managed: false });
  await flush();
  assert.equal(channel.requestClose(), false);
  assert.equal(channel.requestFocus(), false);
  channel.emit(A, 'accountsChanged', []);
  channel.publish({ perms: { [A]: { accounts: [] } }, accounts: [] });
  await flush();
  assert.deepEqual(bg.got.slice(1), [
    { type: 'event', origin: A, event: 'accountsChanged', data: [] },
    { type: 'snapshot', perms: { [A]: { accounts: [] } }, accounts: [] },
  ]);
  bg.port.postMessage({ type: 'hello', managed: true });
  await flush();
  channel.requestClose();
  channel.requestFocus();
  await flush();
  assert.deepEqual(bg.got.slice(3), [{ type: 'close' }, { type: 'focus' }]);
});

test('a managed hub reconnects (fresh: false) when Chrome stops the background; an unmanaged one waits for news', async () => {
  const { rt, channel, timers } = setup();
  await flush();
  rt.last().port.postMessage({ type: 'hello', managed: true });
  await flush();
  rt.last().port.disconnect();
  await flush();
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, HUB_RECONNECT_GAP_MS);
  timers[0].fn();
  await flush();
  assert.deepEqual(rt.last().got, [{ type: 'ready', fresh: false }]);

  const other = setup();
  await flush();
  other.rt.last().port.postMessage({ type: 'hello', managed: false });
  await flush();
  other.rt.last().port.disconnect();
  await flush();
  assert.equal(other.timers.length, 0);
  other.channel.publish({ perms: {}, accounts: [] });
  await flush();
  assert.equal(other.rt.runtime.connects, 2);
  assert.deepEqual(other.rt.last().got, [{ type: 'ready', fresh: false }, { type: 'snapshot', perms: {}, accounts: [] }]);
  assert.ok(channel);
});

test('the hub\'s grants go out before every answer, so the extension\'s copy is never behind what the site was told', async () => {
  let channel = null;
  const perms = { [A]: { accounts: ['0x' + 'aa'.repeat(20)] } };
  const s = setup({
    handle: async (req) => { if (req.method === 'personal_sign') throw { code: 4001, message: 'no' }; return ['0xabc']; },
    beforeReply: () => channel.publish({ perms, accounts: [] }),
  });
  channel = s.channel;
  await flush();
  const bg = s.rt.last();
  bg.port.postMessage({ type: 'hello', managed: true });
  bg.port.postMessage({ type: 'request', id: 'h1', origin: A, method: 'eth_requestAccounts', params: [], gesture: true });
  bg.port.postMessage({ type: 'request', id: 'h2', origin: A, method: 'personal_sign', params: ['0x00', '0x' + 'aa'.repeat(20)] });
  await flush();
  assert.deepEqual(bg.got.slice(1).map((m) => m.type + (m.id ? ':' + m.id : '')), ['snapshot', 'response:h1', 'snapshot', 'response:h2']);
  const broken = setup({ beforeReply: () => { throw new Error('boom'); } });
  await flush();
  broken.rt.last().port.postMessage({ type: 'hello', managed: true });
  broken.rt.last().port.postMessage({ type: 'request', id: 'h3', origin: A, method: 'eth_chainId', params: [] });
  await flush();
  assert.deepEqual(broken.rt.last().got.at(-1), { type: 'response', id: 'h3', result: '0x38' });   // the answer still goes
  assert.deepEqual(broken.calls.errors, ['ext.beforeReply']);
});

test('posts on the hub page never use "*"', async () => {
  const { win, rt } = setup();
  await flush();
  rt.last().port.postMessage({ type: 'hello', managed: true });
  rt.last().port.postMessage({ type: 'request', id: 'h1', origin: A, method: 'eth_chainId', params: [] });
  await flush();
  assert.ok(win.posted.length >= 3);
  assert.ok(win.posted.every((p) => p.targetOrigin === 'https://tapekit.org'));
});
