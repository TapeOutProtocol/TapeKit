// Offline unit tests for wallet/src/rpc.js: read-only JSON-RPC to one public node of the site's chain.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReadRpc } from '../src/rpc.js';
import { readNodes } from '../src/chains.js';

const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const rejectsWith = (p, code) => assert.rejects(p, (e) => { assert.equal(e.code, code, e.message); return true; });

function fakeFetch(reply) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return typeof reply === 'function' ? reply(url, init) : reply;
  };
  fn.calls = calls;
  return fn;
}

test('posts one JSON-RPC call to the first site node of that chain', async () => {
  const f = fakeFetch(json({ jsonrpc: '2.0', id: 1, result: '0x10' }));
  const rpc = createReadRpc({ fetchImpl: f });
  assert.equal(await rpc('0xc4', 'eth_blockNumber', []), '0x10');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, readNodes('0xc4')[0]);
  assert.equal(f.calls[0].init.method, 'POST');
  assert.equal(f.calls[0].init.headers['content-type'], 'application/json');
  assert.equal(f.calls[0].init.credentials, 'omit');
  assert.deepEqual({ ...f.calls[0].body, id: 0 }, { jsonrpc: '2.0', id: 0, method: 'eth_blockNumber', params: [] });
});

test('a node error is passed on with its code, message and string data', async () => {
  const f = fakeFetch(json({ jsonrpc: '2.0', id: 1, error: { code: 3, message: 'execution reverted', data: '0x08c379a0' } }));
  await assert.rejects(createReadRpc({ fetchImpl: f })('0x38', 'eth_call', [{}]), (e) => {
    assert.deepEqual(e, { code: 3, message: 'execution reverted', data: '0x08c379a0' });
    return true;
  });
});

test('HTTP errors, bad JSON and replies without result give -32603', async () => {
  for (const reply of [
    json({}, 500),
    { ok: true, status: 200, json: async () => { throw new SyntaxError('bad json'); } },
    json({ jsonrpc: '2.0', id: 1 }),
    json([{ result: '0x1' }]),
    json({ jsonrpc: '2.0', id: 1, error: 'oops' }),
  ]) {
    await rejectsWith(createReadRpc({ fetchImpl: fakeFetch(reply) })('0x38', 'eth_blockNumber', []), -32603);
  }
  await rejectsWith(createReadRpc({ fetchImpl: async () => { throw new TypeError('Failed to fetch'); } })('0x38', 'eth_blockNumber', []), -32603);
});

test('a node that does not answer in time is aborted with -32603', async () => {
  let signal;
  const hang = async (url, init) => {
    signal = init.signal;
    return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
  };
  await rejectsWith(createReadRpc({ fetchImpl: hang, timeoutMs: 20 })('0x38', 'eth_blockNumber', []), -32603);
  assert.ok(signal.aborted);
});

test('unsupported chains are refused without a request', async () => {
  const f = fakeFetch(json({ result: '0x1' }));
  await rejectsWith(createReadRpc({ fetchImpl: f })('0x1', 'eth_blockNumber', []), 4901);
  assert.equal(f.calls.length, 0);
  assert.throws(() => createReadRpc({}), TypeError);
});
