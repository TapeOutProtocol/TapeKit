// Offline unit tests for wallet/src/popup-channel.js: the hub side of the fallback channel (design §10.2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPopupChannel, claimFirstLoad, FIRST_LOAD_KEY } from '../src/popup-channel.js';
import { makeRequest, makeResult, makeEvent, makeReady, rpcError, CHANNEL } from '../src/protocol.js';

const HUB = 'https://tapekit.org/.tape/wallet/';
const A = 'https://4246-0.tapekit.org';
const B = 'https://1-2-344.tapekit.org';
const tick = () => new Promise((r) => setTimeout(r, 0));

function fakeOpener() {
  const posted = [];
  return { posted, postMessage(msg, target) { posted.push({ msg: structuredClone(msg), target }); } };
}

/** Fake hub window: records listeners so tests can deliver MessageEvent-like objects directly. */
function fakeHub({ opener = fakeOpener(), hash = '' } = {}) {
  const listeners = new Set();
  return {
    opener,
    location: { href: HUB + hash, hash },
    addEventListener(type, fn) { if (type === 'message') listeners.add(fn); },
    removeEventListener(type, fn) { if (type === 'message') listeners.delete(fn); },
    deliver(event) { for (const fn of listeners) fn(event); },
    listeners,
  };
}

function setup({ handle, hash, opener, now, gestureWindowMs, gestureAvailable } = {}) {
  const win = fakeHub({ hash, opener });
  const calls = [];
  const done = [];
  const pendingLog = [];
  const errors = [];
  const channel = createPopupChannel({
    win, hubLocation: HUB, now, gestureWindowMs, gestureAvailable,
    handle: async (req) => { calls.push(req); return handle ? handle(req) : '0x38'; },
    onPendingChange: (n) => pendingLog.push(n),
    onRequestDone: (info) => done.push(info),
    onError: (e, where) => errors.push(where),
  });
  const send = (data, origin = A, source = win.opener) => win.deliver({ data, origin, source });
  return { win, channel, calls, done, pendingLog, errors, send, posted: win.opener ? win.opener.posted : [] };
}

test('accepts requests only from window.opener on a gateway site origin', async () => {
  const h = setup();
  h.send(makeRequest(1, 'eth_chainId', []), A, { postMessage() {} });          // another window
  h.send(makeRequest(2, 'eth_chainId', []), 'https://evil.com');               // not a site
  h.send(makeRequest(3, 'eth_chainId', []), 'https://tapekit.org');            // the root itself
  h.send(makeRequest(4, 'eth_chainId', []), 'https://4246-0.tapekit.org.evil.com');
  h.send({ channel: 'other', type: 'request', id: 5, method: 'eth_chainId' }); // foreign message
  h.send(makeResult(6, '0x1'));                                                 // not a request
  h.send(makeRequest(7, 'eth_chainId', []));                                    // the one that counts
  await tick();
  assert.deepEqual(h.calls.map((c) => c.origin), [A]);
  assert.deepEqual(h.posted, [{ msg: makeResult(7, '0x38'), target: A }]);
});

test('without an opener nothing is accepted', async () => {
  const h = setup({ opener: null });
  h.send(makeRequest(1, 'eth_chainId', []), A, null);
  await tick();
  assert.equal(h.calls.length, 0);
});

test('the origin comes from the browser, never from the message', async () => {
  const h = setup();
  h.send({ ...makeRequest(1, 'eth_requestAccounts', []), origin: B, gesture: true }, A);
  await tick();
  assert.equal(h.calls[0].origin, A);
});

test('replies go to the requesting origin, never "*"', async () => {
  const h = setup({ handle: () => { throw rpcError(4001, 'no'); } });
  h.send(makeRequest('x', 'personal_sign', []), B);
  await tick();
  assert.deepEqual(h.posted, [{ msg: { channel: CHANNEL, type: 'response', id: 'x', error: { code: 4001, message: 'no' } }, target: B }]);
  assert.ok(h.posted.every((p) => p.target !== '*'));
});

test('only the first request after load carries the gesture', async () => {
  const h = setup();
  h.send(makeRequest(1, 'eth_requestAccounts', []));
  h.send(makeRequest(2, 'eth_requestAccounts', []));
  h.send(makeRequest(3, 'eth_requestAccounts', []), B);
  await tick();
  assert.deepEqual(h.calls.map((c) => c.gesture), [true, false, false]);
});

test('ignored messages do not use up the gesture; a late first request gets none', async () => {
  let t = 0;
  const h = setup({ now: () => t, gestureWindowMs: 10_000 });
  h.send(makeRequest(1, 'eth_requestAccounts', []), 'https://evil.com');
  t = 10_001;
  h.send(makeRequest(2, 'eth_requestAccounts', []));
  await tick();
  assert.deepEqual(h.calls.map((c) => c.gesture), [false]);
});

/** Minimal sessionStorage: one per popup window, kept across hub reloads. */
function fakeSession() {
  const data = new Map();
  return { getItem: (k) => (data.has(k) ? data.get(k) : null), setItem: (k, v) => { data.set(k, String(v)); }, data };
}

