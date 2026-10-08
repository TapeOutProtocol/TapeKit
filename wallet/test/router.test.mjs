// Offline unit tests for wallet/src/router.js, part 1: origins, local answers, reads, connect (D-c),
// isolation, revoke, virtual chains and limits. Signing is in router-sign.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, granted, rejectsWith, A, B, C, X, Y, CONTAINER, H1 } from './router-harness.mjs';

test('requests from origins that are not gateway sites are refused with 4100', async () => {
  const h = setup();
  for (const o of ['https://evil.com', 'https://tapekit.org', 'https://4246-0.tapekit.org.evil.com', 'null', undefined, 'http://4246-0.tapekit.org']) {
    await rejectsWith(h.call(o, 'eth_chainId', []), 4100);
    await rejectsWith(h.call(o, 'eth_requestAccounts', [], true), 4100);
  }
  assert.deepEqual(h.wallet.calls, []);
});

test('local answers never touch the wallet or the UI', async () => {
  const h = setup();
  assert.equal(await h.call(A, 'eth_chainId', []), '0x38');
  assert.equal(await h.call(B, 'eth_chainId'), '0xc4');
  assert.equal(await h.call(B, 'net_version', []), '196');
  assert.deepEqual(await h.call(A, 'eth_accounts', []), []);
  assert.deepEqual(await h.call(A, 'wallet_getPermissions', []), []);
  assert.deepEqual(h.wallet.calls, []);
  assert.equal(h.ui.sites.length + h.ui.cards.length + h.ui.notices.length, 0);
});

test('read methods go to the public nodes of the site chain, not the wallet', async () => {
  const h = setup();
  assert.equal(await h.call(B, 'eth_blockNumber', []), '0x10');
  await h.call(A, 'wallet_switchEthereumChain', [{ chainId: '0x2105' }]);
  await h.call(A, 'eth_call', [{ to: X, data: '0x' }, 'latest']);
  assert.deepEqual(h.reads, [['0xc4', 'eth_blockNumber', []], ['0x2105', 'eth_call', [{ to: X, data: '0x' }, 'latest']]]);
  assert.deepEqual(h.wallet.calls, []);
});

test('unsupported and dangerous methods are rejected with 4200', async () => {
  const h = setup();
  for (const m of ['eth_sign', 'eth_signTypedData', 'eth_signTransaction', 'wallet_sendCalls', 'eth_subscribe', 'foo', 'constructor']) {
    await rejectsWith(h.call(A, m, []), 4200);
  }
  assert.deepEqual(h.wallet.calls, []);
});

test('connect with a user gesture grants at once and shows a notice without waiting (D-c)', async () => {
  const h = setup();
  assert.deepEqual(await h.call(A, 'eth_requestAccounts', [], true), [X]);
  assert.equal(h.ui.sites.length, 0, 'no confirmation dialog');
  assert.equal(h.ui.notices.length, 1);
  const n = h.ui.notices[0];
  assert.equal(n.origin, A);
  assert.equal(n.account, X);
  assert.deepEqual({ name: n.identity.name, cpuName: n.identity.cpuName, container: n.identity.container }, { name: '4246.0.tape', cpuName: 'Seed CPU', container: CONTAINER });
  assert.deepEqual(h.events, [[A, 'accountsChanged', [X]]]);
  assert.deepEqual(h.perms[A], { accounts: [X], chainId: '0x38', grantedAt: 1000, holder: H1, container: CONTAINER });
  assert.deepEqual(await h.call(A, 'eth_accounts', []), [X]);
});

test('connect without a gesture asks the user; rejecting gives 4001 and grants nothing', async () => {
  const h = setup({ siteDecision: 'reject' });
  await rejectsWith(h.call(A, 'eth_requestAccounts', []), 4001);
  assert.equal(h.ui.sites.length, 1);
  assert.equal(h.ui.sites[0].identity.name, '4246.0.tape');
  assert.equal(h.ui.sites[0].origin, A);
  assert.deepEqual(await h.call(A, 'eth_accounts', []), []);
  assert.deepEqual(h.perms, {});
  assert.equal(h.events.length, 0);
});

test('connect without a gesture is granted after the user allows it, with no extra notice', async () => {
  const h = setup();
  assert.deepEqual(await h.call(A, 'eth_requestAccounts', []), [X]);
  assert.equal(h.ui.sites.length, 1);
  assert.equal(h.ui.notices.length, 0);
});

