// Test harness for wallet/extension/background.js: a fake chrome, relay ports for site pages and hub-relay
// ports for hub pages, a fake public node and manual timers.
import { createWalletBackground } from '../extension/background.js';
import { ROUTING_KEY } from '../extension/routing.js';
import { SNAPSHOT_KEY } from '../extension/snapshot.js';
import { SITE_PORT, HUB_PORT } from '../src/ext-protocol.js';
import { fakeChrome, fakePortPair, EXT_ID, flush } from './fake-chrome.mjs';

export const GATEWAY = 'tapekit.org';
export const HUB_ORIGIN = 'https://tapekit.org';
export const HUB_URL = 'https://tapekit.org/.tape/wallet/';
export const A = 'https://4246-0.tapekit.org';
export const B = 'https://1-2-344.tapekit.org';
export const X = '0x' + 'aa'.repeat(20);
export { flush, EXT_ID };

export function manualTimers() {
  let seq = 0;
  let timers = new Map();
  return {
    set: (fn, ms) => { const id = ++seq; timers = new Map(timers).set(id, { fn, ms }); return id; },
    clear: (id) => { const next = new Map(timers); next.delete(id); timers = next; },
    fireAll() { const all = timers; timers = new Map(); for (const { fn } of all.values()) fn(); },
    count: () => timers.size,
  };
}

/**
 * @param {{ chrome?: object, snapshot?: object|null, routing?: boolean, tag?: string, fetchImpl?: Function }} opts
 *   snapshot  { perms, accounts } as the hub would publish it (stored as the background would store it)
 */
export function setup({ chrome = null, snapshot = null, routing = true, tag = 'a', fetchImpl = null } = {}) {
  const c = chrome || fakeChrome({ gateway: GATEWAY });
  if (!chrome) {
    const local = {};
    if (routing) local[ROUTING_KEY] = { gateway: GATEWAY };
    if (snapshot) local[SNAPSHOT_KEY] = { hub: HUB_ORIGIN, perms: snapshot.perms, accounts: snapshot.accounts, at: 1 };
    c.storage.local.load(local);
  }
  const errors = [];
  const timers = manualTimers();
  const fetched = [];
  let n = 0;
  const bg = createWalletBackground({
    chrome: c,
    getGateway: async () => (await c.storage.sync.get('gateway')).gateway || '',
    fetchImpl: fetchImpl || (async (url, init) => { fetched.push({ url, body: JSON.parse(init.body) }); return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: '0xread' }) }; }),
    newId: () => `${tag}-${++n}`,
    onError: (e, where) => errors.push({ where, e }),
    setTimer: timers.set,
    clearTimer: timers.clear,
  });
  return { chrome: c, bg, errors, timers, fetched };
}

/** A relay.js connection from a site page. */
export function site(chrome, { origin = A, frameId = 0, documentId = 'doc-' + origin, tabId = 7, url = origin + '/' } = {}) {
  const { port, remote } = fakePortPair(SITE_PORT, { id: EXT_ID, origin, frameId, documentId, url, tab: { id: tabId, windowId: 1 } });
  chrome.runtime.onConnect.fire(port);
  const got = [];
  remote.onMessage.addListener((m) => got.push(m));
  return {
    remote, port, got,
    ask: (id, method, params = [], gesture = false) => remote.postMessage({ type: 'request', id, method, params, gesture }),
    reply: (id) => got.find((m) => m.type === 'response' && m.id === id) || null,
  };
}

/** A hub-relay.js connection from a hub page in window `windowId`; sends `ready` at once. */
export function hub(chrome, { windowId, origin = HUB_ORIGIN, url = HUB_URL, frameId = 0, fresh = true } = {}) {
  const { port, remote } = fakePortPair(HUB_PORT, { id: EXT_ID, origin, frameId, url, tab: { id: windowId * 10, windowId } });
  chrome.runtime.onConnect.fire(port);
  const got = [];
  remote.onMessage.addListener((m) => got.push(m));
  remote.postMessage({ type: 'ready', fresh });
  return {
    remote, got,
    requests: () => got.filter((m) => m.type === 'request' || m.type === 'revoke'),
    answer: (id, result) => remote.postMessage({ type: 'response', id, result }),
    fail: (id, error) => remote.postMessage({ type: 'response', id, error }),
    send: (msg) => remote.postMessage(msg),
  };
}

export const lastWindow = (chrome) => chrome.windows.ids().at(-1);
