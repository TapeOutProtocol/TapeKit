// Offline unit tests for wallet/src/router.js, part 3: grants are bound to the circuit holder.
// SPEC §7.3: a circuit can change hands, and the same origin then belongs to a new holder. A grant made for
// the old holder must not carry over to the new one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, granted, rejectsWith, A, B, X, Y, H1, H2, CONTAINER } from './router-harness.mjs';
import { isGranted } from '../src/permissions.js';

const hex = (s) => '0x' + Buffer.from(s, 'utf8').toString('hex');

/** Hand site A's circuit to H2 and forget cached identities, as if 30 s had passed. */
function changeHands(h, holders, name = '4246.0.tape') {
  holders[name] = H2;
  h.identity.clear();
}

test('a grant records the holder and container the site resolved to', async () => {
  const h = setup();
  await granted(h, A);
  assert.equal(h.perms[A].holder, H1);
  assert.equal(h.perms[A].container, CONTAINER);
});

test('the holder is compared case-insensitively', async () => {
  const holders = { '4246.0.tape': H1.toUpperCase().replace('0X', '0x') };
  const h = setup({ holders });
  await granted(h, A);
  assert.equal(await h.call(A, 'personal_sign', [hex('x'), X]), '0xsig');
  assert.deepEqual(await h.call(A, 'eth_requestAccounts', []), [X]);
  assert.equal(h.ui.sites.length, 0);
});

test('after the circuit changes hands, a connect without a gesture is asked again', async () => {
  const holders = {};
  const h = setup({ holders, siteDecision: 'reject' });
  await granted(h, A, B);
  changeHands(h, holders);
  await rejectsWith(h.call(A, 'eth_requestAccounts', []), 4001);
  assert.equal(h.ui.sites.length, 1, 'the new holder gets the normal confirmation');
  assert.deepEqual(h.events, [[A, 'accountsChanged', []]], 'the old grant is dropped and the site told');
  assert.deepEqual(await h.call(A, 'eth_accounts', []), []);
  assert.deepEqual(await h.call(B, 'eth_accounts', []), [X], 'other sites keep their grants');
});

test('after the circuit changes hands, a connect with a gesture grants anew with a notice', async () => {
  const holders = {};
  const h = setup({ holders });
  await granted(h, A);
  changeHands(h, holders);
  assert.deepEqual(await h.call(A, 'eth_requestAccounts', [], true), [X]);
  assert.equal(h.ui.notices.length, 1, 'D-c notice for the new holder');
  assert.deepEqual(h.events, [[A, 'accountsChanged', []], [A, 'accountsChanged', [X]]]);
  assert.equal(h.perms[A].holder, H2);
});

test('signing after the circuit changes hands gives 4100 and drops the grant', async () => {
  const holders = {};
  const h = setup({ holders });
  await granted(h, A);
  await h.call(A, 'wallet_switchEthereumChain', [{ chainId: '0x2105' }]);
  h.events.length = 0;
  changeHands(h, holders);
  await rejectsWith(h.call(A, 'personal_sign', [hex('x'), X]), 4100);
  assert.deepEqual(h.events, [[A, 'accountsChanged', []]]);
  assert.equal(h.ui.cards.length, 0, 'no card is shown');
  assert.equal(h.wallet.count('personal_sign'), 0);
  assert.ok(!isGranted(h.perms, A));
  assert.equal(await h.call(A, 'eth_chainId', []), '0x2105', 'the virtual chain is kept, as with any revoke');
});

test('no accountsChanged when the dropped grant had no visible accounts', async () => {
  const holders = {};
  const h = setup({ holders, siteDecision: 'reject' });
  await granted(h, A);
  h.wallet.state.accounts = [Y];
  await h.router.walletAccountsChanged([Y]);
  h.events.length = 0;
  changeHands(h, holders);
  await rejectsWith(h.call(A, 'personal_sign', [hex('x'), X]), 4100);
  assert.deepEqual(h.events, []);
  assert.ok(!isGranted(h.perms, A));
});

test('local answers stay network-free, so they can lag a holder change until the next request', async () => {
  const holders = {};
  const h = setup({ holders });
  await granted(h, A);
  changeHands(h, holders);
  h.kernelCalls.length = 0;
  assert.deepEqual(await h.call(A, 'eth_accounts', []), [X]);
  assert.equal(h.kernelCalls.length, 0);
  await rejectsWith(h.call(A, 'personal_sign', [hex('x'), X]), 4100);
  assert.deepEqual(await h.call(A, 'eth_accounts', []), []);
});
