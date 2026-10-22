// Offline unit tests for wallet/src/store.js: the hub's localStorage-backed grant store and wallet choice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLocalStore, readChoice, writeChoice, PERMS_KEY, CHOICE_KEY } from '../src/store.js';

const A = 'https://4246-0.tapekit.org';
const X = '0x' + 'aa'.repeat(20);

function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
}
const broken = () => ({
  getItem() { throw new Error('SecurityError'); },
  setItem() { throw new Error('QuotaExceededError'); },
  removeItem() { throw new Error('SecurityError'); },
});

test('keys are versioned and match the hub contract', () => {
  assert.equal(PERMS_KEY, 'tapekit-wallet:perms:v1');
  assert.equal(CHOICE_KEY, 'tapekit-wallet:choice:v1');
});

test('set writes JSON and get reads it back as a fresh object', () => {
  const storage = fakeStorage();
  const store = createLocalStore({ storage });
  const perms = { [A]: { accounts: [X], chainId: '0x38', grantedAt: 1 } };
  store.set(perms);
  assert.deepEqual(JSON.parse(storage.map.get(PERMS_KEY)), perms);
  const a = store.get();
  assert.deepEqual(a, perms);
  assert.notEqual(a, perms);
  assert.notEqual(store.get(), a, 'each read is a new object, so callers cannot share mutations');
});

test('changes made by another hub window are seen on the next get', () => {
  const storage = fakeStorage();
  const store = createLocalStore({ storage });
  store.set({ [A]: { accounts: [X], chainId: '0x38', grantedAt: 1 } });
  storage.setItem(PERMS_KEY, '{}');
  assert.deepEqual(store.get(), {});
});

test('missing, malformed or non-object data reads as an empty store', () => {
  for (const raw of [undefined, 'not json', '[]', '"x"', 'null', '42']) {
    const storage = fakeStorage(raw === undefined ? {} : { [PERMS_KEY]: raw });
    assert.deepEqual(createLocalStore({ storage }).get(), {}, String(raw));
  }
});

test('a throwing or missing storage falls back to memory and reports the error', () => {
  const errors = [];
  const store = createLocalStore({ storage: broken(), onError: (e, where) => errors.push(where) });
  assert.deepEqual(store.get(), {});
  const perms = { [A]: { accounts: [X], chainId: '0x38', grantedAt: 1 } };
  store.set(perms);
  assert.deepEqual(store.get(), perms, 'the grant still works for this session');
  assert.ok(errors.length >= 2);
  const none = createLocalStore({ storage: null });
  none.set(perms);
  assert.deepEqual(none.get(), perms);
});

test('a revoke whose write fails is not undone by reading the old value back', () => {
  const storage = fakeStorage();
  const errors = [];
  const store = createLocalStore({ storage, onError: (e, where) => errors.push(where) });
  const perms = { [A]: { accounts: [X], chainId: '0x38', grantedAt: 1 } };
  store.set(perms);
  const write = storage.setItem;
  storage.setItem = () => { throw new Error('QuotaExceededError'); };   // reads still work, writes do not
  store.set({});
  assert.deepEqual(store.get(), {}, 'the revoke holds for this session');
  assert.deepEqual(errors, ['store.set']);
  storage.setItem = write;
  store.set({});
  assert.equal(storage.map.get(PERMS_KEY), '{}', 'a later write that works persists the current state');
  storage.setItem(PERMS_KEY, JSON.stringify(perms));
  assert.deepEqual(store.get(), perms, 'and reads follow storage again (other hub windows)');
});

test('values that cannot be serialized are refused before anything is stored', () => {
  const storage = fakeStorage();
  const store = createLocalStore({ storage });
  const cyclic = {}; cyclic.self = cyclic;
  assert.throws(() => store.set(cyclic), TypeError);
  assert.throws(() => store.set(null), TypeError);
  assert.equal(storage.map.size, 0);
});

test('wallet choice: read, write, and tolerate broken storage', () => {
  const storage = fakeStorage();
  assert.equal(readChoice(storage), null);
  assert.equal(writeChoice(storage, 'okx'), true);
  assert.equal(readChoice(storage), 'okx');
  assert.equal(writeChoice(storage, null), true);
  assert.equal(readChoice(storage), null);
  storage.setItem(CHOICE_KEY, 'x'.repeat(100));
  assert.equal(readChoice(storage), null, 'implausible ids are ignored');
  assert.equal(readChoice(broken()), null);
  assert.equal(writeChoice(broken(), 'okx'), false);
  assert.equal(readChoice(null), null);
});
