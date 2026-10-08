// Offline unit tests for wallet/src/adapters/*: discovery, error normalization, chain switching, revoke.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { okx } from '../src/adapters/okx.js';
import { binance } from '../src/adapters/binance.js';
import { ADAPTERS, pickAdapters, adapterById } from '../src/adapters/index.js';
import { chainParams } from '../src/chains.js';

/** Minimal EIP-1193 wallet: records calls; `known` chains can be switched to; `fail` maps method → error to throw. */
function fakeWallet({ chain = '0x38', known = ['0x38', '0x2105'], fail = {}, ignoreSwitch = false } = {}) {
  const calls = [];
  const state = { chain, known: new Set(known) };
  const handlers = {
    eth_chainId: () => state.chain,
    wallet_switchEthereumChain: ([{ chainId }]) => {
      if (!state.known.has(chainId)) throw Object.assign(new Error('Unrecognized chain ID'), { code: 4902 });
      if (!ignoreSwitch) state.chain = chainId;
      return null;
    },
    wallet_addEthereumChain: ([p]) => { state.known.add(p.chainId); return null; },
    wallet_revokePermissions: () => null,
    eth_accounts: () => ['0x' + 'aa'.repeat(20)],
  };
  return {
    calls, state,
    async request({ method, params }) {
      calls.push({ method, params });
      if (fail[method]) throw fail[method];
      if (!handlers[method]) throw { code: 4200, message: 'unsupported' };
      return handlers[method](params);
    },
  };
}
const announce = (rdns, provider) => ({ info: { uuid: '00000000-0000-4000-8000-000000000000', name: rdns, icon: 'data:,', rdns }, provider });

test('adapters expose the same interface', () => {
  for (const a of ADAPTERS) {
    for (const k of ['id', 'rdns', 'label', 'storeUrl']) assert.equal(typeof a[k], 'string', `${a.id}.${k}`);
    assert.match(a.storeUrl, /^https:\/\/chromewebstore\.google\.com\/detail\/[a-z0-9-]+\/[a-p]{32}$/, `${a.id}.storeUrl`);
    for (const k of ['detect', 'normalizeError', 'request', 'ensureChain', 'revoke']) assert.equal(typeof a[k], 'function', `${a.id}.${k}`);
    assert.ok(Object.isFrozen(a));
  }
  assert.equal(okx.rdns, 'com.okex.wallet');
  assert.equal(binance.rdns, 'com.binance.wallet');
  assert.equal(adapterById('okx'), okx);
  assert.equal(adapterById('binance'), binance);
  assert.equal(adapterById('metamask'), null);
});

test('detect prefers the EIP-6963 announcement by rdns', () => {
  const p1 = fakeWallet(), p2 = fakeWallet(), g = fakeWallet();
  const announced = [announce('io.metamask', fakeWallet()), announce('com.binance.wallet', p2), announce('com.okex.wallet', p1)];
  assert.equal(okx.detect({ announced, win: { okxwallet: g } }), p1);
  assert.equal(binance.detect({ announced, win: {} }), p2);
});

test('detect falls back to the dedicated globals, never window.ethereum', () => {
  const o = fakeWallet(), b = fakeWallet(), eth = Object.assign(fakeWallet(), { isOkxWallet: true, isBinance: true });
  assert.equal(okx.detect({ announced: [], win: { okxwallet: o } }), o);
  assert.equal(binance.detect({ announced: [], win: { binancew3w: { isExtension: true, ethereum: b } } }), b);
  assert.equal(okx.detect({ announced: [], win: { ethereum: eth } }), null);
  assert.equal(binance.detect({ announced: [], win: { ethereum: eth } }), null);
  assert.equal(okx.detect({}), null);
  assert.equal(okx.detect({ announced: [announce('com.okex.wallet', { request: 'nope' })], win: {} }), null, 'provider must have request()');
  const throwing = { get okxwallet() { throw new Error('boom'); } };
  assert.equal(okx.detect({ announced: [], win: throwing }), null);
});

test('pickAdapters returns detected wallets in a stable order', () => {
  const o = fakeWallet(), b = fakeWallet();
  const both = pickAdapters([announce('com.binance.wallet', b), announce('com.okex.wallet', o)], {});
  assert.deepEqual(both.map((x) => x.adapter.id), ['okx', 'binance']);
  assert.equal(both[0].provider, o);
  const one = pickAdapters([], { binancew3w: { ethereum: b } });
  assert.equal(one.length, 1, 'exactly one detected: the hub auto-selects it (R1)');
  assert.equal(one[0].adapter, binance);
  assert.deepEqual(pickAdapters([], {}), []);
});

test('OKX plain-object rejections become coded errors', () => {
  assert.deepEqual(okx.normalizeError({ code: 4001, message: 'User rejected the request.' }), { code: 4001, message: 'User rejected the request.' });
  assert.equal(okx.normalizeError({ code: '4902', message: 'x' }).code, 4902);
  assert.equal(okx.normalizeError('User denied').code, 4001);
  assert.equal(okx.normalizeError(undefined).code, -32603);
});

