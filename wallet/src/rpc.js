// Read-only JSON-RPC for the router's `rpc` dependency (design §5.4): one call to the first public node of the
// site's chain (kernel `siteNodes`, the nodes that do not read caller keys from the URL). Like a wallet, it asks
// one node and does not cross-check; these answers are for the site, not for TapeKit's own decisions.
// Never goes through the wallet. Errors are plain { code, message, data? } objects (the router normalizes them).
import { rpcError, ERR } from './protocol.js';
import { readNodes } from './chains.js';

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

function nodeError(e) {
  if (!isPlainObject(e) || !Number.isInteger(e.code) || typeof e.message !== 'string') return rpcError(ERR.INTERNAL, 'The node returned a malformed error.');
  return typeof e.data === 'string' ? { code: e.code, message: e.message, data: e.data } : { code: e.code, message: e.message };
}

/**
 * @param {{ fetchImpl: typeof fetch, timeoutMs?: number }} opts
 * @returns {(chainHex: string, method: string, params: unknown) => Promise<unknown>}
 */
export function createReadRpc({ fetchImpl, timeoutMs = 15_000 } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('rpc: fetchImpl is required');
  let seq = 0;

  return async function rpc(chainHex, method, params) {
    const nodes = readNodes(chainHex);
    if (!nodes || !nodes.length) throw rpcError(ERR.CHAIN_DISCONNECTED, `No public node for chain ${String(chainHex)}.`);
    const id = ++seq;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs);
    let body;
    try {
      const res = await fetchImpl(nodes[0], {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        credentials: 'omit',
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      body = await res.json();
    } catch (e) {
      throw rpcError(ERR.INTERNAL, `The public node did not answer (${String(e && e.message || e).slice(0, 100)}).`);
    } finally {
      clearTimeout(timer);
    }
    if (!isPlainObject(body)) throw rpcError(ERR.INTERNAL, 'The node returned a malformed reply.');
    if ('error' in body && body.error !== undefined && body.error !== null) throw nodeError(body.error);
    if (!('result' in body)) throw rpcError(ERR.INTERNAL, 'The node returned no result.');
    return body.result;
  };
}
