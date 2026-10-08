// Wallet router core (design §5–§7, decisions D-c and D-d). It runs in the hub page; every dependency is
// injected so it also runs under `node --test`.
//
// createRouter(deps) → { handle, walletAccountsChanged, syncWallet, accounts, revokeSite }
//
// deps
//   hubLocation  the hub page's own location; a site is an origin one label below its host (origin.js)
//   adapter, provider  the selected wallet (adapters/*) and its EIP-1193 provider; null → 4900
//   store        { get(): perms, set(perms) } (sync or async); perms shape: see permissions.js
//   identity     { resolve(site) } from identity.js; its `holder` binds each grant to the circuit owner
//   ui           { notice(info), confirmSite(info) → 'ok'|other, confirmSign(card) → 'ok'|other }
//   rpc          (chainHex, method, params) → result: read-only calls to public nodes, never the wallet
//   emit         (origin, event, data): deliver 'accountsChanged' / 'chainChanged' to that ONE site.
//                Events are pushed through this callback (not router.on): the channel that owns the
//                site's port or window does the delivery.
//   now          () → ms; onError (error, where): failures that must not fail the request (e.g. the notice)
//
// handle({ origin, method, params, gesture }) → result, or rejects with a plain { code, message, data? }.
//   origin   must come from the browser (MessageEvent.origin / MessageSender.origin), never from the page.
//   gesture  true only when the trusted side saw a user activation (design §6); anything else is false.
import { classify, rpcError, isRpcError, paramsSize, LIMITS, ERR } from './protocol.js';
import { parseSiteOrigin } from './origin.js';
import { chainForArea, chainParams, isSupportedChain, normalizeChainId } from './chains.js';
import { grant, revoke, accountsFor, siteChain, setSiteChain, isGranted, grantedOrigins, grantedAt, grantHolder, permissionList, checkPermissionRequest } from './permissions.js';
import { siweMismatch } from './siwe.js';
import { readSignRequest } from './params.js';
import { createQueue } from './queue.js';
import { normalizeWalletError } from './adapters/common.js';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const noop = () => {};
const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const homeChain = (site) => chainForArea(site.area);
const cleanAccounts = (list) => (Array.isArray(list) ? [...new Set(list.filter((a) => typeof a === 'string' && ADDRESS.test(a)).map((a) => a.toLowerCase()))] : []);
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

function checkDeps({ hubLocation, store, identity, ui, rpc }) {
  if (!hubLocation) throw new TypeError('router: hubLocation is required');
  if (!store || typeof store.get !== 'function' || typeof store.set !== 'function') throw new TypeError('router: store.get/set are required');
  if (!identity || typeof identity.resolve !== 'function') throw new TypeError('router: identity.resolve is required');
  if (!ui || ['notice', 'confirmSite', 'confirmSign'].some((k) => typeof ui[k] !== 'function')) throw new TypeError('router: ui.notice/confirmSite/confirmSign are required');
  if (typeof rpc !== 'function') throw new TypeError('router: rpc is required');
}

