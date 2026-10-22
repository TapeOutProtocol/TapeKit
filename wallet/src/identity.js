// Site identity for the hub UI and the router (SPEC §7.4, design §4, R8).
// origin → canonical name (origin.js) → kernel.resolve → { name, cpuName, container, status, chainId, holder }.
// Every connect notice and signing card shows this, never the page's own title. Only status 'ok' is usable;
// the router refuses anything else with 4100. `holder` (the circuit's current owner, lower case) binds grants
// to one owner: a circuit can change hands and the origin then belongs to someone else (SPEC §7.3).
// The kernel is injected (tests use a fake).
import { chainForArea, normalizeChainId } from './chains.js';

const MAX_ENTRIES = 200;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const addressOrNull = (v) => (typeof v === 'string' && ADDRESS.test(v) ? v.toLowerCase() : null);

/**
 * @param {{ kernel: { resolve(name: string): Promise<any> }, ttlMs?: number, now?: () => number }} deps
 */
export function createIdentityResolver({ kernel, ttlMs = 30_000, now = Date.now } = {}) {
  if (!kernel || typeof kernel.resolve !== 'function') throw new TypeError('identity: kernel.resolve is required');
  const cache = new Map();      // origin → { at, value }
  const inflight = new Map();   // origin → Promise

  const fresh = (hit, t) => hit && hit.at <= t && t - hit.at < ttlMs;

  function remember(origin, value) {
    cache.delete(origin);
    cache.set(origin, { at: now(), value });
    if (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value);
  }

  async function lookup(site) {
    const homeChain = chainForArea(site.area);
    try {
      const res = await kernel.resolve(site.name);
      const value = Object.freeze({
        name: typeof res.name === 'string' ? res.name : site.name,
        cpuName: res.cpuName ?? null,
        container: res.container ?? null,
        status: typeof res.status === 'string' ? res.status : 'unavailable',
        chainId: normalizeChainId(res.chainId) || homeChain,
        holder: addressOrNull(res.holder),
      });
      remember(site.origin, value);
      return value;
    } catch (e) {
      // Node trouble is not an answer about the site: report it, do not cache it.
      return Object.freeze({ name: site.name, cpuName: null, container: null, status: 'unavailable', chainId: homeChain, holder: null, error: String(e && e.message || e) });
    }
  }

  /** @param {{ origin: string, name: string, area: number|null }} site  result of parseSiteOrigin */
  async function resolve(site) {
    if (!site || typeof site.origin !== 'string' || typeof site.name !== 'string') throw new TypeError('identity: expected a parsed site origin');
    const hit = cache.get(site.origin);
    if (fresh(hit, now())) return hit.value;
    if (inflight.has(site.origin)) return inflight.get(site.origin);
    const p = lookup(site).finally(() => inflight.delete(site.origin));
    inflight.set(site.origin, p);
    return p;
  }

  return { resolve, clear: () => cache.clear() };
}
