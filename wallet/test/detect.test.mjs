// Offline unit tests for wallet/src/detect.js: EIP-6963 discovery in the hub and the wallet choice (R1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectWallets, chooseWallet } from '../src/detect.js';
import { okx } from '../src/adapters/okx.js';
import { binance } from '../src/adapters/binance.js';

const wallet = () => ({ request: async () => null });
const info = (rdns) => ({ uuid: '00000000-0000-4000-8000-000000000000', name: rdns, icon: 'data:,', rdns });

/** A window that answers eip6963:requestProvider with the given announcements, like wallet extensions do. */
function fakeWindow({ announce = [], globals = {} } = {}) {
  const win = Object.assign(new EventTarget(), globals, { CustomEvent });
  win.addEventListener('eip6963:requestProvider', () => {
    for (const detail of announce) win.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail }));
  });
  return win;
}

test('finds wallets that answer eip6963:requestProvider, in adapter order', async () => {
  const o = wallet(), b = wallet();
  const win = fakeWindow({ announce: [{ info: info('com.binance.wallet'), provider: b }, { info: info('io.metamask'), provider: wallet() }, { info: info('com.okex.wallet'), provider: o }] });
  const found = await detectWallets(win, { waitMs: 5 });
  assert.deepEqual(found.map((x) => x.adapter.id), ['okx', 'binance']);
  assert.equal(found[0].provider, o);
  assert.equal(found[1].provider, b);
});

test('collects late announcements within the wait, then stops listening', async () => {
  const o = wallet();
  const win = fakeWindow();
  const late = setTimeout(() => win.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: { info: info('com.okex.wallet'), provider: o } })), 1);
  const found = await detectWallets(win, { waitMs: 30 });
  clearTimeout(late);
  assert.equal(found.length, 1);
  win.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: { info: info('com.binance.wallet'), provider: wallet() } }));
  assert.equal(found.length, 1, 'the result is frozen and no longer updated');
  assert.ok(Object.isFrozen(found));
});

test('falls back to the dedicated globals when nothing is announced', async () => {
  const o = wallet();
  const found = await detectWallets(fakeWindow({ globals: { okxwallet: o } }), { waitMs: 1 });
  assert.deepEqual(found.map((x) => x.adapter.id), ['okx']);
  assert.equal(found[0].provider, o);
});

test('malformed announcements are ignored', async () => {
  const win = fakeWindow({ announce: [null, { info: null, provider: wallet() }, { info: info('com.okex.wallet'), provider: {} }, { info: { rdns: 5 }, provider: wallet() }] });
  assert.deepEqual(await detectWallets(win, { waitMs: 1 }), []);
});

test('chooseWallet: none, exactly one (auto), several with or without a remembered choice', () => {
  const o = { adapter: okx, provider: wallet() };
  const b = { adapter: binance, provider: wallet() };
  assert.deepEqual(chooseWallet([], null), { selected: null, needsPick: false });
  assert.deepEqual(chooseWallet([], 'okx'), { selected: null, needsPick: false });
  assert.deepEqual(chooseWallet([b], 'okx'), { selected: b, needsPick: false }, 'a single wallet is used even if another was remembered');
  assert.deepEqual(chooseWallet([o, b], 'binance'), { selected: b, needsPick: false });
  assert.deepEqual(chooseWallet([o, b], null), { selected: null, needsPick: true });
  assert.deepEqual(chooseWallet([o, b], 'metamask'), { selected: null, needsPick: true }, 'a stale choice asks again');
});
