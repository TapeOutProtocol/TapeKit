// Popup transport for the fallback client (design §10.2): the site page opens the hub on the gateway root with
// window.open and talks to it with postMessage (envelope: protocol.js; hub side: src/popup-channel.js).
// Bundled into wallet/client.js by wallet/build-client.mjs; its only import is protocol.js, which is bundled too.
//
// Rules this file keeps:
//   - Only requests that need the hub open it. Local answers (chain, accounts), read-only calls (straight to a
//     public node of the site's chain) and unknown methods (4200) never open a window.
//   - window.open runs synchronously inside request(), so it is still inside the click that caused it. When the
//     browser refuses (no user gesture, or popups blocked) the request fails with 4100 and asks for a click.
//   - The hub treats only the FIRST request after its `ready` as carrying the click, so that request is the one
//     that opened the window. Requests made before `ready` are queued in order; the sync reads go last.
//   - Strict postMessage: sends go to the exact hub origin, and only messages whose source is the popup this
//     page opened and whose origin is the hub origin are read.
//   - When the popup closes (polled: there is no close event across origins), every pending request fails 4001.
//   - When the hub never says `ready` (it failed to load, or the window is not a TapeKit hub), the queued
//     requests would wait forever: after `readyTimeoutMs` the window is closed and they fail 4900. Nothing was
//     sent to it yet, so closing it cannot drop a request the wallet is working on.
import { ERR, LIMITS, classify, rpcError, paramsSize, makeRequest, readEnvelope } from '../src/protocol.js';

export const POPUP_NAME = 'tapekit-wallet';
export const POPUP_FEATURES = 'popup,width=400,height=640';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const CHAIN_HEX = /^0x[0-9a-f]{1,14}$/;
const SYNC = 'sync';   // marks the transport's own reads after `ready`; their answers never reach the site

const cleanAccounts = (v) => (Array.isArray(v) ? v.filter((a) => typeof a === 'string' && ADDRESS.test(a)) : []);
const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const without = (map, key) => { const next = new Map(map); next.delete(key); return next; };

/** Accounts granted in an EIP-2255 permission list (wallet_requestPermissions result). */
function permittedAccounts(list) {
  if (!Array.isArray(list)) return [];
  const perm = list.find((p) => p && p.parentCapability === 'eth_accounts');
  const caveat = perm && Array.isArray(perm.caveats) ? perm.caveats.find((c) => c && c.type === 'restrictReturnedAccounts') : null;
  return caveat ? cleanAccounts(caveat.value) : [];
}

function nodeError(e) {
  const ok = !!e && typeof e === 'object' && Number.isInteger(e.code) && typeof e.message === 'string';
  if (!ok) return rpcError(ERR.INTERNAL, 'The node returned a malformed error.');
  return typeof e.data === 'string' ? rpcError(e.code, e.message, e.data) : rpcError(e.code, e.message);
}

/**
 * @param {{ win: Window, hubUrl: string, hubOrigin: string, chainId: string, nodes: Record<string, string[]>,
 *           messages: Record<'popup'|'closed'|'load', {zh:string,en:string}>,
 *           fetchImpl?: typeof fetch, pollMs?: number, readyTimeoutMs?: number, timeoutMs?: number }} opts
 */
