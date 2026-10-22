// Scripts the wallet e2e suites put into pages (wallet/test/e2e.mjs, e2e-extension.mjs).
//   fakeWallet(hubHost)  acts only in the hub: an EIP-6963 wallet announced as OKX (com.okex.wallet). Its state
//                        (connected, current chain, known chains) lives in the hub origin's localStorage, so it
//                        survives the hub closing and reopening, like a real wallet's connection. Every call is
//                        reported to Node through the binding. It knows BNB Chain and Base but not X Layer, so
//                        switching to 0xc4 needs the add flow. eth_sendTransaction only reports its params and
//                        answers a fixed hash.
//                        It copies OKX Wallet 4.19.0's focus rule exactly (research/manual-test.md; its Vdn
//                        middleware and xXa check): every request asks whether its tab is the active tab of the
//                        focused normal window. When it is not, a method in OKX_FOCUS_METHODS is refused without
//                        any prompt (wallet_switchEthereumChain answers null and does not switch, the rest fail
//                        4001 with OKX's exact message), except a plain personal_sign (no params[2].isSilentSign),
//                        which goes through; methods outside the set (eth_signTypedData_v4, eth_accounts…) are not
//                        gated. Every call is reported with `refused` and `focused` (the check's answer). The check
//                        runs in the fake wallet extension's background with chrome.tabs/chrome.windows, as OKX
//                        does, so both suites load the fake as an extension (writeFakeWalletExtension). A page
//                        cannot tell on its own: window.toolbar.visible, the spec's popup flag, reads true in a
//                        popup opened cross-origin (site → hub), and headless Chrome reports every tab visible and
//                        focused (measured 2026-10-16, Chrome 155).
//   hubProbe(hubHost)    also hub-only: counts how often the confirm card and the notice become visible, so a
//                        dialog that flashes between two polls is still seen
//   MARKER               injected next to client.js: shows that injection reached a frame at all
//   PAGE_HELPER          evaluated in a site page once loaded: records results and events, and adds the
//                        button the test clicks with real CDP input (the click runs __e2e.next)
//   writeFakeWalletExtension(dir, hubHost)  fakeWallet + hubProbe + the focus check, packed as a wallet extension;
//                        its background also has tabsState() for the suites' tab and window checks
//   hubWindow(…)         the window a hub page runs in (type, own window, size); typedData(chainId) for signatures
//   siweFor(domain), permitData(chainId)   the two cards most likely to be phished (a sign-in message for
//                        another site, a token Permit); CARD_LAYOUT  where the card's parts are on screen
import fs from 'node:fs';
import path from 'node:path';

export const BINDING = '__tapekitE2eWallet';
export const FAKE_ACCOUNT = '0x' + '7e'.repeat(20);
export const FAKE_SIGNATURE = '0x' + '5a'.repeat(65);
export const FAKE_TX_HASH = '0x' + '7a'.repeat(32);
// OKX Wallet 4.19.0 background.js (read 2026-10-16 from Percy's install, re-read 2026-10-17, minified names): the
// set T_0 and the message of its userRejectedRequest.
export const OKX_FOCUS_METHODS = Object.freeze(['wallet_switchEthereumChain', 'wallet_requestPermissions', 'eth_requestAccounts', 'wallet_requestWallets',
  'personal_sign', 'eth_signTransaction', 'eth_sendTransaction', 'eth_approveAndSwap', 'eth_signAndSendBatchTx', 'silentSign']);
export const OKX_DENIED = 'Request Signature: User denied request signature.';
const GATE_TAG = 'tapekit-e2e-fake-wallet-gate';

// Ask the fake wallet extension's background (gate.js → bg.js) like OKX's content script asks its background.
const EXTENSION_GATE = `(() => {
    let seq = 0;
    const waiting = new Map();
    addEventListener('message', (e) => {
      const d = e.source === window && e.data;
      if (!d || d.tag !== '${GATE_TAG}' || d.dir !== 'answer' || !waiting.has(d.id)) return;
      waiting.get(d.id)(d.ok === true);
      waiting.delete(d.id);
    });
    return () => new Promise((done) => { const id = ++seq; waiting.set(id, done); postMessage({ tag: '${GATE_TAG}', dir: 'ask', id }, location.origin); });
  })()`;

