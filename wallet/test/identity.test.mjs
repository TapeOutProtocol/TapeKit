// Offline unit tests for wallet/src/identity.js: site origin → on-chain identity via an injected kernel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIdentityResolver } from '../src/identity.js';
import { parseSiteOrigin } from '../src/origin.js';

const HUB = 'https://tapekit.org/.tape/wallet/';
const A = parseSiteOrigin('https://4246-0.tapekit.org', HUB);
const XL = parseSiteOrigin('https://1-2-344.tapekit.org', HUB);
const CONTAINER = '0x' + '12'.repeat(20);
const HOLDER = '0x' + 'aB'.repeat(20);   // mixed case, as a kernel may return a checksummed address

function fakeKernel(statusByName = {}, { holder = HOLDER } = {}) {
  const calls = [];
  return {
    calls,
    async resolve(input) {
      calls.push(input);
      if (statusByName[input] === 'throw') throw new Error('nodes disagree');
      const chainId = input.split('.').length === 4 ? 196 : 56;
      return { name: input, cpuName: 'Seed CPU', container: CONTAINER, status: statusByName[input] || 'ok', chainId, block: '0x1', holder };
    },
  };
}

test('resolves name, processor, container, status and hex chain', async () => {
  const kernel = fakeKernel();
  const id = createIdentityResolver({ kernel });
  assert.deepEqual(await id.resolve(A), { name: '4246.0.tape', cpuName: 'Seed CPU', container: CONTAINER, status: 'ok', chainId: '0x38', holder: HOLDER.toLowerCase() });
  assert.equal((await id.resolve(XL)).chainId, '0xc4');
  assert.deepEqual(kernel.calls, ['4246.0.tape', '1.2.344.tape'], 'resolves by canonical name derived from the origin');
});

test('holder is lower-cased; a missing or malformed holder is null', async () => {
  for (const [holder, want] of [[HOLDER, HOLDER.toLowerCase()], [null, null], ['0x0', null], [42, null]]) {
    const id = createIdentityResolver({ kernel: fakeKernel({}, { holder }) });
    assert.equal((await id.resolve(A)).holder, want, String(holder));
  }
  const failing = createIdentityResolver({ kernel: fakeKernel({ '4246.0.tape': 'throw' }) });
  assert.equal((await failing.resolve(A)).holder, null);
});

test('caches per origin for ttlMs, then asks the kernel again', async () => {
  const kernel = fakeKernel();
  let t = 1000;
  const id = createIdentityResolver({ kernel, ttlMs: 30_000, now: () => t });
  await id.resolve(A);
  t += 29_999;
  await id.resolve(A);
  assert.equal(kernel.calls.length, 1);
  t += 2;
  await id.resolve(A);
  assert.equal(kernel.calls.length, 2);
});

test('concurrent lookups for one origin share one kernel call', async () => {
  const kernel = fakeKernel();
  const id = createIdentityResolver({ kernel });
  const [a, b] = await Promise.all([id.resolve(A), id.resolve(A)]);
  assert.deepEqual(a, b);
  assert.equal(kernel.calls.length, 1);
});

test('non-ok statuses are passed through so the router can refuse them', async () => {
  const id = createIdentityResolver({ kernel: fakeKernel({ '4246.0.tape': 'not-opened' }) });
  assert.equal((await id.resolve(A)).status, 'not-opened');
});

test('kernel failures give status "unavailable" and are not cached', async () => {
  const kernel = fakeKernel({ '4246.0.tape': 'throw' });
  const id = createIdentityResolver({ kernel });
  const r = await id.resolve(A);
  assert.equal(r.status, 'unavailable');
  assert.equal(r.name, '4246.0.tape');
  assert.equal(r.container, null);
  assert.equal(r.chainId, '0x38');
  await id.resolve(A);
  assert.equal(kernel.calls.length, 2);
});

test('results are frozen and invalid sites are refused', async () => {
  const id = createIdentityResolver({ kernel: fakeKernel() });
  assert.ok(Object.isFrozen(await id.resolve(A)));
  await assert.rejects(() => id.resolve(null), TypeError);
  await assert.rejects(() => id.resolve({ origin: 'https://evil.com' }), TypeError);
  assert.throws(() => createIdentityResolver({}), TypeError);
});

test('clock going backwards does not extend the cache', async () => {
  const kernel = fakeKernel();
  let t = 100_000;
  const id = createIdentityResolver({ kernel, ttlMs: 30_000, now: () => t });
  await id.resolve(A);
  t = 1;
  await id.resolve(A);
  assert.equal(kernel.calls.length, 2);
});
