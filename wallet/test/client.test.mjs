// Offline unit tests for the fallback client (design §10.2): wallet/client/{transport,install}.js and the
// generated wallet/client.js. The popup and the hub are fakes; the real browser run is wallet/test/e2e.mjs.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createPopupTransport, HUB_NAME } from '../client/transport.js';
import { siteContext, installClient } from '../client/install.js';
import { buildClient, clientConfig, CLIENT_FILE } from '../build-client.mjs';
import { makeReady, makeResult, makeError, makeEvent, rpcError } from '../src/protocol.js';
import { chainForArea, readNodes } from '../src/chains.js';
import { parseHostLabel } from '../../kernel/src/name.js';

const CONFIG = clientConfig();
const SITE = 'https://433-0.tapekit.org';
const HUB_ORIGIN = 'https://tapekit.org';
const HUB_URL = HUB_ORIGIN + '/.tape/wallet/';
const X = '0x' + 'ab'.repeat(20);
const Y = '0x' + 'cd'.repeat(20);
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const windows = [];   // every fake page window, so afterEach can close popups a failed test left open

function fakePopup() {
  return { closed: false, posted: [], focused: 0, postMessage(msg, target) { this.posted.push({ msg: structuredClone(msg), target }); }, close() { this.closed = true; }, focus() { this.focused += 1; } };
}

/** A page window: records listeners so tests deliver MessageEvent-like objects directly. */
function fakeWindow({ href = SITE + '/', openResult = 'popup', language = 'en-US' } = {}) {
  const url = new URL(href);
  const listeners = new Map();
  const opened = [];
  const fetched = [];
  const win = {
    location: { href, origin: url.origin, protocol: url.protocol, hostname: url.hostname, port: url.port },
    navigator: { language },
    CustomEvent: globalThis.CustomEvent,
    opened,
    fetched,
    popups: [],
    addEventListener(type, fn) { listeners.set(type, [...(listeners.get(type) || []), fn]); },
    removeEventListener(type, fn) { listeners.set(type, (listeners.get(type) || []).filter((f) => f !== fn)); },
    dispatchEvent(ev) { for (const fn of listeners.get(ev.type) || []) fn(ev); return true; },
    deliver(data, { source, origin = HUB_ORIGIN } = {}) { for (const fn of listeners.get('message') || []) fn({ data, source, origin }); },
    open(...args) {
      opened.push(args);
      if (openResult !== 'popup') return null;
      const p = fakePopup();
      win.popups.push(p);
      return p;
    },
    fetchReply: { result: '0x10' },
    fetch: async (u, init) => { fetched.push({ url: u, init, body: JSON.parse(init.body) }); return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, ...win.fetchReply }) }; },
  };
  win.top = win;
  windows.push(win);
  return win;
}

function setup(opts = {}, transportOpts = {}) {
  const win = fakeWindow(opts);
  const events = [];
  const t = createPopupTransport({ win, hubUrl: HUB_URL, hubOrigin: HUB_ORIGIN, chainId: '0x38', nodes: CONFIG.nodes, messages: CONFIG.messages, pollMs: 5, ...transportOpts });
  t.subscribe((event, data) => events.push([event, data]));
  const call = (method, params) => t.request({ method, params });
  const outcome = (p) => p.then((result) => ({ result }), (error) => ({ error }));
  return { win, t, events, call, outcome };
}

/** Close every popup and wait for the poll to notice, so no interval outlives the test. */
async function closeAll(win) {
  for (const p of win.popups) p.closed = true;
  await tick(20);
}

// A failed assertion can skip a test's closeAll; an open popup keeps the transport's poll timer alive.
afterEach(async () => {
  for (const w of windows.splice(0)) for (const p of w.popups) p.closed = true;
  await tick(20);
});

const requests = (popup) => popup.posted.map((p) => p.msg).filter((m) => m.type === 'request');

test('the committed wallet/client.js is what the sources produce (run npm run build:wallet-client)', () => {
  assert.equal(fs.readFileSync(CLIENT_FILE, 'utf8'), buildClient());
});

test('the inlined chain table is the kernel site nodes and the area table', () => {
  assert.deepEqual(CONFIG.areaChains, { '': chainForArea(null), 2: chainForArea(2), 3: chainForArea(3) });
  for (const [hex, nodes] of Object.entries(CONFIG.nodes)) assert.deepEqual(nodes, [...readNodes(hex)], hex);
  for (const key of ['popup', 'closed', 'load']) assert.ok(CONFIG.messages[key].zh && CONFIG.messages[key].en, key);
  assert.match(CONFIG.messages.popup.zh, /请点网站上的按钮再试/);
});

