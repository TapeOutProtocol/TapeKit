// Shared adapter logic (design §8). A wallet adapter is a small config handed to createAdapter():
// how to find the wallet, and how it revokes. Everything else (error normalization, forwarding,
// chain switching) is the same for every EIP-1193 wallet and lives here.
// Never touches window.ethereum: OKX locks it and Binance silently fails to define it when OKX is present
// (research/wallets.md §3 item 8). Only EIP-6963 announcements and each wallet's own global are used.
import { rpcError } from '../protocol.js';

const MAX_MESSAGE = 300;
const MAX_DATA = 64 * 1024;   // revert data for eth_call / eth_estimateGas; anything else is dropped

// Wallets that throw untyped errors (Binance: `Error` without `code`; research/wallets.md §2 Q5/Q7) are
// classified by their text. First match wins; anything unrecognised is -32603.
const TEXT_RULES = [
  [/^(-?\d{4,5}):/, (m) => Number(m[1])],   // Binance's "<code>:<message>" bridge format
  [/user (rejected|denied|cancell?ed)|(rejected|denied|cancell?ed) by (the )?user/i, 4001],
  [/unrecognized chain|unknown chain/i, 4902],
  [/chain id mismatch/i, 4901],
  [/not supported|unsupported|method not found|not implemented/i, 4200],
  [/not authori[sz]ed|unauthori[sz]ed/i, 4100],
];

const usable = (p) => !!p && (typeof p === 'object' || typeof p === 'function') && typeof p.request === 'function';

function codeOf(e) {
  if (!e || typeof e !== 'object') return null;
  if (Number.isInteger(e.code)) return e.code;
  if (typeof e.code === 'string' && /^-?\d{1,6}$/.test(e.code)) return Number(e.code);
  return null;
}

function messageOf(e) {
  const m = typeof e === 'string' ? e : e && typeof e.message === 'string' ? e.message : '';
  return m.slice(0, MAX_MESSAGE);
}

const dataOf = (e) => (e && typeof e === 'object' && typeof e.data === 'string' && e.data.length <= MAX_DATA ? e.data : undefined);

/**
 * Any wallet or node rejection (plain object, Error, string, undefined) → plain { code, message, data? } for
 * the site. Only string data (revert data) is kept; wallet-internal objects never reach the site.
 */
export function normalizeWalletError(e) {
  const message = messageOf(e);
  const code = codeOf(e);
  if (code !== null) return rpcError(code, message || undefined, dataOf(e));
  for (const [re, to] of TEXT_RULES) {
    const m = re.exec(message);
    if (m) return rpcError(typeof to === 'function' ? to(m) : to, message);
  }
  return rpcError(-32603, message || undefined);
}

/** First EIP-6963 announcement with this rdns whose provider has request(). */
function findAnnounced(announced, rdns) {
  if (!Array.isArray(announced)) return null;
  const hit = announced.find((d) => d && d.info && d.info.rdns === rdns && usable(d.provider));
  return hit ? hit.provider : null;
}

async function call(provider, args) {
  try {
    return await provider.request(args);
  } catch (e) {
    throw normalizeWalletError(e);
  }
}

async function currentChain(provider) {
  const id = await call(provider, { method: 'eth_chainId' });
  return typeof id === 'string' ? id.toLowerCase() : id;
}

/**
 * Put the real wallet on `chainHex` before forwarding a signature (design §5.3). On 4902 the chain is added
 * with TapeKit's own params (a plain copy; never anything a site supplied) and switched to again.
 * The final read catches wallets that return without switching: Binance does for unconnected origins, and OKX
 * answers null without switching when the request does not come from the active tab of the focused normal
 * window (research/manual-test.md). Then the switch did not happen: 4901, and the caller forwards nothing.
 */
async function ensureChain(provider, chainHex, chainParams) {
  if (!chainParams || chainParams.chainId !== chainHex) throw rpcError(-32602, 'ensureChain: params do not match the chain');
  if ((await currentChain(provider)) === chainHex) return;
  const switchTo = () => call(provider, { method: 'wallet_switchEthereumChain', params: [{ chainId: chainHex }] });
  try {
    await switchTo();
  } catch (err) {
    if (err.code !== 4902) throw err;
    await call(provider, { method: 'wallet_addEthereumChain', params: [JSON.parse(JSON.stringify(chainParams))] });
    await switchTo();
  }
  if ((await currentChain(provider)) !== chainHex) throw rpcError(4901, `The wallet did not switch to chain ${chainHex}.`);
}

/**
 * @param {{ id: string, rdns: string, label: string, storeUrl: string, fallback: (win: any) => any, revoke: (call: Function, provider: any) => Promise<{revoked: boolean}> }} spec
 *   storeUrl: the wallet's Chrome Web Store page, shown as plain text in the hub's install guidance
 */
export function createAdapter({ id, rdns, label, storeUrl, fallback, revoke }) {
  function detect({ announced, win } = {}) {
    const viaEip6963 = findAnnounced(announced, rdns);
    if (viaEip6963) return viaEip6963;
    try {
      const p = win ? fallback(win) : null;
      return usable(p) ? p : null;
    } catch {
      return null;   // a hostile or broken getter on the global means "not detected"
    }
  }
  return Object.freeze({
    id, rdns, label, storeUrl, detect,
    normalizeError: normalizeWalletError,
    request: call,
    ensureChain,
    revoke: (provider) => revoke(call, provider),
  });
}