test('a hub reloaded by its opener hands out no new gesture', async () => {
  // The opener can reload its popup without a click (popup.location = …). Without the first-load mark the
  // reloaded hub would treat the next request as the click that opened it.
  const session = fakeSession();
  const first = setup({ gestureAvailable: claimFirstLoad(session) });
  first.send(makeRequest(1, 'eth_requestAccounts', []));
  await tick();
  first.channel.stop();
  const reloaded = setup({ gestureAvailable: claimFirstLoad(session) });
  reloaded.send(makeRequest(1, 'eth_requestAccounts', []));
  await tick();
  assert.deepEqual([first.calls[0].gesture, reloaded.calls[0].gesture], [true, false]);
});

test('claimFirstLoad: true once per window; missing or broken storage gives false', () => {
  const session = fakeSession();
  assert.equal(claimFirstLoad(session), true);
  assert.equal(session.data.get(FIRST_LOAD_KEY), '1');
  assert.equal(claimFirstLoad(session), false);
  assert.equal(claimFirstLoad(fakeSession()), true, 'a new popup window starts fresh');
  assert.equal(claimFirstLoad(null), false);
  assert.equal(claimFirstLoad({ getItem() { throw new Error('SecurityError'); }, setItem() {} }), false);
  assert.equal(claimFirstLoad({ getItem: () => null, setItem() { throw new Error('QuotaExceededError'); } }), false);
  assert.equal(claimFirstLoad({ getItem: () => null, setItem() {} }), false, 'a write that does not stick is not trusted');
});

test('gestureAvailable must be literally true', async () => {
  for (const gestureAvailable of [false, 'true', 1]) {
    const h = setup({ gestureAvailable });
    h.send(makeRequest(1, 'eth_requestAccounts', []));
    await tick();
    assert.equal(h.calls[0].gesture, false, String(gestureAvailable));
  }
});

test('thrown non-RPC errors become -32603 and are reported', async () => {
  const h = setup({ handle: () => { throw new Error('boom'); } });
  h.send(makeRequest(1, 'eth_chainId', []));
  await tick();
  assert.equal(h.posted[0].msg.error.code, -32603);
  assert.deepEqual(h.errors, ['popup.handle']);
  assert.deepEqual(h.done, [{ origin: A, method: 'eth_chainId', error: { code: -32603, message: 'Internal error.' } }]);
});

test('a result that cannot be cloned is answered with -32603 instead of hanging', async () => {
  const opener = { posted: [], postMessage(msg, target) { structuredClone(msg); this.posted.push({ msg, target }); } };
  const h = setup({ opener, handle: () => ({ fn() {} }) });
  h.send(makeRequest(1, 'eth_call', []), A, opener);
  await tick();
  assert.equal(opener.posted.length, 1);
  assert.equal(opener.posted[0].msg.error.code, -32603);
});

test('pending count goes up and down around each request', async () => {
  let release;
  const h = setup({ handle: () => new Promise((r) => { release = r; }) });
  h.send(makeRequest(1, 'personal_sign', []));
  await tick();
  assert.equal(h.channel.pending(), 1);
  release('0xsig');
  await tick();
  assert.equal(h.channel.pending(), 0);
  assert.deepEqual(h.pendingLog, [1, 0]);
  assert.deepEqual(h.done, [{ origin: A, method: 'personal_sign', error: null }]);
});

test('events go only to the origin currently talking through the opener', async () => {
  const h = setup();
  assert.equal(h.channel.emit(A, 'accountsChanged', []), false, 'nobody has talked yet');
  h.send(makeRequest(1, 'eth_chainId', []), A);
  await tick();
  assert.equal(h.channel.emit(A, 'chainChanged', '0xc4'), true);
  assert.equal(h.channel.emit(B, 'chainChanged', '0xc4'), false);
  h.send(makeRequest(2, 'eth_chainId', []), B);   // the opener navigated to B
  await tick();
  assert.equal(h.channel.emit(A, 'chainChanged', '0x38'), false);
  assert.deepEqual(h.posted.filter((p) => p.msg.type === 'event'), [{ msg: makeEvent('chainChanged', '0xc4'), target: A }]);
});

test('ready is posted to the hinted origin only when it is a gateway site', () => {
  const ok = setup({ hash: '#origin=' + encodeURIComponent(A) });
  ok.channel.sendReady();
  assert.deepEqual(ok.posted, [{ msg: makeReady(), target: A }]);
  for (const hash of ['', '#origin=https%3A%2F%2Fevil.com', '#origin=*', '#origin=' + encodeURIComponent('https://tapekit.org'), '#x=1']) {
    const h = setup({ hash });
    assert.equal(h.channel.sendReady(), false, hash);
    assert.deepEqual(h.posted, []);
  }
  const lonely = setup({ opener: null, hash: '#origin=' + encodeURIComponent(A) });
  assert.equal(lonely.channel.sendReady(), false);
});

test('stop removes the listener', async () => {
  const h = setup();
  h.channel.stop();
  assert.equal(h.win.listeners.size, 0);
  h.send(makeRequest(1, 'eth_chainId', []));
  await tick();
  assert.equal(h.calls.length, 0);
});
