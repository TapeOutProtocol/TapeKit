// Offline unit tests for wallet/src/router.js, part 3: OKX Wallet's focus rule (research/manual-test.md, design
// §10.3, revised 2026-10-16 and 2026-10-17). From a tab that is not the active tab of the focused normal window,
// OKX refuses connect, transaction and chain-switch calls without a prompt (connect and transactions fail 4001,
// wallet_switchEthereumChain answers null without switching), but lets a plain personal_sign and
// eth_signTypedData_v4 through. So, while the hub says it runs in a popup-type window (canPrompt false):
//   - personal_sign runs there (it is not chain-bound, so the wallet's chain is never read or switched);
//   - eth_signTypedData_v4 runs there only when the wallet is already on the site's chain;
//   - everything else that needs those calls fails 4900 'needs-tab' and makes none of them.
// And everywhere: a signature is never forwarded after a switch that did not happen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, granted, rejectsWith, A, B, X, H2 } from './router-harness.mjs';
import { describeSign } from '../src/describe.js';

const hex = (s) => '0x' + Buffer.from(s, 'utf8').toString('hex');
const typed = (chainId) => JSON.stringify({ domain: { name: 'Mail', chainId }, primaryType: 'Mail', types: {}, message: { a: 1 } });
const needsTab = (e) => { assert.equal(e.code, 4900); assert.equal(e.data.reason, 'needs-tab'); assert.ok(e.data.messages.zh && e.data.messages.en); return true; };
// OKX's focus-gated set (e2e-pages.mjs OKX_FOCUS_METHODS) minus the plain personal_sign it lets through.
const GATED = ['wallet_switchEthereumChain', 'wallet_addEthereumChain', 'wallet_requestPermissions', 'eth_requestAccounts', 'eth_sendTransaction'];
const gatedCalls = (h) => h.wallet.calls.map((c) => c.method).filter((m) => GATED.includes(m));
const inPopup = (opts = {}) => setup({ ...opts, canPrompt: () => false });

test('a switch the wallet answers with null but does not make: 4901, and the signature is never forwarded', async () => {
  const h = setup({ chain: '0x38', ignoreSwitch: true });
  await granted(h, B);   // X Layer site: the wallet must move from 0x38 to 0xc4
  await rejectsWith(h.call(B, 'eth_signTypedData_v4', [X, typed(196)]), 4901);
  await rejectsWith(h.call(B, 'eth_sendTransaction', [{ from: X, to: X, value: '0x1' }]), 4901);
  assert.equal(h.wallet.count('eth_signTypedData_v4') + h.wallet.count('eth_sendTransaction'), 0);
  assert.equal(h.wallet.count('wallet_switchEthereumChain'), 2);
  assert.equal(h.wallet.state.chain, '0x38');
});

test('the same after the add flow: added, "switched" with null, still on the old chain → 4901', async () => {
  const h = setup({ chain: '0x38', known: ['0x38'], ignoreSwitch: true });
  await granted(h, B);
  await rejectsWith(h.call(B, 'eth_sendTransaction', [{ from: X, to: X }]), 4901);
  const methods = h.wallet.calls.map((c) => c.method);
  assert.deepEqual(methods.slice(methods.indexOf('wallet_switchEthereumChain')), ['wallet_switchEthereumChain', 'wallet_addEthereumChain', 'wallet_switchEthereumChain', 'eth_chainId']);
});

test('personal_sign is not chain-bound: the wallet chain is never read or switched, in a tab or a popup window', async () => {
  for (const canPrompt of [() => true, () => false]) {
    const h = setup({ chain: '0x38', canPrompt });
    await granted(h, B);   // B is on X Layer, the wallet on BNB Chain
    assert.equal(await h.call(B, 'personal_sign', [hex('hello'), X]), '0xsig');
    assert.deepEqual(h.wallet.calls.map((c) => c.method), ['eth_accounts', 'eth_accounts', 'personal_sign']);
    assert.equal(h.wallet.state.chain, '0x38');
    assert.equal(h.ui.cards.length, 1, 'the TapeKit card still comes first');
    assert.equal('chain' in describeSign(h.ui.cards[0]), false, 'and it shows no chain row: the message is not bound to one');
  }
});

test('personal_sign forwards only [message, address]: a third param (OKX reads params[2].isSilentSign) never reaches the wallet', async () => {
  const h = inPopup();
  await granted(h, A);
  assert.equal(await h.call(A, 'personal_sign', [hex('x'), X, { isSilentSign: true }]), '0xsig');
  assert.deepEqual(h.wallet.calls.find((c) => c.method === 'personal_sign').params, [hex('x'), X]);
});

