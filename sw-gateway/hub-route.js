// Where the wallet hub is served (wallet router design §9). Shared by worker.js (Cloudflare) and dev-server.mjs
// (local), so production and dev follow one rule. Pure: no Node or Worker APIs.
//
// The hub lives only on the gateway ROOT host (tapekit.org, localhost:8096), at /.tape/wallet/. Wallet
// extensions then see one origin for every site, and site subdomains (4246-0.tapekit.org) can never run it:
// on a site host, /.tape/wallet/* is served exactly as before, i.e. the bootstrap page under the sandbox CSP.
// "Root" uses the same test as boot.js: the first label is not shaped like a site label (compat-tier labels such
// as 4246-0-open included) and the host has no trailing dot (another origin). Shape, not validity: an invalid site label such as 01-0 is not root either.

export const HUB_PREFIX = '/.tape/wallet/';
export const HUB_HTML = HUB_PREFIX + 'index.html';

/**
 * Header CSP for the hub page (design §9). frame-ancestors 'none' can only be set as a header, so the hub must
 * get it from the server. connect-src: https: for the kernel's nodes, 'self' for /.tape/config.json and the
 * blocklist (needed on http://localhost in dev; already covered by https: in production).
 * worker-src 'none': the hub must never register a Service Worker on the root (a root SW could serve a forged
 * hub to every site from then on). Without it, worker-src falls back to script-src 'self' and only the absence
 * of a register() call would stop it; with it, the browser refuses.
 * No Cross-Origin-Opener-Policy anywhere: the fallback channel needs window.opener between site and hub.
 */
export const HUB_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' https:; worker-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

// Site-shaped: <id>-<cpu> or <id>-<area>-<cpu>, optionally with the compat-tier suffix (serve.js OPEN_SUFFIX,
// e.g. 4246-0-open). A compat-tier host serves a site's own on-chain files, so it must never be treated as root.
const SITE_SHAPED = /^[0-9]+(-[0-9]+){1,2}(-open)?$/;

/** True for the gateway root host; false for site subdomains, site-shaped labels and trailing-dot hosts. */
export function isRootHost(hostname) {
  if (typeof hostname !== 'string' || !hostname || hostname.endsWith('.')) return false;
  return !SITE_SHAPED.test(hostname.split('.')[0]);
}

/**
 * @param {string} hostname  lower-case host name without port
 * @param {string} pathname  URL path
 * @returns {null | { kind: 'site' } | { kind: 'hub', path: string } | { kind: 'asset', path: string }}
 *   null: not a hub path. site: hub path on a site host, serve the bootstrap page as before.
 *   hub: the hub HTML (send HUB_CSP). asset: a hub script, stylesheet or module (static file).
 */
export function hubRoute(hostname, pathname) {
  if (typeof pathname !== 'string' || !pathname.startsWith(HUB_PREFIX)) return null;
  if (!isRootHost(hostname)) return { kind: 'site' };
  if (pathname === HUB_PREFIX || pathname === HUB_HTML) return { kind: 'hub', path: HUB_HTML };
  return { kind: 'asset', path: pathname };
}
