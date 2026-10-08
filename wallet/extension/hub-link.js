// Background side of the hub window (design §10.1): open or reuse the hub as a small popup window on the
// gateway root, hand it the queued requests once its hub-relay.js says `ready`, and settle what it answers.
//
//   - One managed window at a time: chrome.windows.create({ type: 'popup', width: 400, height: 640 }),
//     focused or not as the caller asks (snapshot.js needsFocus); the hub asks for focus when it shows a card.
//   - Only the hub page of the configured gateway counts: top frame, exact origin (port included), path
//     /.tape/wallet/. Requests go only to the window this worker opened; snapshots and events are taken from
//     any such hub page (e.g. a hub tab the user opened to revoke a site).
//   - The window id is kept in chrome.storage.session, so a restarted worker still knows its window.
//   - The user closes the window → every request waiting on it fails 4001 (zh/en text, like the popup client).
//     The hub page reloads → what it held is gone (4001); requests not yet sent wait for the new page.
//     The hub never says `ready` within 20 s → its requests fail 4900 and the window is closed.
//   - The hub asks to close when idle (its 3 s auto-close): closed unless something new is waiting for it.
import { rpcError, ERR } from '../src/protocol.js';
import { readFromHub } from '../src/ext-protocol.js';
import { tr } from '../src/i18n.js';

