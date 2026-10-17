// The extension's copy of the hub's grants (design §10.1). The hub stays the authority: it publishes
// { perms, accounts } through hub-relay.js after every grant, revoke, chain change or wallet account change,
// and the background stores a cleaned copy in chrome.storage.local[SNAPSHOT_KEY]. Only the background writes
// it, and only for a message from the hub page of the configured gateway (background.js); content scripts
// cannot read or write extension local storage at all (the background restricts it to trusted contexts).
//
// With it the background answers eth_chainId, net_version, eth_accounts and wallet_getPermissions, and the
// connect requests of an already-connected site, without opening anything; it picks where to open the hub (a
// tab, the small window for a message signature, or the small unfocused notice window), and the popup lists the
// authorized sites.
// Answers use the same functions as the router (permissions.js), so they match what the hub would say.
// Known limit (design §5.5): while no hub is open, the accounts can lag behind the wallet; the hub re-reads the
// wallet before every signature.
import { classify } from '../src/protocol.js';
import { parseSiteOrigin } from '../src/origin.js';
import { chainForArea, isSupportedChain } from '../src/chains.js';
import { grant, setSiteChain, siteChain, accountsFor, grantedAt, grantedOrigins, grantInfo, permissionList, checkPermissionRequest } from '../src/permissions.js';

export const SNAPSHOT_KEY = 'tapekit-wallet:snapshot:v1';
const MAX_SITES = 1000;
const MAX_ACCOUNTS = 100;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** One origin's entry, rebuilt with the pure permission functions (so a bad field cannot slip through). */
function cleanEntry(perms, raw, origin, site) {
  const home = chainForArea(site.area);
  const entry = raw[origin];
  const chain = isObject(entry) && isSupportedChain(entry.chainId) ? entry.chainId : home;
  const info = grantInfo(raw, origin);
  try {
    if (info) return grant(perms, origin, info.accounts, { chainId: chain, now: info.grantedAt, holder: info.holder, container: info.container });
    return chain !== home ? setSiteChain(perms, origin, chain) : perms;
  } catch {
    return perms;   // malformed holder or container: drop the entry
  }
}

/**
 * The hub's published { perms, accounts } → the stored snapshot, keeping only sites of this hub's gateway.
 * @param {{ perms: object, accounts: unknown[] }} published
 * @param {string} hubUrl  the configured hub, e.g. 'https://tapekit.org/.tape/wallet/'
 */
export function cleanSnapshot(published, hubUrl, now) {
  const raw = isObject(published) && isObject(published.perms) ? published.perms : {};
  let perms = {};
  for (const origin of Object.keys(raw).slice(0, MAX_SITES)) {
    const site = parseSiteOrigin(origin, hubUrl);
    if (site) perms = cleanEntry(perms, raw, origin, site);
  }
  const list = isObject(published) && Array.isArray(published.accounts) ? published.accounts : [];
  const accounts = [...new Set(list.filter((a) => typeof a === 'string' && ADDRESS.test(a)).map((a) => a.toLowerCase()))].slice(0, MAX_ACCOUNTS);
  return { hub: new URL(hubUrl).origin, perms, accounts, at: now };
}

/** The stored snapshot if it belongs to this hub (the gateway may have changed since), else null. */
export function snapshotFor(stored, hubUrl) {
  if (!isObject(stored) || !isObject(stored.perms) || !Array.isArray(stored.accounts)) return null;
  return stored.hub === new URL(hubUrl).origin ? stored : null;
}

const permsOf = (snapshot) => (snapshot ? snapshot.perms : {});
const accountsOf = (snapshot) => (snapshot ? snapshot.accounts : []);

/** The site's current chain (its own virtual chain, design §5.3). @param {{ origin: string, area: number|null }} site */
export const siteChainOf = (snapshot, site) => siteChain(permsOf(snapshot), site.origin, chainForArea(site.area));

