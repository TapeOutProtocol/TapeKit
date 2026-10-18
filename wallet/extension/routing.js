// Turning wallet routing on and off in the TapeKit extension (design §10.1, R6). Used by the popup (the
// "enable" button) and the background (gateway changes, removed permissions). `chrome` is passed in, so the
// rules are unit-tested with a fake.
//
// The manifest asks for no host access at install time: `optional_host_permissions` only. Enabling requests
// access to the configured gateway from the button's click handler (Chrome requires a user gesture), then
// registers three content scripts:
//   wallet/inpage.js     MAIN world, gateway sites: the EIP-1193 / EIP-6963 provider
//   wallet/relay.js      ISOLATED world, gateway sites: page ⇄ extension, reads the user gesture
//   wallet/hub-relay.js  ISOLATED world, the hub page on the gateway root: extension ⇄ hub
// Match patterns ignore ports, so the patterns use the host only; the background still checks the exact origin
// (port included) of every sender. `https://*.<host>/*` also matches the bare root, which is why the site
// scripts exclude it, and /.tape/* (status and notice pages stay script-free, SPEC §7.8).
//
// State: chrome.storage.local[ROUTING_KEY] = { gateway } while enabled for that gateway (host[:port]).

export const ROUTING_KEY = 'tapekit-wallet:routing:v1';
export const SCRIPT_IDS = Object.freeze(['tapekit-wallet-inpage', 'tapekit-wallet-relay', 'tapekit-wallet-hub-relay']);
export const SCRIPT_FILES = Object.freeze({ inpage: 'wallet/inpage.js', relay: 'wallet/relay.js', hubRelay: 'wallet/hub-relay.js' });

const GATEWAY = /^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*)(?::([0-9]{1,5}))?$/;
const IPV4 = /^[0-9]+(\.[0-9]+){3}$/;
const SITE_SHAPED = /^[0-9]+(-[0-9]+){1,2}$/;
// Same scheme rule as extension/gateway.js targetUrl(): plain http only for a localhost gateway.
const PLAIN_HTTP = /^localhost$/;

/**
 * The gateway setting (as normalized by extension/gateway.js getGateway: lower case, no scheme) → everything
 * routing needs, or null when wallet routing cannot work there: empty, an IP address (sites need subdomains),
 * or a site host itself.
 * @param {string} gateway  e.g. 'tapekit.org', 'localhost:8096'
 */
export function gatewayInfo(gateway) {
  const m = GATEWAY.exec(String(gateway || ''));
  if (!m) return null;
  const host = m[1];
  const port = m[2] || '';
  if (IPV4.test(host) || SITE_SHAPED.test(host.split('.')[0])) return null;
  if (port && (Number(port) < 1 || Number(port) > 65535)) return null;
  const scheme = PLAIN_HTTP.test(host) ? 'http' : 'https';
  const hubOrigin = `${scheme}://${host}${port ? ':' + port : ''}`;
  return Object.freeze({
    gateway: `${host}${port ? ':' + port : ''}`,
    host,
    scheme,
    hubOrigin,
    hubUrl: hubOrigin + '/.tape/wallet/',
    sitesPattern: `${scheme}://*.${host}/*`,
    rootPattern: `${scheme}://${host}/*`,
  });
}

/** Host permissions to request: every site of the gateway, plus the root (the hub). */
export const originsFor = (info) => [info.sitesPattern, info.rootPattern];

/** chrome.scripting.registerContentScripts() entries for this gateway. */
export function contentScriptsFor(info) {
  const site = {
    matches: [info.sitesPattern],
    excludeMatches: [info.rootPattern, `${info.scheme}://*.${info.host}/.tape/*`],
    runAt: 'document_start',
    allFrames: false,
    persistAcrossSessions: true,
  };
  return [
    { ...site, id: SCRIPT_IDS[0], js: [SCRIPT_FILES.inpage], world: 'MAIN' },
    { ...site, id: SCRIPT_IDS[1], js: [SCRIPT_FILES.relay], world: 'ISOLATED' },
    {
      id: SCRIPT_IDS[2], matches: [`${info.scheme}://${info.host}/.tape/wallet/*`], js: [SCRIPT_FILES.hubRelay],
      runAt: 'document_start', allFrames: false, world: 'ISOLATED', persistAcrossSessions: true,
    },
  ];
}