test('only a literal gesture === true counts as a gesture', async () => {
  const h = setup({ siteDecision: 'reject' });
  for (const g of ['true', 1, {}, [true]]) await rejectsWith(h.call(A, 'eth_requestAccounts', [], g), 4001);
  assert.equal(h.ui.sites.length, 4);
});

test('a closed or failing confirmation dialog counts as rejection', async () => {
  const h = setup({ siteDecision: () => { throw new Error('hub closed'); } });
  await rejectsWith(h.call(A, 'eth_requestAccounts', []), 4001);
  assert.deepEqual(h.perms, {});
});

test('the real wallet is asked to connect only once for all sites (R1)', async () => {
  const h = setup({ connected: false });
  await h.call(A, 'eth_requestAccounts', [], true);
  await h.call(B, 'eth_requestAccounts', [], true);
  await h.call(A, 'eth_requestAccounts', [], true);
  assert.equal(h.wallet.count('eth_requestAccounts'), 1);
});

test('an already granted site gets its accounts without any UI', async () => {
  const h = setup();
  await granted(h, A);
  assert.deepEqual(await h.call(A, 'eth_requestAccounts', []), [X]);
  assert.equal(h.ui.sites.length + h.ui.notices.length, 0);
});

test("A's grant cannot be used by B", async () => {
  const h = setup({ siteDecision: 'reject' });
  await granted(h, A);
  assert.deepEqual(await h.call(B, 'eth_accounts', []), []);
  assert.deepEqual(await h.call(B, 'wallet_getPermissions', []), []);
  await rejectsWith(h.call(B, 'eth_requestAccounts', []), 4001);
  await rejectsWith(h.call(B, 'personal_sign', ['0x68', X]), 4100);
  assert.equal(h.wallet.count('personal_sign'), 0);
});

test('wallet_requestPermissions returns EIP-2255 permissions and only supports eth_accounts', async () => {
  const h = setup();
  const perms = await h.call(A, 'wallet_requestPermissions', [{ eth_accounts: {} }], true);
  assert.deepEqual(perms, [{ parentCapability: 'eth_accounts', invoker: A, caveats: [{ type: 'restrictReturnedAccounts', value: [X] }], date: 1000 }]);
  assert.deepEqual(await h.call(A, 'wallet_getPermissions', []), perms);
  for (const p of [[{ eth_accounts: {}, snap_x: {} }], [], undefined, [{}], ['eth_accounts']]) {
    await rejectsWith(h.call(B, 'wallet_requestPermissions', p, true), -32602);
  }
});

test('sites whose status is not ok are refused with 4100 (R8)', async () => {
  const h = setup({ statuses: { '1.0.tape': 'not-opened', '4246.0.tape': 'throw' } });
  await rejectsWith(h.call(C, 'eth_requestAccounts', [], true), 4100);
  await rejectsWith(h.call(A, 'eth_requestAccounts', [], true), 4100);
  await assert.rejects(h.call(C, 'eth_requestAccounts', [], true), (e) => e.data && e.data.status === 'not-opened');
  assert.equal(h.ui.notices.length + h.ui.sites.length, 0);
  assert.deepEqual(h.perms, {});
});

test('revoke clears the grant, emits accountsChanged([]) and the next connect starts over', async () => {
  const h = setup({ siteDecision: 'reject' });
  await granted(h, A, B);
  assert.equal(await h.call(A, 'wallet_revokePermissions', [{ eth_accounts: {} }]), null);
  assert.deepEqual(h.events, [[A, 'accountsChanged', []]]);
  assert.deepEqual(await h.call(A, 'eth_accounts', []), []);
  assert.deepEqual(await h.call(B, 'eth_accounts', []), [X], 'other sites keep their grants');
  await rejectsWith(h.call(A, 'eth_requestAccounts', []), 4001);
  assert.equal(h.ui.sites.length, 1, 'asked again');
});

test('hub-side revokeSite works like the site revoking itself', async () => {
  const h = setup();
  await granted(h, A);
  await h.router.revokeSite(A);
  assert.deepEqual(h.events, [[A, 'accountsChanged', []]]);
  assert.deepEqual(await h.call(A, 'eth_accounts', []), []);
});

test('switching chain changes only that site and notifies only that site', async () => {
  const h = setup();
  assert.equal(await h.call(A, 'wallet_switchEthereumChain', [{ chainId: '0xc4' }]), null);
  assert.deepEqual(h.events, [[A, 'chainChanged', '0xc4']]);
  assert.equal(await h.call(A, 'eth_chainId', []), '0xc4');
  assert.equal(await h.call(B, 'eth_chainId', []), '0xc4');
  assert.equal(await h.call(C, 'eth_chainId', []), '0x38');
  await h.call(A, 'wallet_switchEthereumChain', [{ chainId: '0xc4' }]);
  assert.equal(h.events.length, 1, 'no event when nothing changed');
  await h.call(A, 'wallet_addEthereumChain', [{ chainId: '0x2105', rpcUrls: ['https://evil.example'] }]);
  assert.deepEqual(h.events[1], [A, 'chainChanged', '0x2105']);
  assert.deepEqual(h.wallet.calls, [], 'the real wallet is not touched by a virtual switch');
});

