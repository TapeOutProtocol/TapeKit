// Where the extension opens the hub (design §10.1, revised 2026-10-16 and 2026-10-17 for OKX's focus rule). A
// "host" is one browser tab that shows the hub page; the background keeps at most one of each kind:
//   tab    the active tab of a normal window, next to the site's tab. OKX Wallet refuses connect, transaction
//          and chain-switch calls from a popup-type window without a prompt, and from any tab that is not the
//          active tab of the last focused normal window (research/manual-test.md). So every request that may
//          reach those calls opens here (snapshot.js hubPlace 'tab'), and showing the tab also focuses its window.
//   popup  the small window (400×640): focused for a message signature (hubPlace 'window'; OKX lets a plain
//          personal_sign and typed data through from there), without focus for the no-click notice, chain
//          switches and revokes ('notice'). The hub is told it is in a popup window (`hello`), and never makes
//          the wallet calls OKX refuses there.
// Host record: { kind: 'tab'|'popup', tabId, windowId, hubOrigin, returnTabId }; returnTabId is the site tab to
// show again when an idle hub tab the user is still looking at is closed. Records are replaced, never edited.
// Only chrome.tabs / chrome.windows calls live here; hub-link.js decides when to make them.

export const HUB_WINDOW = Object.freeze({ type: 'popup', width: 400, height: 640 });

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isId = (v) => Number.isInteger(v) && v >= 0;

/**
 * The tab still shows (or is loading) the hub page of `hubOrigin`. A hub tab is an ordinary tab: the user can
 * type another address into it, and then it is no longer a host. The extension holds host access to the
 * gateway root, so a hub tab's URL is readable; an unreadable URL means the tab went elsewhere.
 */
export function showsHub(tab, hubOrigin) {
  try {
    const url = new URL(tab.pendingUrl || tab.url);
    return url.origin === hubOrigin && url.pathname.startsWith('/.tape/wallet/');
  } catch {
    return false;
  }
}

/** A stored host record, or null when it is malformed. */
export function readHost(v) {
  if (!isObject(v) || (v.kind !== 'tab' && v.kind !== 'popup') || !isId(v.tabId) || !isId(v.windowId) || typeof v.hubOrigin !== 'string') return null;
  return Object.freeze({ kind: v.kind, tabId: v.tabId, windowId: v.windowId, hubOrigin: v.hubOrigin, returnTabId: isId(v.returnTabId) ? v.returnTabId : null });
}

/** @param {object} chrome */
export function createHostOps(chrome) {
  const tabOf = (id) => (isId(id) ? chrome.tabs.get(id).catch(() => null) : Promise.resolve(null));

  /**
   * Where a new hub tab goes: right after the site's tab when that tab is in a normal window; otherwise in the
   * last focused normal window; null when there is none (a new normal window is opened).
   */
  async function placeTab(siteTabId) {
    const site = await tabOf(siteTabId);
    const win = site ? await chrome.windows.get(site.windowId).catch(() => null) : null;
    if (site && win && win.type === 'normal') return { windowId: site.windowId, index: site.index + 1, openerTabId: site.id };
    const last = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => null);
    return last && last.type === 'normal' ? { windowId: last.id } : null;
  }

  /** Bring a hub tab to the front: active in its window, and that window focused (OKX's "focused" test). */
  async function showTab(tabId) {
    const tab = await tabOf(tabId);
    if (!tab) return;
    if (!tab.active) await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  }

  return Object.freeze({
    tabOf,
    showTab,

    /** The host's tab, open and still on the hub page; else null. */
    hubTab: async (host) => { const tab = await tabOf(host.tabId); return tab && showsHub(tab, host.hubOrigin) ? tab : null; },

    /** The hub tab is the one its window shows (a notice there is seen). */
    isActiveTab: async (tabId) => { const tab = await tabOf(tabId); return !!tab && tab.active === true; },

    /** Open the hub as the active tab of a normal window. */
    async openTab(url, siteTabId, hubOrigin) {
      const place = await placeTab(siteTabId);
      const tab = place
        ? await chrome.tabs.create({ url, active: true, ...place })
        : (await chrome.windows.create({ type: 'normal', url, focused: true })).tabs[0];
      await chrome.windows.update(tab.windowId, { focused: true });
      return readHost({ kind: 'tab', tabId: tab.id, windowId: tab.windowId, hubOrigin, returnTabId: siteTabId });
    },

    /** Open the hub in the small window: focused for a card the user must answer, else without focus. */
    async openPopup(url, hubOrigin, focused = false) {
      const w = await chrome.windows.create({ ...HUB_WINDOW, url, focused: focused === true });
      return readHost({ kind: 'popup', tabId: w.tabs[0].id, windowId: w.id, hubOrigin, returnTabId: null });
    },

    /** The hub asks for the user's attention (it shows a card). */
    async focus(host) {
      if (host.kind === 'tab') await showTab(host.tabId);
      else await chrome.windows.update(host.windowId, { focused: true });
    },

    /** Is this window not a normal one (a popup, an app window…)? Unknown windows count as the host's kind. */
    async inPopupWindow(windowId, host) {
      const win = await chrome.windows.get(windowId).catch(() => null);
      if (win) return win.type !== 'normal';
      return !!host && host.kind === 'popup';
    },

    /**
     * Close a host. A hub tab the user is still looking at hands the screen back to the site's tab first, so
     * the browser returns to the site rather than to whatever tab is next to the hub. A tab the user has taken
     * to another page is left alone.
     */
    async close(host) {
      if (host.kind === 'popup') { await chrome.windows.remove(host.windowId).catch(() => {}); return; }
      const tab = await tabOf(host.tabId);
      if (tab && !showsHub(tab, host.hubOrigin)) return;
      const back = tab && tab.active ? await tabOf(host.returnTabId) : null;
      if (back) {
        await chrome.tabs.update(back.id, { active: true }).catch(() => {});
        if (back.windowId !== tab.windowId) await chrome.windows.update(back.windowId, { focused: true }).catch(() => {});
      }
      await chrome.tabs.remove(host.tabId).catch(() => {});
    },
  });
}
