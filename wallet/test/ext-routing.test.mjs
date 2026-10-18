// Offline unit tests for wallet/extension/routing.js (design §10.1, R6): which host access is requested, which
// content scripts are registered where, and the enable / disable / gateway-change flows; plus the manifest and
// the bundled content scripts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { gatewayInfo, originsFor, contentScriptsFor, enableRouting, disableRouting, syncRouting, routingState, ROUTING_KEY, SCRIPT_IDS } from '../extension/routing.js';
import { bundleContentScripts } from '../extension/bundle.mjs';
import { fakeChrome } from './fake-chrome.mjs';

const state = async (chrome) => (await chrome.storage.local.get(ROUTING_KEY))[ROUTING_KEY] || null;
const registered = async (chrome) => (await chrome.scripting.getRegisteredContentScripts()).map((s) => s.id);

test('gateway → host patterns: https except a localhost gateway; ports dropped (match patterns ignore them)', () => {
  const prod = gatewayInfo('tapekit.org');
  assert.deepEqual(originsFor(prod), ['https://*.tapekit.org/*', 'https://tapekit.org/*']);
  assert.equal(prod.hubUrl, 'https://tapekit.org/.tape/wallet/');
  const dev = gatewayInfo('localhost:8096');
  assert.deepEqual(originsFor(dev), ['http://*.localhost/*', 'http://localhost/*']);
  assert.equal(dev.hubOrigin, 'http://localhost:8096');
  assert.equal(gatewayInfo('gw.example.org:8443').hubOrigin, 'https://gw.example.org:8443');
  for (const bad of ['', '127.0.0.1:8096', '4246-0.tapekit.org', 'tapekit.org/x', 'https://tapekit.org', 'tape kit.org', 'a..b', 'localhost:99999']) {
    assert.equal(gatewayInfo(bad), null, bad);
  }
});

test('content scripts: provider in MAIN and relay in ISOLATED on sites only (not the root, not /.tape/*), top frame, document_start', () => {
  const [inpage, relay, hubRelay] = contentScriptsFor(gatewayInfo('tapekit.org'));
  for (const s of [inpage, relay]) {
    assert.deepEqual(s.matches, ['https://*.tapekit.org/*']);
    assert.deepEqual(s.excludeMatches, ['https://tapekit.org/*', 'https://*.tapekit.org/.tape/*']);
    assert.equal(s.allFrames, false);
    assert.equal(s.runAt, 'document_start');
  }
  assert.equal(inpage.world, 'MAIN');
  assert.deepEqual(inpage.js, ['wallet/inpage.js']);
  assert.equal(relay.world, 'ISOLATED');
  assert.deepEqual(hubRelay.matches, ['https://tapekit.org/.tape/wallet/*']);
  assert.equal(hubRelay.world, 'ISOLATED');
  assert.equal(hubRelay.allFrames, false);
  assert.deepEqual([inpage.id, relay.id, hubRelay.id], [...SCRIPT_IDS]);
});

test('enable: asks for exactly the gateway\'s origins first, then registers the scripts and records the gateway', async () => {
  const chrome = fakeChrome({ gateway: 'tapekit.org' });
  const done = enableRouting(chrome, 'tapekit.org');
  assert.equal(chrome.log.requested.length, 1);   // synchronously: still inside the click's user gesture
  assert.deepEqual(await done, { ok: true });
  assert.deepEqual(chrome.log.requested, [['https://*.tapekit.org/*', 'https://tapekit.org/*']]);
  assert.deepEqual(await registered(chrome), [...SCRIPT_IDS]);
  assert.deepEqual(await state(chrome), { gateway: 'tapekit.org' });
  assert.deepEqual(await routingState(chrome, 'tapekit.org'), { info: gatewayInfo('tapekit.org'), enabled: true });
  assert.deepEqual(await enableRouting(chrome, 'tapekit.org'), { ok: true });   // again: re-registers, no duplicates
  assert.deepEqual(await registered(chrome), [...SCRIPT_IDS]);
});

test('enable: the user says no, or the gateway cannot work → nothing registered', async () => {
  const chrome = fakeChrome();
  chrome.permissions.answer = false;
  assert.deepEqual(await enableRouting(chrome, 'tapekit.org'), { ok: false, reason: 'denied' });
  assert.deepEqual(await enableRouting(chrome, '127.0.0.1:8096'), { ok: false, reason: 'gateway' });
  assert.deepEqual(await registered(chrome), []);
  assert.equal(await state(chrome), null);
  assert.equal(chrome.log.requested.length, 1);   // an unusable gateway does not even ask
});

test('disable: scripts gone, state gone, host access given back', async () => {
  const chrome = fakeChrome();
  await enableRouting(chrome, 'tapekit.org');
  await disableRouting(chrome);
  assert.deepEqual(await registered(chrome), []);
  assert.equal(await state(chrome), null);
  assert.equal(chrome.permissions.has('https://*.tapekit.org/*'), false);
});

