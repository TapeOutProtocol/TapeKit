// The hub's storage (design §9): grants and the chosen wallet live in the hub origin's localStorage, never in
// cookies. tapekit.org is not on the Public Suffix List, so every site subdomain can set cookies for the root;
// localStorage is per origin and sites cannot touch it.
// Every access is wrapped: storage can be disabled (SecurityError), full (QuotaExceededError) or edited by
// hand. When it fails, the store keeps working from memory for this hub session and reports the error.

export const PERMS_KEY = 'tapekit-wallet:perms:v1';
export const CHOICE_KEY = 'tapekit-wallet:choice:v1';

const CHOICE_ID = /^[a-z0-9-]{1,32}$/;
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

function parse(raw) {
  if (typeof raw !== 'string') return {};
  try {
    const v = JSON.parse(raw);
    return isPlainObject(v) ? v : {};
  } catch {
    return {};
  }
}

/**
 * Router store ({ get, set }) over localStorage. Reads go to storage every time, so a revoke made in another
 * hub window is seen at once. Each read returns a new object.
 * @param {{ storage: Storage|null, key?: string, onError?: (e: unknown, where: string) => void }} opts
 */
export function createLocalStore({ storage, key = PERMS_KEY, onError = () => {} } = {}) {
  let memory = '{}';   // last good JSON: used when storage cannot be read or written
  // After a failed write, storage still holds the state from before it (e.g. a grant the user just revoked).
  // Reading it back would silently undo that change, so reads stay on memory until a write succeeds again.
  let stale = false;

  function get() {
    if (storage && !stale) {
      try {
        const raw = storage.getItem(key);
        memory = raw === null ? '{}' : raw;
      } catch (e) {
        onError(e, 'store.get');
      }
    }
    return parse(memory);
  }

  function set(perms) {
    if (!isPlainObject(perms)) throw new TypeError('store: permissions must be an object');
    let json;
    try {
      json = JSON.stringify(perms);
    } catch {
      throw new TypeError('store: permissions must be JSON-serializable');
    }
    memory = json;
    if (!storage) return;
    try {
      storage.setItem(key, json);
      stale = false;
    } catch (e) {
      stale = true;
      onError(e, 'store.set');
    }
  }

  return Object.freeze({ get, set });
}

/** The wallet adapter id the user picked when several were installed, or null. */
export function readChoice(storage, key = CHOICE_KEY) {
  if (!storage) return null;
  try {
    const v = storage.getItem(key);
    return typeof v === 'string' && CHOICE_ID.test(v) ? v : null;
  } catch {
    return null;
  }
}

/** Remember (or with null, forget) the picked wallet. Returns false when storage refused. */
export function writeChoice(storage, id, key = CHOICE_KEY) {
  if (!storage) return false;
  try {
    if (id === null) storage.removeItem(key);
    else storage.setItem(key, String(id));
    return true;
  } catch {
    return false;
  }
}
