// A small fake of the chrome.* APIs the wallet extension uses, for offline unit tests. Ports come in pairs (the
// background end and the content-script end); storage areas copy values like Chrome does (structured clone).
export const EXT_ID = 'tapekitextensionid';

export function fakeEvent() {
  let fns = [];
  return {
    addListener(fn) { fns = [...fns, fn]; },
    removeListener(fn) { fns = fns.filter((f) => f !== fn); },
    hasListeners: () => fns.length > 0,
    fire: (...args) => fns.map((fn) => fn(...args)),
  };
}

export function fakeStorageArea(name, onChanged) {
  let data = {};
  const keysOf = (keys) => (keys === undefined || keys === null ? Object.keys(data) : [keys].flat());
  return {
    accessLevel: null,
    async get(keys) { return Object.fromEntries(keysOf(keys).filter((k) => k in data).map((k) => [k, structuredClone(data[k])])); },
    async set(items) {
      const changes = Object.fromEntries(Object.entries(items).map(([k, v]) => [k, { oldValue: data[k], newValue: structuredClone(v) }]));
      data = { ...data, ...structuredClone(items) };
      if (onChanged) onChanged.fire(changes, name);
    },
    async remove(keys) {
      const drop = new Set([keys].flat());
      data = Object.fromEntries(Object.entries(data).filter(([k]) => !drop.has(k)));
      if (onChanged) onChanged.fire(Object.fromEntries([...drop].map((k) => [k, { newValue: undefined }])), name);
    },
    async setAccessLevel({ accessLevel }) { this.accessLevel = accessLevel; },
    peek: () => structuredClone(data),
    load(items) { data = structuredClone(items); },
  };
}

/** Two connected port ends. `remote` is what a content script holds; `port` is what the background gets. */
export function fakePortPair(name, sender) {
  const ends = [];
  const make = () => {
    const end = { name, sender, onMessage: fakeEvent(), onDisconnect: fakeEvent(), closed: false, sent: [] };
    end.postMessage = (msg) => {
      if (end.closed) throw new Error('Attempting to use a disconnected port object');
      const copy = structuredClone(msg);
      end.sent.push(copy);
      const other = ends.find((e) => e !== end);
      queueMicrotask(() => { if (!other.closed) other.onMessage.fire(structuredClone(copy), other); });
    };
    end.disconnect = () => {
      if (end.closed) return;
      end.closed = true;
      const other = ends.find((e) => e !== end);
      other.closed = true;
      queueMicrotask(() => other.onDisconnect.fire(other));
    };
    ends.push(end);
    return end;
  };
  const port = make();
  const remote = make();
  remote.sender = undefined;
  return { port, remote };
}

/**
 * A fake `chrome` with every API the background, routing.js and the popup touch. Windows have a type and tabs;
 * window 1 is a normal window, focused, for the site tabs (`tabs.ensure`). A window made by windows.create gets
 * one tab with id windowId * 10; tabs.create numbers its tabs from 500. `log.opened` lists every hub host
 * opened: { how: 'tab'|'window', tabId, windowId, opts }.
 */
