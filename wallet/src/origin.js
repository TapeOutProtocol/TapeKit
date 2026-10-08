// Which origins count as on-chain sites (design §5, R8).
// The only identity the router trusts is the origin the browser reports (MessageEvent.origin or the
// extension's MessageSender.origin). A site origin is exactly `<scheme>://<site label>.<hub host>`,
// where the hub host is the host the hub page itself is served from (port included, so dev works).
// Label parsing is the kernel's (`parseHostLabel`), the same rules the gateway uses (`sw.js` labelOf).
import { parseHostLabel, formatName } from '../../kernel/src/name.js';

const DEV_HOST = /^(localhost|[a-z0-9-]+(\.[a-z0-9-]+)*\.localhost|127\.0\.0\.1)$/;

/** Parse the hub location (string, URL or Location). Null when it cannot anchor site origins. */
function hubOf(hubLocation) {
  if (!hubLocation) return null;
  let url;
  try {
    url = new URL(typeof hubLocation === 'string' ? hubLocation : String(hubLocation.href));
  } catch {
    return null;
  }
  if (url.hostname.endsWith('.')) return null;
  const dev = DEV_HOST.test(url.hostname);
  if (url.protocol !== 'https:' && !(dev && url.protocol === 'http:')) return null;
  return { host: url.host, dev };
}

/**
 * @param {unknown} origin  browser-reported origin, e.g. 'https://4246-0.tapekit.org'
 * @param {string|URL|{href:string}} hubLocation  the hub page's own location
 * @returns {{ origin: string, host: string, name: string, area: number|null, label: string } | null}
 */
export function parseSiteOrigin(origin, hubLocation) {
  if (typeof origin !== 'string' || !origin || origin === 'null') return null;
  const hub = hubOf(hubLocation);
  if (!hub) return null;
  let url;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }
  // Exact match with the serialized origin rejects userinfo, paths, default ports, upper case, blob: etc.
  if (url.origin !== origin) return null;
  if (url.protocol !== 'https:' && !(hub.dev && url.protocol === 'http:')) return null;
  if (url.hostname.endsWith('.')) return null;   // 4246-0.tapekit.org. is a different origin
  const suffix = '.' + hub.host;
  if (!url.host.endsWith(suffix)) return null;
  const label = url.host.slice(0, -suffix.length);
  if (!label || label.includes('.')) return null;   // exactly one label below the hub host
  const parsed = parseHostLabel(label);
  if (!parsed) return null;
  return { origin, host: url.host, name: formatName(parsed.tokenId, parsed.cpu, 'tape', parsed.area), area: parsed.area, label };
}
