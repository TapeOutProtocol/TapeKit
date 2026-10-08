// Offline unit tests for wallet/src/permissions.js: per-origin grants, pure functions only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { grant, revoke, accountsFor, siteChain, setSiteChain, isGranted, grantedOrigins, grantedAt, grantHolder, grantInfo } from '../src/permissions.js';

const A = 'https://4246-0.tapekit.org';
const B = 'https://1-2-344.tapekit.org';
const X = '0x' + 'aa'.repeat(20);
const Y = '0x' + 'bb'.repeat(20);
const X_MIXED = '0x' + 'aA'.repeat(20);
const H1 = '0x' + '1F'.repeat(20);
const H2 = '0x' + '2e'.repeat(20);
const CONTAINER = '0x' + 'C0'.repeat(20);

const deepFreeze = (o) => {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); }
  return o;
};
const clone = (o) => JSON.parse(JSON.stringify(o));

test('grant records lower-cased accounts for one origin and returns a new object', () => {
  const empty = deepFreeze({});
  const p = grant(empty, A, [X_MIXED], { chainId: '0x38', now: 1000 });
  assert.notEqual(p, empty);
  assert.deepEqual(empty, {});
  assert.deepEqual(p, { [A]: { accounts: [X], chainId: '0x38', grantedAt: 1000, holder: null, container: null } });
});

test('grant adds a new account after the existing ones and keeps the site chain', () => {
  const before = deepFreeze({ [A]: { accounts: [X], chainId: '0xc4', grantedAt: 1 } });
  const snapshot = clone(before);
  const p = grant(before, A, [Y], { chainId: '0x38', now: 2 });
  assert.deepEqual(before, snapshot, 'input unchanged');
  assert.deepEqual(p[A], { accounts: [X, Y], chainId: '0xc4', grantedAt: 2, holder: null, container: null });
  assert.deepEqual(grant(p, A, [X], { chainId: '0x38', now: 3 })[A].accounts, [X, Y], 'no duplicates');
});

test('grant rejects bad origins, accounts or chains', () => {
  assert.throws(() => grant({}, '', [X], { chainId: '0x38', now: 1 }), TypeError);
  assert.throws(() => grant({}, A, ['0x1234'], { chainId: '0x38', now: 1 }), TypeError);
  assert.throws(() => grant({}, A, [], { chainId: '0x38', now: 1 }), TypeError);
  assert.throws(() => grant({}, A, 'nope', { chainId: '0x38', now: 1 }), TypeError);
  assert.throws(() => grant({}, A, [X], { chainId: '0x1', now: 1 }), TypeError);
  assert.throws(() => grant({}, '__proto__', [X], { chainId: '0x38', now: 1 }), TypeError);
});

test('grant records the circuit holder and container, lower-cased (SPEC §7.3)', () => {
  const p = deepFreeze(grant({}, A, [X], { chainId: '0x38', now: 1, holder: H1, container: CONTAINER }));
  assert.deepEqual(p[A], { accounts: [X], chainId: '0x38', grantedAt: 1, holder: H1.toLowerCase(), container: CONTAINER.toLowerCase() });
  assert.equal(grantHolder(p, A), H1.toLowerCase());
  assert.equal(grantHolder(p, B), null);
  assert.equal(grantHolder(grant({}, A, [X], { chainId: '0x38', now: 1 }), A), null);
  assert.throws(() => grant({}, A, [X], { chainId: '0x38', now: 1, holder: '0x0' }), TypeError);
  assert.throws(() => grant({}, A, [X], { chainId: '0x38', now: 1, container: 7 }), TypeError);
});

test('grantInfo returns a copy of what the hub lists, or null', () => {
  const p = deepFreeze(grant({}, A, [X_MIXED], { chainId: '0x38', now: 5, holder: H1, container: CONTAINER }));
  const info = grantInfo(p, A);
  assert.deepEqual(info, { accounts: [X], chainId: '0x38', grantedAt: 5, holder: H1.toLowerCase(), container: CONTAINER.toLowerCase() });
  info.accounts.push(Y);
  assert.deepEqual(p[A].accounts, [X], 'the stored entry is not shared');
  assert.equal(grantInfo(p, B), null);
  assert.equal(grantInfo(setSiteChain({}, B, '0xc4'), B), null, 'a remembered chain alone is not a grant');
});

