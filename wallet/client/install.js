// Entry point of the fallback client (design §10.2, R7): give a gateway site page the TapeKit provider.
// Bundled into wallet/client.js by wallet/build-client.mjs, which calls installClient(window, CONFIG) with the
// chain table and texts it generates from the kernel config and wallet/src/i18n.js.
//
// It installs only on a top-level page of a gateway site (<site label>.<gateway host>), the same pages the
// extension serves (R6): not on the gateway root, not in frames, not in the sandboxed preview viewer (opaque
// origin, framed). It never touches window.ethereum; sites find it through EIP-6963 or window.tapekit.wallet.
import { createProvider, announceProvider } from '../src/provider.js';
import { createPopupTransport } from './transport.js';

// Same shape as the kernel's parseHostLabel (kernel/src/name.js): <#ID>-<processor> or <#ID>-<area>-<processor>.
const SITE_LABEL = /^([1-9][0-9]*)-(?:([1-9][0-9]*)-)?(0|[1-9][0-9]*)$/;
const HUB_PATH = '/.tape/wallet/';

/**
 * Where this page's hub is and which chain the site lives on, from the page location alone.
 * The hub is the gateway root: drop the site label, keep scheme and port.
 * @param {{ protocol: string, hostname: string, port: string }} loc
 * @param {{ areaChains: Record<string, string> }} config  area ('' = none, i.e. BNB) → chain id hex
 * @returns {{ hubOrigin: string, hubUrl: string, chainId: string } | null}
 */
export function siteContext(loc, config) {
  if (!loc || (loc.protocol !== 'https:' && loc.protocol !== 'http:')) return null;
  const [label, ...rest] = String(loc.hostname || '').split('.');
  const m = SITE_LABEL.exec(label);
  if (!m || !rest.length || rest.some((part) => !part)) return null;   // no gateway host, or a trailing dot
  const area = m[2] || '';
  const chainId = Object.prototype.hasOwnProperty.call(config.areaChains, area) ? config.areaChains[area] : null;
  if (!chainId) return null;
  const hubOrigin = `${loc.protocol}//${rest.join('.')}${loc.port ? ':' + loc.port : ''}`;
  return { hubOrigin, hubUrl: hubOrigin + HUB_PATH, chainId };
}

/**
 * Install the provider on `win`. Returns it, or null when this page is not a top-level gateway site page or a
 * TapeKit provider is already there (the extension, or this script loaded twice).
 * @param {Window} win
 * @param {{ areaChains: Record<string, string>, nodes: Record<string, string[]>, messages: object }} config
 */
export function installClient(win, config) {
  if (!win || win.top !== win) return null;
  const existing = win.tapekit;
  if (existing && existing.wallet) return null;
  const ctx = siteContext(win.location, config);
  if (!ctx) return null;
  const transport = createPopupTransport({ win, ...ctx, nodes: config.nodes, messages: config.messages });
  const provider = createProvider({ transport });
  const base = existing && typeof existing === 'object' ? existing : {};
  try {
    win.tapekit = Object.freeze({ ...base, wallet: provider });
  } catch {
    // window.tapekit is locked by the page: EIP-6963 discovery below still works.
  }
  announceProvider(win, provider);
  return provider;
}