test('siteContext: the hub is the gateway root, same scheme and port; the chain comes from the area', () => {
  const ctx = (href) => { const u = new URL(href); return siteContext({ protocol: u.protocol, hostname: u.hostname, port: u.port }, CONFIG); };
  assert.deepEqual(ctx('https://433-0.tapekit.org/x'), { hubOrigin: 'https://tapekit.org', hubUrl: 'https://tapekit.org/.tape/wallet/', chainId: '0x38' });
  assert.deepEqual(ctx('http://1-2-344.localhost:8096/'), { hubOrigin: 'http://localhost:8096', hubUrl: 'http://localhost:8096/.tape/wallet/', chainId: '0xc4' });
  assert.equal(ctx('https://12-3-2.gw.example.com/').hubOrigin, 'https://gw.example.com');
  assert.equal(ctx('https://12-3-2.gw.example.com/').chainId, '0x2105');
  for (const href of ['https://tapekit.org/', 'http://localhost:8096/', 'https://www.tapekit.org/', 'https://04246-0.tapekit.org/',
    'https://1-1-0.tapekit.org/', 'https://433-0.tapekit.org./', 'http://433-0:8096/', 'http://127.0.0.1:8096/']) {
    assert.equal(ctx(href), null, href);
  }
  assert.equal(siteContext({ protocol: 'tape:', hostname: '433-0.x', port: '' }, CONFIG), null);
});

test('the site label shape matches the kernel parseHostLabel', () => {
  const shape = /^([1-9][0-9]*)-(?:([1-9][0-9]*)-)?(0|[1-9][0-9]*)$/;
  for (const label of ['433-0', '1-2-344', '12-3-2', '4246-0', '0-0', '01-0', '1-02-3', '1-0-', 'a-0', '1', '1-2-3-4']) {
    assert.equal(!!shape.exec(label), !!parseHostLabel(label), label);
  }
});

test('local answers and unknown methods never open the hub', async () => {
  const h = setup();
  assert.equal(await h.call('eth_chainId'), '0x38');
  assert.equal(await h.call('net_version'), '56');
  assert.deepEqual(await h.call('eth_accounts'), []);
  assert.deepEqual(await h.call('wallet_getPermissions'), []);
  for (const m of ['eth_sign', 'eth_signTransaction', 'wallet_sendCalls', 'toString']) {
    const r = await h.outcome(h.call(m, []));
    assert.equal(r.error.code, 4200, m);
  }
  assert.equal(h.win.opened.length, 0);
});

test('read methods go to the first public node of the site chain, without the hub', async () => {
  const h = setup();
  assert.equal(await h.call('eth_blockNumber'), '0x10');
  assert.equal(h.win.fetched[0].url, CONFIG.nodes['0x38'][0]);
  assert.deepEqual([h.win.fetched[0].body.method, h.win.fetched[0].body.params], ['eth_blockNumber', []]);
  assert.equal(h.win.fetched[0].init.credentials, 'omit');
  h.win.fetchReply = { error: { code: 3, message: 'execution reverted', data: '0x08c379a0', extra: { x: 1 } } };
  assert.deepEqual((await h.outcome(h.call('eth_call', [{ to: X }, 'latest']))).error, { code: 3, message: 'execution reverted', data: '0x08c379a0' });
  h.win.fetch = async () => { throw new Error('offline'); };
  assert.equal((await h.outcome(h.call('eth_gasPrice'))).error.code, -32603);
  assert.equal(h.win.opened.length, 0);
});

test('without a user gesture (window.open refused) a hub request fails 4100 in both languages', async () => {
  const h = setup({ openResult: null });
  const { error } = await h.outcome(h.call('eth_requestAccounts', []));
  assert.equal(error.code, 4100);
  assert.equal(error.message, CONFIG.messages.popup.en);
  assert.deepEqual(error.data, { reason: 'popup', messages: CONFIG.messages.popup });
  assert.equal(h.win.opened.length, 1);
  const zh = setup({ openResult: null, language: 'zh-CN' });
  assert.equal((await zh.outcome(zh.call('personal_sign', ['0x68', X]))).error.message, CONFIG.messages.popup.zh);
});

