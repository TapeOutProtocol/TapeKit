// Offline unit tests for wallet/src/origin.js: which browser-reported origins count as on-chain sites.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSiteOrigin } from '../src/origin.js';

const PROD = 'https://tapekit.org/.tape/wallet/';
const DEV = 'http://localhost:8096/.tape/wallet/';

test('accepts BNB and area-coded site origins under the hub host', () => {
  assert.deepEqual(parseSiteOrigin('https://4246-0.tapekit.org', PROD), {
    origin: 'https://4246-0.tapekit.org', host: '4246-0.tapekit.org', name: '4246.0.tape', area: null, label: '4246-0',
  });
  assert.deepEqual(parseSiteOrigin('https://1-2-344.tapekit.org', PROD), {
    origin: 'https://1-2-344.tapekit.org', host: '1-2-344.tapekit.org', name: '1.2.344.tape', area: 2, label: '1-2-344',
  });
  assert.equal(parseSiteOrigin('https://1-3-5.tapekit.org', PROD).name, '1.3.5.tape');
});

test('accepts http sites on a localhost hub, port included', () => {
  const site = parseSiteOrigin('http://4246-0.localhost:8096', DEV);
  assert.equal(site.name, '4246.0.tape');
  assert.equal(site.host, '4246-0.localhost:8096');
  assert.equal(parseSiteOrigin('http://4246-0.dev.localhost:8096', 'http://dev.localhost:8096/.tape/wallet/').name, '4246.0.tape');
});

test('accepts a Location-like or URL hub argument', () => {
  assert.equal(parseSiteOrigin('https://4246-0.tapekit.org', new URL(PROD)).name, '4246.0.tape');
  assert.equal(parseSiteOrigin('https://4246-0.tapekit.org', { href: PROD }).name, '4246.0.tape');
});

test('rejects the root host, other domains and look-alike suffixes', () => {
  const bad = [
    'https://tapekit.org',
    'https://evil.com',
    'https://4246-0.evil.com',
    'https://4246-0.tapekit.org.evil.com',
    'https://4246-0.eviltapekit.org',
    'https://x.4246-0.tapekit.org',
    'https://4246-0.x.tapekit.org',
    'https://4246-0.tapekit.org.',
    'https://4246-0.tapekit.org:8443',
  ];
  for (const o of bad) assert.equal(parseSiteOrigin(o, PROD), null, o);
});

test('rejects invalid site labels', () => {
  const bad = ['https://04246-0.tapekit.org', 'https://4246-00.tapekit.org', 'https://0-0.tapekit.org', 'https://1-9-0.tapekit.org',
    'https://1-1-0.tapekit.org', 'https://abc.tapekit.org', 'https://4246.tapekit.org', 'https://1-2-3-4.tapekit.org', 'https://www.tapekit.org'];
  for (const o of bad) assert.equal(parseSiteOrigin(o, PROD), null, o);
});

test('rejects non-canonical origin strings: userinfo, paths, case, null', () => {
  const bad = [
    'https://user@4246-0.tapekit.org', 'https://user:pw@4246-0.tapekit.org', 'https://4246-0.tapekit.org/',
    'https://4246-0.tapekit.org/x', 'https://4246-0.TAPEKIT.org', 'https://4246-0.tapekit.org:443',
    'null', '', null, undefined, 42, {}, 'not a url', 'file:///etc/passwd', 'data:text/html,hi', 'blob:https://4246-0.tapekit.org/uuid',
  ];
  for (const o of bad) assert.equal(parseSiteOrigin(o, PROD), null, String(o));
});

test('requires https unless the hub itself is on localhost', () => {
  assert.equal(parseSiteOrigin('http://4246-0.tapekit.org', PROD), null);
  assert.equal(parseSiteOrigin('http://4246-0.tapekit.org', 'http://tapekit.org/.tape/wallet/'), null, 'http hub off localhost is not dev');
  assert.equal(parseSiteOrigin('ws://4246-0.localhost:8096', DEV), null);
  assert.equal(parseSiteOrigin('https://4246-0.localhost:8096', DEV).name, '4246.0.tape');
});

test('rejects when the hub location itself is unusable', () => {
  for (const hub of [null, undefined, '', 'nope', 'https://tapekit.org./.tape/wallet/', 'http://127.0.0.1:8096/', 'http://tapekit.org/.tape/wallet/']) {
    assert.equal(parseSiteOrigin('https://4246-0.tapekit.org', hub), null, String(hub));
  }
});