test('gateway change: same gateway → nothing; covered by granted access → re-registered; else switched off', async () => {
  const chrome = fakeChrome();
  await enableRouting(chrome, 'localhost:8096');
  assert.equal(await syncRouting(chrome, 'localhost:8096'), 'on');
  assert.equal(await syncRouting(chrome, 'localhost:9000'), 'on');          // same host patterns, new port
  assert.deepEqual(await state(chrome), { gateway: 'localhost:9000' });
  assert.equal(chrome.permissions.has('http://*.localhost/*'), true);
  assert.equal(await syncRouting(chrome, 'tapekit.org'), 'off');           // needs a click to grant access
  assert.deepEqual(await registered(chrome), []);
  assert.equal(await state(chrome), null);
  assert.equal(chrome.permissions.has('http://*.localhost/*'), false);      // the old gateway's access is dropped
  assert.equal(await syncRouting(chrome, 'tapekit.org'), 'off');
});

test('extension reload or update drops the registered scripts: sync registers them again, without a click (audit 2026-10-18 issue 5)', async () => {
  const chrome = fakeChrome();
  await enableRouting(chrome, 'tapekit.org');
  await chrome.scripting.unregisterContentScripts({ ids: [...SCRIPT_IDS] });   // what Chrome did on reload (m2-reload.txt)
  assert.equal(await syncRouting(chrome, 'tapekit.org'), 'on');
  assert.deepEqual(await registered(chrome), [...SCRIPT_IDS]);
  await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_IDS[2]] });   // one missing
  assert.equal(await syncRouting(chrome, 'tapekit.org'), 'on');
  assert.deepEqual((await registered(chrome)).sort(), [...SCRIPT_IDS].sort());
  const [inpage] = await chrome.scripting.getRegisteredContentScripts({ ids: [SCRIPT_IDS[0]] });
  assert.deepEqual(inpage.matches, ['https://*.tapekit.org/*']);
  assert.equal(chrome.log.requested.length, 1, 'access was already granted: no new permission request');
  assert.deepEqual(await state(chrome), { gateway: 'tapekit.org' });
});

test('sync leaves complete registrations alone', async () => {
  const chrome = fakeChrome();
  await enableRouting(chrome, 'tapekit.org');
  let writes = 0;
  const register = chrome.scripting.registerContentScripts;
  chrome.scripting.registerContentScripts = async (list) => { writes += 1; return register(list); };
  assert.equal(await syncRouting(chrome, 'tapekit.org'), 'on');
  assert.equal(writes, 0);
});

test('host access removed in Chrome\'s settings → routing off', async () => {
  const chrome = fakeChrome();
  await enableRouting(chrome, 'tapekit.org');
  await chrome.permissions.remove({ origins: ['https://*.tapekit.org/*'] });
  assert.equal(await syncRouting(chrome, 'tapekit.org'), 'off');
  assert.deepEqual(await registered(chrome), []);
});

test('the manifest asks for no host access at install time, only optional host permissions', () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('../../extension/manifest.json', import.meta.url), 'utf8'));
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(manifest.content_scripts, undefined);
  assert.deepEqual(manifest.optional_host_permissions, ['https://*/*', 'http://*.localhost/*']);
  for (const p of originsFor(gatewayInfo('tapekit.org'))) assert.ok(p.startsWith('https://'));
  assert.ok(manifest.permissions.includes('scripting') && manifest.permissions.includes('storage'));
});

test('content scripts bundle into classic scripts without module syntax, and run', () => {
  const scripts = bundleContentScripts();
  assert.deepEqual(Object.keys(scripts), ['inpage.js', 'relay.js', 'hub-relay.js']);
  for (const [name, code] of Object.entries(scripts)) {
    assert.doesNotMatch(code, /^\s*(import|export)\b/m, name);
    new vm.Script(code, { filename: name });
  }
  // inpage.js on a site page: installs window.tapekit.wallet and never sets window.ethereum.
  const listeners = {};
  const win = {
    location: { origin: 'https://4246-0.tapekit.org', protocol: 'https:', hostname: '4246-0.tapekit.org', pathname: '/' },
    addEventListener: (t, fn) => { listeners[t] = fn; }, dispatchEvent: () => true, postMessage: () => {},
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    crypto: globalThis.crypto,
  };
  win.top = win;
  win.window = win;
  const ctx = vm.createContext({ window: win, crypto: globalThis.crypto, setTimeout, clearTimeout });
  vm.runInContext(scripts['inpage.js'], ctx);
  assert.equal(win.tapekit.wallet.isTapeKit, true);
  assert.equal(win.ethereum, undefined);
  assert.equal(typeof listeners['eip6963:requestProvider'], 'function');
});
