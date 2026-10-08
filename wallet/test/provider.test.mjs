// Offline unit tests for wallet/src/provider.js: the EIP-1193 provider sites see and its EIP-6963 announcement.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProvider, announceProvider, createProviderInfo, ProviderRpcError } from '../src/provider.js';

function fakeTransport() {
  let listener = null;
  const sent = [];
  return {
    sent,
    fire: (event, data) => listener(event, data),
    subscribe(fn) { listener = fn; },
    async request(args) {
      sent.push(args);
      if (args.method === 'fail') throw { code: 4001, message: 'User rejected the request.', data: '0x01' };
      if (args.method === 'crash') throw new TypeError('bug');
      return 'r:' + args.method;
    },
  };
}
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test('provider has the EIP-1193 shape and does not pretend to be another wallet', () => {
  const p = createProvider({ transport: fakeTransport() });
  for (const k of ['request', 'on', 'removeListener']) assert.equal(typeof p[k], 'function', k);
  assert.equal(p.isTapeKit, true);
  assert.equal(p.isMetaMask, undefined);
  assert.ok(Object.isFrozen(p));
  assert.throws(() => createProvider({}), TypeError);
});

test('request forwards method and params and resolves with the result', async () => {
  const t = fakeTransport();
  const p = createProvider({ transport: t });
  assert.equal(await p.request({ method: 'eth_chainId' }), 'r:eth_chainId');
  assert.equal(await p.request({ method: 'eth_call', params: [{ to: '0x' }] }), 'r:eth_call');
  assert.deepEqual(t.sent, [{ method: 'eth_chainId', params: undefined }, { method: 'eth_call', params: [{ to: '0x' }] }]);
});

test('errors become ProviderRpcError instances with code, message and data', async () => {
  const p = createProvider({ transport: fakeTransport() });
  await assert.rejects(p.request({ method: 'fail' }), (e) => {
    assert.ok(e instanceof ProviderRpcError && e instanceof Error);
    assert.equal(e.code, 4001);
    assert.equal(e.message, 'User rejected the request.');
    assert.equal(e.data, '0x01');
    return true;
  });
  await assert.rejects(p.request({ method: 'crash' }), (e) => e instanceof ProviderRpcError && e.code === -32603);
});

test('malformed request arguments are rejected with -32602 without reaching the transport', async () => {
  const t = fakeTransport();
  const p = createProvider({ transport: t });
  for (const args of [undefined, null, 'eth_chainId', {}, { method: 5 }, { method: '' }, { method: 'x', params: 'str' }, { method: 'x', params: null }]) {
    await assert.rejects(p.request(args), (e) => e instanceof ProviderRpcError && e.code === -32602, JSON.stringify(args));
  }
  assert.equal(t.sent.length, 0);
});

test('events reach listeners until they are removed', () => {
  const t = fakeTransport();
  const p = createProvider({ transport: t });
  const got = [];
  const onAccounts = (a) => got.push(['accounts', a]);
  const onChain = (c) => got.push(['chain', c]);
  assert.equal(p.on('accountsChanged', onAccounts), p, 'chainable');
  p.on('chainChanged', onChain);
  t.fire('accountsChanged', ['0xabc']);
  t.fire('chainChanged', '0xc4');
  p.removeListener('accountsChanged', onAccounts);
  t.fire('accountsChanged', []);
  assert.deepEqual(got, [['accounts', ['0xabc']], ['chain', '0xc4']]);
});

test('a throwing listener does not stop the others and is reported', () => {
  const t = fakeTransport();
  const p = createProvider({ transport: t });
  const reported = [];
  const saved = globalThis.reportError;
  globalThis.reportError = (e) => reported.push(e);
  try {
    const got = [];
    p.on('chainChanged', () => { throw new Error('listener bug'); });
    p.on('chainChanged', (c) => got.push(c));
    t.fire('chainChanged', '0x38');
    assert.deepEqual(got, ['0x38']);
    assert.equal(reported.length, 1);
  } finally {
    globalThis.reportError = saved;
  }
});

test('provider info: TapeKit, org.tapekit, a uuid v4 and an inline SVG icon', () => {
  const info = createProviderInfo();
  assert.equal(info.name, 'TapeKit');
  assert.equal(info.rdns, 'org.tapekit');
  assert.match(info.uuid, UUID_V4);
  assert.match(info.icon, /^data:image\/svg\+xml[,;]/);
  assert.ok(Object.isFrozen(info));
  assert.notEqual(createProviderInfo().uuid, info.uuid);
});

test('announceProvider announces at once and on every eip6963:requestProvider, with a frozen detail', () => {
  const win = new EventTarget();
  win.CustomEvent = CustomEvent;
  const details = [];
  win.addEventListener('eip6963:announceProvider', (e) => details.push(e.detail));
  const p = createProvider({ transport: fakeTransport() });
  const info = createProviderInfo();
  const stop = announceProvider(win, p, info);
  assert.equal(details.length, 1);
  win.dispatchEvent(new CustomEvent('eip6963:requestProvider'));
  assert.equal(details.length, 2);
  const d = details[0];
  assert.equal(d, details[1], 'same detail object every time');
  assert.ok(Object.isFrozen(d) && Object.isFrozen(d.info));
  assert.equal(d.provider, p);
  assert.deepEqual({ ...d.info }, { ...info });
  stop();
  win.dispatchEvent(new CustomEvent('eip6963:requestProvider'));
  assert.equal(details.length, 2, 'no announcements after stop()');
});

test('provider.js has no imports, so it can be wrapped into a classic script', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../src/provider.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /^\s*import\s/m);
  assert.doesNotMatch(src, /\bimport\s*\(/);
  assert.doesNotMatch(src, /window\.ethereum/);
});
