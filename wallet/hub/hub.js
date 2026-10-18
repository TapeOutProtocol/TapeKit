// TapeKit wallet hub (design §3, §9, §10.2). One page on the gateway root (/.tape/wallet/) that every on-chain
// site talks to, so the real wallet only ever sees this one origin and is connected once (R1).
//
// This is the only gateway page with scripts: the status and notice pages stay script-free, but the hub has
// to run the router, talk to the wallet extension and resolve site identities. It is locked down instead:
// header CSP (scripts and styles from this origin only, frame-ancestors 'none'), no inline code, nothing
// external, grants in localStorage (never cookies), and it never registers a Service Worker.
//
// Channels, both fed into the same router (`handle`) and both listed in `channels` for router events:
//   - popup channel: a site's client script opened this page in a new tab, or in a small popup window for a
//     message signature (popup-channel.js, design §10.2 and §10.3);
//   - extension channel: the TapeKit extension's hub-relay.js runs in this page (ext-channel.js, design §10.1).
//     When the extension opened this tab or window itself (`hello` with managed: true), the hub auto-closes it
//     through the extension, and it publishes a snapshot of the grants after every change so the extension can
//     answer eth_chainId / eth_accounts while no hub is open.
//
// OKX Wallet refuses connect, transaction and chain-switch calls from a popup-type window without showing
// anything, but lets a plain personal_sign and eth_signTypedData_v4 through (research/manual-test.md). The hub
// knows it is in a popup window from the extension (`hello`: the notice window, or the focused small window for
// a message signature) or from the client script's URL hint (#window=popup, only for personal_sign). There the
// router's canPrompt() is false: it signs messages, and typed data while the wallet is already on the site's
// chain, and answers anything that needs a refused call 4900 'needs-tab'. The extension then moves the request
// to a hub tab (design §10.3, 2026-10-16 and 2026-10-17); a site's script gets the error.
import { createKernel, createIdbCache, createMemoryCache } from '/.tape/kernel/index.js';
import { createIdentityResolver } from '/.tape/wallet/src/identity.js';
import { createRouter } from '/.tape/wallet/src/router.js';
import { detectWallets, chooseWallet } from '/.tape/wallet/src/detect.js';
import { ADAPTERS } from '/.tape/wallet/src/adapters/index.js';
import { createLocalStore, readChoice, writeChoice, PERMS_KEY } from '/.tape/wallet/src/store.js';
import { createReadRpc } from '/.tape/wallet/src/rpc.js';
import { createPopupChannel, hintedPopupWindow } from '/.tape/wallet/src/popup-channel.js';
import { createExtChannel } from '/.tape/wallet/src/ext-channel.js';
import { createIdleCloser } from '/.tape/wallet/src/idle.js';
import { pickLang, tr, errorText } from '/.tape/wallet/src/i18n.js';
import { REASON_NEEDS_TAB } from '/.tape/wallet/src/protocol.js';
import { parseSiteOrigin } from '/.tape/wallet/src/origin.js';
import { grantedOrigins, grantInfo } from '/.tape/wallet/src/permissions.js';
import { createCards, NOTICE_MS } from './cards.js';
import { createPanels } from './panels.js';

const CLOSE_AFTER_MS = 3000;        // the hub closes this long after the last request (design §10.1)
const FIRST_REQUEST_MS = 15_000;    // ...or this long after opening if no request ever arrives
const WALLET_SYNC_MS = 2000;        // do not let a slow wallet hold up the first request

const lang = pickLang(navigator.language);
const t = (key, vars) => tr(lang, key, vars);
const hubLocation = location.href;
const onError = (e, where) => console.error('[tapekit-wallet]', where, e);
const storage = (() => { try { return window.localStorage; } catch { return null; } })();
const store = createLocalStore({ storage, key: PERMS_KEY, onError });
const openedBySite = !!window.opener;   // a site's client script opened this tab (window.open keeps the opener)
// The site's script opened this page in a popup window (popup-channel.js hintedPopupWindow: its word can only
// make the hub refuse more). Read once, at load.
const scriptPopup = hintedPopupWindow(window);
// The auto-closer: for a tab a site opened now (window.close(); Chrome then shows the site's tab again); for a
// tab or window the extension opened, once the extension says so (startManagedCloser).
let closer = openedBySite ? createIdleCloser({ delayMs: CLOSE_AFTER_MS, initialHoldMs: FIRST_REQUEST_MS, close: () => window.close() }) : null;
let keepOpen = false;   // install guidance is showing: never auto-close
const cards = createCards({ doc: document, win: window, lang, hubHost: location.host });
const panels = createPanels({ doc: document, lang });
const channels = [];