export const fakeWallet = (hubHost) => `(() => {
  if (location.host !== ${JSON.stringify(hubHost)} || !location.pathname.startsWith('/.tape/wallet/')) return;
  const KEY = 'tapekit-e2e-fake-wallet';
  const initial = { connected: false, chain: '0x38', chains: ['0x38', '0x2105'] };
  const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || initial; } catch { return initial; } };
  const save = (s) => localStorage.setItem(KEY, JSON.stringify(s));
  const report = (method, params, focused, refused = false) => { try { window.${BINDING}(JSON.stringify({ method, params, refused, focused })); } catch {} };
  const FOCUS = new Set(${JSON.stringify(OKX_FOCUS_METHODS)});
  const isFocused = ${EXTENSION_GATE};
  // OKX's Vdn: pass when focused, when the method is not gated, or for a plain personal_sign.
  const passes = (focused, method, params) => focused || !FOCUS.has(method)
    || (method === 'personal_sign' && !(params && params[2] && params[2].isSilentSign));
  const provider = {
    async request({ method, params }) {
      const focused = await isFocused();   // OKX asks for every request (and remembers the window)
      if (!passes(focused, method, params)) {
        report(method, params, focused, true);
        if (method === 'wallet_switchEthereumChain') return null;
        throw { code: 4001, message: ${JSON.stringify(OKX_DENIED)} };
      }
      report(method, params, focused);
      const s = load();
      switch (method) {
        case 'eth_accounts': return s.connected ? ['${FAKE_ACCOUNT}'] : [];
        case 'eth_requestAccounts': save({ ...s, connected: true }); return ['${FAKE_ACCOUNT}'];
        case 'eth_chainId': return s.chain;
        case 'wallet_switchEthereumChain': {
          const id = params[0].chainId;
          if (!s.chains.includes(id)) throw { code: 4902, message: 'Unrecognized chain ID "' + id + '".' };
          save({ ...s, chain: id });
          return null;
        }
        case 'wallet_addEthereumChain': save({ ...s, chains: [...new Set([...s.chains, params[0].chainId])] }); return null;
        case 'personal_sign': case 'eth_signTypedData_v4': return '${FAKE_SIGNATURE}';
        // Never sends anything: the test compares the reported params with what the TapeKit card showed.
        case 'eth_sendTransaction': return '${FAKE_TX_HASH}';
        default: throw { code: 4200, message: 'fake wallet: unsupported ' + method };
      }
    },
    on() {}, removeListener() {},
  };
  const info = Object.freeze({ uuid: '00000000-0000-4000-8000-00000000e2e0', name: 'OKX Wallet', icon: 'data:,', rdns: 'com.okex.wallet' });
  addEventListener('eip6963:requestProvider', () => dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) })));
})();`;

export const hubProbe = (hubHost) => `(() => {
  if (location.host !== ${JSON.stringify(hubHost)} || !location.pathname.startsWith('/.tape/wallet/')) return;
  const log = window.__hubLog = { cardShows: 0, toastShows: 0 };
  new MutationObserver((list) => {
    for (const m of list) {
      if (m.target.id === 'card' && !m.target.hidden) log.cardShows += 1;
      if (m.target.id === 'toast' && !m.target.hidden) log.toastShows += 1;
    }
  }).observe(document, { subtree: true, attributes: true, attributeFilter: ['hidden'] });
})();`;

export const MARKER = 'window.__e2eInjected = true;';

export const PAGE_HELPER = `(() => {
  if (window.__e2e) return 'again';
  const wallet = window.tapekit && window.tapekit.wallet;
  const e2e = window.__e2e = { results: {}, events: [], announced: [], next: null };
  addEventListener('eip6963:announceProvider', (ev) => e2e.announced.push(ev.detail.info));
  dispatchEvent(new Event('eip6963:requestProvider'));
  if (!wallet) return 'no-wallet';
  wallet.on('accountsChanged', (a) => e2e.events.push(['accountsChanged', a]));
  wallet.on('chainChanged', (c) => e2e.events.push(['chainChanged', c]));
  e2e.call = (key, method, params) => {
    delete e2e.results[key];
    return wallet.request({ method, params }).then(
      (result) => { e2e.results[key] = { result }; },
      (e) => { e2e.results[key] = { error: { code: e.code, message: e.message, data: e.data } }; });
  };
  const b = document.createElement('button');
  b.id = '__e2e_btn';
  b.textContent = 'e2e';
  Object.assign(b.style, { position: 'fixed', left: '0px', top: '0px', width: '160px', height: '60px', zIndex: '2147483647' });
  b.addEventListener('click', () => { const f = e2e.next; e2e.next = null; if (typeof f === 'function') f(); });
  document.documentElement.append(b);
  return 'ok';
})()`;

