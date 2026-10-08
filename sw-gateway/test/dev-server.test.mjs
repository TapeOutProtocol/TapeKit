// Offline unit tests for sw-gateway/dev-server.mjs: the local gateway serves the wallet hub like production
// (root host only, hub CSP header), so browser tests see the real policy.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import server from '../dev-server.mjs';
import { HUB_CSP } from '../hub-route.js';

let port;
before(() => new Promise((resolve) => server.listen(0, '127.0.0.1', () => { port = server.address().port; resolve(); })));
after(() => new Promise((resolve) => server.close(resolve)));

function get(host, path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, headers: { host } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('root host: the hub with the hub CSP header', async () => {
  for (const path of ['/.tape/wallet/', '/.tape/wallet/index.html']) {
    const r = await get('localhost:8096', path);
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-security-policy'], HUB_CSP, path);
    assert.match(r.body, /<script type="module" src="\/\.tape\/wallet\/hub\.js"><\/script>/);
  }
});

test('root host: hub assets with the right types; wallet modules point at /.tape/kernel/', async () => {
  const css = await get('localhost:8096', '/.tape/wallet/hub.css');
  assert.match(css.headers['content-type'], /^text\/css/);
  assert.equal(css.headers['x-content-type-options'], 'nosniff');
  const js = await get('localhost:8096', '/.tape/wallet/hub.js');
  assert.match(js.headers['content-type'], /^text\/javascript/);
  const origin = await get('localhost:8096', '/.tape/wallet/src/origin.js');
  assert.match(origin.body, /from '\.\.\/\.\.\/kernel\/name\.js'/);
  // %2f survives URL parsing and is decoded afterwards: the path must still not leave wallet/src
  assert.equal((await get('localhost:8096', '/.tape/wallet/src/..%2f..%2f..%2fpackage.json')).status, 403);
});

test('site subdomains get the bootstrap page, not the hub, as before', async () => {
  for (const host of ['4246-0.localhost:8096', '1-2-344.localhost:8096', '4246-0-open.localhost:8096']) {
    for (const path of ['/.tape/wallet/', '/.tape/wallet/hub.js']) {
      const r = await get(host, path);
      assert.equal(r.headers['content-security-policy'], undefined, host + path);
      assert.match(r.body, /tape:\/\/ 网关引导页/, host + path);
    }
  }
});

test('the bootstrap and kernel paths are unchanged', async () => {
  const boot = await get('4246-0.localhost:8096', '/');
  assert.match(boot.body, /\/\.tape\/boot\.js/);
  const kernel = await get('localhost:8096', '/.tape/kernel/name.js');
  assert.match(kernel.headers['content-type'], /^text\/javascript/);
});
