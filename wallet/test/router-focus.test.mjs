// Offline unit tests for wallet/src/router.js, part 3: OKX Wallet's focus rule (research/manual-test.md, design
// §10 2026-10-16). OKX refuses connect, sign and chain-switch calls from a tab that is not the active tab of the
// focused normal window: connect and sign fail 4001 with no prompt, and wallet_switchEthereumChain answers null
// without switching. The router (1) never makes those calls while the hub says it cannot prompt (canPrompt), and
// (2) never forwards a signature after a switch that did not happen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, granted, rejectsWith, A, B, X } from './router-harness.mjs';

const hex = (s) => '0x' + Buffer.from(s, 'utf8').toString('hex');
const needsTab = (e) => { assert.equal(e.code, 4900); assert.equal(e.data.reason, 'needs-tab'); assert.ok(e.data.messages.zh && e.data.messages.en); return true; };

test('a switch the wallet answers with null but does not make: 4901, and the signature is never forwarded', async () => {
  const h = setup({ chain: '0x38', ignoreSwitch: true });
  await granted(h, B);   // X Layer site: the wallet must move from 0x38 to 0xc4
  await rejectsWith(h.call(B, 'personal_sign', [hex('x'), X]), 4901);
  await rejectsWith(h.call(B, 'eth_sendTransaction', [{ from: X, to: X, value: '0x1' }]), 4901);
  assert.equal(h.wallet.count('personal_sign') + h.wallet.count('eth_sendTransaction'), 0);
  assert.equal(h.wallet.count('wallet_switchEthereumChain'), 2);
  assert.equal(h.wallet.state.chain, '0x38');
});

test('the same after the add flow: added, "switched" with null, still on the old chain → 4901', async () => {
  const h = setup({ chain: '0x38', known: ['0x38'], ignoreSwitch: true });
  await granted(h, B);
  await rejectsWith(h.call(B, 'personal_sign', [hex('x'), X]), 4901);
  const methods = h.wallet.calls.map((c) => c.method);
  assert.deepEqual(methods.slice(methods.indexOf('wallet_switchEthereumChain')), ['wallet_switchEthereumChain', 'wallet_addEthereumChain', 'wallet_switchEthereumChain', 'eth_chainId']);
});

test('canPrompt false (the hub is in a popup window): signing fails needs-tab before the card, nothing reaches the wallet', async () => {
  let prompt = true;
  const h = setup({ canPrompt: () => prompt });
  await granted(h, A);
  prompt = false;
  await assert.rejects(h.call(A, 'personal_sign', [hex('x'), X]), needsTab);
  await assert.rejects(h.call(A, 'eth_signTypedData_v4', [X, JSON.stringify({ domain: { chainId: 56 } })]), needsTab);
  assert.equal(h.ui.cards.length, 0);
  assert.deepEqual(h.wallet.calls.map((c) => c.method).filter((m) => m !== 'eth_accounts'), []);
  await rejectsWith(h.call(A, 'personal_sign', [hex('x'), '0x' + 'bb'.repeat(20)]), 4100);   // invalid requests keep their own error
});

test('canPrompt false: the one-time wallet connection is refused (needs-tab), with no dialog and no eth_requestAccounts', async () => {
  for (const gesture of [true, false]) {
    const h = setup({ connected: false, canPrompt: () => false });
    await assert.rejects(h.call(A, 'eth_requestAccounts', [], gesture), needsTab);
    assert.equal(h.wallet.count('eth_requestAccounts'), 0);
    assert.equal(h.ui.sites.length + h.ui.notices.length, 0);
    assert.deepEqual(h.perms, {}, 'nothing granted');
  }
});

test('canPrompt false: what needs no wallet prompt still works (gesture connect with a known account, chain, revoke, local)', async () => {
  const h = setup({ canPrompt: () => false });
  assert.deepEqual(await h.call(A, 'eth_requestAccounts', [], true), [X]);
  assert.equal(h.ui.notices.length, 1);
  assert.equal(await h.call(A, 'wallet_switchEthereumChain', [{ chainId: '0xc4' }]), null);
  assert.equal(await h.call(A, 'eth_chainId'), '0xc4');
  assert.equal(await h.call(A, 'wallet_revokePermissions', [{ eth_accounts: {} }]), null);
  assert.equal(h.wallet.count('eth_requestAccounts') + h.wallet.count('wallet_switchEthereumChain'), 0);
});