export function fakeChrome({ gateway = 'tapekit.org', granted = [] } = {}) {
  const onChanged = fakeEvent();
  const windows = new Map([[1, { id: 1, type: 'normal', focused: true }]]);
  const tabs = new Map();
  let windowSeq = 100;
  let tabSeq = 500;
  let lastFocused = 1;
  let perms = new Set(granted);
  let scripts = [];
  const log = { created: [], updated: [], removed: [], sentToTabs: [], requested: [], opened: [], tabsUpdated: [], tabsRemoved: [] };
  const tabsIn = (windowId) => [...tabs.values()].filter((t) => t.windowId === windowId).sort((a, b) => a.index - b.index);
  const copyTab = (t) => ({ ...t });
  function putTab(tab) {
    if (tab.active) for (const t of tabsIn(tab.windowId)) tabs.set(t.id, { ...t, active: false });
    const others = tabsIn(tab.windowId).filter((t) => t.id !== tab.id);
    const index = Math.min(Number.isInteger(tab.index) ? tab.index : others.length, others.length);
    const ordered = [...others.slice(0, index), tab, ...others.slice(index)];
    ordered.forEach((t, i) => tabs.set(t.id, { ...(t.id === tab.id ? tab : tabs.get(t.id)), index: i }));
    return copyTab(tabs.get(tab.id));
  }
  function dropTab(id, isWindowClosing) {
    const t = tabs.get(id);
    if (!t) return false;
    tabs.delete(id);
    tabsIn(t.windowId).forEach((x, i) => tabs.set(x.id, { ...x, index: i }));
    queueMicrotask(() => chrome.tabs.onRemoved.fire(id, { windowId: t.windowId, isWindowClosing }));
    return true;
  }
  const chrome = {
    log,
    runtime: {
      id: EXT_ID,
      lastError: undefined,
      getURL: (p) => `chrome-extension://${EXT_ID}/${p}`,
      onConnect: fakeEvent(),
      onMessage: fakeEvent(),
      onStartup: fakeEvent(),
      onInstalled: fakeEvent(),
    },
    storage: {
      onChanged,
      local: fakeStorageArea('local', onChanged),
      session: fakeStorageArea('session', onChanged),
      sync: fakeStorageArea('sync', onChanged),
    },
    windows: {
      onRemoved: fakeEvent(),
      async create(opts) {
        const id = ++windowSeq;
        log.created.push(structuredClone(opts));
        const focused = opts.focused === true;
        windows.set(id, { id, type: opts.type || 'normal', focused, url: opts.url });
        if (focused) lastFocused = id;
        const tab = putTab({ id: id * 10, windowId: id, active: true, url: opts.url, openerTabId: null });
        log.opened.push({ how: 'window', tabId: tab.id, windowId: id, opts: structuredClone(opts) });
        return { id, focused, type: opts.type || 'normal', tabs: [copyTab(tab)] };
      },
      async get(id) { if (!windows.has(id)) throw new Error('No window with id: ' + id); return { ...windows.get(id) }; },
      async getLastFocused({ windowTypes } = {}) {
        const w = windows.get(lastFocused);
        if (w && (!windowTypes || windowTypes.includes(w.type))) return { ...w };
        const normal = [...windows.values()].find((x) => !windowTypes || windowTypes.includes(x.type));
        if (!normal) throw new Error('No last-focused window');
        return { ...normal };
      },
      async update(id, info) {
        log.updated.push({ id, ...info });
        if (!windows.has(id)) throw new Error('No window with id: ' + id);
        windows.set(id, { ...windows.get(id), ...info });
        if (info.focused === true) lastFocused = id;
        return { ...windows.get(id) };
      },
      async remove(id) {
        log.removed.push(id);
        if (!windows.delete(id)) throw new Error('No window with id: ' + id);
        for (const t of tabsIn(id)) dropTab(t.id, true);
        queueMicrotask(() => chrome.windows.onRemoved.fire(id));
      },
      ids: () => [...windows.keys()],
    },
    tabs: {
      onRemoved: fakeEvent(),
      list: [],   // [{ id, url }] for tabs.query
      async query({ url }) {
        const prefix = url.endsWith('/*') ? url.slice(0, -1) : url;
        return chrome.tabs.list.filter((t) => t.url.startsWith(prefix));
      },
      async sendMessage(tabId, msg, opts) { log.sentToTabs.push({ tabId, msg: structuredClone(msg), opts }); },
      /** Test helper: a site tab that exists before the background sees it. */
      ensure({ id, windowId = 1, active = true, url = '' }) {
        if (!windows.has(windowId)) windows.set(windowId, { id: windowId, type: 'normal', focused: false });
        return tabs.has(id) ? copyTab(tabs.get(id)) : putTab({ id, windowId, active, url, openerTabId: null });
      },
      async create(opts) {
        const windowId = opts.windowId ?? lastFocused;
        if (!windows.has(windowId)) throw new Error('No window with id: ' + windowId);
        const tab = putTab({ id: ++tabSeq, windowId, index: opts.index, active: opts.active !== false, url: opts.url, openerTabId: opts.openerTabId ?? null });
        log.opened.push({ how: 'tab', tabId: tab.id, windowId, opts: structuredClone(opts) });
        return tab;
      },
      async get(id) { if (!tabs.has(id)) throw new Error('No tab with id: ' + id); return copyTab(tabs.get(id)); },
      async update(id, info) {
        log.tabsUpdated.push({ id, ...info });
        if (!tabs.has(id)) throw new Error('No tab with id: ' + id);
        if (typeof info.url === 'string') tabs.set(id, { ...tabs.get(id), url: info.url });   // the tab shows another page
        return info.active ? putTab({ ...tabs.get(id), active: true }) : copyTab(tabs.get(id));
      },
      /** The user drags a tab to another window (it becomes that window's active tab). */
      async move(id, { windowId, index = -1 }) {
        if (!tabs.has(id) || !windows.has(windowId)) throw new Error('No tab or window');
        const tab = tabs.get(id);
        tabs.delete(id);
        tabsIn(tab.windowId).forEach((x, i) => tabs.set(x.id, { ...x, index: i }));
        return putTab({ ...tab, windowId, index: index < 0 ? undefined : index, active: true });
      },
      async remove(id) {
        log.tabsRemoved.push(id);
        if (!dropTab(id, false)) throw new Error('No tab with id: ' + id);
      },
      all: () => [...tabs.values()].map(copyTab),
    },
    permissions: {
      onRemoved: fakeEvent(),
      answer: true,   // what the user clicks in the permission dialog
      async request({ origins }) {
        log.requested.push([...origins]);
        if (chrome.permissions.answer) origins.forEach((o) => perms.add(o));
        return chrome.permissions.answer;
      },
      async contains({ origins }) { return origins.every((o) => perms.has(o)); },
      async remove({ origins }) { origins.forEach((o) => perms.delete(o)); return true; },
      has: (o) => perms.has(o),
    },
    scripting: {
      async registerContentScripts(list) {
        for (const s of list) if (scripts.some((x) => x.id === s.id)) throw new Error(`Duplicate script ID '${s.id}'`);
        scripts = [...scripts, ...structuredClone(list)];
      },
      async getRegisteredContentScripts({ ids } = {}) { return structuredClone(ids ? scripts.filter((s) => ids.includes(s.id)) : scripts); },
      async unregisterContentScripts({ ids }) {
        for (const id of ids) if (!scripts.some((s) => s.id === id)) throw new Error(`Nonexistent script ID '${id}'`);
        scripts = scripts.filter((s) => !ids.includes(s.id));
      },
    },
  };
  chrome.storage.sync.load({ gateway });
  return chrome;
}

export const flush = async (n = 10) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
