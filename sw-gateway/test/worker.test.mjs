// Offline unit tests for sw-gateway/worker.js: the wallet hub is served only on the root host, with its own
// CSP; site subdomains and every other path behave as before. env.ASSETS is a fake with Cloudflare's
// single-page-application fallback (unknown paths → /index.html).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import worker from '../worker.js';
import { HUB_CSP } from '../hub-route.js';
import { DOC_CSP, isReservedSitePath } from '../serve.js';

const SANDBOX = "default-src 'none'; sandbox";
const FILES = {
  '/index.html': 'BOOT',
  '/sw.js': 'SW',
  '/.tape/wallet/index.html': 'HUB',
  '/.tape/wallet/hub.js': 'HUBJS',
  '/.tape/wallet/hub.css': 'HUBCSS',
  '/.tape/wallet/src/router.js': 'ROUTER',
};

function fakeAssets() {
  const seen = [];
  return {
    seen,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      seen.push(path);
      const body = Object.prototype.hasOwnProperty.call(FILES, path) ? FILES[path] : FILES['/index.html'];
      return new Response(body, { status: 200, headers: { 'content-type': 'text/plain' } });
    },
  };
}

async function get(url) {
  const ASSETS = fakeAssets();
  const res = await worker.fetch(new Request(url), { ASSETS });
  return { status: res.status, body: await res.text(), csp: res.headers.get('content-security-policy'), headers: res.headers, seen: ASSETS.seen };
}

test('root host: /.tape/wallet/ serves the hub HTML with the hub CSP', async () => {
  for (const url of ['https://tapekit.org/.tape/wallet/', 'https://tapekit.org/.tape/wallet/index.html', 'http://localhost:8096/.tape/wallet/']) {
    const r = await get(url);
    assert.equal(r.body, 'HUB', url);
    assert.equal(r.csp, HUB_CSP, url);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(r.seen, ['/.tape/wallet/index.html']);
  }
});

test('the hub CSP forbids framing, inline code and off-origin scripts', () => {
  const d = Object.fromEntries(HUB_CSP.split(';').map((s) => s.trim().split(/\s+/)).map(([k, ...v]) => [k, v.join(' ')]));
  assert.equal(d['frame-ancestors'], "'none'");
  assert.equal(d['script-src'], "'self'");
  assert.equal(d['style-src'], "'self'");
  assert.equal(d['default-src'], "'none'");
  assert.equal(d['base-uri'], "'none'");
  assert.equal(d['form-action'], "'none'");
  assert.equal(d['worker-src'], "'none'", 'the hub can never register a Service Worker on the root');
  assert.ok(!HUB_CSP.includes('unsafe-'));
});

test('the meta CSP in the hub HTML keeps every header directive a meta tag can carry', () => {
  const html = fs.readFileSync(new URL('../../wallet/hub/index.html', import.meta.url), 'utf8');
  const meta = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)[1];
  const header = HUB_CSP.split(';').map((s) => s.trim()).filter((s) => !s.startsWith('frame-ancestors'));
  assert.deepEqual(meta.split(';').map((s) => s.trim()), header);
});

test('root host: hub scripts, styles and modules are static files with nosniff and the sandbox CSP', async () => {
  for (const [path, body] of [['/.tape/wallet/hub.js', 'HUBJS'], ['/.tape/wallet/hub.css', 'HUBCSS'], ['/.tape/wallet/src/router.js', 'ROUTER']]) {
    const r = await get('https://tapekit.org' + path);
    assert.equal(r.body, body, path);
    assert.equal(r.csp, SANDBOX, path);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  }
});

test('site subdomains never get the hub, nor anything else at its path: a script-free notice (404) that names the real hub', async () => {
  // Audit 2026-10-18 issue 6: a site's own file at /.tape/wallet/ could pose as the hub at an address users are
  // taught to trust. The compat tier (-open) would have served it from chain; the self-verifying tier's bootstrap
  // would have installed the Service Worker, which then served it (sw.js checks the same rule).
  const hosts = ['https://4246-0.tapekit.org', 'https://1-2-344.tapekit.org', 'https://01-0.tapekit.org', 'https://4246-0-open.tapekit.org', 'https://tapekit.org.', 'https://4246-0.tapekit.org.', 'http://4246-0.localhost:8096'];
  for (const host of hosts) {
    for (const path of ['/.tape/wallet/', '/.tape/wallet', '/.tape/wallet/index.html', '/.tape/wallet/hub.js', '/.tape/wallet/src/router.js', '/.tape/WALLET/', '/.tape/%77allet/', '/.tape/wallet%2Findex.html']) {
      const r = await get(host + path);
      assert.equal(r.status, 404, host + path);
      assert.equal(r.csp, DOC_CSP, host + path);
      assert.match(r.body, /\/\.tape\/wallet\//, host + path);
      assert.doesNotMatch(r.body, /<script/i);
      assert.deepEqual(r.seen, [], 'nothing fetched: not the bootstrap, not the chain');
    }
  }
  const named = await get('https://4246-0.tapekit.org/.tape/wallet/');
  assert.match(named.body, /https:\/\/tapekit\.org\/\.tape\/wallet\//);
  const dev = await get('http://4246-0.localhost:8096/.tape/wallet/');
  assert.match(dev.body, /http:\/\/localhost:8096\/\.tape\/wallet\//);
});

test('isReservedSitePath: the hub path in any spelling a browser or a server may map to it', () => {
  for (const p of ['/.tape/wallet', '/.tape/wallet/', '/.tape/wallet/x.js', '/.tape/Wallet/', '/.tape/%77allet/', '/.tape/wallet%2F']) assert.equal(isReservedSitePath(p), true, p);
  for (const p of ['/', '/.tape/status', '/.tape/walletx', '/wallet/', '/.tape/kernel/index.js', '/a/.tape/wallet/', '/%zz']) assert.equal(isReservedSitePath(p), false, p);
});

test('everything else is unchanged', async () => {
  let r = await get('https://tapekit.org/');
  assert.equal(r.csp, null, 'the bootstrap page carries its own meta CSP');
  r = await get('https://4246-0.tapekit.org/sw.js');
  assert.equal(r.body, 'SW');
  assert.equal(r.csp, null);
  for (const url of ['https://tapekit.org/.tape/wallet', 'https://tapekit.org/docs/', 'https://4246-0.tapekit.org/.tape/status', 'https://tapekit.org/.tape/kernel/index.js']) {
    r = await get(url);
    assert.equal(r.csp, SANDBOX, url);
    assert.equal(r.headers.get('cache-control'), 'no-cache');
  }
  r = await get('https://4246-0.tapekit.org/.tape/csp-report');
  assert.equal(r.status, 204);
  assert.deepEqual(r.seen, []);
});

test('no response sets Cross-Origin-Opener-Policy (the popup channel needs window.opener)', async () => {
  for (const url of ['https://tapekit.org/.tape/wallet/', 'https://4246-0.tapekit.org/', 'https://tapekit.org/']) {
    assert.equal((await get(url)).headers.get('cross-origin-opener-policy'), null, url);
  }
});
