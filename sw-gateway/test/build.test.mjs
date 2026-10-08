// Offline unit tests for sw-gateway/build.mjs: the wallet hub ships in dist/gateway/.tape/wallet/, its kernel
// imports point at /.tape/kernel/, and the self-check rejects any import that does not resolve.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildGateway, checkGateway } from '../build.mjs';
import { hubSourceFile, gatewaySource } from '../hub-files.mjs';

function withBuild(fn) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'tapekit-gateway-'));
  try {
    buildGateway(out);
    return fn(out);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
}
const read = (out, p) => fs.readFileSync(path.join(out, p), 'utf8');
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));

test('the hub and the router modules are in the gateway build', () => withBuild((out) => {
  for (const f of ['index.html', 'sw.js', '.tape/kernel/index.js', '.tape/wallet/index.html', '.tape/wallet/hub.js', '.tape/wallet/hub.css',
    '.tape/wallet/src/router.js', '.tape/wallet/src/popup-channel.js', '.tape/wallet/src/adapters/okx.js']) {
    assert.ok(fs.existsSync(path.join(out, f)), f);
  }
  assert.ok(!fs.existsSync(path.join(out, '.tape/wallet/test')), 'tests are not shipped');
}));

test('wallet modules import the kernel from /.tape/kernel/, not kernel/src/', () => withBuild((out) => {
  const wallet = walk(path.join(out, '.tape', 'wallet')).filter((f) => f.endsWith('.js'));
  for (const f of wallet) assert.ok(!read(out, path.relative(out, f)).includes('kernel/src/'), f);
  assert.match(read(out, '.tape/wallet/src/origin.js'), /from '\.\.\/\.\.\/kernel\/name\.js'/);
  assert.match(read(out, '.tape/wallet/src/chains.js'), /from '\.\.\/\.\.\/kernel\/config\.js'/);
}));

test('the dev server and the build serve the same hub bytes', () => withBuild((out) => {
  for (const f of walk(path.join(out, '.tape', 'wallet'))) {
    const urlPath = '/' + path.relative(out, f).split(path.sep).join('/');
    const src = hubSourceFile(urlPath);
    assert.ok(src, urlPath);
    assert.equal(String(gatewaySource(src, fs.readFileSync(src))), fs.readFileSync(f, 'utf8'), urlPath);
  }
}));

test('the self-check rejects relative imports that do not resolve', () => withBuild((out) => {
  fs.writeFileSync(path.join(out, '.tape/wallet/src/bad.js'), "import { x } from '../../kernel/src/name.js';\n");
  assert.throws(() => checkGateway(out), /bad\.js/);
}));

test('the self-check rejects absolute imports and hub assets that do not exist', () => {
  withBuild((out) => {
    fs.appendFileSync(path.join(out, '.tape/wallet/hub.js'), "\nimport '/.tape/wallet/src/missing.js';\n");
    assert.throws(() => checkGateway(out), /missing\.js/);
  });
  withBuild((out) => {
    fs.rmSync(path.join(out, '.tape/wallet/hub.css'));
    assert.throws(() => checkGateway(out), /hub\.css/);
  });
});

test('the self-check rejects imports that leave the gateway directory', () => withBuild((out) => {
  fs.writeFileSync(path.join(out, '.tape/wallet/src/escape.js'), "export * from '../../../../kernel/src/index.js';\n");
  assert.throws(() => checkGateway(out), /escape\.js/);
}));
