// Offline unit tests for wallet/src/chains.js: the three supported chains agree with the kernel config.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NETWORKS, networkByArea, siteNodes } from '../../kernel/src/config.js';
import { CHAINS, SUPPORTED_CHAINS, chainForArea, chainParams, isSupportedChain, normalizeChainId, readNodes } from '../src/chains.js';

test('supports exactly 56, 196 and 8453', () => {
  assert.deepEqual([...SUPPORTED_CHAINS], ['0x38', '0xc4', '0x2105']);
  assert.ok(Object.isFrozen(SUPPORTED_CHAINS));
  for (const hex of SUPPORTED_CHAINS) assert.ok(isSupportedChain(hex));
  for (const hex of ['0x1', '0x89', '0x0', '56', 'xyz', null]) assert.ok(!isSupportedChain(hex), String(hex));
});

test('chain params agree with the kernel network config', () => {
  assert.equal(Object.keys(CHAINS).length, NETWORKS.length);
  for (const net of NETWORKS) {
    const hex = '0x' + net.chainId.toString(16);
    const p = chainParams(hex);
    assert.ok(p, net.name);
    assert.equal(p.chainId, hex);
    assert.equal(p.chainName, net.name);
    assert.equal(p.nativeCurrency.symbol, net.currency);
    assert.equal(p.nativeCurrency.decimals, 18);
    assert.deepEqual([...p.rpcUrls], siteNodes(net), 'wallet gets only nodes that take no caller keys');
    assert.ok(p.rpcUrls.length > 0);
    for (const u of [...p.rpcUrls, ...p.blockExplorerUrls]) assert.match(u, /^https:\/\/[^/]+/, u);
    assert.deepEqual(readNodes(hex), siteNodes(net));
  }
});

test('chain params are deeply frozen (sites can never alter them)', () => {
  const p = chainParams('0xc4');
  assert.ok(Object.isFrozen(p) && Object.isFrozen(p.nativeCurrency) && Object.isFrozen(p.rpcUrls) && Object.isFrozen(p.blockExplorerUrls));
  assert.equal(chainParams('0x1'), null);
  assert.equal(readNodes('0x1'), null);
});

test('area maps to chain through the kernel (BNB has no area)', () => {
  assert.equal(chainForArea(null), '0x38');
  assert.equal(chainForArea(undefined), '0x38');
  assert.equal(chainForArea(2), '0xc4');
  assert.equal(chainForArea(3), '0x2105');
  assert.equal(chainForArea(4), null);
  for (const area of [null, 2, 3]) assert.equal(chainForArea(area), '0x' + networkByArea(area).chainId.toString(16));
});

test('normalizeChainId accepts hex, decimal and numbers; rejects junk', () => {
  assert.equal(normalizeChainId('0x38'), '0x38');
  assert.equal(normalizeChainId('0X0038'), '0x38');
  assert.equal(normalizeChainId('0xC4'), '0xc4');
  assert.equal(normalizeChainId(56), '0x38');
  assert.equal(normalizeChainId('8453'), '0x2105');
  for (const v of [0, -1, 1.5, '0x', '0x0', '', 'abc', '0xzz', null, undefined, {}, [], '056', Number.MAX_SAFE_INTEGER + 2, '0x' + 'f'.repeat(20)]) {
    assert.equal(normalizeChainId(v), null, String(v));
  }
});
