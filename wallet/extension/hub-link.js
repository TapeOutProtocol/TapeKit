// Background side of the hub (design §10.1, revised 2026-10-16): open or reuse the hub on the gateway root,
// hand it the queued requests once its hub-relay.js says `ready`, and settle what it answers.
//
//   - Where the hub runs (hub-host.js): a request that may reach the wallet's connect, sign or chain-switch calls
//     opens it as the active tab of a normal window, next to the site's tab; OKX Wallet refuses those calls from
//     a popup-type window without a prompt (research/manual-test.md). The no-click notice, chain switches and
//     revokes use the small notice window, opened without focus. An open hub tab takes every request that needs
//     a tab, and the others while it is the active tab (a notice in a background tab would go unseen); an open
//     notice window takes only the ones that need no tab. At most one host of each kind.
//   - Safety net: the hub in the notice window refuses a wallet call it turns out to need (the snapshot was
//     behind: the wallet dropped the hub) with 4900 'needs-tab'. Such a request moves to a hub tab, once.
//   - `hello` tells the hub whether this worker opened it (managed) and whether its window is a popup, from
//     chrome.windows: the page cannot tell (window.toolbar.visible reads true in an extension's popup window).
//   - Only the hub page of the configured gateway counts: top frame, exact origin (port included), path
//     /.tape/wallet/. Requests go only to hosts this worker opened, each bound to its host's tab id; snapshots
//     and events are taken from any such hub page (e.g. a hub tab the user opened to revoke a site).
//   - Hosts are kept in chrome.storage.session, so a restarted worker still knows them.
//   - The user closes a host → every request waiting on it fails 4001 (zh/en text, like the client script).
//     The hub page reloads → what it held is gone (4001); requests not yet sent wait for the new page.
//     The user takes a hub tab to another page → it is no longer a host: the next request opens a new one, and
//     what waited on the old one fails 4001.
//     The hub never says `ready` within 20 s → its requests fail 4900 and the host is closed.
//   - The hub asks to close when idle (its 3 s auto-close): closed unless something new is waiting for it. A hub
//     tab the user is still looking at shows the site's tab again first.
import { rpcError, ERR, REASON_NEEDS_TAB } from '../src/protocol.js';
import { readFromHub } from '../src/ext-protocol.js';
import { tr } from '../src/i18n.js';
import { createHostOps, readHost } from './hub-host.js';

export const HUB_KEY = 'tapekit-wallet:hub:v2';   // chrome.storage.session: { tab: host|null, popup: host|null }
export const READY_TIMEOUT_MS = 20_000;

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const texts = (key) => ({ zh: tr('zh', key), en: tr('en', key) });
export const closedError = () => rpcError(ERR.USER_REJECTED, tr('en', 'err.closed'), { reason: 'closed', messages: texts('err.closed') });
const loadError = () => rpcError(ERR.DISCONNECTED, tr('en', 'err.load'), { reason: 'load', messages: texts('err.load') });
const portTab = (port) => (port && port.sender && port.sender.tab ? port.sender.tab.id : null);
const needsTabError = (error) => isObject(error) && isObject(error.data) && error.data.reason === REASON_NEEDS_TAB;
const hostOf = (hosts, tabId) => [hosts.tab, hosts.popup].find((h) => h && h.tabId === tabId) || null;
const withoutHost = (hosts, host) => ({ tab: hosts.tab === host ? null : hosts.tab, popup: hosts.popup === host ? null : hosts.popup });
const withKey = (map, key, value) => new Map(map).set(key, value);
const withoutKey = (map, key) => { const next = new Map(map); next.delete(key); return next; };

/** The sender is the hub page of this gateway, in a tab's top frame. */
export function isHubSender(sender, info) {
  if (!sender || sender.frameId !== 0 || !sender.tab || sender.origin !== info.hubOrigin) return false;
  try {
    const url = new URL(sender.url);
    return url.origin === info.hubOrigin && url.pathname.startsWith('/.tape/wallet/');
  } catch {
    return false;
  }
}

/**
 * @param {{ chrome: object, pending: ReturnType<import('./pending.js').createPendingStore>,
 *           config: () => Promise<{ info: object|null }>, onReply: (entry: object, reply: object) => void,
 *           onEvent: (msg: object, info: object) => void, onSnapshot: (msg: object, info: object) => void,
 *           onError: (e: unknown, where: string) => void, setTimer?: typeof setTimeout, clearTimer?: typeof clearTimeout }} deps
 */
