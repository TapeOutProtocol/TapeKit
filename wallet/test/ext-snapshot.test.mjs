// Offline unit tests for wallet/extension/snapshot.js: the extension's copy of the hub's grants (design §10.1).
// Its local answers must be exactly the router's, and nothing outside this gateway's sites may get in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanSnapshot, snapshotFor, localAnswer, connectedAnswer, needsTab, grantedSites, siteChainOf } from '../extension/snapshot.js';
import { parseSiteOrigin } from '../src/origin.js';
import { grant, setSiteChain } from '../src/permissions.js';
import { setup as routerSetup, A as RA, X as RX } from './router-harness.mjs';

const HUB = 'https://tapekit.org/.tape/wallet/';
const A = 'https://4246-0.tapekit.org';
const B = 'https://1-2-344.tapekit.org';
const X = '0x' + 'aa'.repeat(20);
const Y = '0x' + 'bb'.repeat(20);
const H = '0x' + '1f'.repeat(20);
const site = (o) => parseSiteOrigin(o, HUB);

test('clean: keeps this gateway\'s sites only, rebuilt field by field', () => {
  const perms = {
    [A]: { accounts: [X.toUpperCase().replace('0X', '0x'), 'junk'], chainId: '0xc4', grantedAt: 7, holder: H, container: H, extra: 'dropped' },
    [B]: { accounts: [], chainId: '0x2105' },                    // chain only, no grant
    'https://tapekit.org': { accounts: [X], chainId: '0x38' },   // the root
    'https://4246-0.tapekit.org.evil.com': { accounts: [X], chainId: '0x38' },
    'https://1-0.other.org': { accounts: [X], chainId: '0x38' },
    'https://5-0.tapekit.org': { accounts: [X], chainId: '0x38', holder: 'not-an-address' },
    __proto__: { polluted: true },
  };
  const snap = cleanSnapshot({ perms, accounts: [Y, 'nope', Y] }, HUB, 99);
  assert.deepEqual(Object.keys(snap.perms).sort(), [A, B].sort());
  assert.deepEqual(snap.perms[A], { accounts: [X], chainId: '0xc4', grantedAt: 7, holder: H, container: H });
  assert.deepEqual(snap.perms[B].accounts, []);
  assert.equal(snap.perms[B].chainId, '0x2105');
  assert.deepEqual(snap.accounts, [Y]);
  assert.equal(snap.hub, 'https://tapekit.org');
  assert.equal(snap.at, 99);
  assert.deepEqual(cleanSnapshot(null, HUB, 1).perms, {});
});

test('a snapshot is used only for the hub it was written for', () => {
  const snap = cleanSnapshot({ perms: {}, accounts: [] }, HUB, 1);
  assert.equal(snapshotFor(snap, HUB), snap);
  assert.equal(snapshotFor(snap, 'https://other.org/.tape/wallet/'), null);
  assert.equal(snapshotFor({ hub: 'https://tapekit.org' }, HUB), null);
  assert.equal(snapshotFor(undefined, HUB), null);
});

test('local answers equal the router\'s for the same grants and wallet accounts', async () => {
  const h = routerSetup({ accounts: [RX], connected: true });
  await h.router.handle({ origin: RA, method: 'eth_requestAccounts', params: [], gesture: true });
  await h.router.handle({ origin: RA, method: 'wallet_switchEthereumChain', params: [{ chainId: '0x2105' }] });
  const snap = cleanSnapshot({ perms: h.perms, accounts: h.router.accounts() }, 'https://tapekit.org/.tape/wallet/', 1);
  for (const method of ['eth_chainId', 'net_version', 'eth_accounts', 'wallet_getPermissions']) {
    assert.deepEqual(localAnswer(snap, site(RA), method), await h.router.handle({ origin: RA, method }), method);
  }
});

