// MAIN-world content script for gateway site pages (design §10.1, R2, R6). Bundled by wallet/extension/bundle.mjs
// into the classic script wallet/inpage.js together with protocol.js, provider.js and ext-protocol.js.
//
// It gives the page the same TapeKit provider as the fallback client (provider.js): EIP-1193, announced with
// EIP-6963 as "TapeKit", also at window.tapekit.wallet, and it never touches window.ethereum. Its transport only
// posts requests to relay.js (the ISOLATED world of this page) and reads the relay's answers: every decision
// (local answers, the hub, the user gesture, the site's identity) is made outside the page.
//
// Where it installs: registered for <scheme>://*.<gateway host>/* minus the root and /.tape/*, top frame only
// (routing.js); it checks the same things again here. Pages that already have a TapeKit provider are left
// alone. The extension runs at document_start, before any page script, so when a site also bundles
// wallet/client.js, the extension's provider is the one installed and client.js steps aside (installClient
// sees window.tapekit.wallet): one TapeKit wallet per page, and the extension wins because it can show the
// site dialog without a click and reads the gesture where the page cannot touch it.
import { makeRequest, readEnvelope, rpcError, ERR } from '../src/protocol.js';
import { createProvider, announceProvider } from '../src/provider.js';
import { PAGE_CHANNEL, DIR, wrapMessage, unwrapMessage } from '../src/ext-protocol.js';

// Same shape as the kernel's parseHostLabel (kernel/src/name.js) and wallet/client/install.js.
const SITE_HOST_LABEL = /^([1-9][0-9]*)-(?:([1-9][0-9]*)-)?(0|[1-9][0-9]*)$/;

/** A top-level page on a site host (<site label>.<gateway host>), not a gateway /.tape/* page. */
export function isSitePage(win) {
  if (!win || win.top !== win || !win.location) return false;
  const { protocol, hostname, pathname } = win.location;
  if (protocol !== 'https:' && protocol !== 'http:') return false;
  if (String(pathname).startsWith('/.tape/')) return false;
  const [label, ...rest] = String(hostname).split('.');
  return SITE_HOST_LABEL.test(label) && rest.length > 0 && rest.every((part) => part.length > 0);
}

const sameList = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i]);

/** Accounts granted in an EIP-2255 permission list (wallet_requestPermissions result). */
function permittedAccounts(list) {
  const perm = Array.isArray(list) ? list.find((p) => p && p.parentCapability === 'eth_accounts') : null;
  const caveat = perm && Array.isArray(perm.caveats) ? perm.caveats.find((c) => c && c.type === 'restrictReturnedAccounts') : null;
  return caveat && Array.isArray(caveat.value) ? caveat.value : [];
}

/**
 * Transport over window.postMessage to relay.js; same interface as the popup transport, and the same event rule
 * (wallet/client/transport.js): the page's accounts start as [] and its chain as unknown; an answer that changes
 * them (eth_accounts, eth_requestAccounts, wallet_requestPermissions, wallet_revokePermissions, eth_chainId)
 * emits the event here, and a router event is passed on only when it differs from what the page knows. So a
 * connect gives one accountsChanged, and a hub window that opens and re-announces unchanged accounts to every
 * connected site gives none.
 */
export function createRelayTransport(win) {
  const origin = win.location.origin;
  let seq = 0;
  let waiting = new Map();   // id → { method, resolve, reject }; replaced on change
  let listener = () => {};
  let accounts = Object.freeze([]);
  let chain = null;   // learned from the first eth_chainId answer or chainChanged event

  function setAccounts(list) {
    if (!Array.isArray(list) || sameList(accounts, list)) return;
    accounts = Object.freeze([...list]);
    listener('accountsChanged', [...list]);
  }

  function setChain(value, fromAnswer) {
    if (typeof value !== 'string' || value === chain) return;
    const first = chain === null;
    chain = value;
    if (!(first && fromAnswer)) listener('chainChanged', value);   // learning the chain is not a change
  }

  function learn(method, result) {
    if (method === 'eth_accounts' || method === 'eth_requestAccounts') setAccounts(result);
    else if (method === 'wallet_requestPermissions') setAccounts(permittedAccounts(result));
    else if (method === 'wallet_revokePermissions') setAccounts([]);
    else if (method === 'eth_chainId') setChain(result, true);
  }

  function onEvent(event, data) {
    if (event === 'accountsChanged') setAccounts(data);
    else if (event === 'chainChanged') setChain(data, false);
    else listener(event, data);
  }

  function settle(id, fn) {
    const p = waiting.get(id);
    if (!p) return;
    const next = new Map(waiting);
    next.delete(id);
    waiting = next;
    fn(p);
  }

  win.addEventListener('message', (event) => {
    if (event.source !== win) return;
    const msg = readEnvelope(unwrapMessage(event.data, PAGE_CHANNEL, DIR.toPage));
    if (!msg) return;
    if (msg.type === 'response') settle(msg.id, (p) => { if ('error' in msg) return p.reject(msg.error); learn(p.method, msg.result); return p.resolve(msg.result); });
    else if (msg.type === 'event') onEvent(msg.event, msg.data);
  });

  return Object.freeze({
    request({ method, params }) {
      const id = ++seq;
      return new Promise((resolve, reject) => {
        waiting = new Map(waiting).set(id, { method, resolve, reject });
        try {
          win.postMessage(wrapMessage(PAGE_CHANNEL, DIR.toRelay, makeRequest(id, method, params)), origin);
        } catch {
          settle(id, (p) => p.reject(rpcError(ERR.INVALID_PARAMS, 'params must be plain data.')));
        }
      });
    },
    subscribe(fn) { listener = typeof fn === 'function' ? fn : () => {}; },
  });
}

/** Install the provider on `win`. Returns it, or null when this page does not get one. */
export function installInpage(win) {
  if (!isSitePage(win)) return null;
  const existing = win.tapekit;
  if (existing && existing.wallet) return null;
  const provider = createProvider({ transport: createRelayTransport(win) });
  const base = existing && typeof existing === 'object' ? existing : {};
  try {
    win.tapekit = Object.freeze({ ...base, wallet: provider });
  } catch {
    // window.tapekit is locked: EIP-6963 discovery below still works.
  }
  announceProvider(win, provider);
  return provider;
}