test('opens the hub as a tab: exact URL and name, no window features (no popup window, no noopener)', async () => {
  const h = setup();
  h.outcome(h.call('eth_requestAccounts', []));
  // OKX refuses connect and sign calls from a popup-type window (research/manual-test.md): any features string
  // ('popup', a width, 'noopener') would change that, so there is none at all.
  assert.deepEqual(h.win.opened[0], [HUB_URL + '#origin=' + encodeURIComponent(SITE), HUB_NAME]);
  assert.equal(h.win.opened[0].length, 2);
  await closeAll(h.win);
});

test('an open hub tab is brought to the front for a connect or a signature, not for a chain switch', async () => {
  const h = setup();
  h.outcome(h.call('wallet_switchEthereumChain', [{ chainId: '0x38' }]));
  const hub = h.win.popups[0];
  h.win.deliver(makeReady(), { source: hub });
  assert.equal(hub.focused, 0, 'the tab the browser just opened is already in front');
  h.outcome(h.call('wallet_switchEthereumChain', [{ chainId: '0xc4' }]));
  assert.equal(hub.focused, 0);
  h.outcome(h.call('personal_sign', ['0x68', X]));
  h.outcome(h.call('eth_requestAccounts', []));
  assert.equal(hub.focused, 2);
  assert.equal(h.win.opened.length, 1);
  await closeAll(h.win);
});

test('the request that opened the hub is the first message after ready; sync reads follow; exact target origin', async () => {
  const h = setup();
  const first = h.call('eth_requestAccounts', []);
  const second = h.call('wallet_switchEthereumChain', [{ chainId: '0x2105' }]);
  const popup = h.win.popups[0];
  assert.equal(h.win.opened.length, 1, 'one window for both requests');
  assert.equal(popup.posted.length, 0, 'nothing is sent before ready');
  h.win.deliver(makeReady(), { source: popup });
  assert.deepEqual(requests(popup).map((m) => m.method), ['eth_requestAccounts', 'wallet_switchEthereumChain', 'eth_chainId', 'eth_accounts']);
  assert.ok(popup.posted.every((p) => p.target === HUB_ORIGIN));
  const [r1, r2] = requests(popup);
  h.win.deliver(makeResult(r1.id, [X]), { source: popup });
  h.win.deliver(makeResult(r2.id, null), { source: popup });
  assert.deepEqual(await first, [X]);
  assert.equal(await second, null);
  await closeAll(h.win);
});

test('messages from another window or another origin are ignored', async () => {
  const h = setup();
  const p = h.outcome(h.call('eth_requestAccounts', []));
  const popup = h.win.popups[0];
  h.win.deliver(makeReady(), { source: {} });                                        // not our popup
  h.win.deliver(makeReady(), { source: popup, origin: 'https://433-0.tapekit.org' }); // not the hub origin
  assert.equal(popup.posted.length, 0);
  h.win.deliver(makeReady(), { source: popup });
  const id = requests(popup)[0].id;
  h.win.deliver(makeResult(id, [Y]), { source: h.win });
  h.win.deliver(makeResult(id, [Y]), { source: popup, origin: 'https://evil.example' });
  h.win.deliver(makeEvent('accountsChanged', [Y]), { source: h.win });
  h.win.deliver({ channel: 'other', type: 'response', id, result: [Y] }, { source: popup });
  h.win.deliver(makeResult(id, [X]), { source: popup });
  assert.deepEqual(await p, { result: [X] });
  assert.deepEqual(h.events, [['accountsChanged', [X]]]);
  await closeAll(h.win);
});

test('accounts and chain: [] until the hub answers, then hub results and events, each change emitted once', async () => {
  const h = setup();
  const p = h.call('eth_requestAccounts', []);
  const popup = h.win.popups[0];
  h.win.deliver(makeReady(), { source: popup });
  const [req, syncChain, syncAccounts] = requests(popup);
  h.win.deliver(makeEvent('accountsChanged', [X]), { source: popup });
  h.win.deliver(makeResult(req.id, [X]), { source: popup });
  await p;
  h.win.deliver(makeResult(syncAccounts.id, []), { source: popup });   // late sync answers must not undo newer news
  h.win.deliver(makeEvent('chainChanged', '0xc4'), { source: popup });
  h.win.deliver(makeResult(syncChain.id, '0x38'), { source: popup });
  assert.deepEqual(await h.call('eth_accounts'), [X]);
  assert.equal(await h.call('eth_chainId'), '0xc4');
  h.win.deliver(makeEvent('chainChanged', '0x2105'), { source: popup });
  assert.equal(await h.call('eth_chainId'), '0x2105');
  assert.equal(await h.call('net_version'), '8453');
  await h.call('eth_blockNumber');
  assert.equal(h.win.fetched.at(-1).url, CONFIG.nodes['0x2105'][0], 'reads follow the chain switch');
  h.win.deliver(makeEvent('chainChanged', 'nonsense'), { source: popup });
  assert.equal(await h.call('eth_chainId'), '0x2105');
  assert.deepEqual(h.events, [['accountsChanged', [X]], ['chainChanged', '0xc4'], ['chainChanged', '0x2105']]);
  await closeAll(h.win);
});

