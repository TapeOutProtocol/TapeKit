// Offline unit tests for wallet/src/describe.js: what the signing card shows (design §7).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeSign, formatUnits } from '../src/describe.js';

const X = '0x' + 'aa'.repeat(20);
const Y = '0x' + 'bb'.repeat(20);
const A = 'https://4246-0.tapekit.org';
const hex = (s) => '0x' + Buffer.from(s, 'utf8').toString('hex');
const card = (method, params, extra = {}) => ({ origin: A, method, params, chainId: '0x38', siweWarning: false, ...extra });

test('personal_sign: UTF-8 hex is shown as text, raw strings as they are; no chain (not chain-bound, 2026-10-17)', () => {
  assert.deepEqual(describeSign(card('personal_sign', [hex('hello\nworld'), X])), {
    kind: 'message', account: X, text: 'hello\nworld', hex: null, siweWarning: false, siweDomain: null,
  });
  for (const chainId of ['0x38', '0xc4', '0x2105']) assert.equal('chain' in describeSign(card('personal_sign', ['m', X], { chainId })), false, chainId);
  assert.equal(describeSign(card('personal_sign', ['plain text', X])).text, 'plain text');
});

test('personal_sign: bytes that are not UTF-8 are shown as hex', () => {
  const d = describeSign(card('personal_sign', ['0xff00fe', X]));
  assert.equal(d.text, null);
  assert.equal(d.hex, '0xff00fe');
});

test('personal_sign: direction-changing characters are made visible', () => {
  const d = describeSign(card('personal_sign', [hex('pay ‮evil‬ ok'), X]));
  assert.equal(d.text, 'pay [U+202E]evil[U+202C] ok');
});

test('personal_sign: SIWE warning carries the domain the message names', () => {
  const msg = 'evil.com wants you to sign in with your Ethereum account:\n' + X;
  const d = describeSign(card('personal_sign', [hex(msg), X], { siweWarning: true }));
  assert.equal(d.siweWarning, true);
  assert.equal(d.siweDomain, 'evil.com');
});

test('typed data: domain, primaryType and pretty JSON', () => {
  const data = { types: {}, primaryType: 'Mail', domain: { name: 'Ether Mail', version: '1', chainId: 56, verifyingContract: Y }, message: { a: 1 } };
  const d = describeSign(card('eth_signTypedData_v4', [X, JSON.stringify(data)]));
  assert.equal(d.kind, 'typed');
  assert.equal(d.account, X);
  assert.deepEqual(d.chain, { id: '0x38', name: 'BNB Smart Chain', symbol: 'BNB' }, 'typed data is chain-bound: the card keeps the chain row');
  assert.deepEqual(d.domain, { name: 'Ether Mail', version: '1', chainId: '56', verifyingContract: Y });
  assert.equal(d.primaryType, 'Mail');
  assert.equal(d.json, JSON.stringify(data, null, 2));
  assert.equal(describeSign(card('eth_signTypedData_v4', [X, data])).primaryType, 'Mail', 'object form works too');
});

test('typed data: missing domain fields are null, odd values are stringified', () => {
  const d = describeSign(card('eth_signTypedData_v4', [X, { primaryType: { x: 1 }, domain: { name: 7 } }]));
  assert.deepEqual(d.domain, { name: '7', version: null, chainId: null, verifyingContract: null });
  assert.equal(d.primaryType, null);
});

test('transaction: chain, recipient, value in native units, data length and selector', () => {
  const d = describeSign(card('eth_sendTransaction', [{ from: X, to: Y, value: '0xde0b6b3a7640000', data: '0xa9059cbb' + '00'.repeat(64) }]));
  assert.deepEqual(d, {
    kind: 'tx', account: X, chain: { id: '0x38', name: 'BNB Smart Chain', symbol: 'BNB' },
    to: Y, value: '1 BNB', dataBytes: 68, selector: '0xa9059cbb',
  });
});

test('transaction: contract creation, no value, no data, other chain', () => {
  const d = describeSign(card('eth_sendTransaction', [{ from: X }], { chainId: '0xc4' }));
  assert.equal(d.to, null);
  assert.equal(d.value, '0 OKB');
  assert.equal(d.dataBytes, 0);
  assert.equal(d.selector, null);
  assert.equal(d.chain.name, 'X Layer');
  const short = describeSign(card('eth_sendTransaction', [{ from: X, to: Y, data: '0x1234' }]));
  assert.equal(short.dataBytes, 2);
  assert.equal(short.selector, null, 'fewer than 4 bytes has no selector');
});

test('transaction: a malformed value is shown raw, not guessed', () => {
  assert.equal(describeSign(card('eth_sendTransaction', [{ from: X, to: Y, value: 'lots' }])).value, 'lots (?)');
  // Not a JSON-RPC quantity: a wallet may read it as hex (0x1000…), so the card must not say "1 BNB"
  assert.equal(describeSign(card('eth_sendTransaction', [{ from: X, to: Y, value: '1000000000000000000' }])).value, '1000000000000000000 (?)');
  assert.equal(describeSign(card('eth_sendTransaction', [{ from: X, to: Y, value: 1000 }])).value, '0.000000000000001 BNB', 'JS numbers are unambiguous');
  assert.equal(describeSign(card('eth_sendTransaction', [{ from: X, to: Y, input: '0xdeadbeef00' }])).selector, '0xdeadbeef', 'input is read like data');
});

test('formatUnits trims trailing zeros and keeps every digit', () => {
  assert.equal(formatUnits(0n, 18), '0');
  assert.equal(formatUnits(1n, 18), '0.000000000000000001');
  assert.equal(formatUnits(1500000000000000000n, 18), '1.5');
  assert.equal(formatUnits(123456789000000000000000n, 18), '123456.789');
});
