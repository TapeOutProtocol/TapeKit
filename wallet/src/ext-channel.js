// Hub side of the extension channel (design §10.1). The TapeKit extension puts hub-relay.js (an ISOLATED-world
// content script) into this page; it talks to the hub with window.postMessage on this window (ext-protocol.js).
//
// Trust rules:
//   - Only messages whose source is this very window, from this origin, with the HUB_CHANNEL tag and the
//     'to-hub' direction are read. Other windows (a site that opened the hub, frames) never match
//     `event.source === window`; the site's own popup channel (popup-channel.js) is a separate listener.
//   - `origin` and `gesture` in a request come from the extension: the background takes the site origin from
//     the browser (MessageSender.origin, top frame only) and the gesture from the site's isolated world
//     (navigator.userActivation). This channel trusts them; the popup channel's "first request after open"
//     rule does not apply here.
//   - Nothing is accepted before the relay's `hello`, and nothing is posted before it either except the one
//     `hub-ready` that tells the relay to connect: without the extension, the hub posts nothing else.
//
// Same interface as the popup channel for the hub's fan-out: { emit(origin, event, data) → bool, pending(),
// stop() }, plus publish(snapshot), requestClose(), requestFocus(), isManaged() and inPopupWindow().
// inPopupWindow() is the background's word (it asks chrome.windows for the type of the hub's window): the page
// cannot tell, since window.toolbar.visible reads true in an extension's popup window (measured 2026-10-16).
// `beforeReply` runs right before each answer is posted: the hub publishes its grants there, so the extension
// (which handles one port's messages in order) has stored them before the site sees the answer. Without it, a
// site that calls eth_accounts right after a connect could be answered from the old copy.
import { rpcError, isRpcError, ERR } from './protocol.js';
import { parseSiteOrigin } from './origin.js';
import { HUB_CHANNEL, DIR, wrapMessage, unwrapMessage, readToHub } from './ext-protocol.js';

const noop = () => {};

/**
 * @param {{ win: Window, hubLocation: string, handle: (req: object) => Promise<unknown>,
 *           revoke: (origin: string) => Promise<unknown>, onHello?: (info: { managed: boolean, popup: boolean }) => void,
 *           onPendingChange?: (n: number) => void, onRequestDone?: (info: object) => void,
 *           beforeReply?: () => void, onError?: (e: unknown, where: string) => void }} opts
 */
export function createExtChannel({
  win, hubLocation, handle, revoke, onHello = noop, onPendingChange = noop, onRequestDone = noop, beforeReply = noop, onError = noop,
} = {}) {
  if (!win || typeof win.addEventListener !== 'function') throw new TypeError('ext-channel: win is required');
  if (typeof handle !== 'function' || typeof revoke !== 'function') throw new TypeError('ext-channel: handle and revoke are required');
  const origin = win.location.origin;
  let connected = false;
  let managed = false;
  let popup = false;
  let pending = 0;

  function post(msg) {
    try {
      win.postMessage(wrapMessage(HUB_CHANNEL, DIR.fromHub, msg), origin);
      return true;
    } catch (e) {
      onError(e, 'ext.post');   // e.g. DataCloneError: the result cannot cross postMessage
      if (msg.type === 'response' && !('error' in msg)) post({ type: 'response', id: msg.id, error: rpcError(ERR.INTERNAL) });
      return false;
    }
  }

  function setPending(n) {
    pending = n;
    onPendingChange(n);
  }

  async function run(msg, work) {
    setPending(pending + 1);
    let error = null;
    let result = null;
    try {
      result = await work();
    } catch (e) {
      if (!isRpcError(e)) onError(e, 'ext.handle');
      error = isRpcError(e) ? e : rpcError(ERR.INTERNAL);
    }
    try {
      beforeReply();
    } catch (e) {
      onError(e, 'ext.beforeReply');
    }
    post(error ? { type: 'response', id: msg.id, error } : { type: 'response', id: msg.id, result });
    setPending(pending - 1);
    onRequestDone({ origin: msg.origin, method: msg.type === 'revoke' ? 'revoke' : msg.method, error });
  }

  function onMessage(event) {
    if (!event || event.source !== win || event.origin !== origin) return;
    const msg = readToHub(unwrapMessage(event.data, HUB_CHANNEL, DIR.toHub));
    if (!msg) return;
    if (msg.type === 'hello') {
      connected = true;
      managed = msg.managed;
      popup = msg.popup;
      onHello({ managed, popup });
      return;
    }
    if (!connected) return;
    if (!parseSiteOrigin(msg.origin, hubLocation)) {
      post({ type: 'response', id: msg.id, error: rpcError(ERR.UNAUTHORIZED, 'Requests are only accepted from TapeKit gateway sites.') });
      return;
    }
    if (msg.type === 'revoke') run(msg, async () => { await revoke(msg.origin); return null; });
    else run(msg, () => handle({ origin: msg.origin, method: msg.method, params: msg.params, gesture: msg.gesture }));
  }

  win.addEventListener('message', onMessage);
  post({ type: 'hub-ready' });

  return Object.freeze({
    emit(site, event, data) {
      return connected ? post({ type: 'event', origin: site, event, data }) : false;
    },
    /** Grants and wallet accounts for the extension's local answers (eth_chainId, eth_accounts…). */
    publish({ perms, accounts }) {
      return connected ? post({ type: 'snapshot', perms, accounts }) : false;
    },
    requestClose: () => (connected && managed ? post({ type: 'close' }) : false),
    requestFocus: () => (connected && managed ? post({ type: 'focus' }) : false),
    isManaged: () => connected && managed,
    /** The extension says this hub runs in a popup-type window. */
    inPopupWindow: () => connected && popup,
    pending: () => pending,
    stop() { win.removeEventListener('message', onMessage); },
  });
}