const readState = async (chrome) => {
  const got = await chrome.storage.local.get(ROUTING_KEY);
  const state = got && got[ROUTING_KEY];
  return state && typeof state.gateway === 'string' ? state : null;
};

async function unregisterScripts(chrome) {
  const ours = await chrome.scripting.getRegisteredContentScripts({ ids: [...SCRIPT_IDS] });
  if (ours.length) await chrome.scripting.unregisterContentScripts({ ids: ours.map((s) => s.id) });
}

async function registerScripts(chrome, info) {
  await unregisterScripts(chrome);
  await chrome.scripting.registerContentScripts(contentScriptsFor(info));
}

/** All three scripts are registered, each for this gateway's patterns. */
async function scriptsInPlace(chrome, info) {
  const ours = await chrome.scripting.getRegisteredContentScripts({ ids: [...SCRIPT_IDS] });
  const same = (a, b) => JSON.stringify(a || []) === JSON.stringify(b || []);
  return contentScriptsFor(info).every((want) => ours.some((s) => s.id === want.id && same(s.matches, want.matches) && same(s.excludeMatches, want.excludeMatches)));
}

const sameOrigins = (a, b) => !!a && !!b && a.scheme === b.scheme && a.host === b.host;

/** Give back the old gateway's host access (least privilege). Required host permissions cannot be removed. */
async function dropAccess(chrome, info) {
  if (!info) return;
  try { await chrome.permissions.remove({ origins: originsFor(info) }); } catch { /* required, or already gone */ }
}

/** Whether routing is on for this gateway. */
export async function routingState(chrome, gateway) {
  const info = gatewayInfo(gateway);
  const state = await readState(chrome);
  return { info, enabled: !!info && !!state && state.gateway === info.gateway };
}

/**
 * The popup's "enable" button. Call it straight from the click handler: chrome.permissions.request is its
 * first await, so it still runs inside the user gesture.
 * @returns {Promise<{ ok: boolean, reason?: 'gateway'|'denied' }>}
 */
export async function enableRouting(chrome, gateway) {
  const info = gatewayInfo(gateway);
  if (!info) return { ok: false, reason: 'gateway' };
  const granted = await chrome.permissions.request({ origins: originsFor(info) });
  if (!granted) return { ok: false, reason: 'denied' };
  await registerScripts(chrome, info);
  await chrome.storage.local.set({ [ROUTING_KEY]: { gateway: info.gateway } });
  return { ok: true };
}

/** The popup's "disable" button: no more injection, and the gateway's host access is given back. */
export async function disableRouting(chrome) {
  const state = await readState(chrome);
  await unregisterScripts(chrome);
  await chrome.storage.local.remove(ROUTING_KEY);
  if (state) await dropAccess(chrome, gatewayInfo(state.gateway));
}

/**
 * Background: start-up, install or update, the gateway setting changed, or host access was removed. Same
 * gateway with access → make sure the scripts are registered: registrations persist across browser sessions,
 * but an extension reload or update drops them (measured 2026-10-18, Chrome 155: routing still said "on" and no
 * site got the wallet), and access is already granted, so no click is needed. A new gateway already covered by
 * granted access → re-register for it. Otherwise routing is turned off until the user enables it again (that
 * needs a click).
 * @returns {Promise<'off'|'on'>}
 */
export async function syncRouting(chrome, gateway) {
  const state = await readState(chrome);
  if (!state) return 'off';
  const info = gatewayInfo(gateway);
  const old = gatewayInfo(state.gateway);
  const covered = !!info && await chrome.permissions.contains({ origins: originsFor(info) });
  if (covered && state.gateway === info.gateway) {
    if (!(await scriptsInPlace(chrome, info))) await registerScripts(chrome, info);
    return 'on';
  }
  await unregisterScripts(chrome);
  if (covered) {
    await chrome.scripting.registerContentScripts(contentScriptsFor(info));
    await chrome.storage.local.set({ [ROUTING_KEY]: { gateway: info.gateway } });
    if (!sameOrigins(old, info)) await dropAccess(chrome, old);
    return 'on';
  }
  await chrome.storage.local.remove(ROUTING_KEY);
  if (!sameOrigins(old, info)) await dropAccess(chrome, old);
  return 'off';
}