test('the sync read learns a chain and accounts the hub already holds for this site', async () => {
  const h = setup();
  const p = h.call('personal_sign', ['0x68', X]);
  const popup = h.win.popups[0];
  h.win.deliver(makeReady(), { source: popup });
  const [req, syncChain, syncAccounts] = requests(popup);
  h.win.deliver(makeResult(syncChain.id, '0xc4'), { source: popup });
  h.win.deliver(makeResult(syncAccounts.id, [X]), { source: popup });
  assert.equal(await h.call('eth_chainId'), '0xc4');
  assert.deepEqual(await h.call('wallet_getPermissions'), [{ parentCapability: 'eth_accounts', invoker: SITE, caveats: [{ type: 'restrictReturnedAccounts', value: [X] }] }]);
  h.win.deliver(makeError(req.id, rpcError(4001)), { source: popup });
  assert.equal((await h.outcome(p)).error.code, 4001);
  await closeAll(h.win);
});

test('revoke clears the accounts; requestPermissions learns them from the permission list', async () => {
  const h = setup();
  const p1 = h.call('wallet_requestPermissions', [{ eth_accounts: {} }]);
  const popup = h.win.popups[0];
  h.win.deliver(makeReady(), { source: popup });
  h.win.deliver(makeResult(requests(popup)[0].id, [{ parentCapability: 'eth_accounts', caveats: [{ type: 'restrictReturnedAccounts', value: [X] }] }]), { source: popup });
  await p1;
  assert.deepEqual(await h.call('eth_accounts'), [X]);
  const p2 = h.call('wallet_revokePermissions', [{ eth_accounts: {} }]);
  h.win.deliver(makeResult(requests(popup).at(-1).id, null), { source: popup });
  await p2;
  assert.deepEqual(await h.call('eth_accounts'), []);
  assert.deepEqual(h.events, [['accountsChanged', [X]], ['accountsChanged', []]]);
  await closeAll(h.win);
});

test('closing the popup rejects every pending request with 4001; the next request opens a new hub', async () => {
  const h = setup();
  const a = h.outcome(h.call('personal_sign', ['0x68', X]));
  const b = h.outcome(h.call('eth_requestAccounts', []));
  h.win.deliver(makeReady(), { source: h.win.popups[0] });
  h.win.popups[0].closed = true;
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(ra.error.code, 4001);
  assert.equal(rb.error.code, 4001);
  assert.deepEqual(ra.error.data, { reason: 'closed', messages: CONFIG.messages.closed });
  h.outcome(h.call('eth_requestAccounts', []));
  assert.equal(h.win.opened.length, 2);
  await closeAll(h.win);
});

test('a hub that never says ready (failed to load): its window is closed and every queued request fails 4900', async () => {
  const h = setup({ language: 'zh-CN' }, { readyTimeoutMs: 30 });
  const a = h.outcome(h.call('eth_requestAccounts', []));
  const b = h.outcome(h.call('personal_sign', ['0x68', X]));
  const popup = h.win.popups[0];
  const settled = await Promise.race([Promise.all([a, b]), tick(1000).then(() => 'still waiting')]);
  assert.notEqual(settled, 'still waiting', 'without a ready timeout the requests wait forever');
  for (const { error } of settled) {
    assert.equal(error.code, 4900);
    assert.equal(error.message, CONFIG.messages.load.zh);
    assert.deepEqual(error.data, { reason: 'load', messages: CONFIG.messages.load });
  }
  assert.equal(popup.closed, true, 'the dead window is closed');
  assert.equal(popup.posted.length, 0, 'nothing was ever sent to it');
  h.win.deliver(makeReady(), { source: popup });   // a late ready from that window is ignored
  assert.equal(popup.posted.length, 0);
  h.outcome(h.call('eth_requestAccounts', []));
  assert.equal(h.win.opened.length, 2, 'the next click opens a fresh hub');
  await closeAll(h.win);
});

