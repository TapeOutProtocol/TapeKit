// Per-site grants (design §5.5, §6; SPEC §7.4: permissions are recorded per origin).
// Shape: { [origin]: { accounts: [lower-case address], chainId: hex, grantedAt: number|null,
//                      holder: lower-case address|null, container: lower-case address|null } }
// `holder` is the circuit owner the grant was made for (SPEC §7.3: a circuit can change hands, and the same
// origin then belongs to someone else); `container` is kept for display. Every function is pure: inputs are never modified, updates return a new object. The storage backend
// (hub localStorage, extension snapshot) is someone else's job.
import { isSupportedChain } from './chains.js';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ORIGIN = /^https?:\/\/[^/\s]+$/;

const own = (perms, origin) => !!perms && typeof perms === 'object' && typeof origin === 'string' && Object.prototype.hasOwnProperty.call(perms, origin);
const entryOf = (perms, origin) => (own(perms, origin) && perms[origin] && typeof perms[origin] === 'object' ? perms[origin] : null);
const accountsOf = (entry) => (entry && Array.isArray(entry.accounts) ? entry.accounts.filter((a) => typeof a === 'string' && ADDRESS.test(a)).map((a) => a.toLowerCase()) : []);
const base = (perms) => (perms && typeof perms === 'object' ? perms : {});

function mustOrigin(origin) {
  if (typeof origin !== 'string' || !ORIGIN.test(origin)) throw new TypeError('permissions: invalid origin');
}
function mustChain(chainId) {
  if (!isSupportedChain(chainId)) throw new TypeError('permissions: unsupported chain ' + String(chainId));
}
function optionalAddress(v, what) {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' || !ADDRESS.test(v)) throw new TypeError(`permissions: ${what} must be an address`);
  return v.toLowerCase();
}
function mustAccounts(accounts) {
  if (!Array.isArray(accounts) || accounts.length === 0 || !accounts.every((a) => typeof a === 'string' && ADDRESS.test(a))) {
    throw new TypeError('permissions: accounts must be a non-empty list of addresses');
  }
  return accounts.map((a) => a.toLowerCase());
}

const holderOf = (entry) => (entry && typeof entry.holder === 'string' ? entry.holder.toLowerCase() : null);

/**
 * Grant accounts to an origin for the circuit's current holder. New accounts go after the ones already
 * granted to the same holder; accounts granted to a different holder are dropped. The site's chain is kept
 * if it already has one, otherwise `chainId` (its home chain) is used.
 * @param {object} perms @param {string} origin @param {string[]} accounts
 * @param {{chainId:string, now:number, holder?:string|null, container?:string|null}} opts
 */
export function grant(perms, origin, accounts, { chainId, now, holder, container }) {
  mustOrigin(origin);
  const add = mustAccounts(accounts);
  const owner = optionalAddress(holder, 'holder');
  const box = optionalAddress(container, 'container');
  const entry = entryOf(perms, origin);
  const chain = entry && isSupportedChain(entry.chainId) ? entry.chainId : chainId;
  mustChain(chain);
  const kept = entry && holderOf(entry) === owner ? accountsOf(entry) : [];
  const merged = [...new Set([...kept, ...add])];
  return { ...base(perms), [origin]: { accounts: merged, chainId: chain, grantedAt: now, holder: owner, container: box } };
}

/** The circuit holder the origin's grant was made for (lower case), or null. */
export const grantHolder = (perms, origin) => holderOf(entryOf(perms, origin));

/** Remove everything recorded for an origin (accounts and its virtual chain). */
export function revoke(perms, origin) {
  if (!own(perms, origin)) return base(perms);
  return Object.fromEntries(Object.entries(perms).filter(([k]) => k !== origin));
}

/** Accounts the site may see: granted ∩ wallet's current accounts, in wallet order, lower case. */
export function accountsFor(perms, origin, walletAccounts) {
  const granted = new Set(accountsOf(entryOf(perms, origin)));
  if (!granted.size || !Array.isArray(walletAccounts)) return [];
  const current = walletAccounts.filter((a) => typeof a === 'string' && ADDRESS.test(a)).map((a) => a.toLowerCase());
  return [...new Set(current.filter((a) => granted.has(a)))];
}

export const isGranted = (perms, origin) => accountsOf(entryOf(perms, origin)).length > 0;

/** The site's virtual chain (design §5.3), or `defaultChain` (its home chain) when none is stored. */
export function siteChain(perms, origin, defaultChain) {
  const entry = entryOf(perms, origin);
  return entry && isSupportedChain(entry.chainId) ? entry.chainId : defaultChain;
}

/** Set the site's virtual chain. Remembering a chain for an ungranted site does not grant anything. */
export function setSiteChain(perms, origin, chainId) {
  mustOrigin(origin);
  mustChain(chainId);
  const entry = entryOf(perms, origin);
  const next = entry ? { ...entry, accounts: accountsOf(entry), chainId } : { accounts: [], chainId, grantedAt: null, holder: null, container: null };
  return { ...base(perms), [origin]: next };
}

/** When the site's latest grant was made (ms), or null. */
export function grantedAt(perms, origin) {
  const entry = entryOf(perms, origin);
  return entry && Number.isFinite(entry.grantedAt) ? entry.grantedAt : null;
}

/** A copy of the origin's grant for display (the hub's "authorized sites" list), or null when not granted. */
export function grantInfo(perms, origin) {
  if (!isGranted(perms, origin)) return null;
  const entry = entryOf(perms, origin);
  const box = typeof entry.container === 'string' ? entry.container.toLowerCase() : null;
  return { accounts: accountsOf(entry), chainId: entry.chainId, grantedAt: grantedAt(perms, origin), holder: holderOf(entry), container: box };
}

/** Origins that currently hold at least one account (for the "authorized sites" list). */
export const grantedOrigins = (perms) => Object.keys(base(perms)).filter((o) => isGranted(perms, o));
