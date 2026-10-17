// Offline unit tests for wallet/src/router.js, part 2: signing and transactions (D-d), parameter checks,
// account changes, SIWE warning, chain switching of the real wallet and the global queue.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, granted, rejectsWith, deferred, tick, A, B, X, Y, CONTAINER } from './router-harness.mjs';
import { chainParams } from '../src/chains.js';

const hex = (s) => '0x' + Buffer.from(s, 'utf8').toString('hex');
const siwe = (domain) => `${domain} wants you to sign in with your Ethereum account:\n${X}\n\nURI: https://${domain}\nVersion: 1\nChain ID: 56\nNonce: 1\nIssued At: 2026-10-08T00:00:00Z`;
const typed = (chainId) => JSON.stringify({ types: { EIP712Domain: [{ name: 'chainId', type: 'uint256' }] }, primaryType: 'EIP712Domain', domain: { chainId }, message: {} });

test('a signature is forwarded only after the TapeKit card is confirmed (D-d)', async () => {
  const h = setup();
  await granted(h, A);
  assert.equal(await h.call(A, 'personal_sign', [hex('hello'), X]), '0xsig');
  assert.equal(h.ui.cards.length, 1);
  const card = h.ui.cards[0];
  assert.equal(card.origin, A);
  assert.equal(card.method, 'personal_sign');
  assert.deepEqual(card.params, [hex('hello'), X]);
  assert.equal(card.chainId, '0x38');
  assert.equal(card.siweWarning, false);
  assert.deepEqual({ name: card.identity.name, cpuName: card.identity.cpuName, container: card.identity.container }, { name: '4246.0.tape', cpuName: 'Seed CPU', container: CONTAINER });
  const signs = h.wallet.calls.filter((c) => c.method === 'personal_sign');
  assert.deepEqual(signs, [{ method: 'personal_sign', params: [hex('hello'), X] }]);
});

test('rejecting or closing the card gives 4001 and nothing reaches the wallet', async () => {
  for (const signDecision of ['reject', () => undefined, () => true, () => { throw new Error('closed'); }]) {
    const h = setup({ signDecision });
    await granted(h, A);
    await rejectsWith(h.call(A, 'personal_sign', [hex('hello'), X]), 4001);
    await rejectsWith(h.call(A, 'eth_sendTransaction', [{ from: X, to: Y, value: '0x1' }]), 4001);
    assert.equal(h.wallet.count('personal_sign') + h.wallet.count('eth_sendTransaction'), 0);
  }
});

test('signing needs a grant; another address than the granted one gives 4100', async () => {
  const h = setup();
  await rejectsWith(h.call(A, 'personal_sign', [hex('x'), X]), 4100);
  await granted(h, A);
  await rejectsWith(h.call(A, 'personal_sign', [hex('x'), Y]), 4100);
  await rejectsWith(h.call(A, 'eth_signTypedData_v4', [Y, typed(56)]), 4100);
  await rejectsWith(h.call(A, 'eth_sendTransaction', [{ from: Y, to: X }]), 4100);
  assert.equal(h.ui.cards.length, 0, 'no card for requests that cannot be valid');
});

test('typed data or a transaction for another chain gives 4901', async () => {
  const h = setup();
  await granted(h, A);
  await rejectsWith(h.call(A, 'eth_signTypedData_v4', [X, typed(196)]), 4901);
  await rejectsWith(h.call(A, 'eth_sendTransaction', [{ from: X, to: Y, chainId: '0x2105' }]), 4901);
  assert.equal(h.ui.cards.length, 0);
  assert.equal(await h.call(A, 'eth_signTypedData_v4', [X, typed(56)]), '0xsig');
  assert.equal(await h.call(A, 'eth_sendTransaction', [{ from: X, to: Y, chainId: '0x38' }]), '0xsig');
  await h.call(A, 'wallet_switchEthereumChain', [{ chainId: '0xc4' }]);
  await rejectsWith(h.call(A, 'eth_signTypedData_v4', [X, typed(56)]), 4901);
  assert.equal(await h.call(A, 'eth_signTypedData_v4', [X, typed('0xc4')]), '0xsig');
});

test('malformed signing params give -32602', async () => {
  const h = setup();
  await granted(h, A);
  await rejectsWith(h.call(A, 'personal_sign', [X]), -32602);
  await rejectsWith(h.call(A, 'eth_signTypedData_v4', [X, '{bad json']), -32602);
  await rejectsWith(h.call(A, 'eth_sendTransaction', ['0x']), -32602);
});

test('sites whose status is not ok cannot sign, even with an old grant', async () => {
  const statuses = { '1.0.tape': 'not-opened' };
  const h = setup({ statuses });
  await granted(h, A);
  statuses['4246.0.tape'] = 'blocked';
  h.identity.clear();
  await rejectsWith(h.call(A, 'personal_sign', [hex('x'), X]), 4100);
  assert.equal(h.ui.cards.length, 0);
});

test('if the wallet account changed, the request is not forwarded: 4100 + accountsChanged', async () => {
  const h = setup();
  await granted(h, A);
  h.wallet.state.accounts = [Y];
  await rejectsWith(h.call(A, 'personal_sign', [hex('x'), X]), 4100);
  assert.deepEqual(h.events, [[A, 'accountsChanged', []]]);
  assert.equal(h.wallet.count('personal_sign'), 0);
  assert.equal(h.ui.cards.length, 0, 'checked before the card is shown');
});

