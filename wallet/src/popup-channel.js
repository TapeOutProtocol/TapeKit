// Hub side of the fallback channel (design §10.2): a site's client script opens the hub with window.open (as a
// new tab since 2026-10-16: no window features, see client/transport.js) and talks to it with postMessage.
// Messages use the protocol.js envelope:
//   site → hub  { channel, type: 'request', id, method, params }
//   hub → site  { channel, type: 'response', id, result | error }   { channel, type: 'event', event, data }
//   hub → site  { channel, type: 'ready' }   once, to the origin hinted in the hub URL (#origin=…)
//
// Trust rules:
//   - Only messages whose source is window.opener AND whose browser-reported origin is a gateway site
//     (origin.js) are read. Nothing the message says about its origin or a gesture is used (readEnvelope).
//   - Replies and events go to opener.postMessage(msg, thatOrigin), never '*': if the opener has navigated
//     elsewhere since, the browser drops them.
//   - Gesture (design §6): the browser only lets a site open a tab or a window inside a user gesture, so the
//     FIRST request after the hub loads is the one that opened it. Only that request counts as a gesture, and
//     only if it arrives within `gestureWindowMs`; every later request does not.
//   - But the opener can reload or re-navigate the hub it opened at any time, without a click
//     (hub.location = …, or window.open(url, sameName)). A reloaded hub must not hand out a fresh gesture,
//     or a site could re-grant itself right after the user revoked it. The hub passes
//     gestureAvailable = claimFirstLoad(sessionStorage): sessionStorage belongs to the hub's tab (a top-level
//     browsing context, popup or not), survives its reloads and navigations, and only the hub origin can
//     write it.
//
// Channel interface shared with later channels (the extension relay): { emit(origin, event, data) → bool,
// pending() → number, stop() }. The hub fans router events out to every channel; each delivers only to the
// sites it can reach.
import { readEnvelope, makeResult, makeError, makeEvent, makeReady, rpcError, isRpcError, ERR } from './protocol.js';
import { parseSiteOrigin } from './origin.js';

const noop = () => {};

export const FIRST_LOAD_KEY = 'tapekit-wallet:popup-loaded:v1';

/**
 * True only on the first hub load in this tab; marks the tab so every later load gets false.
 * Unreadable or unwritable storage gives false (no gesture: the site confirmation is shown instead).
 * @param {Storage|null} storage  the hub's sessionStorage
 */
export function claimFirstLoad(storage, key = FIRST_LOAD_KEY) {
  if (!storage) return false;
  try {
    if (storage.getItem(key) !== null) return false;
    storage.setItem(key, '1');
    return storage.getItem(key) === '1';
  } catch {
    return false;
  }
}

/** The opener's origin hinted in the hub URL: '#origin=<encoded origin>'. Only a hint for the handshake. */
function hintedOrigin(win, hubLocation) {
  const hash = win.location && typeof win.location.hash === 'string' ? win.location.hash : '';
  if (!hash.startsWith('#')) return null;
  const value = new URLSearchParams(hash.slice(1)).get('origin');
  return value && parseSiteOrigin(value, hubLocation) ? value : null;
}

/**
 * @param {{ win: Window, hubLocation: string|URL|Location, handle: (req: object) => Promise<unknown>,
 *           gestureAvailable?: boolean, gestureWindowMs?: number, now?: () => number, onPendingChange?: (n: number) => void,
 *           onRequestDone?: (info: { origin: string, method: string, error: object|null }) => void,
 *           onError?: (e: unknown, where: string) => void }} opts
 */
export function createPopupChannel({
  win, hubLocation, handle, gestureAvailable = true, gestureWindowMs = 10_000, now = Date.now,
  onPendingChange = noop, onRequestDone = noop, onError = noop,
} = {}) {
  if (!win || typeof win.addEventListener !== 'function') throw new TypeError('popup-channel: win is required');
  if (typeof handle !== 'function') throw new TypeError('popup-channel: handle is required');
  const startedAt = now();
  let gestureUsed = gestureAvailable !== true;
  let pending = 0;
  let talking = null;   // origin of the latest accepted request: the site the opener currently shows

  function post(target, origin, msg) {
    try {
      target.postMessage(msg, origin);
      return true;
    } catch (e) {
      onError(e, 'popup.post');   // e.g. DataCloneError: the result cannot cross postMessage
      if (msg.type === 'response' && !('error' in msg)) post(target, origin, makeError(msg.id, rpcError(ERR.INTERNAL)));
      return false;
    }
  }

  function setPending(n) {
    pending = n;
    onPendingChange(n);
  }

  async function answer(source, origin, msg, gesture) {
    let error = null;
    try {
      const result = await handle({ origin, method: msg.method, params: msg.params, gesture });
      post(source, origin, makeResult(msg.id, result));
    } catch (e) {
      if (!isRpcError(e)) onError(e, 'popup.handle');
      error = isRpcError(e) ? e : rpcError(ERR.INTERNAL);
      post(source, origin, makeError(msg.id, error));
    } finally {
      setPending(pending - 1);
      onRequestDone({ origin, method: msg.method, error });
    }
  }

  function onMessage(event) {
    const opener = win.opener;
    if (!opener || !event || event.source !== opener) return;
    const origin = event.origin;
    if (!parseSiteOrigin(origin, hubLocation)) return;
    const msg = readEnvelope(event.data);
    if (!msg || msg.type !== 'request') return;
    const gesture = !gestureUsed && now() - startedAt <= gestureWindowMs;
    gestureUsed = true;
    talking = origin;
    setPending(pending + 1);
    answer(opener, origin, msg, gesture);
  }

  win.addEventListener('message', onMessage);

  return Object.freeze({
    /** Tell the opener the hub is listening. Returns false when there is no opener or no valid hint. */
    sendReady() {
      const origin = hintedOrigin(win, hubLocation);
      if (!win.opener || !origin) return false;
      return post(win.opener, origin, makeReady());
    },
    emit(origin, event, data) {
      if (!win.opener || origin !== talking) return false;
      return post(win.opener, origin, makeEvent(event, data));
    },
    pending: () => pending,
    stop() { win.removeEventListener('message', onMessage); },
  });
}
