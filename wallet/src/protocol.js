// Wallet router protocol: method table, EIP-1193 error codes, limits and the message envelope
// shared by the site provider, the channels (extension / popup) and the hub.
// Pure data and functions, no imports: runs in pages, extension workers and Node.

/** Tag carried by every message so unrelated postMessage traffic is ignored. */
export const CHANNEL = 'tapekit-wallet/1';

/** EIP-1193 provider errors plus the two JSON-RPC errors the router uses. */
export const ERR = Object.freeze({
  USER_REJECTED: 4001,
  UNAUTHORIZED: 4100,
  UNSUPPORTED_METHOD: 4200,
  DISCONNECTED: 4900,
  CHAIN_DISCONNECTED: 4901,
  UNRECOGNIZED_CHAIN: 4902,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  LIMIT_EXCEEDED: -32005,   // EIP-1474; used when a site has too many pending requests
});

const DEFAULT_MESSAGES = Object.freeze({
  4001: 'User rejected the request.',
  4100: 'The requested account and/or method has not been authorized by the user.',
  4200: 'The requested method is not supported by TapeKit.',
  4900: 'TapeKit is not connected to a wallet.',
  4901: 'The request is not for the chain this site is on.',
  4902: 'Unrecognized chain ID. TapeKit supports BNB Smart Chain (0x38), X Layer (0xc4) and Base (0x2105).',
  '-32602': 'Invalid method parameters.',
  '-32603': 'Internal error.',
  '-32005': 'Too many pending requests from this site.',
});

/**
 * data.reason of the hub's 4900 "this window cannot reach the wallet". OKX Wallet refuses connect, sign and
 * chain-switch calls from a popup-type window without showing anything (research/manual-test.md), so the hub
 * never makes them there; the extension then moves the request to a hub tab (design §10, 2026-10-16).
 */
export const REASON_NEEDS_TAB = 'needs-tab';

/** Abuse limits (design §5.2): serialized params per request, pending requests per site. */
export const LIMITS = Object.freeze({
  maxParamsBytes: 256 * 1024,
  maxQueuedPerSite: 4,
});

/** Method classification (design §5.1). Anything not listed is rejected with 4200. */
export const METHODS = Object.freeze({
  local: Object.freeze(['eth_chainId', 'net_version', 'eth_accounts', 'wallet_getPermissions']),
  permission: Object.freeze(['eth_requestAccounts', 'wallet_requestPermissions']),
  revoke: Object.freeze(['wallet_revokePermissions']),
  chain: Object.freeze(['wallet_switchEthereumChain', 'wallet_addEthereumChain']),
  sign: Object.freeze(['personal_sign', 'eth_signTypedData_v4', 'eth_sendTransaction']),
  read: Object.freeze([
    'eth_blockNumber', 'eth_call', 'eth_estimateGas', 'eth_gasPrice', 'eth_maxPriorityFeePerGas', 'eth_feeHistory',
    'eth_getBalance', 'eth_getCode', 'eth_getStorageAt', 'eth_getTransactionCount', 'eth_getTransactionByHash',
    'eth_getTransactionReceipt', 'eth_getBlockByNumber', 'eth_getBlockByHash', 'eth_getLogs',
  ]),
});

// A Map, not an object lookup: 'toString' or '__proto__' must not resolve to anything.
const KIND_BY_METHOD = new Map(Object.entries(METHODS).flatMap(([kind, list]) => list.map((m) => [m, kind])));

/** @returns {'local'|'permission'|'revoke'|'chain'|'sign'|'read'|'reject'} */
export function classify(method) {
  return (typeof method === 'string' && KIND_BY_METHOD.get(method)) || 'reject';
}

/**
 * Plain EIP-1193 error object. Plain (not an Error) so it survives structured clone and postMessage;
 * the site provider turns it into a ProviderRpcError.
 * @param {number} code @param {string} [message] @param {unknown} [data]
 */
export function rpcError(code, message, data) {
  if (!Number.isInteger(code)) throw new TypeError('rpcError: code must be an integer');
  const text = typeof message === 'string' && message ? message : DEFAULT_MESSAGES[code] || 'Wallet error.';
  return data === undefined ? { code, message: text } : { code, message: text, data };
}

export const isRpcError = (e) => !!e && typeof e === 'object' && !(e instanceof Error) && Number.isInteger(e.code) && typeof e.message === 'string';

/** Bytes of the JSON form of params; Infinity when it cannot be serialized (cycles, BigInt). */
export function paramsSize(params) {
  if (params === undefined) return 0;
  try {
    return new TextEncoder().encode(JSON.stringify(params)).length;
  } catch {
    return Infinity;
  }
}

// ---- Envelope ----

const EVENTS = new Set(['accountsChanged', 'chainChanged', 'connect', 'disconnect', 'message']);
const METHOD_NAME = /^[A-Za-z0-9_]{1,100}$/;
const isId = (id) => (typeof id === 'string' && id.length > 0 && id.length <= 100) || Number.isSafeInteger(id);
const isParams = (p) => p === undefined || (typeof p === 'object' && p !== null);

export const makeRequest = (id, method, params) => ({ channel: CHANNEL, type: 'request', id, method, params });
export const makeResult = (id, result) => ({ channel: CHANNEL, type: 'response', id, result });
export const makeError = (id, error) => ({ channel: CHANNEL, type: 'response', id, error });
export const makeEvent = (event, data) => ({ channel: CHANNEL, type: 'event', event, data });
/**
 * Popup channel handshake, hub → opener. The hub cannot learn the opener's origin before the opener has
 * written to it, so the opener puts its origin in the hub URL (#origin=…) and the hub posts `ready` to that
 * origin only (never '*'). A false hint is harmless: the browser drops the message. Carries no data.
 */
export const makeReady = () => ({ channel: CHANNEL, type: 'ready' });

function readError(e) {
  if (!e || typeof e !== 'object' || !Number.isInteger(e.code) || typeof e.message !== 'string') return null;
  return rpcError(e.code, e.message, e.data);
}

/**
 * Validate an incoming message and copy only the known fields.
 * Anything else the sender added (an "origin", a "gesture" flag) is dropped: those facts come from the
 * browser or from the trusted relay, never from the page. Returns null for anything malformed.
 */
export function readEnvelope(msg) {
  if (!msg || typeof msg !== 'object' || msg.channel !== CHANNEL) return null;
  if (msg.type === 'request') {
    if (!isId(msg.id) || typeof msg.method !== 'string' || !METHOD_NAME.test(msg.method) || !isParams(msg.params)) return null;
    return makeRequest(msg.id, msg.method, msg.params);
  }
  if (msg.type === 'response') {
    if (!isId(msg.id)) return null;
    if ('error' in msg) { const error = readError(msg.error); return error ? makeError(msg.id, error) : null; }
    return 'result' in msg ? makeResult(msg.id, msg.result) : null;
  }
  if (msg.type === 'event') return EVENTS.has(msg.event) ? makeEvent(msg.event, msg.data) : null;
  if (msg.type === 'ready') return makeReady();
  return null;
}