test('a ready in time cancels the ready timeout', async () => {
  const h = setup({}, { readyTimeoutMs: 30 });
  const p = h.outcome(h.call('personal_sign', ['0x68', X]));
  const popup = h.win.popups[0];
  h.win.deliver(makeReady(), { source: popup });
  await tick(80);
  assert.equal(popup.closed, false);
  h.win.deliver(makeResult(requests(popup)[0].id, '0x5a'), { source: popup });
  assert.deepEqual(await p, { result: '0x5a' });
  await closeAll(h.win);
});

test('an open, ready hub is reused: no new window and the request is sent at once', async () => {
  const h = setup();
  h.outcome(h.call('wallet_switchEthereumChain', [{ chainId: '0x38' }]));
  const popup = h.win.popups[0];
  h.win.deliver(makeReady(), { source: popup });
  h.outcome(h.call('eth_requestAccounts', []));
  assert.equal(h.win.opened.length, 1);
  assert.equal(requests(popup).at(-1).method, 'eth_requestAccounts');
  await closeAll(h.win);
});

test('a hub that reloads (second ready) fails the requests it was holding', async () => {
  const h = setup();
  const p = h.outcome(h.call('personal_sign', ['0x68', X]));
  const popup = h.win.popups[0];
  h.win.deliver(makeReady(), { source: popup });
  h.win.deliver(makeReady(), { source: popup });
  assert.equal((await p).error.code, 4001);
  await closeAll(h.win);
});

test('params that cannot be posted fail -32602 before any window opens', async () => {
  const h = setup();
  assert.equal((await h.outcome(h.call('personal_sign', [() => 1, X]))).error.code, -32602);
  assert.equal((await h.outcome(h.call('personal_sign', ['0x' + 'aa'.repeat(140_000), X]))).error.code, -32602);
  assert.equal(h.win.opened.length, 0);
});

test('installClient: top-level gateway site pages only; EIP-6963 and window.tapekit.wallet, never window.ethereum', () => {
  const win = fakeWindow();
  const seen = [];
  win.addEventListener('eip6963:announceProvider', (e) => seen.push(e.detail));
  const provider = installClient(win, CONFIG);
  assert.ok(provider && provider.isTapeKit);
  assert.equal(win.tapekit.wallet, provider);
  assert.ok(Object.isFrozen(win.tapekit));
  assert.equal(win.ethereum, undefined);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].info.rdns, 'org.tapekit');
  assert.equal(seen[0].info.name, 'TapeKit');
  win.dispatchEvent(new CustomEvent('eip6963:requestProvider'));
  assert.equal(seen.length, 2);
  assert.equal(installClient(win, CONFIG), null, 'a second copy steps aside');

  const framed = fakeWindow();
  framed.top = {};
  assert.equal(installClient(framed, CONFIG), null);
  assert.equal(framed.tapekit, undefined);
  for (const href of ['http://localhost:8096/', 'https://tapekit.org/.tape/wallet/', 'https://example.com/']) {
    const w = fakeWindow({ href });
    assert.equal(installClient(w, CONFIG), null, href);
    assert.equal(w.tapekit, undefined, href);
  }
  const keep = fakeWindow();
  keep.tapekit = { other: 1 };
  installClient(keep, CONFIG);
  assert.equal(keep.tapekit.other, 1);
});

test('the generated client.js runs as a classic script and installs the provider', async () => {
  const win = fakeWindow({ href: 'http://11636-0.localhost:8096/' });
  const seen = [];
  win.addEventListener('eip6963:announceProvider', (e) => seen.push(e.detail.info.rdns));
  const context = vm.createContext({ window: win, TextEncoder, structuredClone, setTimeout, clearTimeout, setInterval, clearInterval, AbortController, crypto: globalThis.crypto, CustomEvent });
  vm.runInContext(fs.readFileSync(CLIENT_FILE, 'utf8'), context, { filename: 'client.js' });
  assert.deepEqual(seen, ['org.tapekit']);
  const wallet = win.tapekit.wallet;
  assert.equal(await wallet.request({ method: 'eth_chainId' }), '0x38');
  await assert.rejects(wallet.request({ method: 'eth_sign', params: [] }), (e) => e.code === 4200 && e.name === 'ProviderRpcError');
  wallet.request({ method: 'eth_requestAccounts' }).catch(() => {});
  assert.equal(win.opened[0][0], 'http://localhost:8096/.tape/wallet/#origin=' + encodeURIComponent('http://11636-0.localhost:8096'));
  await closeAll(win);
  assert.ok(!/postMessage\([^)]*'\*'/.test(fs.readFileSync(CLIENT_FILE, 'utf8')), "no postMessage to '*'");
});
