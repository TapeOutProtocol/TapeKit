// Scripts the wallet e2e puts into pages (wallet/test/e2e.mjs).
//   fakeWallet(hubHost)  injected at document start everywhere, acts only in the hub: an EIP-6963 wallet
//                        announced as OKX (com.okex.wallet). Its state (connected, current chain, known chains)
//                        lives in the hub origin's localStorage, so it survives the popup closing and reopening,
//                        like a real wallet's connection. Every call is reported to Node through the binding.
//                        It knows BNB Chain and Base but not X Layer, so switching to 0xc4 needs the add flow.
//   hubProbe(hubHost)    also hub-only: counts how often the confirm card and the notice become visible, so a
//                        dialog that flashes between two polls is still seen
//   MARKER               injected next to client.js: shows that injection reached a frame at all
//   PAGE_HELPER          evaluated in a site page once loaded: records results and events, and adds the
//                        button the test clicks with real CDP input (the click runs __e2e.next)
//   writeFakeWalletExtension(dir, hubHost)  fakeWallet + hubProbe packed as a wallet extension (e2e-extension.mjs)
import fs from 'node:fs';
import path from 'node:path';

export const BINDING = '__tapekitE2eWallet';
export const FAKE_ACCOUNT = '0x' + '7e'.repeat(20);
export const FAKE_SIGNATURE = '0x' + '5a'.repeat(65);

export const fakeWallet = (hubHost) => `(() => {
  if (location.host !== ${JSON.stringify(hubHost)} || !location.pathname.startsWith('/.tape/wallet/')) return;
  const KEY = 'tapekit-e2e-fake-wallet';
  const initial = { connected: false, chain: '0x38', chains: ['0x38', '0x2105'] };
  const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || initial; } catch { return initial; } };
  const save = (s) => localStorage.setItem(KEY, JSON.stringify(s));
  const report = (method, params) => { try { window.${BINDING}(JSON.stringify({ method, params })); } catch {} };
  const provider = {
    async request({ method, params }) {
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

/**
 * The fake wallet shipped the way OKX and Binance ship theirs: a MAIN-world content script at document_start on
 * the hub page. e2e-extension.mjs needs this because Chrome does not hold a window opened by an extension
 * (chrome.windows.create) for the test's Page.addScriptToEvaluateOnNewDocument, so scripts injected that way
 * miss the hub's first document (measured 2026-10-08, Chrome 154). Returns `dir`.
 */
export function writeFakeWalletExtension(dir, hubHost) {
  fs.mkdirSync(dir, { recursive: true });
  const manifest = {
    manifest_version: 3, name: 'TapeKit e2e fake wallet', version: '1',
    content_scripts: [{ matches: ['http://localhost/.tape/wallet/*'], js: ['wallet.js'], run_at: 'document_start', world: 'MAIN', all_frames: false }],
  };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(dir, 'wallet.js'), `${fakeWallet(hubHost)}\n${hubProbe(hubHost)}\n`);
  return dir;
}