test('connect answers for a connected site equal the router\'s; null when the site has no visible grant', async () => {
  const h = routerSetup({ accounts: [RX], connected: true });
  await h.router.handle({ origin: RA, method: 'eth_requestAccounts', params: [], gesture: true });
  const snap = cleanSnapshot({ perms: h.perms, accounts: h.router.accounts() }, HUB, 1);
  for (const [method, params] of [['eth_requestAccounts', []], ['wallet_requestPermissions', [{ eth_accounts: {} }]]]) {
    assert.deepEqual(connectedAnswer(snap, site(RA), method, params), await h.router.handle({ origin: RA, method, params }), method);
  }
  assert.equal(connectedAnswer(snap, site(B), 'eth_requestAccounts', []), null);                  // A's grant is not B's
  assert.equal(connectedAnswer({ ...snap, accounts: [Y] }, site(RA), 'eth_requestAccounts', []), null);   // wallet moved on
  assert.equal(connectedAnswer(null, site(RA), 'eth_requestAccounts', []), null);
  for (const params of [[{ eth_accounts: {}, other: {} }], [], [[]], undefined]) {   // same -32602 as the router
    const err = await h.router.handle({ origin: RA, method: 'wallet_requestPermissions', params }).catch((e) => e);
    assert.equal(err.code, -32602);
    assert.throws(() => connectedAnswer(snap, site(RA), 'wallet_requestPermissions', params), (e) => e.code === err.code && e.message === err.message);
  }
});

test('local answers: home chain without a snapshot; A\'s grant is not B\'s; accounts must still be in the wallet', () => {
  assert.equal(localAnswer(null, site(B), 'eth_chainId'), '0xc4');
  assert.deepEqual(localAnswer(null, site(A), 'eth_accounts'), []);
  const perms = grant({}, A, [X], { chainId: '0x38', now: 1 });
  assert.deepEqual(localAnswer({ perms, accounts: [X] }, site(A), 'eth_accounts'), [X]);
  assert.deepEqual(localAnswer({ perms, accounts: [X] }, site(B), 'eth_accounts'), []);
  assert.deepEqual(localAnswer({ perms, accounts: [Y] }, site(A), 'eth_accounts'), []);
  assert.deepEqual(localAnswer({ perms, accounts: [Y] }, site(A), 'wallet_getPermissions'), []);
  assert.equal(siteChainOf({ perms: setSiteChain(perms, A, '0x2105'), accounts: [] }, site(A)), '0x2105');
});

test('a tab for the card, the one-time wallet connection and the site dialog; the gesture notice, chain switches and revokes need none', () => {
  const perms = grant({}, A, [X], { chainId: '0x38', now: 1 });
  const connected = { perms, accounts: [X] };
  assert.equal(needsTab('personal_sign', true, connected, A), true);
  assert.equal(needsTab('eth_sendTransaction', false, connected, A), true);
  assert.equal(needsTab('eth_signTypedData_v4', false, connected, A), true);
  assert.equal(needsTab('eth_requestAccounts', true, null, B), true);                       // no wallet account yet
  assert.equal(needsTab('eth_requestAccounts', true, { perms, accounts: [] }, B), true);
  assert.equal(needsTab('eth_requestAccounts', false, connected, B), true);                 // site dialog
  assert.equal(needsTab('eth_requestAccounts', true, connected, B), false);                 // notice only
  assert.equal(needsTab('wallet_requestPermissions', 'yes', connected, B), true);           // only literal true
  assert.equal(needsTab('eth_requestAccounts', false, connected, A), false);                 // already connected
  assert.equal(needsTab('wallet_switchEthereumChain', false, connected, A), false);
  assert.equal(needsTab('wallet_revokePermissions', false, connected, A), false);
});

test('the popup list: granted sites only, with name and container, newest first', () => {
  let perms = grant({}, A, [X], { chainId: '0x38', now: 1, container: H });
  perms = grant(perms, B, [X], { chainId: '0xc4', now: 2 });
  perms = setSiteChain(perms, 'https://9-0.tapekit.org', '0x2105');
  const list = grantedSites({ perms, accounts: [X] }, HUB);
  assert.deepEqual(list.map((s) => [s.origin, s.name]), [[B, '1.2.344.tape'], [A, '4246.0.tape']]);
  assert.equal(list[1].container, H);
  assert.deepEqual(grantedSites(null, HUB), []);
});
