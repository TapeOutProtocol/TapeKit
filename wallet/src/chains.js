// The three chains the router supports (BNB Smart Chain 56, X Layer 196, Base 8453).
// Chain id, name, currency and nodes come from the kernel config, so there is one source of truth.
// Only the block explorer and the currency's long name are added here. These are the params TapeKit
// passes to wallet_addEthereumChain; params a site supplies are never used (EIP-3085, design §5.1).
import { NETWORKS, networkByArea, networkByChainId, siteNodes } from '../../kernel/src/config.js';

const EXTRA = Object.freeze({
  56: Object.freeze({ currencyName: 'BNB', explorer: 'https://bscscan.com' }),
  196: Object.freeze({ currencyName: 'OKB', explorer: 'https://www.oklink.com/xlayer' }),
  8453: Object.freeze({ currencyName: 'Ether', explorer: 'https://basescan.org' }),
});

const toHex = (n) => '0x' + Number(n).toString(16);

function paramsFor(net) {
  const extra = EXTRA[net.chainId];
  if (!extra) throw new Error(`chains.js: no wallet params for chain ${net.chainId}`);
  return Object.freeze({
    chainId: toHex(net.chainId),
    chainName: net.name,
    nativeCurrency: Object.freeze({ name: extra.currencyName, symbol: net.currency, decimals: 18 }),
    // Nodes that do not read caller keys from the URL (kernel `siteNodes`), same rule as for sites.
    rpcUrls: Object.freeze(siteNodes(net)),
    blockExplorerUrls: Object.freeze([extra.explorer]),
  });
}

/** hex chain id → frozen EIP-3085 AddEthereumChainParameter */
export const CHAINS = Object.freeze(Object.fromEntries(NETWORKS.map((net) => [toHex(net.chainId), paramsFor(net)])));
export const SUPPORTED_CHAINS = Object.freeze(Object.keys(CHAINS));

const HEX = /^0x[0-9a-f]{1,14}$/i;
const DEC = /^[1-9][0-9]{0,15}$/;

/** Chain id in any common form (number, '0x..', decimal string) → canonical lower-case hex, or null. */
export function normalizeChainId(value) {
  let n = null;
  if (typeof value === 'number') n = value;
  else if (typeof value === 'string' && HEX.test(value)) n = Number.parseInt(value.slice(2), 16);
  else if (typeof value === 'string' && DEC.test(value)) n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? toHex(n) : null;
}

export const isSupportedChain = (hex) => typeof hex === 'string' && Object.prototype.hasOwnProperty.call(CHAINS, hex);

/** @returns {Readonly<{chainId:string, chainName:string, nativeCurrency:object, rpcUrls:readonly string[], blockExplorerUrls:readonly string[]}>|null} */
export const chainParams = (hex) => (isSupportedChain(hex) ? CHAINS[hex] : null);

/** Site area (null = BNB) → the site's home chain as hex, via the kernel's area table. */
export function chainForArea(area) {
  const net = networkByArea(area);
  return net && isSupportedChain(toHex(net.chainId)) ? toHex(net.chainId) : null;
}

/** Public nodes for read-only calls on a chain (kernel `siteNodes`), or null for unsupported chains. */
export function readNodes(hex) {
  if (!isSupportedChain(hex)) return null;
  return siteNodes(networkByChainId(Number.parseInt(hex.slice(2), 16)));
}
