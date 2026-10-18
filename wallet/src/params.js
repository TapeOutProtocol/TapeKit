// Parameter checks for signing methods (design §5.2), before anything is shown or forwarded:
//   personal_sign        [message, address]
//   eth_signTypedData_v4 [address, typedData (JSON string or object)]
//   eth_sendTransaction  [{ from, to?, value?, data? | input?, chainId? }]
// Returns the signer (lower case), the chain the request itself names (or null), and `params`: exactly what the
// card shows and the wallet gets, nothing else the site sent (design §10.3). Malformed → -32602.
//
// A transaction is rebuilt from an allow-list (audit 2026-10-18 issue 2): from, to, value and the call data. The
// site's other fields never reach the wallet: gas, fees and nonce are the wallet's to set (OKX overwrites them
// anyway), and nothing the card does not show may ride along. The call data may come as `data` or `input`; OKX
// Wallet 4.19.0 uses `input` whenever `data` is falsy, so when both are present they must be the same bytes, and
// the copy carries them as `data` only. EIP-7702 delegations (authorizationList, type 0x4) are refused: the card
// cannot show what a delegated account would run.
import { rpcError, ERR } from './protocol.js';
import { normalizeChainId } from './chains.js';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const QUANTITY = /^0x[0-9a-fA-F]{1,64}$/;
const HEX_BYTES = /^0x(?:[0-9a-fA-F]{2})*$/;
const invalid = (why) => rpcError(ERR.INVALID_PARAMS, `Invalid params: ${why}.`);
const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const given = (v) => v !== undefined && v !== null;

function address(v) {
  if (typeof v !== 'string' || !ADDRESS.test(v)) throw invalid('missing or malformed address');
  return v.toLowerCase();
}

function chainOf(v, what) {
  if (v === undefined || v === null) return null;
  const hex = normalizeChainId(v);
  if (!hex) throw invalid(`malformed ${what}`);
  return hex;
}

function typedData(v) {
  let data = v;
  if (typeof v === 'string') {
    try { data = JSON.parse(v); } catch { throw invalid('typed data is not JSON'); }
  }
  if (!isObject(data)) throw invalid('typed data must be an object');
  if ('domain' in data && !isObject(data.domain)) throw invalid('typed data domain must be an object');
  return data;
}

/** A JSON-RPC quantity (0x-hex), or a safe non-negative JS integer, as canonical 0x-hex. */
function quantity(v, what) {
  if (typeof v === 'string' && QUANTITY.test(v)) return '0x' + BigInt(v).toString(16);
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return '0x' + v.toString(16);
  throw invalid(`${what} must be a 0x-hex quantity`);
}

/** The call data from `data` or `input` (see the header), or null when there is none. */
function callData(tx) {
  const [data, input] = [tx.data, tx.input];
  if (given(data) && given(input) && String(data).toLowerCase() !== String(input).toLowerCase()) throw invalid('data and input differ');
  const bytes = given(data) ? data : input;
  if (!given(bytes)) return null;
  if (typeof bytes !== 'string' || !HEX_BYTES.test(bytes)) throw invalid('data must be 0x-hex bytes');
  return bytes;
}

/** The transaction the card shows and the wallet gets: { from, to?, value?, data? }, frozen. */
export function cleanTransaction(tx) {
  if (!isObject(tx)) throw invalid('transaction must be an object');
  if (given(tx.authorizationList)) throw invalid('EIP-7702 authorizations are not supported');
  if (given(tx.type) && normalizeChainId(tx.type) === '0x4') throw invalid('EIP-7702 transactions are not supported');
  const out = { from: address(tx.from) };
  if (given(tx.to)) {
    if (typeof tx.to !== 'string' || !ADDRESS.test(tx.to)) throw invalid('malformed to');
    out.to = tx.to;
  }
  if (given(tx.value)) out.value = quantity(tx.value, 'value');
  const data = callData(tx);
  if (data !== null) out.data = data;
  return Object.freeze(out);
}

/** @returns {{ address: string, chainId: string|null, params: any[] }} */
export function readSignRequest(method, params) {
  if (!Array.isArray(params)) throw invalid('params must be an array');
  if (method === 'personal_sign') {
    if (typeof params[0] !== 'string') throw invalid('message must be a string');
    return { address: address(params[1]), chainId: null, params: [params[0], params[1]] };
  }
  if (method === 'eth_signTypedData_v4') {
    const signer = address(params[0]);
    const data = typedData(params[1]);
    return { address: signer, chainId: chainOf(data.domain && data.domain.chainId, 'domain.chainId'), params: [params[0], params[1]] };
  }
  if (method === 'eth_sendTransaction') {
    const tx = cleanTransaction(params[0]);
    return { address: tx.from, chainId: chainOf(params[0].chainId, 'chainId'), params: [tx] };
  }
  throw invalid(`${String(method).slice(0, 100)} is not a signing method`);
}