// ISOLATED-world half of the extension gate: page question → background → page answer.
const GATE_RELAY = `(() => {
  addEventListener('message', (e) => {
    const d = e.source === window && e.data;
    if (!d || d.tag !== '${GATE_TAG}' || d.dir !== 'ask') return;
    const answer = (ok) => postMessage({ tag: '${GATE_TAG}', dir: 'answer', id: d.id, ok }, location.origin);
    chrome.runtime.sendMessage({ type: '${GATE_TAG}' }).then((r) => answer(!!r && r.ok === true), () => answer(true));
  });
})();`;

// The background: OKX's focus check (its xXa, copied line for line), plus tabsState() for the e2e tab checks.
//   Each check reads the active tabs and the last focused window, and remembers that window (IXa) unless it is a
//   'popup' (or an active tab is on link.x.immutable.com). A request passes only if its tab is an active tab
//   and, while that window has focus, sits in the remembered window (or the last focused one before any was
//   remembered). A failed check counts as focused, as in OKX.
//   Start state: OKX's provider runs in every page, so in a real browser some ordinary page has talked to it, and
//   it has remembered that normal window, long before a hub does. This fake runs only in hub pages, so it starts
//   from that state (seedRemembered: the last focused normal window) instead of from nothing. From nothing, a hub
//   in a popup window passed the first check, and the old popup-hub code passed both suites (audit 2026-10-18
//   issue 7).
const TABS_STATE = `self.tabsState = async () => (await chrome.windows.getAll({ populate: true })).map((w) => ({
  id: w.id, type: w.type, focused: w.focused,
  tabs: w.tabs.map((t) => ({ id: t.id, index: t.index, active: t.active, url: t.url || t.pendingUrl || '', openerTabId: t.openerTabId ?? null })),
}));`;
const WALLET_BACKGROUND = `${TABS_STATE}
let remembered = null;
async function seedRemembered() {
  if (!remembered) remembered = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => null);
}
async function isFocusedTab(tabId) {
  await seedRemembered();
  const [tabs, win] = await Promise.allSettled([chrome.tabs.query({ active: true }), chrome.windows.getLastFocused()]);
  const active = tabs.value, last = win.value;
  const immutable = ['link.x.immutable.com'].some((u) => active?.some((t) => t?.url?.includes(u)));
  if (last?.type !== 'popup' || immutable) remembered = last;
  const ref = remembered || last;
  const tab = active?.find((t) => t?.id === tabId);
  return tab ? (last?.focused ? tab?.windowId === ref?.id : true) : false;
}
chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (!msg || msg.type !== '${GATE_TAG}' || !sender.tab) return false;
  isFocusedTab(sender.tab.id).then((ok) => respond({ ok }), () => respond({ ok: true }));
  return true;
});`;

/**
 * Every tab, with its window's id and type, as the fake wallet's background sees it (it has the tabs permission).
 * @param {{ inWorker: Function }} b  startBrowser() result   @param {string} extensionId  the fake wallet's id
 */
export async function tabsState(b, extensionId) {
  const windows = await b.inWorker(`chrome-extension://${extensionId}/bg.js`, 'self.tabsState()', `typeof self.tabsState === 'function'`);
  return windows.flatMap((w) => w.tabs.map((t) => ({ ...t, windowId: w.id, windowType: w.type })));
}

/**
 * Where a hub page runs, next to the site page that asked: the type of its window (chrome.windows, from the fake
 * wallet's background), whether that is another window than the site's, and its size (CDP
 * Browser.getWindowForTarget + Browser.getWindowBounds; CDP window ids are the chrome.windows ids).
 * @param {object} b  startBrowser() result   @param {string} extensionId  the fake wallet's id
 */
export async function hubWindow(b, extensionId, hubPage, sitePage) {
  const { windowId } = await b.send('Browser.getWindowForTarget', { targetId: hubPage.targetId });
  const site = await b.send('Browser.getWindowForTarget', { targetId: sitePage.targetId });
  const { bounds } = await b.send('Browser.getWindowBounds', { windowId });
  const tab = (await tabsState(b, extensionId)).find((t) => t.windowId === windowId) || null;
  return { type: tab ? tab.windowType : null, ownWindow: windowId !== site.windowId, width: bounds.width, height: bounds.height };
}

/**
 * A token transfer sent the way that fooled the card before the allow-list (audit 2026-10-18 issue 2): `data: null`
 * and the call in `input` (OKX Wallet uses `input` when `data` is falsy), plus fields the card never showed. The
 * wallet must get `expected`: the same bytes as `data`, the site's chainId, nothing else.
 */