export function createRouter(deps = {}) {
  checkDeps(deps);
  const { hubLocation, adapter = null, provider = null, store, identity, ui, rpc, emit = noop, now = Date.now, onError = noop } = deps;
  const queue = createQueue(LIMITS.maxQueuedPerSite);
  let walletAccounts = Object.freeze([]);   // last known accounts of the real wallet (replaced, never mutated)

  // ---- real wallet ----

  function requireWallet() {
    if (!adapter || !provider) throw rpcError(ERR.DISCONNECTED);
  }

  /** Replace the cached wallet accounts and tell each granted site whose view changed. Returns notified origins. */
  async function setWalletAccounts(list) {
    const prev = walletAccounts;
    const next = Object.freeze(cleanAccounts(list));
    walletAccounts = next;
    const notified = new Set();
    if (sameList(prev, next)) return notified;
    const perms = await store.get();
    for (const origin of grantedOrigins(perms)) {
      const after = accountsFor(perms, origin, next);
      if (!sameList(accountsFor(perms, origin, prev), after)) { emit(origin, 'accountsChanged', after); notified.add(origin); }
    }
    return notified;
  }

  async function readWalletAccounts() {
    requireWallet();
    const notified = await setWalletAccounts(await adapter.request(provider, { method: 'eth_accounts' }));
    return { accounts: walletAccounts, notified };
  }

  /** The one-time wallet connection (R1): only when the wallet has not given the hub an account yet. */
  async function connectWallet() {
    requireWallet();
    const list = cleanAccounts(await adapter.request(provider, { method: 'eth_requestAccounts' }));
    if (!list.length) throw rpcError(ERR.UNAUTHORIZED, 'The wallet did not provide an account.');
    await setWalletAccounts(list);
    return list[0];
  }

  // ---- UI and identity ----

  async function confirm(ask) {
    let answer;
    try {
      answer = await ask();
    } catch (e) {
      onError(e, 'confirm');   // hub closed or UI failure: same as the user saying no
      throw rpcError(ERR.USER_REJECTED);
    }
    if (answer !== 'ok') throw rpcError(ERR.USER_REJECTED);
  }

  function notify(info) {
    try {
      Promise.resolve(ui.notice(info)).catch((e) => onError(e, 'notice'));
    } catch (e) {
      onError(e, 'notice');
    }
  }

  async function requireOk(site) {
    const id = await identity.resolve(site);
    const status = id && typeof id.status === 'string' ? id.status : 'unavailable';
    if (status !== 'ok') throw rpcError(ERR.UNAUTHORIZED, `This site cannot use the wallet (status: ${status}).`, { status });
    return id;
  }

  // ---- method handlers ----

  // Local answers never touch the network, so they do not re-check the circuit holder: after the circuit
  // changes hands, eth_accounts can still show the old grant until the site's next permission or signing
  // request, which resolves the identity and drops the grant (dropStaleGrant). Nothing can be signed meanwhile.
  async function local(site, method) {
    const perms = await store.get();
    const chain = siteChain(perms, site.origin, homeChain(site));
    if (method === 'eth_chainId') return chain;
    if (method === 'net_version') return String(Number.parseInt(chain, 16));
    const accounts = accountsFor(perms, site.origin, walletAccounts);
    return method === 'eth_accounts' ? accounts : permissionList(site.origin, accounts, grantedAt(perms, site.origin));
  }

  async function read(site, method, params) {
    const chain = siteChain(await store.get(), site.origin, homeChain(site));
    try {
      return await rpc(chain, method, params === undefined ? [] : params);
    } catch (e) {
      throw normalizeWalletError(e);
    }
  }

  async function newGrant(site, id, current, gesture) {
    if (!gesture) await confirm(() => ui.confirmSite({ origin: site.origin, identity: id, account: current[0] || null }));
    const account = current[0] || (await connectWallet());
    const perms = grant(await store.get(), site.origin, [account], { chainId: homeChain(site), now: now(), holder: id.holder, container: id.container });
    await store.set(perms);
    const visible = accountsFor(perms, site.origin, walletAccounts);
    if (gesture) notify({ origin: site.origin, identity: id, account });
    emit(site.origin, 'accountsChanged', visible);
    return visible;
  }

  async function permission(site, method, params, gesture) {
    if (method === 'wallet_requestPermissions') checkPermissionRequest(params);
    const id = await requireOk(site);
    await dropStaleGrant(site, id);
    const { accounts: current } = await readWalletAccounts();
    let visible = accountsFor(await store.get(), site.origin, current);
    if (!visible.length) visible = await newGrant(site, id, current, gesture);
    if (method === 'eth_requestAccounts') return visible;
    return permissionList(site.origin, visible, grantedAt(await store.get(), site.origin));
  }

  async function revokeSite(site) {
    const perms = await store.get();
    const home = homeChain(site);
    const chain = siteChain(perms, site.origin, home);
    const hadAccounts = accountsFor(perms, site.origin, walletAccounts).length > 0;
    const cleared = revoke(perms, site.origin);
    await store.set(chain === home ? cleared : setSiteChain(cleared, site.origin, chain));   // the site keeps its chain
    if (hadAccounts) emit(site.origin, 'accountsChanged', []);
    return null;
  }

  /**
   * SPEC §7.3: a circuit can change hands, and the same origin then belongs to a new holder. A grant made
   * for another holder is revoked (like the site revoking itself), so the request continues as "not granted".
   */
  async function dropStaleGrant(site, id) {
    const perms = await store.get();
    const holder = typeof id.holder === 'string' ? id.holder.toLowerCase() : null;
    if (isGranted(perms, site.origin) && grantHolder(perms, site.origin) !== holder) await revokeSite(site);
  }

  /** Switch only this site's virtual chain (design §5.3). Site-supplied chain params are ignored (EIP-3085). */
  async function chain(site, method, params) {
    const p = Array.isArray(params) ? params[0] : null;
    if (!isPlainObject(p)) throw rpcError(ERR.INVALID_PARAMS, 'Expected [{ chainId }].');
    const hex = normalizeChainId(p.chainId);
    if (!hex) throw rpcError(ERR.INVALID_PARAMS, 'Malformed chainId.');
    if (!isSupportedChain(hex)) throw rpcError(ERR.UNRECOGNIZED_CHAIN);
    const perms = await store.get();
    if (siteChain(perms, site.origin, homeChain(site)) === hex) return null;
    await store.set(setSiteChain(perms, site.origin, hex));
    emit(site.origin, 'chainChanged', hex);
    return null;
  }

  /** Design §5.5: the signer must still be the wallet's current account, else 4100 + accountsChanged. */
  async function mustBeCurrent(site, perms, address) {
    const { accounts, notified } = await readWalletAccounts();
    if (accounts.includes(address)) return;
    if (!notified.has(site.origin)) emit(site.origin, 'accountsChanged', accountsFor(perms, site.origin, accounts));
    throw rpcError(ERR.UNAUTHORIZED, 'The wallet account changed. Connect again to continue.');
  }

  async function sign(site, method, params) {
    const id = await requireOk(site);
    await dropStaleGrant(site, id);
    requireWallet();
    const perms = await store.get();
    if (!isGranted(perms, site.origin)) throw rpcError(ERR.UNAUTHORIZED, 'This site is not connected.');
    const { address, chainId: asked } = readSignRequest(method, params);
    if (!accountsFor(perms, site.origin, [address]).length) throw rpcError(ERR.UNAUTHORIZED, 'This address is not connected to this site.');
    const chainHex = siteChain(perms, site.origin, homeChain(site));
    if (asked !== null && asked !== chainHex) throw rpcError(ERR.CHAIN_DISCONNECTED, `The request is for chain ${asked}, but this site is on ${chainHex}.`);
    await mustBeCurrent(site, perms, address);
    const siweWarning = method === 'personal_sign' && siweMismatch(params[0], site.host);
    await confirm(() => ui.confirmSign({ origin: site.origin, identity: id, method, params, chainId: chainHex, siweWarning }));
    await mustBeCurrent(site, perms, address);   // the user may have switched accounts while the card was open
    await adapter.ensureChain(provider, chainHex, chainParams(chainHex));
    return adapter.request(provider, { method, params });
  }

  const QUEUED = { permission, revoke: revokeSite, chain, sign };

  function dispatch({ origin, method, params, gesture } = {}) {
    const site = parseSiteOrigin(origin, hubLocation);
    if (!site) throw rpcError(ERR.UNAUTHORIZED, 'Requests are only accepted from TapeKit gateway sites.');
    if (params !== undefined && (params === null || typeof params !== 'object')) throw rpcError(ERR.INVALID_PARAMS, 'params must be an array or an object.');
    if (paramsSize(params) > LIMITS.maxParamsBytes) throw rpcError(ERR.INVALID_PARAMS, 'Request parameters are larger than 256 KB.');
    const kind = classify(method);
    if (kind === 'local') return local(site, method);
    if (kind === 'read') return read(site, method, params);
    if (kind === 'reject') throw rpcError(ERR.UNSUPPORTED_METHOD, `TapeKit does not support ${String(method).slice(0, 100)}.`);
    return queue.run(site.origin, () => QUEUED[kind](site, method, params, gesture === true));
  }

  async function handle(request) {
    try {
      return await dispatch(request || {});
    } catch (e) {
      if (isRpcError(e)) throw e;
      onError(e, 'router');
      throw rpcError(ERR.INTERNAL);
    }
  }

  return Object.freeze({
    handle,
    /** Call with the wallet's `accountsChanged` payload. */
    walletAccountsChanged: async (accounts) => { await setWalletAccounts(accounts); },
    /** Read the wallet's accounts once (e.g. when the hub opens). Does not prompt. */
    syncWallet: async () => (await readWalletAccounts()).accounts,
    /** The wallet's accounts as last seen by the router (for the extension's snapshot). Never prompts. */
    accounts: () => [...walletAccounts],
    /** The hub's "revoke" button. Goes through the queue but does not count toward the site's limit. */
    revokeSite: (origin) => {
      const site = parseSiteOrigin(origin, hubLocation);
      if (!site) return Promise.reject(rpcError(ERR.UNAUTHORIZED));
      return queue.run(site.origin, () => revokeSite(site), { limited: false });
    },
  });
}