export function createHubLink({ chrome, pending, config, onReply, onEvent, onSnapshot, onError, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const session = chrome.storage.session;
  const ops = createHostOps(chrome);
  let ports = new Map();         // host tab id → its hub-relay port, after its `ready`
  let readyTimers = new Map();   // host tab id → timer
  let line = Promise.resolve();  // host changes run one at a time

  /** Run `step` after every host change before it. */
  function serial(step) {
    const next = line.then(step);
    line = next.catch(() => {});
    return next;
  }

  async function readHosts() {
    const got = await session.get(HUB_KEY);
    const v = got && isObject(got[HUB_KEY]) ? got[HUB_KEY] : {};
    return { tab: readHost(v.tab), popup: readHost(v.popup) };
  }
  const writeHosts = (hosts) => (hosts.tab || hosts.popup ? session.set({ [HUB_KEY]: hosts }) : session.remove(HUB_KEY));

  function rejectBound(tabId, states, error) {
    for (const e of pending.find((x) => x.hostTabId === tabId && states.includes(x.state))) onReply(e, { error });
  }

  function stopReadyTimer(tabId) {
    if (readyTimers.has(tabId)) clearTimer(readyTimers.get(tabId));
    readyTimers = withoutKey(readyTimers, tabId);
  }

  /** Forget a host (closed by the user, by Chrome or by this worker) and drop its port and timer. */
  async function forget(tabId) {
    const hosts = await readHosts();
    const host = hostOf(hosts, tabId);
    if (host) await writeHosts(withoutHost(hosts, host));
    ports = withoutKey(ports, tabId);
    stopReadyTimer(tabId);
    return host;
  }

  function armReadyTimer(tabId) {
    stopReadyTimer(tabId);
    readyTimers = withKey(readyTimers, tabId, setTimer(() => {
      readyTimers = withoutKey(readyTimers, tabId);
      if (ports.has(tabId)) return;
      rejectBound(tabId, ['queued', 'sent'], loadError());
      serial(async () => { const host = await forget(tabId); if (host) await ops.close(host); }).catch((e) => onError(e, 'hub.timeout'));
    }, READY_TIMEOUT_MS));
  }

  /** A host that is still open on the hub page and belongs to this gateway, else null. */
  async function live(host, info) {
    return host && host.hubOrigin === info.hubOrigin && await ops.hubTab(host) ? host : null;
  }

  async function ensureNow(needTab, siteTabId, info) {
    const stored = await readHosts();
    const hosts = { tab: await live(stored.tab, info), popup: await live(stored.popup, info) };
    // A stored host that is gone (closed while no worker listened, taken to another page by the user, or of an
    // old gateway): what waited on it would wait forever. It fails 4001 like a closed host, and its record goes.
    const gone = [stored.tab, stored.popup].filter((old) => old && !hostOf(hosts, old.tabId));
    for (const old of gone) {
      ports = withoutKey(ports, old.tabId);
      stopReadyTimer(old.tabId);
      rejectBound(old.tabId, ['queued', 'sent'], closedError());
    }
    if (gone.length) await writeHosts(hosts);
    if (hosts.tab && (needTab || await ops.isActiveTab(hosts.tab.tabId))) {
      const host = Number.isInteger(siteTabId) ? readHost({ ...hosts.tab, returnTabId: siteTabId }) : hosts.tab;
      await writeHosts({ ...hosts, tab: host });
      if (needTab) await ops.showTab(host.tabId);
      return host.tabId;
    }
    if (!needTab && hosts.popup) return hosts.popup.tabId;
    const host = needTab ? await ops.openTab(info.hubUrl, siteTabId, info.hubOrigin) : await ops.openPopup(info.hubUrl, info.hubOrigin);
    await writeHosts({ ...hosts, [host.kind]: host });
    armReadyTimer(host.tabId);
    return host.tabId;
  }

  /** Send every queued entry for the ready host `tabId`, oldest first. */
  function flush(tabId) {
    const port = ports.get(tabId);
    if (!port) return;
    for (const e of pending.find((x) => x.state === 'queued' && x.hostTabId === tabId)) {
      pending.update(e.hubId, { state: 'sent' });
      const msg = e.kind === 'revoke'
        ? { type: 'revoke', id: e.hubId, origin: e.origin }
        : { type: 'request', id: e.hubId, origin: e.origin, method: e.method, params: e.params, gesture: e.gesture === true };
      try {
        port.postMessage(msg);
      } catch (err) {
        onError(err, 'hub.post');
        onReply(e, { error: rpcError(ERR.INTERNAL) });
      }
    }
  }

  /**
   * Queue `hubId` (already in `pending`) for the hub, opening or reusing a host.
   * @param {boolean} needTab  snapshot.js needsTab: the request may reach the wallet's user-facing calls
   * @param {number|null} siteTabId  the requesting site's tab (where a new hub tab goes, and returns to)
   */
  async function enqueue(hubId, needTab, info, siteTabId = null) {
    let tabId;
    try {
      tabId = await serial(() => ensureNow(needTab === true, siteTabId, info));
    } catch (e) {
      onError(e, 'hub.open');
      const entry = pending.get(hubId);
      if (entry) onReply(entry, { error: rpcError(ERR.DISCONNECTED, 'TapeKit could not open its page.') });
      return;
    }
    await pending.update(hubId, { hostTabId: tabId });
    flush(tabId);
  }

  async function closeNow(tabId) {
    // More is coming: a request bound to this host, or one still choosing its host (hostTabId null).
    if (pending.find((x) => x.state !== 'done' && (x.hostTabId === tabId || x.hostTabId === null)).length) return;
    const host = await forget(tabId);
    if (host) await ops.close(host);
  }

  /** The notice window's hub needed the wallet after all: run the request again in a hub tab (once). */
  async function moveToTab(entry, info) {
    await pending.update(entry.hubId, { state: 'queued', hostTabId: null, moved: true });
    await enqueue(entry.hubId, true, info, entry.tabId);
  }

  async function onResponse(msg, host, info) {
    const e = pending.get(msg.id);
    if (!e || e.hostTabId !== host.tabId || e.state !== 'sent') return;
    if ('error' in msg && needsTabError(msg.error) && host.kind === 'popup' && e.kind === 'site' && e.moved !== true) return moveToTab(e, info);
    onReply(e, 'error' in msg ? { error: msg.error } : { result: msg.result });
  }

  async function onMessage(port, raw) {
    await pending.loaded;
    const { info } = await config();
    if (!info || !isHubSender(port.sender, info)) return;
    const tabId = portTab(port);
    const host = hostOf(await readHosts(), tabId);
    if (isObject(raw) && raw.type === 'ready') {
      port.postMessage({ type: 'hello', managed: !!host, popup: await ops.inPopupWindow(port.sender.tab.windowId, host) });
      if (!host) return;
      stopReadyTimer(tabId);
      if (raw.fresh === true) rejectBound(tabId, ['sent'], closedError());   // a new page: the old one's work is gone
      ports = withKey(ports, tabId, port);
      flush(tabId);
      return;
    }
    const msg = readFromHub(raw);
    if (!msg) return;
    if (msg.type === 'snapshot') return onSnapshot(msg, info);
    if (msg.type === 'event') return onEvent(msg, info);
    if (!host || ports.get(tabId) !== port) return;
    if (msg.type === 'response') await onResponse(msg, host, info);
    else if (msg.type === 'focus') await ops.focus(host);
    else if (msg.type === 'close') await serial(() => closeNow(tabId));
  }

  /** A tab or window is gone: if it was a host, every request waiting on it fails 4001. */
  async function hostGone(tabId) {
    await pending.loaded;
    await serial(() => forget(tabId));
    rejectBound(tabId, ['queued', 'sent'], closedError());
  }

  return Object.freeze({
    enqueue,
    flush,
    /**
     * chrome.runtime.onConnect for HUB_PORT. One port's messages are handled one after another, in the order
     * the hub sent them: the snapshot it sends right before an answer is stored before the site gets the answer.
     */
    connect(port) {
      let order = Promise.resolve();
      port.onMessage.addListener((raw) => { order = order.then(() => onMessage(port, raw)).catch((e) => onError(e, 'hub.message')); });
      port.onDisconnect.addListener(() => {
        void chrome.runtime.lastError;
        const tabId = portTab(port);
        if (ports.get(tabId) !== port) return;
        ports = withoutKey(ports, tabId);
        // The hub page unloaded while this worker ran: the requests it held are gone. Unsent ones keep waiting.
        rejectBound(tabId, ['sent'], closedError());
      });
    },
    /** chrome.tabs.onRemoved */
    tabRemoved: (tabId) => hostGone(tabId),
    /**
     * chrome.windows.onRemoved: the hosts in that window (their tabs' onRemoved may come later or not at all).
     * The stored window is where the host opened: a hub tab the user dragged to another window lives on.
     */
    async windowRemoved(windowId) {
      const hosts = await readHosts();
      for (const host of [hosts.tab, hosts.popup]) {
        if (!host || host.windowId !== windowId) continue;
        const tab = await ops.tabOf(host.tabId);
        if (!tab || tab.windowId === windowId) await hostGone(host.tabId);
      }
    },
  });
}
