// Parameter checks for signing methods (design §5.2), before anything is shown or forwarded:
//   personal_sign        [message, address]
//   eth_signTypedData_v4 [address, typedData (JSON string or object)]
//   eth_sendTransaction  [{ from, chainId?, ... }]
// Returns the signer (lower case) and the chain the request itself names (or null). Malformed → -32602.
import { rpcError, ERR } from './protocol.js';
import { normalizeChainId } from './chains.js';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const invalid = (why) => rpcError(ERR.INVALID_PARAMS, `Invalid params: ${why}.`);
const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

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

/** @returns {{ address: string, chainId: string|null }} */
export function readSignRequest(method, params) {
  if (!Array.isArray(params)) throw invalid('params must be an array');
  if (method === 'personal_sign') {
    if (typeof params[0] !== 'string') throw invalid('message must be a string');
    return { address: address(params[1]), chainId: null };
  }
  if (method === 'eth_signTypedData_v4') {
    const signer = address(params[0]);
    const data = typedData(params[1]);
    return { address: signer, chainId: chainOf(data.domain && data.domain.chainId, 'domain.chainId') };
  }
  if (method === 'eth_sendTransaction') {
    const tx = params[0];
    if (!isObject(tx)) throw invalid('transaction must be an object');
    return { address: address(tx.from), chainId: chainOf(tx.chainId, 'chainId') };
  }
  throw invalid(`${String(method).slice(0, 100)} is not a signing method`);
}
