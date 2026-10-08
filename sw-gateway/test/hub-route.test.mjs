// Offline unit tests for sw-gateway/hub-route.js: which hosts count as the gateway root (the only place the
// wallet hub is served). Compat-tier site hosts (serve.js OPEN_SUFFIX, e.g. 4246-0-open) serve a site's own
// on-chain files, so they must never be treated as root.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isRootHost, hubRoute } from '../hub-route.js';
import { OPEN_SUFFIX } from '../serve.js';

test('the gateway root hosts are root', () => {
  for (const host of ['tapekit.org', 'localhost', 'tape.example.org']) assert.equal(isRootHost(host), true, host);
});

test('site hosts of both tiers are not root', () => {
  for (const host of ['4246-0.tapekit.org', '1-2-344.tapekit.org', `4246-0${OPEN_SUFFIX}.tapekit.org`, `1-2-344${OPEN_SUFFIX}.tapekit.org`, `4246-0${OPEN_SUFFIX}.localhost`]) {
    assert.equal(isRootHost(host), false, host);
  }
});

test('a trailing-dot host is not root', () => {
  assert.equal(isRootHost('tapekit.org.'), false);
});

test('hub paths on a compat-tier host are routed as a site, never as the hub', () => {
  for (const path of ['/.tape/wallet/', '/.tape/wallet/index.html', '/.tape/wallet/hub.js']) {
    assert.deepEqual(hubRoute(`4246-0${OPEN_SUFFIX}.tapekit.org`, path), { kind: 'site' }, path);
  }
});