document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
document.title = t('hub.title');
document.getElementById('title').textContent = t('hub.title');
document.getElementById('intro').textContent = t('hub.intro');

/** Router events go to every channel; each delivers only to the sites it can reach. */
function emit(origin, event, data) {
  for (const c of channels) c.emit(origin, event, data);
  if (event === 'accountsChanged') refreshSites();
  publishSnapshot();
}

async function busyWhile(work) {
  if (closer) closer.busy();
  try { return await work(); } finally { if (closer) closer.done(); }
}

const routerReady = bootRouter();
let routerNow = null;   // the router once booted (set before any request handler sees it)
routerReady.then((r) => { routerNow = r; }, () => {});

function revokeSite(origin) {
  busyWhile(async () => (await routerReady).revokeSite(origin))
    .catch((e) => onError(e, 'revoke'))
    .finally(() => { refreshSites(); publishSnapshot(); });
}

function refreshSites() {
  const perms = store.get();
  const entries = grantedOrigins(perms).map((origin) => {
    const site = parseSiteOrigin(origin, hubLocation);
    const info = grantInfo(perms, origin);
    return { origin, name: site ? site.name : origin, container: info.container, accounts: info.accounts, grantedAt: info.grantedAt };
  });
  panels.showSites(entries, revokeSite);
}

async function fetchJson(url) {
  try {
    const r = await fetch(url, { cache: 'no-store', credentials: 'omit' });
    return r.ok ? await r.json() : {};
  } catch (e) {
    onError(e, 'config');
    return {};
  }
}

/** Same blocklist the gateway applies (sw.js refreshBlocklist): blocked sites resolve to status 'blocked'. */
async function loadBlocklist(url) {
  try {
    const r = await fetch(url || '/.tape/blocklist.txt', { cache: 'no-store', credentials: 'omit' });
    if (!r.ok) return new Set();
    return new Set((await r.text()).split('\n').map((l) => l.trim().toLowerCase()).filter((l) => l && !l.startsWith('#')));
  } catch (e) {
    onError(e, 'blocklist');
    return new Set();
  }
}

/** Kernel for site identities. Nodes come only from the gateway operator's config, as in sw.js boot(). */
async function bootKernel() {
  const config = await fetchJson('/.tape/config.json');
  const rpcUrls = Array.isArray(config.rpcUrls) && config.rpcUrls.length ? config.rpcUrls : undefined;
  const [cache, blocked] = await Promise.all([
    createIdbCache('tapekit-wallet').catch(() => createMemoryCache()),
    loadBlocklist(config.blocklistUrl),
  ]);
  // resolveTtlMs 0: identity.js keeps the only cache (30 s, design §4). With the kernel's own 60 s cache on
  // top, a holder change or a new block could go unseen for up to 90 s.
  return createKernel({ cache, rpcUrls, resolveTtlMs: 0, isBlocked: ({ container, name }) => blocked.has(String(container).toLowerCase()) || blocked.has(name) });
}

function changeWallet() {
  writeChoice(storage, null);
  location.reload();
}

/** Exactly one wallet → use it (R1); several → remembered choice or ask; none → install guidance. */
async function selectWallet(found) {
  const { selected, needsPick } = chooseWallet(found, readChoice(storage));
  if (!found.length) {
    panels.walletNone(ADAPTERS);
    keepOpen = true;
    if (closer) closer.disable();   // keep the guidance on screen
    return null;
  }
  const canChange = found.length > 1 && !openedBySite;   // reloading would drop the site's requests
  if (!needsPick) {
    panels.walletUsing(selected.adapter.label, canChange ? changeWallet : null);
    return selected;
  }
  const id = await busyWhile(() => panels.walletPick(found));
  writeChoice(storage, id);
  panels.walletUsing(found.find((x) => x.adapter.id === id).adapter.label, canChange ? changeWallet : null);
  return found.find((x) => x.adapter.id === id);
}

function watchWallet(provider, router) {
  if (typeof provider.on !== 'function') return;
  try {
    provider.on('accountsChanged', (accounts) => { router.walletAccountsChanged(accounts).catch((e) => onError(e, 'wallet.accounts')); });
  } catch (e) {
    onError(e, 'wallet.on');
  }
}

