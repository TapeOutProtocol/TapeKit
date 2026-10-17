// Wallet routing in the extension's service worker (design §10.1). extension/background.js calls
// createWalletBackground() at start-up; every listener is registered synchronously, as MV3 requires.
//
// Site requests arrive from relay.js over a SITE_PORT port:
//   - Identity: the port's MessageSender. The top frame only (frameId 0), a gateway site origin of the
//     configured gateway (origin.js, port included), and not a /.tape/* page. Nothing the page says about its
//     origin is read. `gesture` is relay.js's reading of navigator.userActivation in the isolated world.
//   - Local answers (eth_chainId, net_version, eth_accounts, wallet_getPermissions) come from the hub's
//     snapshot (snapshot.js), and so does a connect from a site that already has a visible grant; read-only
//     calls go straight to a public node of the site's chain (rpc.js); unknown methods get 4200. None of these
//     open a window.
//   - Everything else goes to the hub (hub-link.js), opened or reused (snapshot.js hubPlace): as a tab next to
//     the site's tab when the request may reach the wallet's connect, transaction or chain-switch calls; in the
//     small window, focused, for a message signature; else in the small window without focus. Each such
//     request is kept in chrome.storage.session (pending.js) until answered, so a restarted worker still
//     delivers it.
//   - A site whose port closed while this worker ran (page gone or put in the back/forward cache) loses its
//     unsent requests; when relay.js comes back and asks for them (`resume`), they fail 4900.
// Router events from the hub go to the tabs showing that one origin (chrome.tabs.sendMessage), never others.
// The popup's "revoke" goes to the hub like a site request; the snapshot is written only for hub pages.
import { CHANNEL, readEnvelope, classify, rpcError, isRpcError, paramsSize, LIMITS, ERR } from '../src/protocol.js';
import { SITE_PORT, HUB_PORT, EVENT_MESSAGE, REVOKE_MESSAGE } from '../src/ext-protocol.js';
import { parseSiteOrigin } from '../src/origin.js';
import { createReadRpc } from '../src/rpc.js';
import { gatewayInfo, syncRouting, ROUTING_KEY } from './routing.js';
import { SNAPSHOT_KEY, cleanSnapshot, snapshotFor, localAnswer, connectedAnswer, siteChainOf, hubPlace } from './snapshot.js';
import { createPendingStore } from './pending.js';
import { createHubLink } from './hub-link.js';

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const notEnabled = () => rpcError(ERR.UNAUTHORIZED, 'TapeKit wallet routing is not enabled for this page.');
const lost = () => rpcError(ERR.DISCONNECTED, 'The request was dropped while the page was away. Try again.');

/**
 * @param {{ chrome: object, getGateway: () => Promise<string>, fetchImpl: typeof fetch, now?: () => number,
 *           newId?: () => string, onError?: (e: unknown, where: string) => void,
 *           setTimer?: typeof setTimeout, clearTimer?: typeof clearTimeout }} deps
 */
