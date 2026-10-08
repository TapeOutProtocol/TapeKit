// TapeKit wallet hub (design §3, §9, §10.2). One page on the gateway root (/.tape/wallet/) that every on-chain
// site talks to, so the real wallet only ever sees this one origin and is connected once (R1).
//
// This is the only gateway page with scripts: the status and notice pages stay script-free, but the hub has
// to run the router, talk to the wallet extension and resolve site identities. It is locked down instead:
// header CSP (scripts and styles from this origin only, frame-ancestors 'none'), no inline code, nothing
// external, grants in localStorage (never cookies), and it never registers a Service Worker.
//
// Channels: today only the popup channel (a site's client script opened this window). The extension channel
// arrives later; it plugs in the same way: it gets `handle` and is added to `channels` for router events.
import { createKernel, createIdbCache, createMemoryCache } from '/.tape/kernel/index.js';
import { createIdentityResolver } from '/.tape/wallet/src/identity.js';
import { createRouter } from '/.tape/wallet/src/router.js';
import { detectWallets, chooseWallet } from '/.tape/wallet/src/detect.js';
import { ADAPTERS } from '/.tape/wallet/src/adapters/index.js';
import { createLocalStore, readChoice, writeChoice, PERMS_KEY } from '/.tape/wallet/src/store.js';
import { createReadRpc } from '/.tape/wallet/src/rpc.js';
import { createPopupChannel, claimFirstLoad } from '/.tape/wallet/src/popup-channel.js';
import { createIdleCloser } from '/.tape/wallet/src/idle.js';
import { pickLang, tr, errorText } from '/.tape/wallet/src/i18n.js';
import { parseSiteOrigin } from '/.tape/wallet/src/origin.js';
import { grantedOrigins, grantInfo } from '/.tape/wallet/src/permissions.js';
import { createCards, NOTICE_MS } from './cards.js';
import { createPanels } from './panels.js';

const CLOSE_AFTER_MS = 3000;        // popup closes this long after the last request (design §10.1)
const FIRST_REQUEST_MS = 15_000;    // ...or this long after opening if no request ever arrives
const WALLET_SYNC_MS = 2000;        // do not let a slow wallet hold up the first request

const lang = pickLang(navigator.language);
const t = (key, vars) => tr(lang, key, vars);
const hubLocation = location.href;
const onError = (e, where) => console.error('[tapekit-wallet]', where, e);
const storage = (() => { try { return window.localStorage; } catch { return null; } })();
const store = createLocalStore({ storage, key: PERMS_KEY, onError });
const isPopup = !!window.opener;
// Only the first load of this popup window may carry the opening click (popup-channel.js): the opener can
// reload the hub without one.
const firstLoad = isPopup && claimFirstLoad((() => { try { return window.sessionStorage; } catch { return null; } })());
const closer = isPopup ? createIdleCloser({ delayMs: CLOSE_AFTER_MS, initialHoldMs: FIRST_REQUEST_MS, close: () => window.close() }) : null;
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
}

async function busyWhile(work) {
  if (closer) closer.busy();
  try { return await work(); } finally { if (closer) closer.done(); }
}

const routerReady = bootRouter();

function revokeSite(origin) {
  busyWhile(async () => (await routerReady).revokeSite(origin))
    .catch((e) => onError(e, 'revoke'))
    .finally(refreshSites);
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
    if (closer) closer.disable();   // keep the guidance on screen
    return null;
  }
  const canChange = found.length > 1 && !isPopup;   // reloading a popup would drop the site's requests
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
      confirmSite: (info) => cards.confirmSite(info),
      confirmSign: (card) => cards.confirmSign(card),
    },
    rpc: createReadRpc({ fetchImpl: (url, init) => fetch(url, init) }),
    emit,
    onError,
  });
  if (selected) {
    watchWallet(selected.provider, router);
    const sync = router.syncWallet().catch((e) => onError(e, 'wallet.sync'));
    await Promise.race([sync, new Promise((r) => setTimeout(r, WALLET_SYNC_MS))]);
  }
  return router;
}

function requestDone({ origin, error }) {
  if (!error) { panels.showStatus(''); return; }
  const site = parseSiteOrigin(origin, hubLocation);
  panels.showStatus(t('status.failed', { site: site ? site.name : origin, reason: errorText(lang, error.code) }));
}

let lastPending = 0;
const popupChannel = createPopupChannel({
  win: window,
  hubLocation,
  gestureAvailable: firstLoad,
  handle: async (req) => (await routerReady).handle(req),
  onPendingChange: (n) => {
    if (closer) { if (n > lastPending) closer.busy(); else closer.done(); }
    lastPending = n;
  },
  onRequestDone: requestDone,
  onError,
});
channels.push(popupChannel);

routerReady.catch((e) => { onError(e, 'boot'); panels.showStatus(errorText(lang, -32603)); });
window.addEventListener('storage', (e) => { if (e.key === PERMS_KEY || e.key === null) refreshSites(); });
refreshSites();
if (isPopup) {
  popupChannel.sendReady();
  closer.start();
}
