// What the signing card shows about a request (design §7). Pure: turns the router's confirmSign card into
// display fields; the hub UI only renders them as text (never as HTML).
//   personal_sign         the message as text, or hex when the bytes are not UTF-8; the SIWE warning. No chain:
//                         a personal message is not chain-bound, and the wallet is not switched for it
//                         (design §10.3, 2026-10-17)
//   eth_signTypedData_v4  domain (name, version, chain, contract), primaryType and the full JSON
//   eth_sendTransaction   chain, recipient, value in native units, data length and 4-byte selector
// Params were already checked by the router (params.js); this only formats.
import { chainParams } from './chains.js';
import { messageText, parseSiweDomain } from './siwe.js';

// Bidirectional controls can make "pay evil" read as "live yap" on screen: show them as visible markers.
const BIDI = /[؜‎‏‪-‮⁦-⁩]/g;
const visible = (s) => s.replace(BIDI, (c) => `[U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}]`);

const HEX_BYTES = /^0x(?:[0-9a-fA-F]{2})*$/;
const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const scalar = (v) => (typeof v === 'string' ? v : ['number', 'bigint', 'boolean'].includes(typeof v) ? String(v) : null);
const lower = (v) => (typeof v === 'string' ? v.toLowerCase() : null);

/** bigint amount in the smallest unit → decimal string, trailing zeros trimmed, no rounding. */
export function formatUnits(amount, decimals) {
  const neg = amount < 0n;
  const abs = neg ? -amount : amount;
  const base = 10n ** BigInt(decimals);
  const frac = (abs % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return (neg ? '-' : '') + (abs / base).toString() + (frac ? '.' + frac : '');
}

// JSON-RPC quantities are 0x-hex. A string without 0x is ambiguous: some wallet code adds the prefix and
// reads "1000" as 0x1000. Such values are shown raw with "(?)" instead of a guessed amount.
function quantity(v) {
  if (v === undefined || v === null) return 0n;
  if (typeof v === 'string' && /^0x[0-9a-fA-F]{1,64}$/.test(v)) return BigInt(v);
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  return null;
}

function chainInfo(hex) {
  const p = chainParams(hex);
  return { id: hex, name: p ? p.chainName : String(hex), symbol: p ? p.nativeCurrency.symbol : '' };
}

function message(params) {
  const raw = params[0];
  const text = messageText(raw);
  return { text: text === null ? null : visible(text), hex: text === null ? raw : null };
}

function typed(params) {
  let data = params[1];
  if (typeof data === 'string') data = JSON.parse(data);
  const domain = isObject(data.domain) ? data.domain : {};
  return {
    domain: {
      name: scalar(domain.name),
      version: scalar(domain.version),
      chainId: scalar(domain.chainId),
      verifyingContract: scalar(domain.verifyingContract),
    },
    primaryType: typeof data.primaryType === 'string' ? data.primaryType : null,
    json: JSON.stringify(data, null, 2),
  };
}

function transaction(tx, chain) {
  const amount = quantity(tx.value);
  const value = amount === null ? `${String(tx.value).slice(0, 100)} (?)` : `${formatUnits(amount, 18)} ${chain.symbol}`.trim();
  const data = tx.data !== undefined ? tx.data : tx.input;
  const okData = data === undefined || data === null || (typeof data === 'string' && HEX_BYTES.test(data));
  const bytes = !okData ? null : typeof data === 'string' ? (data.length - 2) / 2 : 0;
  return {
    to: typeof tx.to === 'string' && tx.to ? tx.to : null,
    value,
    dataBytes: bytes,
    selector: bytes !== null && bytes >= 4 ? data.slice(0, 10).toLowerCase() : null,
  };
}

/**
 * @param {{ method: string, params: any[], chainId: string, siweWarning?: boolean }} card  from router confirmSign
 */
export function describeSign(card) {
  const chain = chainInfo(card.chainId);
  const params = Array.isArray(card.params) ? card.params : [];
  if (card.method === 'personal_sign') {
    return {
      kind: 'message', account: lower(params[1]), ...message(params),
      siweWarning: card.siweWarning === true, siweDomain: card.siweWarning === true ? parseSiweDomain(params[0]) : null,
    };
  }
  if (card.method === 'eth_signTypedData_v4') return { kind: 'typed', account: lower(params[0]), chain, ...typed(params) };
  if (card.method === 'eth_sendTransaction') {
    const tx = isObject(params[0]) ? params[0] : {};
    return { kind: 'tx', account: lower(tx.from), chain, ...transaction(tx, chain) };
  }
  throw new TypeError('describeSign: not a signing method');
}
