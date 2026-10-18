// Offline unit tests for wallet/src/queue.js (global FIFO, per-site limit) and wallet/src/params.js
// (signer address and requested chain of signing requests).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createQueue } from '../src/queue.js';
import { readSignRequest } from '../src/params.js';

const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise((r) => setTimeout(r, 0));

test('queue runs one task at a time in FIFO order across keys', async () => {
  const q = createQueue(4);
  const order = [];
  const d1 = deferred();
  const p1 = q.run('a', async () => { order.push('a1 start'); await d1.promise; order.push('a1 end'); return 1; });
  const p2 = q.run('b', async () => { order.push('b1'); return 2; });
  await tick();
  assert.deepEqual(order, ['a1 start'], 'b waits while a is in flight');
  d1.resolve();
  assert.deepEqual(await Promise.all([p1, p2]), [1, 2]);
  assert.deepEqual(order, ['a1 start', 'a1 end', 'b1']);
});

test('a failing task does not block the queue', async () => {
  const q = createQueue(4);
  const p1 = q.run('a', async () => { throw new Error('x'); });
  const p2 = q.run('a', async () => 'ok');
  await assert.rejects(p1, /x/);
  assert.equal(await p2, 'ok');
  assert.equal(q.pending('a'), 0);
});

test('queue rejects the 5th pending request of one key with -32005', async () => {
  const q = createQueue(4);
  const d = deferred();
  const ps = [1, 2, 3, 4].map(() => q.run('a', () => d.promise));
  assert.equal(q.pending('a'), 4);
  await assert.rejects(q.run('a', async () => 'never'), (e) => e.code === -32005);
  const other = q.run('b', async () => 'b ok');
  const unlimited = q.run('a', async () => 'internal', { limited: false });
  d.resolve('done');
  assert.deepEqual(await Promise.all(ps), ['done', 'done', 'done', 'done']);
  assert.equal(await other, 'b ok');
  assert.equal(await unlimited, 'internal');
  assert.equal(q.pending('a'), 0);
  assert.equal(await q.run('a', async () => 'again'), 'again', 'slots are released');
});

const X = '0x' + 'aA'.repeat(20);
const x = X.toLowerCase();
const typed = (domain) => JSON.stringify({ types: { EIP712Domain: [] }, primaryType: 'Mail', domain, message: {} });

const signerOf = (m, p) => { const r = readSignRequest(m, p); return { address: r.address, chainId: r.chainId }; };

test('readSignRequest extracts the signer of each signing method', () => {
  assert.deepEqual(signerOf('personal_sign', ['0x68656c6c6f', X]), { address: x, chainId: null });
  assert.deepEqual(signerOf('eth_signTypedData_v4', [X, typed({ name: 'A' })]), { address: x, chainId: null });
  assert.deepEqual(signerOf('eth_sendTransaction', [{ from: X, to: X, value: '0x1' }]), { address: x, chainId: null });
});

test('readSignRequest returns exactly the params to show and forward: [message, address], [address, typedData], [tx]', () => {
  const data = typed({ name: 'A' });
  assert.deepEqual(readSignRequest('personal_sign', ['0x68', X, { isSilentSign: true }]).params, ['0x68', X]);
  assert.deepEqual(readSignRequest('eth_signTypedData_v4', [X, data, { isSilentSign: true }]).params, [X, data]);
  assert.deepEqual(readSignRequest('eth_sendTransaction', [{ from: X, to: X, value: '0x1' }, { isSilentSign: true }]).params, [{ from: x, to: X, value: '0x1' }]);
});

const txOf = (tx) => readSignRequest('eth_sendTransaction', [tx]).params[0];