test('unsupported chains give 4902 and malformed chain params -32602', async () => {
  const h = setup();
  for (const id of ['0x1', '0x89', 137]) await rejectsWith(h.call(A, 'wallet_switchEthereumChain', [{ chainId: id }]), 4902);
  await rejectsWith(h.call(A, 'wallet_addEthereumChain', [{ chainId: '0xa' }]), 4902);
  for (const p of [[], undefined, [{}], [{ chainId: 'abc' }], ['0x38']]) await rejectsWith(h.call(A, 'wallet_switchEthereumChain', p), -32602);
  assert.equal(await h.call(A, 'eth_chainId', []), '0x38');
});

test('revoking keeps the site chain it switched to', async () => {
  const h = setup();
  await granted(h, A);
  await h.call(A, 'wallet_switchEthereumChain', [{ chainId: '0x2105' }]);
  await h.call(A, 'wallet_revokePermissions', [{ eth_accounts: {} }]);
  assert.equal(await h.call(A, 'eth_chainId', []), '0x2105');
});

test('params over 256 KB and non-object params are refused with -32602', async () => {
  const h = setup();
  const big = '0x' + '61'.repeat(140 * 1024);
  await rejectsWith(h.call(A, 'personal_sign', [big, X]), -32602);
  await rejectsWith(h.call(A, 'eth_call', [{ data: big }]), -32602);
  await rejectsWith(h.call(A, 'eth_chainId', 'x'), -32602);
  assert.equal(h.ui.cards.length + h.reads.length, 0);
});

test('without a wallet, wallet methods give 4900 and local answers still work', async () => {
  const h = setup({ withWallet: false });
  await rejectsWith(h.call(A, 'eth_requestAccounts', [], true), 4900);
  await rejectsWith(h.call(A, 'personal_sign', ['0x68', X]), 4900);
  assert.equal(await h.call(A, 'eth_chainId', []), '0x38');
});

test('a wallet account switch is pushed only to sites whose view changes', async () => {
  const h = setup();
  await granted(h, A, B);
  await h.router.walletAccountsChanged([Y]);
  assert.deepEqual(h.events, [[A, 'accountsChanged', []], [B, 'accountsChanged', []]]);
  assert.deepEqual(await h.call(A, 'eth_accounts', []), []);
  h.events.length = 0;
  await h.router.walletAccountsChanged([X.toUpperCase().replace('0X', '0x')]);
  assert.deepEqual(h.events, [[A, 'accountsChanged', [X]], [B, 'accountsChanged', [X]]]);
  h.events.length = 0;
  await h.router.walletAccountsChanged([X]);
  assert.deepEqual(h.events, [], 'no change, no event');
});

test('after an account switch a granted site re-requesting is handled as a new account (§5.5)', async () => {
  const h = setup({ accounts: [X] });
  await granted(h, A);
  h.wallet.state.accounts = [Y];
  await h.router.walletAccountsChanged([Y]);
  h.events.length = 0;
  assert.deepEqual(await h.call(A, 'eth_requestAccounts', [], true), [Y]);
  assert.equal(h.ui.notices.length, 1);
  assert.deepEqual(h.perms[A].accounts, [X, Y]);
});

test('a failing notice does not fail the grant and is reported', async () => {
  const h = setup();
  h.ui.notice = () => { throw new Error('popup gone'); };
  assert.deepEqual(await h.call(A, 'eth_requestAccounts', [], true), [X]);
  assert.equal(h.errors.length, 1);
  assert.equal(h.errors[0][0], 'notice');
});

test('the router never mutates stored permission objects', async () => {
  const h = setup();
  await h.call(A, 'eth_requestAccounts', [], true);
  const before = h.perms;
  const snapshot = JSON.stringify(before);
  await h.call(B, 'eth_requestAccounts', [], true);
  await h.call(A, 'wallet_switchEthereumChain', [{ chainId: '0xc4' }]);
  await h.call(A, 'wallet_revokePermissions', []);
  assert.equal(JSON.stringify(before), snapshot);
  assert.equal(h.errors.length, 0);
});
