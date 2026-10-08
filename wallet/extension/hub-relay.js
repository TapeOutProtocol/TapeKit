// ISOLATED-world content script on the hub page (design §10.1). Bundled by wallet/extension/bundle.mjs into the
// classic script wallet/hub-relay.js with protocol.js and ext-protocol.js. It is a filtered pipe between the
// extension background (chrome.runtime port HUB_PORT) and the hub page (window.postMessage, HUB_CHANNEL):
//   - From the page it reads only messages whose source is this window, from this origin, with the tag and
//     the 'from-hub' direction (readFromHub). To the page it posts with targetOrigin = this origin.
//   - It connects only after the hub says `hub-ready`, i.e. once a TapeKit hub listens, and sends `ready`
//     with `fresh: true` the first time on this page (a new page holds none of the old page's requests).
//   - The background answers `hello` with `managed` (it opened this window). A managed hub waits on the user
//     for minutes, so when Chrome stops the background the relay reconnects at once (at most once a second)
//     with `fresh: false`. Other hub pages (a tab the user opened) reconnect only when they have something to
//     send, so an idle tab does not keep waking the extension.
import { HUB_CHANNEL, HUB_PORT, DIR, wrapMessage, unwrapMessage, readToHub, readFromHub } from '../src/ext-protocol.js';

export const HUB_RECONNECT_GAP_MS = 1000;

/**
 * @param {{ win: Window, runtime: typeof chrome.runtime, now?: () => number,
 *           setTimer?: typeof setTimeout, clearTimer?: typeof clearTimeout }} opts
 */
export function startHubRelay({ win, runtime, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  if (!win || win.top !== win || !runtime) return null;
  const origin = win.location.origin;
  let port = null;
  let hubReady = false;
  let fresh = true;
  let managed = false;
  let dead = false;
  let outbox = [];   // hub messages waiting for a port
  let lastConnect = -Infinity;
  let retry = null;

  const toHub = (msg) => win.postMessage(wrapMessage(HUB_CHANNEL, DIR.toHub, msg), origin);

  function onPortMessage(raw) {
    const msg = readToHub(raw);
    if (!msg) return;
    if (msg.type === 'hello') managed = msg.managed;
    toHub(msg);
  }

  function onDisconnect() {
    void runtime.lastError;
    port = null;
    if (dead || !managed || retry !== null) return;
    retry = setTimer(() => { retry = null; if (!port) open(); }, Math.max(0, lastConnect + HUB_RECONNECT_GAP_MS - now()));
  }

  function open() {
    if (retry !== null) { clearTimer(retry); retry = null; }
    lastConnect = now();
    try {
      port = runtime.connect({ name: HUB_PORT });
    } catch {
      port = null;
      dead = true;   // the extension is gone; the hub keeps working for sites that use the popup client
      outbox = [];
      return;
    }
    port.onMessage.addListener(onPortMessage);
    port.onDisconnect.addListener(onDisconnect);
    const queued = outbox;
    outbox = [];
    send({ type: 'ready', fresh });
    fresh = false;
    for (const msg of queued) send(msg);
  }

  /** Post on the port; a port that closed meanwhile keeps the message for the next connection. */
  function send(msg) {
    try {
      port.postMessage(msg);
    } catch {
      if (msg.type !== 'ready') outbox = [...outbox, msg];
    }
  }

  function onPageMessage(event) {
    if (event.source !== win || event.origin !== origin) return;
    const msg = readFromHub(unwrapMessage(event.data, HUB_CHANNEL, DIR.fromHub));
    if (!msg || dead) return;
    if (msg.type === 'hub-ready') {
      if (!hubReady) { hubReady = true; open(); }
      return;
    }
    if (!hubReady) return;
    if (port) { send(msg); return; }
    outbox = [...outbox, msg];
    open();
  }

  win.addEventListener('message', onPageMessage);
  return Object.freeze({ connected: () => !!port });
}
