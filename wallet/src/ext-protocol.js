// Messages of the extension channel (design §10.1). Four hops, each with its own tag or port name:
//   site page:  inpage.js (MAIN world)  ⇄ relay.js (ISOLATED)      window.postMessage, tag PAGE_CHANNEL
//   relay.js                            ⇄ extension background     chrome.runtime port SITE_PORT
//   extension background                ⇄ hub-relay.js (ISOLATED)  chrome.runtime port HUB_PORT
//   hub page:  hub-relay.js             ⇄ hub.js (MAIN world)      window.postMessage, tag HUB_CHANNEL
// Window messages are wrapped as { channel, dir, msg }: both worlds of a page see every message posted on it,
// so `dir` says which side it is for. Readers copy only known fields and drop the rest.
//
// The hub (wallet/src/ext-channel.js) and the background read the hub messages with the functions below;
// relay.js, hub-relay.js and inpage.js are bundled with this file into classic content scripts.
import { CHANNEL, readEnvelope } from './protocol.js';

export const PAGE_CHANNEL = 'tapekit-wallet-page/1';
export const HUB_CHANNEL = 'tapekit-wallet-hub/1';
export const SITE_PORT = 'tapekit-wallet-site';
export const HUB_PORT = 'tapekit-wallet-hub';
/** chrome.tabs.sendMessage type for router events (background → relay.js); events need no open port. */
export const EVENT_MESSAGE = 'tapekit-wallet:event';
/** chrome.runtime.sendMessage type for "revoke this site" from the extension popup (popup → background). */
export const REVOKE_MESSAGE = 'tapekit-wallet:revoke';
/**
 * Attribute hub-relay.js puts on the hub page's <html> at document_start: the TapeKit extension is here. Only the
 * hub origin's own scripts and extensions can write the hub's DOM, never a site, and the mark can only make the
 * hub stricter (hub.js: the script channel then hands out no click).
 */
export const HUB_MARK = 'data-tapekit-extension';

export const DIR = Object.freeze({ toRelay: 'to-relay', toPage: 'to-page', toHub: 'to-hub', fromHub: 'from-hub' });

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isHubId = (id) => typeof id === 'string' && id.length > 0 && id.length <= 100;

export const wrapMessage = (channel, dir, msg) => ({ channel, dir, msg });

/** The inner message of a window message with this tag and direction, or null. */
export function unwrapMessage(data, channel, dir) {
  return isObject(data) && data.channel === channel && data.dir === dir ? data.msg : null;
}

/** A request's method and params, checked with the site envelope rules (protocol.js). */
function readCall(method, params) {
  const env = readEnvelope({ channel: CHANNEL, type: 'request', id: 1, method, params });
  return env ? { method: env.method, params: env.params } : null;
}

/**
 * Messages for the hub (background → hub-relay → hub):
 *   { type: 'hello', managed, popup }   managed: the background opened this tab or window and will close it
 *                                        (auto-close applies); popup: it is a popup-type window, where the
 *                                        wallet's connect, transaction and chain-switch calls must not be made
 *   { type: 'request', id, origin, method, params, gesture }   origin and gesture as checked by the extension
 *   { type: 'revoke', id, origin }   the extension popup's "revoke" button
 */
export function readToHub(msg) {
  if (!isObject(msg)) return null;
  if (msg.type === 'hello') return { type: 'hello', managed: msg.managed === true, popup: msg.popup === true };
  if (!isHubId(msg.id) || typeof msg.origin !== 'string') return null;
  if (msg.type === 'revoke') return { type: 'revoke', id: msg.id, origin: msg.origin };
  if (msg.type !== 'request') return null;
  const call = readCall(msg.method, msg.params);
  return call ? { type: 'request', id: msg.id, origin: msg.origin, ...call, gesture: msg.gesture === true } : null;
}

/**
 * Messages from the hub (hub → hub-relay → background):
 *   { type: 'hub-ready' }            the hub listens (hub-relay then connects its port)
 *   { type: 'response', id, result | error }
 *   { type: 'event', origin, event, data }   a router event for that one site
 *   { type: 'snapshot', perms, accounts }    grants and wallet accounts for the extension's local answers
 *   { type: 'close' }  { type: 'focus' }     the hub is idle / shows a card the user must see
 */
export function readFromHub(msg) {
  if (!isObject(msg)) return null;
  if (msg.type === 'hub-ready' || msg.type === 'close' || msg.type === 'focus') return { type: msg.type };
  if (msg.type === 'snapshot') {
    return isObject(msg.perms) && Array.isArray(msg.accounts) ? { type: 'snapshot', perms: msg.perms, accounts: msg.accounts } : null;
  }
  if (msg.type === 'event') {
    const env = readEnvelope({ channel: CHANNEL, type: 'event', event: msg.event, data: msg.data });
    return env && typeof msg.origin === 'string' ? { type: 'event', origin: msg.origin, event: env.event, data: env.data } : null;
  }
  if (msg.type !== 'response' || !isHubId(msg.id)) return null;
  const env = readEnvelope({ ...msg, channel: CHANNEL });
  if (!env) return null;
  return 'error' in env ? { type: 'response', id: msg.id, error: env.error } : { type: 'response', id: msg.id, result: env.result };
}
