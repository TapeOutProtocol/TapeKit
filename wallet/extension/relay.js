// ISOLATED-world content script for gateway site pages (design §6, §10.1). Bundled by
// wallet/extension/bundle.mjs into the classic script wallet/relay.js with protocol.js and ext-protocol.js.
//
// It carries requests from the page's provider (inpage.js, MAIN world) to the extension background over a
// chrome.runtime port, and the answers back:
//   - Only window messages whose source is this window, with the PAGE_CHANNEL tag and the 'to-relay'
//     direction, are read; only the method, params and id are kept (readEnvelope). Frames and other windows
//     never match `event.source === window`, and the script itself runs in the top frame only.
//   - User gesture: on each connect request (eth_requestAccounts, wallet_requestPermissions) it reads
//     navigator.userActivation.isActive here, in the isolated world: the page cannot redefine this object,
//     and script-made clicks (element.click(), dispatched events) never activate it. The result is sent as
//     `gesture`. Nothing else in the message is about the site: the background takes the origin from the port.
//   - The port opens on the first request. Chrome may stop the background while requests wait (a signature
//     can take minutes); the port then closes and the relay reconnects at once (at most once a second) and
//     sends `resume` with the ids it still waits for. When the extension is gone (disabled, updated), connect
//     throws: everything waiting fails 4900 and later requests too.
//   - Router events come by chrome.tabs.sendMessage (no port needed) and are passed on only when they name
//     this page's origin.
import { CHANNEL, readEnvelope, makeError, makeEvent, rpcError, classify, ERR } from '../src/protocol.js';
import { PAGE_CHANNEL, SITE_PORT, EVENT_MESSAGE, DIR, wrapMessage, unwrapMessage } from '../src/ext-protocol.js';

export const RECONNECT_GAP_MS = 1000;

const extensionGone = () => rpcError(ERR.DISCONNECTED, 'The TapeKit extension was disabled or updated. Reload the page.');

/** navigator.userActivation.isActive as this (isolated) world sees it. */
export function userActive(win) {
  const ua = win.navigator && win.navigator.userActivation;
  return !!ua && ua.isActive === true;
}

/**
 * @param {{ win: Window, runtime: typeof chrome.runtime, now?: () => number,
 *           setTimer?: typeof setTimeout, clearTimer?: typeof clearTimeout }} opts
 */
export function startRelay({ win, runtime, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  if (!win || win.top !== win || !runtime) return null;
  const origin = win.location.origin;
  let port = null;
  let dead = false;
  let waiting = new Set();   // request ids sent to the background and not answered yet
  let lastConnect = -Infinity;
  let retry = null;

  const toPage = (msg) => win.postMessage(wrapMessage(PAGE_CHANNEL, DIR.toPage, msg), origin);
  const without = (id) => { const next = new Set(waiting); next.delete(id); return next; };

  function failAll() {
    const ids = waiting;
    waiting = new Set();
    for (const id of ids) toPage(makeError(id, extensionGone()));
  }

  function onPortMessage(msg) {
    if (!msg || msg.type !== 'response' || !waiting.has(msg.id)) return;
    const env = readEnvelope({ ...msg, channel: CHANNEL });
    if (!env) return;
    waiting = without(msg.id);
    toPage(env);
  }

  function onDisconnect() {
    void runtime.lastError;   // read, so Chrome does not report it as unchecked
    port = null;
    if (dead || !waiting.size || retry !== null) return;
    retry = setTimer(() => { retry = null; if (!port && waiting.size) open(); }, Math.max(0, lastConnect + RECONNECT_GAP_MS - now()));
  }

  /** Connect; when requests are still waiting (a reconnect), ask the background for them. */
  function open() {
    if (retry !== null) { clearTimer(retry); retry = null; }
    lastConnect = now();
    try {
      port = runtime.connect({ name: SITE_PORT });
    } catch {
      port = null;
      dead = true;
      failAll();
      return false;
    }
    port.onMessage.addListener(onPortMessage);
    port.onDisconnect.addListener(onDisconnect);
    if (waiting.size) port.postMessage({ type: 'resume', ids: [...waiting] });
    return true;
  }

  function onPageMessage(event) {
    if (event.source !== win) return;
    const req = readEnvelope(unwrapMessage(event.data, PAGE_CHANNEL, DIR.toRelay));
    if (!req || req.type !== 'request' || waiting.has(req.id)) return;
    const gesture = classify(req.method) === 'permission' && userActive(win);
    if (dead || (!port && !open())) { toPage(makeError(req.id, extensionGone())); return; }
    waiting = new Set(waiting).add(req.id);
    try {
      port.postMessage({ type: 'request', id: req.id, method: req.method, params: req.params, gesture });
    } catch {
      waiting = without(req.id);
      toPage(makeError(req.id, rpcError(ERR.INVALID_PARAMS, 'The request could not be sent to TapeKit.')));
    }
  }

  function onRuntimeMessage(msg, sender) {
    if (!sender || sender.id !== runtime.id || !msg || msg.type !== EVENT_MESSAGE || msg.origin !== origin) return;
    const env = readEnvelope({ channel: CHANNEL, type: 'event', event: msg.event, data: msg.data });
    if (env) toPage(makeEvent(env.event, env.data));
  }

  win.addEventListener('message', onPageMessage);
  runtime.onMessage.addListener(onRuntimeMessage);
  return Object.freeze({ waiting: () => waiting.size, connected: () => !!port });
}
