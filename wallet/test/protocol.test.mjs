// Offline unit tests for wallet/src/protocol.js: method table, error codes, limits, message envelopes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHANNEL, ERR, LIMITS, METHODS, classify, rpcError, isRpcError, paramsSize,
  makeRequest, makeResult, makeError, makeEvent, makeReady, readEnvelope,
} from '../src/protocol.js';

test('classify follows the design method table', () => {
  for (const m of ['eth_chainId', 'net_version', 'eth_accounts', 'wallet_getPermissions']) assert.equal(classify(m), 'local', m);
  for (const m of ['eth_requestAccounts', 'wallet_requestPermissions']) assert.equal(classify(m), 'permission', m);
  assert.equal(classify('wallet_revokePermissions'), 'revoke');
  for (const m of ['wallet_switchEthereumChain', 'wallet_addEthereumChain']) assert.equal(classify(m), 'chain', m);
  for (const m of ['personal_sign', 'eth_signTypedData_v4', 'eth_sendTransaction']) assert.equal(classify(m), 'sign', m);
  for (const m of ['eth_blockNumber', 'eth_call', 'eth_estimateGas', 'eth_getLogs', 'eth_getTransactionReceipt']) assert.equal(classify(m), 'read', m);
});

test('classify rejects dangerous and unknown methods', () => {
  for (const m of ['eth_sign', 'eth_signTypedData', 'eth_signTransaction', 'wallet_sendCalls', 'eth_signTypedData_v3', 'foo', '', 'toString', '__proto__', 'constructor']) {
    assert.equal(classify(m), 'reject', m);
  }
  assert.equal(classify(undefined), 'reject');
  assert.equal(classify(42), 'reject');
});

test('method table is frozen and has no overlaps', () => {
  assert.ok(Object.isFrozen(METHODS));
  const seen = new Set();
  for (const [kind, list] of Object.entries(METHODS)) {
    assert.ok(Object.isFrozen(list), kind);
    for (const m of list) { assert.ok(!seen.has(m), `duplicate ${m}`); seen.add(m); }
  }
});

test('error codes match EIP-1193 and JSON-RPC', () => {
  assert.deepEqual({ ...ERR }, {
    USER_REJECTED: 4001, UNAUTHORIZED: 4100, UNSUPPORTED_METHOD: 4200, DISCONNECTED: 4900,
    CHAIN_DISCONNECTED: 4901, UNRECOGNIZED_CHAIN: 4902, INVALID_PARAMS: -32602, INTERNAL: -32603,
    LIMIT_EXCEEDED: -32005,
  });
  assert.ok(Object.isFrozen(ERR));
});

test('rpcError builds plain { code, message, data } objects', () => {
  const e = rpcError(4001, 'nope');
  assert.deepEqual(e, { code: 4001, message: 'nope' });
  assert.ok(!(e instanceof Error));
  assert.deepEqual(rpcError(-32602, 'bad', { field: 'x' }), { code: -32602, message: 'bad', data: { field: 'x' } });
  assert.equal(typeof rpcError(4100).message, 'string');
  assert.ok(rpcError(4100).message.length > 0, 'default message');
  assert.ok(isRpcError(rpcError(4200)));
  assert.ok(!isRpcError(new Error('x')));
  assert.ok(!isRpcError({ code: '4001', message: 'x' }));
  assert.throws(() => rpcError(1.5, 'x'), TypeError);
});

test('limits: 256 KB params and 4 queued requests per site', () => {
  assert.equal(LIMITS.maxParamsBytes, 256 * 1024);
  assert.equal(LIMITS.maxQueuedPerSite, 4);
  assert.ok(Object.isFrozen(LIMITS));
});

test('paramsSize counts UTF-8 bytes of the JSON form', () => {
  assert.equal(paramsSize(undefined), 0);
  assert.equal(paramsSize(['a']), 5);          // ["a"]
  assert.equal(paramsSize(['é']), 6);          // two bytes for é
  const cyclic = []; cyclic.push(cyclic);
  assert.equal(paramsSize(cyclic), Infinity);
  assert.equal(paramsSize([1n]), Infinity);
});

test('envelopes round-trip through readEnvelope', () => {
  const req = makeRequest(7, 'eth_chainId', []);
  assert.deepEqual(readEnvelope(req), req);
  assert.equal(req.channel, CHANNEL);
  assert.deepEqual(readEnvelope(makeResult(7, '0x38')), { channel: CHANNEL, type: 'response', id: 7, result: '0x38' });
  const err = makeError('a', rpcError(4001, 'no'));
  assert.deepEqual(readEnvelope(err).error, { code: 4001, message: 'no' });
  assert.deepEqual(readEnvelope(makeEvent('chainChanged', '0xc4')), { channel: CHANNEL, type: 'event', event: 'chainChanged', data: '0xc4' });
  assert.deepEqual(readEnvelope(makeReady()), { channel: CHANNEL, type: 'ready' });
  assert.deepEqual(readEnvelope({ ...makeReady(), id: 1, origin: 'https://evil.com' }), { channel: CHANNEL, type: 'ready' }, 'extra fields dropped');
});

test('readEnvelope rejects malformed or foreign messages', () => {
  const bad = [
    null, 'x', 42, {}, { channel: 'other', type: 'request', id: 1, method: 'eth_chainId' },
    { channel: CHANNEL, type: 'request', id: {}, method: 'eth_chainId' },
    { channel: CHANNEL, type: 'request', id: 1, method: 5 },
    { channel: CHANNEL, type: 'request', id: 1, method: 'x'.repeat(200) },
    { channel: CHANNEL, type: 'request', id: 1, method: 'eth_call', params: 'str' },
    { channel: CHANNEL, type: 'request', id: Infinity, method: 'eth_call' },
    { channel: CHANNEL, type: 'response', id: 1 },
    { channel: CHANNEL, type: 'response', id: 1, error: { code: 'x', message: 'y' } },
    { channel: CHANNEL, type: 'event', event: 'unknownEvent', data: 1 },
    { channel: CHANNEL, type: 'nope', id: 1 },
  ];
  for (const b of bad) assert.equal(readEnvelope(b), null, JSON.stringify(b));
});

test('readEnvelope keeps only known fields (no smuggled origin or gesture)', () => {
  const msg = { channel: CHANNEL, type: 'request', id: 1, method: 'eth_requestAccounts', params: [], origin: 'https://evil.com', gesture: true };
  assert.deepEqual(readEnvelope(msg), { channel: CHANNEL, type: 'request', id: 1, method: 'eth_requestAccounts', params: [] });
});