test('an account switch while the card is open is caught before forwarding', async () => {
  const h = setup({ signDecision: () => { h.wallet.state.accounts = [Y]; return 'ok'; } });
  await granted(h, A);
  await rejectsWith(h.call(A, 'personal_sign', [hex('x'), X]), 4100);
  assert.equal(h.wallet.count('personal_sign'), 0);
  assert.deepEqual(h.events, [[A, 'accountsChanged', []]], 'notified once');
});

test('SIWE messages for another domain carry a warning on the card', async () => {
  const h = setup();
  await granted(h, A);
  await h.call(A, 'personal_sign', [hex(siwe('evil.com')), X]);
  await h.call(A, 'personal_sign', [siwe('evil.com'), X]);
  await h.call(A, 'personal_sign', [hex(siwe('4246-0.tapekit.org')), X]);
  await h.call(A, 'personal_sign', [hex('plain message'), X]);
  assert.deepEqual(h.ui.cards.map((c) => c.siweWarning), [true, true, false, false]);
});

test("the real wallet is moved to the site's chain before forwarding typed data or a transaction", async () => {
  const h = setup({ chain: '0x38' });
  await granted(h, A, B);
  await h.call(B, 'eth_signTypedData_v4', [X, typed(196)]);
  const methods = h.wallet.calls.map((c) => c.method);
  assert.ok(methods.indexOf('wallet_switchEthereumChain') < methods.indexOf('eth_signTypedData_v4'));
  assert.deepEqual(h.wallet.calls.find((c) => c.method === 'wallet_switchEthereumChain').params, [{ chainId: '0xc4' }]);
  assert.equal(h.wallet.state.chain, '0xc4');
  h.wallet.calls.length = 0;
  await h.call(A, 'eth_sendTransaction', [{ from: X, to: X }]);
  assert.equal(h.wallet.state.chain, '0x38', 'and back for the BNB site');
  h.wallet.calls.length = 0;
  await h.call(B, 'personal_sign', [hex('x'), X]);
  assert.equal(h.wallet.state.chain, '0x38', 'a message signature is not chain-bound: no switch (design §10.3, 2026-10-17)');
  assert.equal(h.wallet.count('wallet_switchEthereumChain') + h.wallet.count('eth_chainId'), 0);
});

test('a chain the wallet lacks is added with TapeKit params, then switched to', async () => {
  const h = setup({ chain: '0x38', known: ['0x38'] });
  await granted(h, B);
  assert.equal(await h.call(B, 'eth_signTypedData_v4', [X, typed(196)]), '0xsig');
  const add = h.wallet.calls.find((c) => c.method === 'wallet_addEthereumChain');
  assert.deepEqual(add.params, [JSON.parse(JSON.stringify(chainParams('0xc4')))]);
  const methods = h.wallet.calls.map((c) => c.method);
  assert.deepEqual(methods.slice(methods.indexOf('wallet_switchEthereumChain')), [
    'wallet_switchEthereumChain', 'wallet_addEthereumChain', 'wallet_switchEthereumChain', 'eth_chainId', 'eth_signTypedData_v4',
  ]);
});

test('wallet errors reach the site in normalized form', async () => {
  const h = setup();
  await granted(h, A);
  h.wallet.request = async () => { throw new Error('User rejected the request.'); };
  await rejectsWith(h.call(A, 'personal_sign', [hex('x'), X]), 4001);
});

test('one request at a time: B waits while A is on the card', async () => {
  const gates = [];
  const h = setup({ signDecision: () => { const d = deferred(); gates.push(d); return d.promise; } });
  await granted(h, A, B);
  const pa = h.call(A, 'personal_sign', [hex('a'), X]);
  const pb = h.call(B, 'personal_sign', [hex('b'), X]);
  await tick();
  assert.equal(h.ui.cards.length, 1);
  assert.equal(h.ui.cards[0].origin, A);
  assert.equal(await h.call(B, 'eth_chainId', []), '0xc4', 'local answers do not wait for the queue');
  gates[0].resolve('ok');
  assert.equal(await pa, '0xsig');
  await tick();
  assert.equal(h.ui.cards.length, 2);
  assert.equal(h.ui.cards[1].origin, B);
  gates[1].resolve('ok');
  assert.equal(await pb, '0xsig');
});

test('a site with 4 pending requests gets -32005 for the 5th; other sites are not affected', async () => {
  const gates = [];
  const h = setup({ signDecision: () => { const d = deferred(); gates.push(d); return d.promise; } });
  await granted(h, A, B);
  const pending = [1, 2, 3, 4].map((i) => h.call(A, 'personal_sign', [hex('m' + i), X]));
  await rejectsWith(h.call(A, 'personal_sign', [hex('m5'), X]), -32005);
  await rejectsWith(h.call(A, 'wallet_switchEthereumChain', [{ chainId: '0xc4' }]), -32005);
  const pb = h.call(B, 'personal_sign', [hex('b'), X]);
  for (let i = 0; i < 5; i++) {
    await tick();
    gates[i].resolve('ok');
  }
  assert.deepEqual(await Promise.all([...pending, pb]), ['0xsig', '0xsig', '0xsig', '0xsig', '0xsig']);
  assert.equal(h.ui.cards.length, 5);
});