export function hiddenCallTx(chainId) {
  const token = '0x55d398326f99059ff775485246999027b3197955';   // USDT on BNB Chain (only a recipient here)
  const call = '0xa9059cbb' + '00'.repeat(12) + 'ee'.repeat(20) + (10n ** 21n).toString(16).padStart(64, '0');
  return {
    sent: { from: FAKE_ACCOUNT, to: token, value: '0x0', data: null, input: call, gas: '0x5208', type: '0x2', nonce: '0x0' },
    expected: { from: FAKE_ACCOUNT, to: token, value: '0x0', data: call, chainId },
    token, selector: '0xa9059cbb', bytes: (call.length - 2) / 2,
  };
}

/** A 10-line EIP-4361 sign-in message for `domain` (the audit's example: app.uniswap.org). */
export const siweFor = (domain) => [`${domain} wants you to sign in with your Ethereum account:`, FAKE_ACCOUNT, '', 'Sign in to Uniswap', '',
  `URI: https://${domain}`, 'Version: 1', 'Chain ID: 1', 'Nonce: 8f3a2c1d', 'Issued At: 2026-10-18T00:00:00Z'].join('\n');

/** A USDC-style EIP-2612 Permit for an unlimited amount, bound to `chainId`. */
export const permitData = (chainId) => JSON.stringify({
  types: {
    EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }],
    Permit: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }],
  },
  primaryType: 'Permit', domain: { name: 'USD Coin', version: '2', chainId, verifyingContract: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d' },
  message: { owner: FAKE_ACCOUNT, spender: '0x' + '22'.repeat(20), value: (2n ** 256n - 1n).toString(), nonce: 0, deadline: 1799999999 },
});

/**
 * Evaluated in a hub page with a card open: the viewport, and for the card's title, identity rows and warning
 * whether they lie fully inside it; whether the page header and the authorized-sites list are shown.
 */
export const CARD_LAYOUT = `(() => {
  const at = (sel) => { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect();
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), onScreen: r.height > 0 && r.top >= 0 && r.bottom <= innerHeight }; };
  const shown = (sel) => { const e = document.querySelector(sel); return !!e && e.getClientRects().length > 0; };
  return { viewport: [innerWidth, innerHeight], scrollY: Math.round(scrollY), title: at('#card h2'), identity: at('#card dl.rows'), warning: at('#card .warn'),
    header: shown('header'), sites: shown('#sites') };
})()`;

/** A CARD_LAYOUT reading of `viewport` has the title, the identity rows and (`warning`) the warning on screen, and no header or site list. */
export const cardOnScreen = (l, viewport, warning) => !!l && l.viewport.join() === viewport.join() && !!l.title && l.title.onScreen && !!l.identity && l.identity.onScreen
  && (!warning || (!!l.warning && l.warning.onScreen)) && !l.header && !l.sites;

/** EIP-712 typed data for the e2e signatures (eth_signTypedData_v4), bound to `chainId`. */
export const typedData = (chainId) => JSON.stringify({
  types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'chainId', type: 'uint256' }], Mail: [{ name: 'contents', type: 'string' }] },
  primaryType: 'Mail', domain: { name: 'TapeKit e2e', chainId }, message: { contents: 'hello' },
});

/**
 * The fake wallet shipped the way OKX and Binance ship theirs: a MAIN-world content script at document_start on
 * the hub page, an ISOLATED-world content script and a background that decides OKX's focus rule with
 * chrome.tabs/chrome.windows. An extension also reaches hub pages that Chrome does not hold for the test's
 * Page.addScriptToEvaluateOnNewDocument: windows and tabs opened by an extension (chrome.windows.create,
 * chrome.tabs.create) run their first document before the test can inject anything (measured 2026-10-08,
 * Chrome 154). Returns `dir`.
 */
export function writeFakeWalletExtension(dir, hubHost) {
  fs.mkdirSync(dir, { recursive: true });
  const page = { matches: ['http://localhost/.tape/wallet/*'], run_at: 'document_start', all_frames: false };
  const manifest = {
    manifest_version: 3, name: 'TapeKit e2e fake wallet', version: '1', permissions: ['tabs'],
    background: { service_worker: 'bg.js' },
    content_scripts: [{ ...page, js: ['wallet.js'], world: 'MAIN' }, { ...page, js: ['gate.js'], world: 'ISOLATED' }],
  };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(dir, 'wallet.js'), `${fakeWallet(hubHost)}\n${hubProbe(hubHost)}\n`);
  fs.writeFileSync(path.join(dir, 'gate.js'), GATE_RELAY + '\n');
  fs.writeFileSync(path.join(dir, 'bg.js'), WALLET_BACKGROUND + '\n');
  return dir;
}