export function createPopupTransport({ win, hubUrl, hubOrigin, chainId, nodes, messages, fetchImpl, pollMs = 400, readyTimeoutMs = 20_000, timeoutMs = 15_000 }) {
  const lang = /^zh\b/i.test(String((win.navigator && win.navigator.language) || '')) ? 'zh' : 'en';
  const doFetch = fetchImpl || ((url, init) => win.fetch(url, init));
  const failure = (code, key) => rpcError(code, messages[key][lang], { reason: key, messages: { zh: messages[key].zh, en: messages[key].en } });

  let popup = null;           // the hub window this page opened
  let ready = false;          // the hub in `popup` has said `ready`
  let outbox = [];            // requests waiting for `ready`, oldest first
  let pending = new Map();    // id → { method, resolve, reject }  (replaced on change, never edited)
  let seq = 0;
  let readSeq = 0;
  let poll = null;
  let readyTimer = null;      // fails the session when the hub never says `ready`
  let accounts = Object.freeze([]);   // [] until the hub returns accounts in this page session
  let chain = chainId;                // the site's home chain until the hub reports otherwise
  let accountsEpoch = 0;              // bumped on every accounts change, so a late sync answer cannot undo it
  let chainEpoch = 0;
  let listener = () => {};

  function setAccounts(next) {
    const list = Object.freeze(cleanAccounts(next));
    accountsEpoch += 1;
    if (sameList(accounts, list)) return;
    accounts = list;
    listener('accountsChanged', [...list]);
  }

  function setChain(next) {
    if (typeof next !== 'string' || !CHAIN_HEX.test(next)) return;
    chainEpoch += 1;
    if (next === chain) return;
    chain = next;
    listener('chainChanged', next);
  }

  function local(method) {
    if (method === 'eth_chainId') return chain;
    if (method === 'net_version') return String(Number.parseInt(chain, 16));
    if (method === 'eth_accounts') return [...accounts];
    return accounts.length   // wallet_getPermissions (EIP-2255)
      ? [{ parentCapability: 'eth_accounts', invoker: win.location.origin, caveats: [{ type: 'restrictReturnedAccounts', value: [...accounts] }] }]
      : [];
  }

  /** Read-only call to the first public node of the site's current chain (same rule as the hub's rpc.js). */
  async function read(method, params) {
    const list = nodes[chain];
    if (!list || !list.length) throw rpcError(ERR.CHAIN_DISCONNECTED, `No public node for chain ${chain}.`);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let body;
    try {
      const res = await doFetch(list[0], {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++readSeq, method, params: params === undefined ? [] : params }),
        credentials: 'omit',
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      body = await res.json();
    } catch (e) {
      throw rpcError(ERR.INTERNAL, `The public node did not answer (${String((e && e.message) || e).slice(0, 100)}).`);
    } finally {
      clearTimeout(timer);
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw rpcError(ERR.INTERNAL, 'The node returned a malformed reply.');
    if (body.error !== undefined && body.error !== null) throw nodeError(body.error);
    if (!('result' in body)) throw rpcError(ERR.INTERNAL, 'The node returned no result.');
    return body.result;
  }

  // ---- popup session ----

  function post(msg) {
    try {
      popup.postMessage(msg, hubOrigin);
    } catch {
      settle(msg.id, (p) => p.reject(rpcError(ERR.INVALID_PARAMS, 'The request could not be sent to TapeKit.')));
    }
  }

  function settle(id, fn) {
    const p = pending.get(id);
    if (!p) return;
    pending = without(pending, id);
    fn(p);
  }

  /** Fail every request this page is waiting on: popup closed or reloaded (4001), or never ready (4900). */
  function failAll(code = ERR.USER_REJECTED, key = 'closed') {
    const all = pending;
    pending = new Map();
    outbox = [];
    for (const p of all.values()) if (p.method !== SYNC) p.reject(failure(code, key));
  }

  function stopReadyTimer() {
    if (readyTimer !== null) clearTimeout(readyTimer);
    readyTimer = null;
  }

  function endSession(code, key) {
    if (poll !== null) clearInterval(poll);
    poll = null;
    stopReadyTimer();
    popup = null;
    ready = false;
    failAll(code, key);
  }

  function onReadyTimeout() {
    readyTimer = null;
    if (!popup || ready) return;
    const w = popup;
    endSession(ERR.DISCONNECTED, 'load');
    try { w.close(); } catch { /* the user can still close it */ }
  }

  /** Reuse the open hub, or open it now (inside the caller's click). False when the browser refuses. */
  function openHub() {
    if (popup && !popup.closed) return true;
    if (popup) endSession();
    let w = null;
    try {
      w = win.open(hubUrl + '#origin=' + encodeURIComponent(win.location.origin), POPUP_NAME, POPUP_FEATURES);
    } catch {
      w = null;
    }
    if (!w) return false;
    popup = w;
    ready = false;
    poll = setInterval(() => { if (popup && popup.closed) endSession(); }, pollMs);
    readyTimer = setTimeout(onReadyTimeout, readyTimeoutMs);
    return true;
  }

  /** After `ready`: learn the site's chain and accounts from the hub (local answers there, never a prompt). */
  function sync() {
    const sent = { accounts: accountsEpoch, chain: chainEpoch };
    const ask = (method, apply) => {
      const id = ++seq;
      pending = new Map(pending).set(id, { method: SYNC, resolve: apply, reject: () => {} });
      post(makeRequest(id, method, []));
    };
    ask('eth_chainId', (r) => { if (chainEpoch === sent.chain) setChain(r); });
    ask('eth_accounts', (r) => { if (accountsEpoch === sent.accounts) setAccounts(r); });
  }

  function onReady() {
    stopReadyTimer();
    if (ready) failAll();   // the hub reloaded: requests it was holding are gone
    ready = true;
    const queued = outbox;
    outbox = [];
    for (const msg of queued) post(msg);
    sync();
  }

  function learn(method, result) {
    if (method === 'eth_requestAccounts') setAccounts(result);
    else if (method === 'wallet_requestPermissions') setAccounts(permittedAccounts(result));
    else if (method === 'wallet_revokePermissions') setAccounts([]);
  }

  function onResponse(msg) {
    settle(msg.id, (p) => {
      if ('error' in msg) return p.reject(msg.error);
      if (p.method !== SYNC) learn(p.method, msg.result);
      return p.resolve(msg.result);
    });
  }

  function onEvent(msg) {
    if (msg.event === 'accountsChanged') setAccounts(msg.data);
    else if (msg.event === 'chainChanged') setChain(msg.data);
  }

  function onMessage(event) {
    if (!popup || !event || event.source !== popup || event.origin !== hubOrigin) return;
    const msg = readEnvelope(event.data);
    if (!msg) return;
    if (msg.type === 'ready') onReady();
    else if (msg.type === 'response') onResponse(msg);
    else if (msg.type === 'event') onEvent(msg);
  }

  function viaHub(method, params) {
    if (paramsSize(params) > LIMITS.maxParamsBytes) return Promise.reject(rpcError(ERR.INVALID_PARAMS, 'Request parameters are larger than 256 KB.'));
    try {
      if (typeof structuredClone === 'function') structuredClone(params);   // fail now, not after the click is used up
    } catch {
      return Promise.reject(rpcError(ERR.INVALID_PARAMS, 'params must be plain data.'));
    }
    if (!openHub()) return Promise.reject(failure(ERR.UNAUTHORIZED, 'popup'));
    const id = ++seq;
    const msg = makeRequest(id, method, params);
    return new Promise((resolve, reject) => {
      pending = new Map(pending).set(id, { method, resolve, reject });
      if (ready) post(msg);
      else outbox = [...outbox, msg];
    });
  }

  win.addEventListener('message', onMessage);

  return Object.freeze({
    request({ method, params }) {
      const kind = classify(method);
      if (kind === 'local') return Promise.resolve(local(method));
      if (kind === 'read') return read(method, params);
      if (kind === 'reject') return Promise.reject(rpcError(ERR.UNSUPPORTED_METHOD, `TapeKit does not support ${String(method).slice(0, 100)}.`));
      return viaHub(method, params);
    },
    subscribe(fn) { listener = typeof fn === 'function' ? fn : () => {}; },
  });
}

