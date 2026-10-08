// The EIP-1193 provider a site sees, and its EIP-6963 announcement as "TapeKit" (R2, design §4).
// The transport (extension relay or hub popup) is injected:
//   transport.request({ method, params }) → Promise<result>, rejects with { code, message, data? }
//   transport.subscribe((event, data) => void)   events pushed by the router for this site only
// It never touches the page's global `ethereum` property; discovery is EIP-6963 only.
// No imports on purpose: later steps wrap this file into a classic script (fallback client, extension
// MAIN-world script), so every helper it needs lives in this file.

const ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96">'
  + '<rect width="96" height="96" rx="20" fill="#111"/>'
  + '<rect x="14" y="26" width="68" height="44" rx="6" fill="none" stroke="#fff" stroke-width="5"/>'
  + '<circle cx="34" cy="48" r="7" fill="#fff"/><circle cx="62" cy="48" r="7" fill="#fff"/></svg>';
const ICON = 'data:image/svg+xml,' + encodeURIComponent(ICON_SVG);

/** EIP-1193 ProviderRpcError. */
export class ProviderRpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.name = 'ProviderRpcError';
    this.code = code;
    if (data !== undefined) this.data = data;
  }
}

function toProviderError(e) {
  if (e instanceof ProviderRpcError) return e;
  if (e && typeof e === 'object' && Number.isInteger(e.code) && typeof e.message === 'string') return new ProviderRpcError(e.code, e.message, e.data);
  return new ProviderRpcError(-32603, 'Internal error.');
}

function uuidV4() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** EIP-6963 provider info; one uuid per page load. */
export function createProviderInfo() {
  return Object.freeze({ uuid: uuidV4(), name: 'TapeKit', icon: ICON, rdns: 'org.tapekit' });
}

function report(e) {
  if (typeof globalThis.reportError === 'function') globalThis.reportError(e);
  else setTimeout(() => { throw e; }, 0);
}

const validArgs = (a) => !!a && typeof a === 'object' && typeof a.method === 'string' && a.method.length > 0
  && (a.params === undefined || (a.params !== null && typeof a.params === 'object'));

/** @param {{ transport: { request: Function, subscribe: Function } }} opts */
export function createProvider({ transport } = {}) {
  if (!transport || typeof transport.request !== 'function' || typeof transport.subscribe !== 'function') {
    throw new TypeError('createProvider: transport.request and transport.subscribe are required');
  }
  let listeners = new Map();   // event → listener[]; replaced on change, never edited in place

  transport.subscribe((event, data) => {
    for (const fn of listeners.get(event) || []) {
      try { fn(data); } catch (e) { report(e); }   // one broken listener must not starve the others
    }
  });

  const provider = Object.freeze({
    isTapeKit: true,
    async request(args) {
      if (!validArgs(args)) throw new ProviderRpcError(-32602, 'Expected { method: string, params?: array | object }.');
      try {
        return await transport.request({ method: args.method, params: args.params });
      } catch (e) {
        throw toProviderError(e);
      }
    },
    on(event, listener) {
      if (typeof listener !== 'function') throw new TypeError('listener must be a function');
      listeners = new Map(listeners).set(event, [...(listeners.get(event) || []), listener]);
      return provider;
    },
    removeListener(event, listener) {
      const list = listeners.get(event) || [];
      const i = list.indexOf(listener);
      if (i >= 0) listeners = new Map(listeners).set(event, [...list.slice(0, i), ...list.slice(i + 1)]);
      return provider;
    },
  });
  return provider;
}

/**
 * Announce the provider (EIP-6963): once now, and again on every eip6963:requestProvider.
 * The detail is frozen and the same object every time. Returns a function that stops answering.
 */
export function announceProvider(win, provider, info = createProviderInfo()) {
  const detail = Object.freeze({
    info: Object.freeze({ uuid: info.uuid, name: info.name, icon: info.icon, rdns: info.rdns }),
    provider,
  });
  const Ev = win.CustomEvent || globalThis.CustomEvent;
  const announce = () => win.dispatchEvent(new Ev('eip6963:announceProvider', { detail }));
  win.addEventListener('eip6963:requestProvider', announce);
  announce();
  return () => win.removeEventListener('eip6963:requestProvider', announce);
}