export function createWalletBackground({
  chrome, getGateway, fetchImpl, now = Date.now, newId = () => crypto.randomUUID(),
  onError = (e, where) => console.error('[tapekit-wallet]', where, e), setTimer, clearTimer,
}) {
  const pending = createPendingStore({ area: chrome.storage.session, now, onError });
  const sitePorts = new Map();   // documentId → port, for this worker's lifetime only
  const rpc = createReadRpc({ fetchImpl });

  /** Current gateway, whether routing is on for it, and the hub's snapshot for it. Read fresh every time. */
  async function config() {
    const info = gatewayInfo(await getGateway());
    const got = await chrome.storage.local.get([ROUTING_KEY, SNAPSHOT_KEY]);
    const routing = got[ROUTING_KEY];
    if (!info || !isObject(routing) || routing.gateway !== info.gateway) return { info: null, snapshot: null };
    return { info, snapshot: snapshotFor(got[SNAPSHOT_KEY], info.hubUrl) };
  }

  /** The site behind a relay port, from the browser's MessageSender only; null when it is not one. */
  function siteOf(sender, info) {
    if (!info || !sender || sender.frameId !== 0 || !sender.tab || typeof sender.documentId !== 'string') return null;
    try {
      if (new URL(sender.url).pathname.startsWith('/.tape/')) return null;
    } catch {
      return null;
    }
    return parseSiteOrigin(sender.origin, info.hubUrl);
  }

  function deliver(entry, reply) {
    if (entry.kind !== 'site') { pending.remove([entry.hubId]); return; }
    const port = sitePorts.get(entry.documentId);
    if (!port) { pending.update(entry.hubId, { state: 'done', reply }); return; }   // relay.js will resume
    pending.remove([entry.hubId]);
    try {
      port.postMessage({ type: 'response', id: entry.siteId, ...reply });
    } catch (e) {
      onError(e, 'site.post');
    }
  }

  async function sendEvent({ origin, event, data }, info) {
    if (!parseSiteOrigin(origin, info.hubUrl)) return;
    const tabs = await chrome.tabs.query({ url: origin + '/*' });
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, { type: EVENT_MESSAGE, origin, event, data }, { frameId: 0 }).catch(() => {});
    }
  }

  async function saveSnapshot(msg, info) {
    await chrome.storage.local.set({ [SNAPSHOT_KEY]: cleanSnapshot(msg, info.hubUrl, now()) });
  }

  const hub = createHubLink({ chrome, pending, config, onReply: deliver, onEvent: sendEvent, onSnapshot: saveSnapshot, onError, setTimer, clearTimer });

  async function toHub(entry, place, info) {
    const waiting = pending.find((e) => e.origin === entry.origin && e.state !== 'done').length;
    if (waiting >= LIMITS.maxQueuedPerSite) throw rpcError(ERR.LIMIT_EXCEEDED, undefined, { pending: waiting });
    const hubId = newId();
    await pending.put({ ...entry, hubId, state: 'queued', hostTabId: null, reply: null });
    await hub.enqueue(hubId, place, info, entry.tabId);
  }

  async function request(port, req, gesture) {
    const reply = (r) => port.postMessage({ type: 'response', id: req.id, ...r });
    const { info, snapshot } = await config();
    const site = siteOf(port.sender, info);
    if (!site) return reply({ error: notEnabled() });
    try {
      const kind = classify(req.method);
      if (kind === 'reject') throw rpcError(ERR.UNSUPPORTED_METHOD, `TapeKit does not support ${req.method}.`);
      if (paramsSize(req.params) > LIMITS.maxParamsBytes) throw rpcError(ERR.INVALID_PARAMS, 'Request parameters are larger than 256 KB.');
      if (kind === 'local') return reply({ result: localAnswer(snapshot, site, req.method) });
      if (kind === 'read') return reply({ result: await rpc(siteChainOf(snapshot, site), req.method, req.params === undefined ? [] : req.params) });
      const connected = kind === 'permission' ? connectedAnswer(snapshot, site, req.method, req.params) : null;
      if (connected !== null) return reply({ result: connected });
      const sender = port.sender;
      const entry = { kind: 'site', origin: site.origin, documentId: sender.documentId, tabId: sender.tab.id, siteId: req.id, method: req.method, params: req.params, gesture };
      await toHub(entry, hubPlace(req.method, gesture, snapshot, site.origin), info);
    } catch (e) {
      if (!isRpcError(e)) onError(e, 'site.request');
      reply({ error: isRpcError(e) ? e : rpcError(ERR.INTERNAL) });
    }
  }

  /** relay.js reconnected (this worker restarted, or the page came back) and still waits for `ids`. */
  function resume(port, documentId, ids) {
    for (const id of Array.isArray(ids) ? ids.slice(0, 100) : []) {
      const [entry] = pending.find((e) => e.documentId === documentId && e.siteId === id);
      if (!entry) port.postMessage({ type: 'response', id, error: lost() });
      else if (entry.state === 'done') deliver(entry, entry.reply);
    }
  }

  async function onSiteMessage(port, raw) {
    await pending.loaded;
    if (!isObject(raw)) return;
    const documentId = port.sender && port.sender.documentId;
    if (raw.type === 'resume') return resume(port, documentId, raw.ids);
    if (raw.type !== 'request') return;
    const req = readEnvelope({ channel: CHANNEL, type: 'request', id: raw.id, method: raw.method, params: raw.params });
    if (req) await request(port, req, raw.gesture === true);
  }

  function connectSite(port) {
    const documentId = port.sender && port.sender.documentId;
    if (typeof documentId === 'string') sitePorts.set(documentId, port);
    port.onMessage.addListener((raw) => { onSiteMessage(port, raw).catch((e) => onError(e, 'site.message')); });
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      if (sitePorts.get(documentId) !== port) return;
      sitePorts.delete(documentId);
      pending.remove(pending.find((e) => e.documentId === documentId && e.state === 'queued').map((e) => e.hubId));
    });
  }

  /** The popup's revoke button. Only the extension's own popup page may ask. */
  async function revokeFromPopup(msg) {
    await pending.loaded;
    const { info } = await config();
    const site = info && parseSiteOrigin(msg.origin, info.hubUrl);
    if (!site) return false;
    const hubId = newId();
    await pending.put({ kind: 'revoke', hubId, origin: site.origin, documentId: null, tabId: null, siteId: null, state: 'queued', hostTabId: null, reply: null });
    await hub.enqueue(hubId, 'notice', info);
    return true;
  }

  const sync = () => getGateway().then((g) => syncRouting(chrome, g)).catch((e) => onError(e, 'routing.sync'));

  // ---- listeners (synchronous, at start-up)

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name === SITE_PORT) connectSite(port);
    else if (port.name === HUB_PORT) hub.connect(port);
  });
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!isObject(msg) || msg.type !== REVOKE_MESSAGE) return false;
    const popupPage = chrome.runtime.getURL('popup/');
    if (!sender || sender.id !== chrome.runtime.id || typeof sender.url !== 'string' || !sender.url.startsWith(popupPage)) return false;
    revokeFromPopup(msg).then((ok) => sendResponse({ ok }), (e) => { onError(e, 'popup.revoke'); sendResponse({ ok: false }); });
    return true;
  });
  chrome.windows.onRemoved.addListener((windowId) => { hub.windowRemoved(windowId).catch((e) => onError(e, 'hub.removed')); });
  chrome.tabs.onRemoved.addListener((tabId) => {
    pending.loaded.then(() => pending.remove(pending.find((e) => e.tabId === tabId && e.state !== 'sent').map((e) => e.hubId)));
    hub.tabRemoved(tabId).catch((e) => onError(e, 'hub.removed'));   // a hub tab or the notice window's tab
  });
  chrome.storage.onChanged.addListener((changes, area) => { if (area === 'sync' && changes.gateway) sync(); });
  chrome.permissions.onRemoved.addListener(sync);
  chrome.runtime.onStartup.addListener(sync);
  chrome.runtime.onInstalled.addListener(sync);

  // Only extension pages and this worker may read or write local storage: the routing switch and the snapshot
  // live there, and content scripts (which run inside web pages) have no business with either.
  Promise.resolve()
    .then(() => chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }))
    .catch((e) => onError(e, 'storage.access'));

  return Object.freeze({ ready: pending.loaded, config });
}