test('a transaction is rebuilt from an allow-list: from, to, value, data (chainId is the router\'s); everything else is dropped', () => {
  const tx = txOf({
    from: X, to: X, value: '0x0de0b6b3a7640000', data: '0xa9059cbb', chainId: '0x38',
    gas: '0x5208', gasPrice: '0x1', maxFeePerGas: '0x2', maxPriorityFeePerGas: '0x1', nonce: '0x7', type: '0x2', accessList: [], extra: 'x',
  });
  assert.deepEqual(tx, { from: x, to: X, value: '0xde0b6b3a7640000', data: '0xa9059cbb' });
  assert.deepEqual(txOf({ from: X }), { from: x }, 'contract creation, no value, no data');
  assert.deepEqual(txOf({ from: X, to: null, value: null, data: null, input: null }), { from: x });
  assert.equal(txOf({ from: X, to: X, value: 1000 }).value, '0x3e8', 'a JS number becomes a quantity');
  assert.ok(Object.isFrozen(tx));
});

test('data and input: either one is read as the call data; both present must agree (OKX uses input when data is falsy)', () => {
  const call = '0xa9059cbb' + '00'.repeat(64);
  assert.equal(txOf({ from: X, to: X, input: call }).data, call);
  assert.equal(txOf({ from: X, to: X, data: null, input: call }).data, call, 'data: null + input: the card shows input, and input is what is forwarded');
  assert.equal(txOf({ from: X, to: X, data: call, input: call.toUpperCase().replace('0X', '0x') }).data, call, 'same bytes, other case');
  assert.equal('input' in txOf({ from: X, to: X, input: call }), false, 'only data is forwarded');
  for (const tx of [{ data: '0x', input: call }, { data: call, input: '0x' }, { data: '', input: call }, { data: '0x12', input: '0x34' }]) {
    assert.throws(() => txOf({ from: X, to: X, ...tx }), (e) => e.code === -32602, JSON.stringify(tx));
  }
});

test('EIP-7702 (authorizationList, type 0x4) and malformed fields are refused with -32602', () => {
  const bad = [
    { authorizationList: [] }, { authorizationList: [{ address: X }] }, { type: '0x4' }, { type: '0x04' }, { type: 4 }, { type: '4' },
    { to: '' }, { to: '0x12' }, { to: 42 }, { value: '1000' }, { value: 'lots' }, { value: -1 }, { value: 1.5 }, { value: '0x' }, { value: {} },
    { data: '0x123' }, { data: 'hello' }, { data: 42 }, { input: '0xzz' },
  ];
  for (const extra of bad) assert.throws(() => txOf({ from: X, to: X, ...extra }), (e) => e.code === -32602, JSON.stringify(extra));
});

test('readSignRequest reads typed-data domain.chainId and tx chainId in any form', () => {
  assert.equal(readSignRequest('eth_signTypedData_v4', [X, typed({ chainId: 56 })]).chainId, '0x38');
  assert.equal(readSignRequest('eth_signTypedData_v4', [X, typed({ chainId: '196' })]).chainId, '0xc4');
  assert.equal(readSignRequest('eth_signTypedData_v4', [X, { domain: { chainId: '0x2105' }, types: {}, primaryType: 'A', message: {} }]).chainId, '0x2105');
  assert.equal(readSignRequest('eth_sendTransaction', [{ from: X, chainId: '0x38' }]).chainId, '0x38');
});

test('readSignRequest rejects malformed params with -32602', () => {
  const bad = [
    ['personal_sign', undefined], ['personal_sign', {}], ['personal_sign', [X, '0x68']], ['personal_sign', ['0x68']],
    ['personal_sign', [42, X]], ['eth_signTypedData_v4', [X, '{not json']], ['eth_signTypedData_v4', [X, 'null']],
    ['eth_signTypedData_v4', [X, typed({ chainId: 'abc' })]], ['eth_signTypedData_v4', ['0x12', typed({})]],
    ['eth_sendTransaction', []], ['eth_sendTransaction', [{ to: X }]], ['eth_sendTransaction', [{ from: X, chainId: 'zz' }]],
    ['eth_signTypedData_v4', [X, typed({ chainId: 56 }).replace('"domain"', '"domain":null,"x"')]],
  ];
  for (const [m, p] of bad) assert.throws(() => readSignRequest(m, p), (e) => e.code === -32602, `${m} ${JSON.stringify(p)}`);
});
