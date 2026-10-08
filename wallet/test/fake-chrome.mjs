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

/** A fake `chrome` with every API the background, routing.js and the popup touch. */
export function fakeChrome({ gateway = 'tapekit.org', granted = [] } = {}) {
  const onChanged = fakeEvent();
  const windows = new Map();
  let windowSeq = 100;
  let perms = new Set(granted);
  let scripts = [];
  const log = { created: [], updated: [], removed: [], sentToTabs: [], requested: [] };
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
        windows.set(id, { id, focused: opts.focused === true, url: opts.url });
        return { id, focused: opts.focused === true, tabs: [{ id: id * 10, windowId: id }] };
      },
      async get(id) { if (!windows.has(id)) throw new Error('No window with id: ' + id); return { ...windows.get(id) }; },
      async update(id, info) { log.updated.push({ id, ...info }); windows.set(id, { ...windows.get(id), ...info }); return { ...windows.get(id) }; },
      async remove(id) {
        log.removed.push(id);
        if (!windows.delete(id)) throw new Error('No window with id: ' + id);
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
