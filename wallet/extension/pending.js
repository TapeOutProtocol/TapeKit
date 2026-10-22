// Requests the extension background has taken for the hub (design §10.1). Chrome stops an idle extension
// service worker after 30 s, and a signature can wait on the user for minutes, so every such request is
// written to chrome.storage.session (memory only, cleared when the browser closes, not readable by content
// scripts). A restarted worker reloads the table: the hub's answer still reaches the site.
//
// Entry: { hubId, kind: 'site'|'revoke', origin, documentId, tabId, siteId, method, params, gesture, place,
//          state: 'queued'|'sent'|'done', hostTabId, moved, reply, at }
//   place   where it first went (snapshot.js hubPlace); front.js pauses a site after a Reject of a 'tab'/'window' one
//   tabId   the site's tab                hostTabId  the tab of the hub host it is bound to (null: choosing)
//   queued  waiting for that hub to be ready     sent  the hub has it
//   moved   true once moved from the notice window to a hub tab (hub-link.js; at most once)
//   done    answered while the site's port was closed (the worker restarted); delivered when the relay resumes
// The in-memory table is replaced on every change (never edited) and written through in order.

export const PENDING_KEY = 'tapekit-wallet:pending:v1';
export const MAX_AGE_MS = 60 * 60 * 1000;   // older entries are dropped when the table is loaded

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const STATES = new Set(['queued', 'sent', 'done']);
const valid = (e) => isObject(e) && typeof e.hubId === 'string' && STATES.has(e.state) && Number.isFinite(e.at);

/**
 * @param {{ area: chrome.storage.StorageArea, now?: () => number, onError?: (e: unknown, where: string) => void }} opts
 */
export function createPendingStore({ area, now = Date.now, onError = () => {} }) {
  let entries = new Map();
  let writing = Promise.resolve();

  const loaded = (async () => {
    try {
      const got = await area.get(PENDING_KEY);
      const raw = got && isObject(got[PENDING_KEY]) ? got[PENDING_KEY] : {};
      const t = now();
      entries = new Map(Object.values(raw).filter((e) => valid(e) && t - e.at < MAX_AGE_MS).map((e) => [e.hubId, Object.freeze({ ...e })]));
    } catch (e) {
      onError(e, 'pending.load');
    }
  })();

  function persist() {
    const table = Object.fromEntries(entries);
    writing = writing.then(() => area.set({ [PENDING_KEY]: table })).catch((e) => onError(e, 'pending.save'));
    return writing;
  }

  function replace(next) {
    entries = next;
    return persist();
  }

  return Object.freeze({
    /** Resolves once the table from before a restart is loaded. Mutate only after this. */
    loaded,
    get: (hubId) => entries.get(hubId) || null,
    /** Entries matching `pred`, oldest first (insertion order). */
    find: (pred) => [...entries.values()].filter(pred),
    put: (entry) => replace(new Map(entries).set(entry.hubId, Object.freeze({ ...entry, at: now() }))),
    update(hubId, patch) {
      const e = entries.get(hubId);
      return e ? replace(new Map(entries).set(hubId, Object.freeze({ ...e, ...patch }))) : writing;
    },
    remove(hubIds) {
      const drop = new Set(hubIds);
      if (![...drop].some((id) => entries.has(id))) return writing;
      return replace(new Map([...entries].filter(([id]) => !drop.has(id))));
    },
    /** Resolves when every change so far is on disk (tests, and before replying to a port). */
    flushed: () => writing,
  });
}