test('typed data and transactions forward only the params the card showed: [address, typedData] and [tx]', async () => {
  const h = setup({ chain: '0x38' });
  await granted(h, A);
  const data = typed(56);
  const tx = { from: X, to: X, value: '0x1' };
  await h.call(A, 'eth_signTypedData_v4', [X, data, { isSilentSign: true }]);
  await h.call(A, 'eth_sendTransaction', [tx, { isSilentSign: true }]);
  assert.deepEqual(h.wallet.calls.find((c) => c.method === 'eth_signTypedData_v4').params, [X, data]);
  assert.deepEqual(h.wallet.calls.find((c) => c.method === 'eth_sendTransaction').params, [{ ...tx, chainId: '0x38' }]);
});

test('canPrompt false (popup window): personal_sign shows the card first, then signs; no gated wallet call at all', async () => {
  const h = inPopup();
  await granted(h, A);
  let walletBeforeCard = null;
  h.ui.confirmSign = async (card) => { h.ui.cards.push(card); walletBeforeCard = h.wallet.count('personal_sign'); return 'ok'; };
  assert.equal(await h.call(A, 'personal_sign', [hex('popup'), X]), '0xsig');
  assert.equal(walletBeforeCard, 0, 'the card is shown before the wallet sees anything');
  assert.deepEqual(gatedCalls(h), []);
});

test('canPrompt false: personal_sign keeps every check (granted signer, current account, holder, SIWE warning)', async () => {
  const h = inPopup();
  await granted(h, A);
  await rejectsWith(h.call(A, 'personal_sign', [hex('x'), '0x' + 'bb'.repeat(20)]), 4100);   // not the granted account
  await rejectsWith(h.call(B, 'personal_sign', [hex('x'), X]), 4100);                       // B is not connected
  const siwe = `evil.com wants you to sign in with your Ethereum account:\n${X}\n\nURI: https://evil.com\nVersion: 1\nChain ID: 56\nNonce: 12345678\nIssued At: 2026-10-17T00:00:00Z`;
  await h.call(A, 'personal_sign', [siwe, X]);
  assert.equal(h.ui.cards.at(-1).siweWarning, true);
  h.wallet.state.accounts = ['0x' + 'cc'.repeat(20)];   // the user switched accounts in the wallet
  await rejectsWith(h.call(A, 'personal_sign', [hex('x'), X]), 4100);
  assert.equal(h.wallet.count('personal_sign'), 1);
  assert.deepEqual(gatedCalls(h), []);
  const holders = {};
  const moved = inPopup({ holders });
  await granted(moved, A);
  holders['4246.0.tape'] = H2;   // the circuit changed hands
  moved.identity.clear();
  await rejectsWith(moved.call(A, 'personal_sign', [hex('x'), X]), 4100);
  assert.equal(moved.ui.cards.length + moved.wallet.count('personal_sign'), 0, 'no card, nothing signed');
});

test('canPrompt false: typed data runs there when the wallet is already on the site\'s chain, with no switch', async () => {
  const h = inPopup({ chain: '0xc4' });
  await granted(h, B);
  assert.equal(await h.call(B, 'eth_signTypedData_v4', [X, typed(196)]), '0xsig');
  assert.equal(h.ui.cards.length, 1);
  assert.deepEqual(gatedCalls(h), []);
});

test('canPrompt false: typed data on another chain fails needs-tab before the card; no switch is ever sent', async () => {
  const h = inPopup({ chain: '0x38' });
  await granted(h, B);
  await assert.rejects(h.call(B, 'eth_signTypedData_v4', [X, typed(196)]), needsTab);
  await assert.rejects(h.call(B, 'eth_signTypedData_v4', [X, typed()]), needsTab);   // no domain.chainId: still the site's chain
  assert.equal(h.ui.cards.length, 0);
  assert.deepEqual(gatedCalls(h), []);
  assert.equal(h.wallet.count('eth_signTypedData_v4'), 0);
});

test('canPrompt false: typed data whose wallet chain changes while the card is open fails needs-tab after it, unsigned', async () => {
  const h = inPopup({ chain: '0x38' });
  await granted(h, A);
  h.ui.confirmSign = async (card) => { h.ui.cards.push(card); h.wallet.state.chain = '0x2105'; return 'ok'; };
  await assert.rejects(h.call(A, 'eth_signTypedData_v4', [X, typed(56)]), needsTab);
  assert.equal(h.ui.cards.length, 1);
  assert.deepEqual(gatedCalls(h), []);
  assert.equal(h.wallet.count('eth_signTypedData_v4'), 0);
});

test('canPrompt false: a transaction fails needs-tab before the card, nothing reaches the wallet', async () => {
  const h = inPopup();
  await granted(h, A);
  await assert.rejects(h.call(A, 'eth_sendTransaction', [{ from: X, to: X, value: '0x1' }]), needsTab);
  assert.equal(h.ui.cards.length, 0);
  assert.deepEqual(h.wallet.calls.map((c) => c.method).filter((m) => m !== 'eth_accounts'), []);
  await rejectsWith(h.call(A, 'eth_sendTransaction', [{ from: '0x' + 'bb'.repeat(20), to: X }]), 4100);   // invalid requests keep their own error
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
