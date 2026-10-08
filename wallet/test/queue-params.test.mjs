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

test('readSignRequest extracts the signer of each signing method', () => {
  assert.deepEqual(readSignRequest('personal_sign', ['0x68656c6c6f', X]), { address: x, chainId: null });
  assert.deepEqual(readSignRequest('eth_signTypedData_v4', [X, typed({ name: 'A' })]), { address: x, chainId: null });
  assert.deepEqual(readSignRequest('eth_sendTransaction', [{ from: X, to: X, value: '0x1' }]), { address: x, chainId: null });
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
