// Which site requests may open TapeKit's card or the wallet in front of the user (audit 2026-10-18 issue 4). The
// extension can open and focus windows without a click, which no web page can. Without these rules a connected
// site in a background tab could put a focused signing window over whatever the user is doing, and do it again
// right after every Reject. OKX Wallet accepts its prompting calls only from the active tab of the focused window
// for the same reason; the hub tab satisfies that rule on the site's behalf, so the extension checks the site.
//   - A request that opens a card or the wallet (snapshot.js hubPlace 'tab' or 'window') without a click or key
//     press on the site (relay.js gesture) is accepted only from the site's tab while it is the active tab of the
//     window that has focus or of the last focused normal window, or while the hub tab TapeKit opened for that
//     very tab is the one shown there (a site often asks again right after an answer: connect, then sign in).
//     Else 4100, data.reason 'not-active'. "Last focused normal window": TapeKit's own small window takes the
//     focus for a signature, and the site's tab must not count as "background" because of it.
//   - After the user rejects such a request (4001, closing the hub included), the site's next one without a click
//     fails at once with 4001, data.reason 'rejected', for REJECT_COOLDOWN_MS. A request with a click ends it.
// The no-click notice, chain switches and revokes ('notice': the small window without focus) are not held back.
// Pauses live in chrome.storage.session like the pending requests, so a restarted worker keeps them.
import { rpcError, ERR } from '../src/protocol.js';
import { tr } from '../src/i18n.js';
import { HUB_KEY } from './hub-link.js';
import { readHost, showsHub } from './hub-host.js';

export const COOLDOWN_KEY = 'tapekit-wallet:cooldown:v1';   // chrome.storage.session: { [origin]: until (ms) }
export const REJECT_COOLDOWN_MS = 2 * 60_000;
const MAX_ORIGINS = 200;

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const texts = (key) => ({ zh: tr('zh', key), en: tr('en', key) });
export const notActiveError = () => rpcError(ERR.UNAUTHORIZED, tr('en', 'err.notActive'), { reason: 'not-active', messages: texts('err.notActive') });
export const rejectedError = () => rpcError(ERR.USER_REJECTED, tr('en', 'err.rejected'), { reason: 'rejected', messages: texts('err.rejected') });

/** Is the site's tab what the user is looking at (see the header)? Unknown tabs or windows count as no. */
export async function inFront(chrome, tabId, hubOrigin) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return false;
  const win = await chrome.windows.get(tab.windowId).catch(() => null);
  if (tab.active === true && !!win && win.focused === true) return true;   // the window the user is in now (any type)
  const last = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => null);
  if (!last || last.type !== 'normal' || last.id !== tab.windowId) return false;
  if (tab.active === true) return true;
  const got = await chrome.storage.session.get(HUB_KEY);
  const host = got && isObject(got[HUB_KEY]) ? readHost(got[HUB_KEY].tab) : null;
  if (!host || host.returnTabId !== tabId) return false;
  const hubTab = await chrome.tabs.get(host.tabId).catch(() => null);
  return !!hubTab && hubTab.active === true && hubTab.windowId === tab.windowId && showsHub(hubTab, hubOrigin);
}

/** @param {{ chrome: object, now?: () => number, onError?: (e: unknown, where: string) => void }} deps */
export function createFrontGuard({ chrome, now = Date.now, onError = () => {} }) {
  const area = chrome.storage.session;
  let pauses = {};   // origin → until; replaced, never edited
  let writing = Promise.resolve();

  const loaded = area.get(COOLDOWN_KEY).then((got) => {
    const raw = got && isObject(got[COOLDOWN_KEY]) ? got[COOLDOWN_KEY] : {};
    pauses = Object.fromEntries(Object.entries(raw).filter(([, until]) => Number.isFinite(until)));
  }).catch((e) => onError(e, 'front.load'));

  function save(next) {
    const t = now();
    pauses = Object.fromEntries(Object.entries(next).filter(([, until]) => until > t).slice(-MAX_ORIGINS));
    const copy = pauses;
    writing = writing.then(() => area.set({ [COOLDOWN_KEY]: copy })).catch((e) => onError(e, 'front.save'));
    return writing;
  }

  const paused = (origin) => Object.prototype.hasOwnProperty.call(pauses, origin) && pauses[origin] > now();

  return Object.freeze({
    /**
     * Throws the error to answer with when this request must not open UI now; else resolves.
     * @param {{ origin: string, tabId: number, place: string, gesture: boolean }} req  place: snapshot.js hubPlace
     */
    async admit({ origin, tabId, place, gesture }, info) {
      if (place !== 'tab' && place !== 'window') return;
      await loaded;
      if (gesture === true) {
        if (Object.prototype.hasOwnProperty.call(pauses, origin)) await save(Object.fromEntries(Object.entries(pauses).filter(([o]) => o !== origin)));
        return;
      }
      if (paused(origin)) throw rejectedError();
      if (!(await inFront(chrome, tabId, info.hubOrigin))) throw notActiveError();
    },
    /** The hub (or the background) answered a site request: a Reject of a card or wallet prompt starts a pause. */
    async settled(entry, reply) {
      if (!entry || entry.kind !== 'site' || (entry.place !== 'tab' && entry.place !== 'window')) return;
      if (!reply || !isObject(reply.error) || reply.error.code !== ERR.USER_REJECTED) return;
      await loaded;
      await save({ ...pauses, [entry.origin]: now() + REJECT_COOLDOWN_MS });
    },
  });
}
