// Hub side of the fallback channel (design §10.2): a site's client script opens the hub with window.open and
// talks to it with postMessage. The hub opens as a new tab, except for a message signature (personal_sign),
// which opens it in a small popup window (design §10.3, 2026-10-17; see client/transport.js).
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
//   - No click, ever (design §6; Percy's decision 2026-10-18, audit issue 3 option B): this hub cannot see the
//     click on the site. Browsers block tabs and windows opened without one, but not when the user has allowed
//     pop-ups for the site, and a site can open a blank window during any earlier click and send it here later
//     ("banked click"), or reload the hub it opened. So no request on this channel counts as a gesture: a site's
//     first connect gets the Allow / Reject dialog (router.js newGrant), and a site the user allowed gets its
//     address with no prompt until the grant is revoked.
//
// Channel interface shared with later channels (the extension relay): { emit(origin, event, data) → bool,
// pending() → number, stop() }. The hub fans router events out to every channel; each delivers only to the
// sites it can reach.
import { readEnvelope, makeResult, makeError, makeEvent, makeReady, rpcError, isRpcError, ERR } from './protocol.js';
import { parseSiteOrigin } from './origin.js';

const noop = () => {};

/** The hub URL's fragment as parameters ('#origin=…&window=…'), or null. */
function hashParams(win) {
  const hash = win && win.location && typeof win.location.hash === 'string' ? win.location.hash : '';
  return hash.startsWith('#') ? new URLSearchParams(hash.slice(1)) : null;
}

/** The opener's origin hinted in the hub URL: '#origin=<encoded origin>'. Only a hint for the handshake. */
function hintedOrigin(win, hubLocation) {
  const params = hashParams(win);
  const value = params && params.get('origin');
  return value && parseSiteOrigin(value, hubLocation) ? value : null;
}

/**
 * The site's client script says it opened this hub in a popup-type window: 'window=popup' next to '#origin='.
 * The page cannot tell on its own (window.toolbar.visible reads true in a popup opened across origins, measured
 * 2026-10-16), so the hub takes the opener's word, and its router then refuses every wallet call OKX refuses
 * from a popup window (router canPrompt) with 'needs-tab' instead of making it.
 * Taking the site's word is safe because the hint can only make the hub do less for that one site:
 *   - a false 'popup' on a tab: the hub refuses calls it could have made; the site's own requests fail 4900;
 *   - a missing hint on a popup: the hub makes the calls, as a tab would, and OKX refuses them without a prompt
 *     (4001, or a switch answered null, which ensureChain reads back and turns into 4901). The TapeKit card,
 *     the signer and account checks and the chain read-back run either way, so nothing is signed unseen.
 * Read once at load: a later fragment change is not a reload and changes nothing.
 */
export function hintedPopupWindow(win) {
  const params = hashParams(win);
  return !!win.opener && !!params && params.get('window') === 'popup';
}

/**
 * @param {{ win: Window, hubLocation: string|URL|Location, handle: (req: object) => Promise<unknown>,
 *           onPendingChange?: (n: number) => void,
 *           onRequestDone?: (info: { origin: string, method: string, error: object|null }) => void,
 *           onError?: (e: unknown, where: string) => void }} opts
 */
export function createPopupChannel({
  win, hubLocation, handle, onPendingChange = noop, onRequestDone = noop, onError = noop,
} = {}) {
  if (!win || typeof win.addEventListener !== 'function') throw new TypeError('popup-channel: win is required');
  if (typeof handle !== 'function') throw new TypeError('popup-channel: handle is required');
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

  async function answer(source, origin, msg) {
    let error = null;
    try {
      const result = await handle({ origin, method: msg.method, params: msg.params, gesture: false });
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
    talking = origin;
    setPending(pending + 1);
    answer(opener, origin, msg);
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