test('Binance Error objects without a code are classified by text', () => {
  assert.equal(binance.normalizeError(new Error('Not supported')).code, 4200);
  assert.equal(binance.normalizeError(new Error('method not supported')).code, 4200);
  assert.equal(binance.normalizeError(new Error('User rejected the request')).code, 4001);
  assert.equal(binance.normalizeError(new Error('4902:Unrecognized chain ID')).code, 4902);
  assert.equal(binance.normalizeError(new Error('Chain ID mismatch. Expected: 0x38')).code, 4901);
  assert.equal(binance.normalizeError(Object.assign(new Error('x'), { code: 4902 })).code, 4902);
  const odd = binance.normalizeError(new Error('something odd'));
  assert.equal(odd.code, -32603);
  assert.equal(odd.message, 'something odd');
  const e = binance.normalizeError(new Error('y'.repeat(5000)));
  assert.ok(e.message.length <= 300, 'messages are bounded');
  assert.ok(!(e instanceof Error) && !('stack' in e), 'plain, cloneable object without internals');
});

test('string error data (revert data) is kept; other data is dropped', () => {
  assert.deepEqual(okx.normalizeError({ code: 3, message: 'execution reverted', data: '0x08c379a0' }), { code: 3, message: 'execution reverted', data: '0x08c379a0' });
  assert.deepEqual(okx.normalizeError({ code: 4001, message: 'no', data: { internal: { secret: 1 } } }), { code: 4001, message: 'no' });
  assert.equal(okx.normalizeError({ code: 3, message: 'x', data: '0x' + '00'.repeat(70_000) }).data, undefined, 'huge data dropped');
});

test('request normalizes wallet errors', async () => {
  const w = fakeWallet({ fail: { personal_sign: new Error('User rejected') } });
  await assert.rejects(() => binance.request(w, { method: 'personal_sign', params: ['0x00', '0x' + 'aa'.repeat(20)] }), (e) => e.code === 4001);
  assert.equal(await okx.request(w, { method: 'eth_chainId' }), '0x38');
});

test('ensureChain does nothing when the wallet is already on the chain', async () => {
  const w = fakeWallet({ chain: '0x38' });
  await okx.ensureChain(w, '0x38', chainParams('0x38'));
  assert.deepEqual(w.calls.map((c) => c.method), ['eth_chainId']);
});

test('ensureChain switches to a known chain', async () => {
  const w = fakeWallet({ chain: '0x38' });
  await okx.ensureChain(w, '0x2105', chainParams('0x2105'));
  assert.deepEqual(w.calls.map((c) => c.method), ['eth_chainId', 'wallet_switchEthereumChain', 'eth_chainId']);
  assert.deepEqual(w.calls[1].params, [{ chainId: '0x2105' }]);
});

test("ensureChain on 4902 adds the chain with TapeKit's own params, then switches", async () => {
  const w = fakeWallet({ chain: '0x38', known: ['0x38'] });
  await binance.ensureChain(w, '0xc4', chainParams('0xc4'));
  assert.deepEqual(w.calls.map((c) => c.method), ['eth_chainId', 'wallet_switchEthereumChain', 'wallet_addEthereumChain', 'wallet_switchEthereumChain', 'eth_chainId']);
  assert.deepEqual(w.calls[2].params, [JSON.parse(JSON.stringify(chainParams('0xc4')))]);
  assert.ok(!Object.isFrozen(w.calls[2].params[0]), 'the wallet gets a plain copy');
  assert.equal(w.state.chain, '0xc4');
});

test('ensureChain stops on other switch errors and checks the result', async () => {
  const w = fakeWallet({ fail: { wallet_switchEthereumChain: { code: 4001, message: 'User rejected' } } });
  await assert.rejects(() => okx.ensureChain(w, '0x2105', chainParams('0x2105')), (e) => e.code === 4001);
  assert.ok(!w.calls.some((c) => c.method === 'wallet_addEthereumChain'));
  const silent = fakeWallet({ ignoreSwitch: true });   // Binance returns quietly without switching for unconnected origins
  await assert.rejects(() => binance.ensureChain(silent, '0x2105', chainParams('0x2105')), (e) => e.code === 4901);
  await assert.rejects(() => okx.ensureChain(fakeWallet(), '0x2105', chainParams('0x38')), (e) => e.code === -32602, 'params must match the chain');
});

test('revoke: OKX has no wallet_revokePermissions, Binance does', async () => {
  const w1 = fakeWallet();
  assert.deepEqual(await okx.revoke(w1), { revoked: false });
  assert.deepEqual(w1.calls, []);
  const w2 = fakeWallet();
  assert.deepEqual(await binance.revoke(w2), { revoked: true });
  assert.deepEqual(w2.calls, [{ method: 'wallet_revokePermissions', params: [{ eth_accounts: {} }] }]);
});