async function bootRouter() {
  panels.walletLoading();
  const [kernel, found] = await Promise.all([bootKernel(), detectWallets(window)]);
  const selected = await selectWallet(found);
  const router = createRouter({
    hubLocation,
    adapter: selected ? selected.adapter : null,
    provider: selected ? selected.provider : null,
    store,
    identity: createIdentityResolver({ kernel }),
    ui: {
      notice: (info) => {
        if (closer) closer.hold(NOTICE_MS);
        return cards.notice(info, { onRevoke: revokeSite });
      },
      confirmSite: (info) => { extChannel.requestFocus(); return cards.confirmSite(info); },
      confirmSign: (card) => { extChannel.requestFocus(); return cards.confirmSign(card); },
    },
    rpc: createReadRpc({ fetchImpl: (url, init) => fetch(url, init) }),
    emit,
    onError,
    canPrompt: () => !scriptPopup && !extChannel.inPopupWindow(),
  });
  if (selected) {
    watchWallet(selected.provider, router);
    const sync = router.syncWallet().catch((e) => onError(e, 'wallet.sync'));
    sync.then(publishSnapshot);   // also when it settles after the race below
    await Promise.race([sync, new Promise((r) => setTimeout(r, WALLET_SYNC_MS))]);
  }
  return router;
}

function requestDone({ origin, error }) {
  publishSnapshot();
  if (!error) { panels.showStatus(''); return; }
  const site = parseSiteOrigin(origin, hubLocation);
  const name = site ? site.name : origin;
  if (error.data && error.data.reason === REASON_NEEDS_TAB) {
    // The extension moves the request to a hub tab; a site's script cannot, so it gets the error.
    panels.showStatus(extChannel.inPopupWindow() ? t('status.moved', { site: name }) : t('status.failed', { site: name, reason: errorText(lang, 'tab') }));
    return;
  }
  panels.showStatus(t('status.failed', { site: name, reason: errorText(lang, error.code) }));
}

let lastPending = 0;
const popupChannel = createPopupChannel({
  win: window,
  hubLocation,
  handle: async (req) => (await routerReady).handle(req),
  onPendingChange: (n) => {
    if (closer) { if (n > lastPending) closer.busy(); else closer.done(); }
    lastPending = n;
  },
  onRequestDone: requestDone,
  onError,
});
channels.push(popupChannel);

// ---- extension channel

let closeAsked = false;   // the managed closer has asked the extension to close this window
let lastExtPending = 0;

// No initial hold: the extension sends its queued requests right behind `hello`, so the notice window closes
// 5 s after the notice (design §6), not 15 s after opening.
function managedCloser() {
  return createIdleCloser({ delayMs: CLOSE_AFTER_MS, close: () => { closeAsked = true; extChannel.requestClose(); } });
}

/** The extension opened this window: close it through the extension once idle (window.close() may be refused). */
function startManagedCloser() {
  if (closer || keepOpen) return;
  closer = managedCloser();
  closer.start();
}

const extChannel = createExtChannel({
  win: window,
  hubLocation,
  handle: async (req) => (await routerReady).handle(req),
  revoke: async (origin) => {
    try { return await (await routerReady).revokeSite(origin); } finally { refreshSites(); }
  },
  onHello: ({ managed }) => {
    if (managed) startManagedCloser();
    publishSnapshot();
  },
  onPendingChange: (n) => {
    // A request crossed the close request (the extension keeps the window when it has more for it): start over.
    if (n > lastExtPending && closeAsked && !keepOpen) { closeAsked = false; closer = managedCloser(); closer.start(); }
    if (closer) { if (n > lastExtPending) closer.busy(); else closer.done(); }
    lastExtPending = n;
  },
  onRequestDone: requestDone,
  beforeReply: publishNow,
  onError,
});
channels.push(extChannel);

/** Send the grants and the wallet's accounts to the extension now (nothing is sent without it). */
function publishNow() {
  extChannel.publish({ perms: store.get(), accounts: routerNow ? routerNow.accounts() : [] });
}

let publishQueued = false;
/** Same, coalesced: for changes that are not followed by an answer (wallet events, other hub windows). */
function publishSnapshot() {
  if (publishQueued) return;
  publishQueued = true;
  setTimeout(async () => {
    publishQueued = false;
    await routerReady.catch(() => null);
    publishNow();
  }, 0);
}

routerReady.catch((e) => { onError(e, 'boot'); panels.showStatus(errorText(lang, -32603)); });
window.addEventListener('storage', (e) => { if (e.key === PERMS_KEY || e.key === null) { refreshSites(); publishSnapshot(); } });
refreshSites();
if (openedBySite) {
  popupChannel.sendReady();
  closer.start();
}
