// A fake browser window for the content-script tests: one window object shared by the page (MAIN world) and the
// content scripts (ISOLATED world), as in Chrome, where both see every message posted on the window. Messages a
// window posts to itself arrive with `source === win` and the window's origin; `deliver` sends anything else.
import { fakeEvent, fakePortPair, EXT_ID } from './fake-chrome.mjs';

export function fakeWindow(href, { top = true, userActive = false } = {}) {
  const url = new URL(href);
  let listeners = new Set();
  let attrs = new Map();   // document.documentElement's attributes
  const win = {
    document: { documentElement: {
      setAttribute: (k, v) => { attrs = new Map(attrs).set(k, String(v)); },
      hasAttribute: (k) => attrs.has(k),
      getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
    } },
    location: { href: url.href, origin: url.origin, protocol: url.protocol, hostname: url.hostname, pathname: url.pathname, port: url.port, hash: url.hash },
    navigator: { language: 'en', userActivation: { isActive: userActive, hasBeenActive: userActive } },
    posted: [],
    addEventListener(type, fn) { if (type === 'message') listeners = new Set(listeners).add(fn); },
    removeEventListener(type, fn) { const next = new Set(listeners); next.delete(fn); listeners = next; },
    dispatchEvent(ev) { (win.custom[ev.type] || []).forEach((fn) => fn(ev)); return true; },
    custom: {},
    postMessage(data, targetOrigin) {
      const copy = structuredClone(data);
      win.posted.push({ data: copy, targetOrigin });
      if (targetOrigin !== '*' && targetOrigin !== url.origin) return;
      queueMicrotask(() => win.deliver({ data: structuredClone(copy), origin: url.origin, source: win }));
    },
    deliver(event) { for (const fn of listeners) fn(event); },
    listenerCount: () => listeners.size,
  };
  const addCustom = (type, fn) => { win.custom = { ...win.custom, [type]: [...(win.custom[type] || []), fn] }; };
  const add = win.addEventListener;
  win.addEventListener = (type, fn) => (type === 'message' ? add(type, fn) : addCustom(type, fn));
  win.top = top ? win : { other: true };
  win.CustomEvent = class { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } };
  return win;
}

/** chrome.runtime as a content script sees it; `background` collects the background ends of its ports. */
export function fakeRuntime({ broken = false } = {}) {
  const background = [];
  const runtime = {
    id: EXT_ID,
    lastError: undefined,
    onMessage: fakeEvent(),
    connects: 0,
    broken,
    connect({ name }) {
      runtime.connects += 1;
      if (runtime.broken) throw new Error('Extension context invalidated.');
      const { port, remote } = fakePortPair(name, { id: EXT_ID });
      const got = [];
      port.onMessage.addListener((m) => got.push(m));
      background.push({ port, got });
      return remote;
    },
  };
  return { runtime, background, last: () => background.at(-1) };
}