test("a grant for a new holder does not inherit the old holder's accounts", () => {
  const old = deepFreeze(grant({}, A, [X], { chainId: '0xc4', now: 1, holder: H1, container: CONTAINER }));
  const p = grant(old, A, [Y], { chainId: '0x38', now: 2, holder: H2, container: CONTAINER });
  assert.deepEqual(p[A].accounts, [Y]);
  assert.equal(p[A].holder, H2.toLowerCase());
  assert.equal(p[A].chainId, '0xc4', 'the virtual chain is a site setting and is kept');
  assert.deepEqual(grant(old, A, [Y], { chainId: '0x38', now: 2, holder: H1.toLowerCase() })[A].accounts, [X, Y], 'same holder in any case merges');
});

test("A's grant is invisible to B", () => {
  const p = deepFreeze(grant({}, A, [X], { chainId: '0x38', now: 1 }));
  assert.deepEqual(accountsFor(p, A, [X]), [X]);
  assert.deepEqual(accountsFor(p, B, [X]), []);
  assert.ok(isGranted(p, A));
  assert.ok(!isGranted(p, B));
  assert.ok(!isGranted(p, 'toString'));
  assert.deepEqual(accountsFor(p, 'constructor', [X]), []);
});

test('accountsFor is the intersection with the wallet, in wallet order', () => {
  const p = deepFreeze(grant(grant({}, A, [X], { chainId: '0x38', now: 1 }), A, [Y], { chainId: '0x38', now: 2 }));
  const wallet = deepFreeze([Y.toUpperCase().replace('0X', '0x'), X]);
  assert.deepEqual(accountsFor(p, A, wallet), [Y, X]);
  assert.deepEqual(accountsFor(p, A, [Y]), [Y]);
  assert.deepEqual(accountsFor(p, A, ['0x' + 'cc'.repeat(20)]), [], 'wallet switched to an ungranted account');
  assert.deepEqual(accountsFor(p, A, []), []);
  assert.deepEqual(accountsFor(p, A, null), []);
});

test('revoke removes only that origin', () => {
  const p = deepFreeze(grant(grant({}, A, [X], { chainId: '0x38', now: 1 }), B, [X], { chainId: '0xc4', now: 1 }));
  const snapshot = clone(p);
  const q = revoke(p, A);
  assert.deepEqual(p, snapshot);
  assert.deepEqual(Object.keys(q), [B]);
  assert.deepEqual(accountsFor(q, A, [X]), []);
  assert.deepEqual(accountsFor(q, B, [X]), [X]);
  assert.deepEqual(revoke(q, A), q, 'revoking an absent origin is a no-op');
});

test('siteChain falls back to the default; setSiteChain changes only that site', () => {
  const p = deepFreeze(grant({}, A, [X], { chainId: '0x38', now: 1 }));
  assert.equal(siteChain(p, A, '0x2105'), '0x38');
  assert.equal(siteChain(p, B, '0xc4'), '0xc4');
  const q = deepFreeze(setSiteChain(p, A, '0xc4'));
  assert.equal(siteChain(q, A, '0x38'), '0xc4');
  assert.deepEqual(q[A].accounts, [X]);
  assert.equal(siteChain(p, A, '0x2105'), '0x38', 'old object unchanged');
  const r = setSiteChain(q, B, '0x2105');
  assert.equal(siteChain(r, B, '0x38'), '0x2105');
  assert.ok(!isGranted(r, B), 'remembering a chain is not a grant');
  assert.deepEqual(accountsFor(r, B, [X]), []);
  assert.throws(() => setSiteChain(q, A, '0x1'), TypeError);
});

test('grantedOrigins lists only origins with accounts; grantedAt reads the time', () => {
  const p = setSiteChain(grant({}, A, [X], { chainId: '0x38', now: 7 }), B, '0xc4');
  assert.deepEqual(grantedOrigins(p), [A]);
  assert.equal(grantedAt(p, A), 7);
  assert.equal(grantedAt(p, B), null);
  assert.equal(grantedAt(p, 'https://nope.tapekit.org'), null);
  assert.equal(grantedAt(null, A), null);
});

test('functions tolerate a missing or malformed store', () => {
  assert.deepEqual(accountsFor(undefined, A, [X]), []);
  assert.equal(siteChain(null, A, '0x38'), '0x38');
  assert.deepEqual(accountsFor({ [A]: { accounts: 'oops' } }, A, [X]), []);
  assert.equal(siteChain({ [A]: { chainId: '0x1' } }, A, '0x38'), '0x38', 'stored unsupported chain is ignored');
  assert.deepEqual(grantedOrigins(null), []);
});
