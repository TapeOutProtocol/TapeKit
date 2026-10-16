// Scripts the wallet e2e suites put into pages (wallet/test/e2e.mjs, e2e-extension.mjs).
//   fakeWallet(hubHost)  acts only in the hub: an EIP-6963 wallet announced as OKX (com.okex.wallet). Its state
//                        (connected, current chain, known chains) lives in the hub origin's localStorage, so it
//                        survives the hub closing and reopening, like a real wallet's connection. Every call is
//                        reported to Node through the binding. It knows BNB Chain and Base but not X Layer, so
//                        switching to 0xc4 needs the add flow.
//                        It copies OKX Wallet 4.19.0's focus rule (research/manual-test.md): a method in
//                        OKX_FOCUS_METHODS from a tab that is not the active tab of the focused normal window is
//                        refused without any prompt: wallet_switchEthereumChain answers null and does not switch,
//                        everything else fails 4001 with OKX's exact message. Refused calls are reported with
//                        `refused: true`. The check runs in the fake wallet extension's background with
//                        chrome.tabs/chrome.windows, as OKX does, so both suites load the fake as an extension
//                        (writeFakeWalletExtension). A page cannot tell on its own: window.toolbar.visible, the
//                        spec's popup flag, reads true in a popup opened cross-origin (site → hub), and headless
//                        Chrome reports every tab visible and focused (measured 2026-10-16, Chrome 155).
//   hubProbe(hubHost)    also hub-only: counts how often the confirm card and the notice become visible, so a
//                        dialog that flashes between two polls is still seen
//   MARKER               injected next to client.js: shows that injection reached a frame at all
//   PAGE_HELPER          evaluated in a site page once loaded: records results and events, and adds the
//                        button the test clicks with real CDP input (the click runs __e2e.next)
//   writeFakeWalletExtension(dir, hubHost)  fakeWallet + hubProbe + the focus check, packed as a wallet extension;
//                        its background also has tabsState() for the suites' tab and window checks
import fs from 'node:fs';
import path from 'node:path';

export const BINDING = '__tapekitE2eWallet';
export const FAKE_ACCOUNT = '0x' + '7e'.repeat(20);
export const FAKE_SIGNATURE = '0x' + '5a'.repeat(65);
// OKX Wallet 4.19.0 background.js (read 2026-10-16 from Percy's install, minified names): the set T_0 and the
// message of its userRejectedRequest. One deliberate difference: OKX lets a personal_sign through when its
// third param is not a silent-sign request; the fake refuses it like the rest of the set, so a signature sent
// from the wrong window is caught too.
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
  const report = (method, params, refused = false) => { try { window.${BINDING}(JSON.stringify({ method, params, refused })); } catch {} };
  const FOCUS = new Set(${JSON.stringify(OKX_FOCUS_METHODS)});
  const focused = ${EXTENSION_GATE};
  const provider = {
    async request({ method, params }) {
      if (FOCUS.has(method) && !(await focused())) {
        report(method, params, true);
        if (method === 'wallet_switchEthereumChain') return null;
        throw { code: 4001, message: ${JSON.stringify(OKX_DENIED)} };
      }
      report(method, params);
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

// The background: OKX's focus check (its xXa), plus tabsState() for the e2e tab checks.
//   OKX remembers the last focused window whose type is not 'popup' (IXa) each time it checks a request, and
//   a request passes only if its tab is an active tab and, while Chrome has focus, sits in that remembered
//   window. OKX's own provider runs in every page, so in a real browser IXa is set by the first normal page
//   that talks to it; this fake runs only in the hub, so before its first check it falls back to the last
//   focused normal window (chrome.windows.getLastFocused with windowTypes ['normal']). A failed check counts as
//   focused, as in OKX.
const TABS_STATE = `self.tabsState = async () => (await chrome.windows.getAll({ populate: true })).map((w) => ({
  id: w.id, type: w.type, focused: w.focused,
  tabs: w.tabs.map((t) => ({ id: t.id, index: t.index, active: t.active, url: t.url || t.pendingUrl || '', openerTabId: t.openerTabId ?? null })),
}));`;
const WALLET_BACKGROUND = `${TABS_STATE}
let remembered = null;
async function isFocusedTab(tabId) {
  const [active, last] = await Promise.all([chrome.tabs.query({ active: true }), chrome.windows.getLastFocused()]);
  if (last && last.type !== 'popup') remembered = last;
  const normal = remembered || await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => null);
  const tab = active.find((t) => t.id === tabId);
  if (!tab) return false;
  return last && last.focused ? tab.windowId === (normal || last).id : true;
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