/** Answer for a 'local' method (protocol.js), exactly as router.js local() would. */
export function localAnswer(snapshot, site, method) {
  const chain = siteChainOf(snapshot, site);
  if (method === 'eth_chainId') return chain;
  if (method === 'net_version') return String(Number.parseInt(chain, 16));
  const accounts = accountsFor(permsOf(snapshot), site.origin, accountsOf(snapshot));
  return method === 'eth_accounts' ? accounts : permissionList(site.origin, accounts, grantedAt(permsOf(snapshot), site.origin));
}

/**
 * Answer for a connect request (eth_requestAccounts, wallet_requestPermissions) from a site that already has a
 * visible grant (granted ∩ the wallet's accounts, both as in the snapshot), exactly as router.js permission()
 * answers it; null when it has none, and the request goes to the hub. The circuit-holder and status re-check is
 * left to signing: router.js sign() resolves the identity again and drops a stale grant.
 */
export function connectedAnswer(snapshot, site, method, params) {
  if (method === 'wallet_requestPermissions') checkPermissionRequest(params);
  const accounts = accountsFor(permsOf(snapshot), site.origin, accountsOf(snapshot));
  if (!accounts.length) return null;
  return method === 'eth_requestAccounts' ? accounts : permissionList(site.origin, accounts, grantedAt(permsOf(snapshot), site.origin));
}

// Signatures OKX Wallet lets through from a popup-type window (research/manual-test.md): a plain personal_sign
// (the router forwards exactly [message, address]) and eth_signTypedData_v4, which is not in its gated set.
const WINDOW_SIGNS = new Set(['personal_sign', 'eth_signTypedData_v4']);

/**
 * Where the hub runs for this request (design §10.3, revised 2026-10-16 and 2026-10-17):
 *   'tab'     the active tab of a normal window. OKX Wallet refuses connect, transaction and chain-switch calls
 *             from a popup-type window without a prompt, so: a transaction (the card, then the chain switch and
 *             the wallet); a connect while the hub has no wallet account yet (the one-time wallet connection,
 *             R1); a connect without a user gesture from a site that is not connected (the site dialog, D-c,
 *             which may lead to the wallet connection).
 *   'window'  the small window, focused (the TapeKit card needs the user, D-d): a message signature. OKX lets
 *             these through there. personal_sign is not chain-bound; typed data on another chain needs a switch,
 *             so that hub answers 'needs-tab' and the request moves to a tab (hub-link.js).
 *   'notice'  the small window without focus: a connect with a gesture while the wallet account is known (only
 *             the no-click notice), chain switches and revokes (TapeKit's own records; the wallet is switched at
 *             signing time). When the snapshot is wrong (the wallet dropped the hub since), the hub refuses the
 *             wallet call there (router canPrompt, 'needs-tab') and the request moves to a tab.
 * @returns {'tab'|'window'|'notice'}
 */
export function hubPlace(method, gesture, snapshot, origin) {
  const kind = classify(method);
  if (kind === 'sign') return WINDOW_SIGNS.has(method) ? 'window' : 'tab';
  if (kind !== 'permission') return 'notice';
  if (!accountsOf(snapshot).length) return 'tab';
  if (accountsFor(permsOf(snapshot), origin, accountsOf(snapshot)).length) return 'notice';
  return gesture === true ? 'notice' : 'tab';
}

/** Does this request need the hub in a tab (hubPlace 'tab')? */
export const needsTab = (method, gesture, snapshot, origin) => hubPlace(method, gesture, snapshot, origin) === 'tab';

/** Authorized sites for the popup list, newest first. */
export function grantedSites(snapshot, hubUrl) {
  const perms = permsOf(snapshot);
  return grantedOrigins(perms)
    .map((origin) => {
      const site = parseSiteOrigin(origin, hubUrl);
      const info = grantInfo(perms, origin);
      return { origin, name: site ? site.name : origin, container: info.container, accounts: info.accounts, grantedAt: info.grantedAt };
    })
    .sort((a, b) => (b.grantedAt || 0) - (a.grantedAt || 0));
}