export const HUB_KEY = 'tapekit-wallet:hub:v1';   // chrome.storage.session: { windowId, focused, hubOrigin }
export const HUB_WINDOW = Object.freeze({ type: 'popup', width: 400, height: 640 });
export const READY_TIMEOUT_MS = 20_000;

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const texts = (key) => ({ zh: tr('zh', key), en: tr('en', key) });
export const closedError = () => rpcError(ERR.USER_REJECTED, tr('en', 'err.closed'), { reason: 'closed', messages: texts('err.closed') });
const loadError = () => rpcError(ERR.DISCONNECTED, tr('en', 'err.load'), { reason: 'load', messages: texts('err.load') });
const portWindow = (port) => (port && port.sender && port.sender.tab ? port.sender.tab.windowId : null);

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
  let hubPort = null;       // the managed window's port, after its `ready`
  let chain = Promise.resolve();   // window open/focus steps run one at a time
  let readyTimer = null;

  const readWindow = async () => { const got = await session.get(HUB_KEY); return got && isObject(got[HUB_KEY]) ? got[HUB_KEY] : null; };
  const writeWindow = (state) => (state ? session.set({ [HUB_KEY]: state }) : session.remove(HUB_KEY));
  const windowOf = (id) => chrome.windows.get(id).catch(() => null);

  function rejectBound(windowId, states, error) {
    for (const e of pending.find((x) => x.windowId === windowId && states.includes(x.state))) onReply(e, { error });
  }

  async function focusWindow(state) {
    await chrome.windows.update(state.windowId, { focused: true });
    const next = { ...state, focused: true };
    await writeWindow(next);
    return next;
  }

  function armReadyTimer(windowId) {
    if (readyTimer !== null) clearTimer(readyTimer);
    readyTimer = setTimer(() => {
      readyTimer = null;
      if (portWindow(hubPort) === windowId) return;
      rejectBound(windowId, ['queued', 'sent'], loadError());
      readWindow().then((s) => (s && s.windowId === windowId ? writeWindow(null) : null)).catch((e) => onError(e, 'hub.timeout'));
      chrome.windows.remove(windowId).catch(() => {});
    }, READY_TIMEOUT_MS);
  }

  async function ensureNow(focus, info) {
    const state = await readWindow();
    const open = state && state.hubOrigin === info.hubOrigin ? await windowOf(state.windowId) : null;
    if (open) {
      // The user may have clicked elsewhere since: ask Chrome, not the stored flag.
      if (focus && !open.focused) await focusWindow(state);
      return state.windowId;
    }
    const w = await chrome.windows.create({ ...HUB_WINDOW, url: info.hubUrl, focused: focus === true });
    await writeWindow({ windowId: w.id, focused: focus === true, hubOrigin: info.hubOrigin });
    armReadyTimer(w.id);
    return w.id;
  }

  /** The managed hub window's id: reused (focused if asked) or newly opened. */
  function ensure(focus, info) {
    const step = chain.then(() => ensureNow(focus, info));
    chain = step.catch(() => {});
    return step;
  }

  /** Send every queued entry for the ready window, oldest first. */
  function flush() {
    if (!hubPort) return;
    const windowId = portWindow(hubPort);
    for (const e of pending.find((x) => x.state === 'queued' && x.windowId === windowId)) {
      pending.update(e.hubId, { state: 'sent' });
      const msg = e.kind === 'revoke'
        ? { type: 'revoke', id: e.hubId, origin: e.origin }
        : { type: 'request', id: e.hubId, origin: e.origin, method: e.method, params: e.params, gesture: e.gesture === true };
      try {
        hubPort.postMessage(msg);
      } catch (err) {
        onError(err, 'hub.post');
        onReply(e, { error: rpcError(ERR.INTERNAL) });
      }
    }
  }

  /** Queue `hubId` (already in `pending`) for the hub, opening the window if needed. */
  async function enqueue(hubId, focus, info) {
    let windowId;
    try {
      windowId = await ensure(focus, info);
    } catch (e) {
      onError(e, 'hub.open');
      const entry = pending.get(hubId);
      if (entry) onReply(entry, { error: rpcError(ERR.DISCONNECTED, 'TapeKit could not open its window.') });
      return;
    }
    await pending.update(hubId, { windowId });
    flush();
  }

  async function closeNow(windowId) {
    // More is coming: a request bound to this window, or one still choosing its window (windowId null).
    if (pending.find((x) => x.state !== 'done' && (x.windowId === windowId || x.windowId === null)).length) return;
    const state = await readWindow();
    if (state && state.windowId === windowId) await writeWindow(null);
    if (portWindow(hubPort) === windowId) hubPort = null;
    await chrome.windows.remove(windowId).catch(() => {});
  }

  /** The hub is idle and asks to close. Runs in the same line as `ensure`, so it cannot interleave with a reuse. */
  function closeIfIdle(windowId) {
    const step = chain.then(() => closeNow(windowId));
    chain = step.catch(() => {});
    return step;
  }

  async function onMessage(port, raw) {
    await pending.loaded;
    const { info } = await config();
    if (!info || !isHubSender(port.sender, info)) return;
    const windowId = portWindow(port);
    const state = await readWindow();
    const managed = !!state && state.windowId === windowId;
    if (isObject(raw) && raw.type === 'ready') {
      port.postMessage({ type: 'hello', managed });
      if (!managed) return;
      if (readyTimer !== null) { clearTimer(readyTimer); readyTimer = null; }
      if (raw.fresh === true) rejectBound(windowId, ['sent'], closedError());   // a new page: the old one's work is gone
      hubPort = port;
      flush();
      return;
    }
    const msg = readFromHub(raw);
    if (!msg) return;
    if (msg.type === 'snapshot') return onSnapshot(msg, info);
    if (msg.type === 'event') return onEvent(msg, info);
    if (!managed || port !== hubPort) return;
    if (msg.type === 'response') {
      const e = pending.get(msg.id);
      if (e && e.windowId === windowId && e.state === 'sent') onReply(e, 'error' in msg ? { error: msg.error } : { result: msg.result });
    } else if (msg.type === 'focus') {
      await focusWindow(state);
    } else if (msg.type === 'close') {
      await closeIfIdle(windowId);
    }
  }

  return Object.freeze({
    enqueue,
    flush,
    /**
     * chrome.runtime.onConnect for HUB_PORT. One port's messages are handled one after another, in the order
     * the hub sent them: the snapshot it sends right before an answer is stored before the site gets the answer.
     */
    connect(port) {
      let line = Promise.resolve();
      port.onMessage.addListener((raw) => { line = line.then(() => onMessage(port, raw)).catch((e) => onError(e, 'hub.message')); });
      port.onDisconnect.addListener(() => {
        void chrome.runtime.lastError;
        if (hubPort !== port) return;
        hubPort = null;
        // The hub page unloaded while this worker ran: the requests it held are gone. Unsent ones keep waiting.
        rejectBound(portWindow(port), ['sent'], closedError());
      });
    },
    /** chrome.windows.onRemoved */
    async windowRemoved(windowId) {
      await pending.loaded;
      const state = await readWindow();
      if (state && state.windowId === windowId) await writeWindow(null);
      if (portWindow(hubPort) === windowId) hubPort = null;
      rejectBound(windowId, ['queued', 'sent'], closedError());
    },
  });
}
