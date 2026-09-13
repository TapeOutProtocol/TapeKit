// 主网只读实测：连公共节点做 eth_call，不发交易、不需要任何密钥。
// 样例站点：test.hashport.ai 绑定的容器 = 0 号处理器（Genesis CPU）的 #4246，只有一个 index.html（756 字节）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createKernel } from '../src/index.js';

const CONTAINER = '0x86ddaef00401e3f10418398d67d7189fc458ea95';
const INDEX_SHA = '0xec444c899bd9229f9173082fff362da66dd297179482a58b30b6f53ce9f7a0b6';
const k = createKernel();

test('名字 4246.0.tape → 容器、处理器、持有人；付费状态如实返回', async () => {
  const r = await k.resolve('4246.0.tape');
  assert.equal(r.container, CONTAINER);
  assert.equal(r.cpu, 0n);
  assert.equal(r.cpuName, 'Genesis CPU');
  assert.equal(r.tokenId, 4246n);
  assert.equal(r.name, '4246.0.tape');
  assert.equal(r.opened, true);
  assert.ok(r.stores.ok, '仓库与付费合约实现应在钉住名单内');
  assert.ok(['ok', 'unpaid'].includes(r.status));
  assert.equal(r.status === 'ok', r.paid);
  console.log('  status', r.status, 'holder', r.holder, 'block', BigInt(r.block).toString());
});

test('容器地址反查出同一个名字', async () => {
  const r = await k.resolve('0x86DDaEF00401E3F10418398D67D7189fc458eA95');
  assert.equal(r.name, '4246.0.tape');
  assert.equal(r.container, CONTAINER);
});

test('清单与文件读取，SHA-256 与链上一致', async () => {
  const r = await k.resolve('#4246@0');
  const man = await k.manifest(r);
  assert.deepEqual(man.paths, ['index.html']);
  assert.equal(man.fallback, 'index.html');
  const f = await k.getFile(r, man, '');
  assert.equal(f.path, 'index.html');
  assert.equal(f.size, 756);
  assert.equal(f.sha256, INDEX_SHA);
  assert.equal(f.verified, true);
  assert.match(new TextDecoder().decode(f.bytes), /<html/i);
  const spa = await k.getFile(r, man, 'some/route');   // 单页路由退回 index.html
  assert.equal(spa.path, 'index.html');
  assert.equal(await k.getFile(r, man, 'missing.png'), null);
  const site = await k.loadSite(r);
  assert.equal(site.files.size, 1);
  assert.deepEqual(site.problems, []);
});

test('不存在的处理器、不存在的 #ID、非 TapeOut 地址', async () => {
  assert.equal((await k.resolve('1.999999')).status, 'no-such-cpu');
  assert.equal((await k.resolve('999999999.0')).status, 'no-such-token');
  assert.equal((await k.resolve('0x000000000000000000000000000000000000dEaD')).status, 'not-tapeout');
  // 一个真实合约但不是容器：网站仓库本身
  assert.equal((await k.resolve('0xd006ffdd5ae313b17729621a00999cd3c71ce5e6')).status, 'not-tapeout');
});

test('实现被换掉时拒绝读取（模拟：钉住名单里放一个错误地址）', async () => {
  const k2 = createKernel({ network: { expectedImpl: { '0xd006ffdd5ae313b17729621a00999cd3c71ce5e6': ['0x0000000000000000000000000000000000000001'] } } });
  assert.equal((await k2.resolve('4246.0.tape')).status, 'store-changed');
});

test('屏蔽名单生效', async () => {
  const k3 = createKernel({ isBlocked: ({ name }) => name === '4246.0.tape' });
  assert.equal((await k3.resolve('4246.0.tape')).status, 'blocked');
});

test('按需读取 openSite：只取清单，用到才读；第二个内核用同一缓存不再读链', async () => {
  const { createMemoryCache } = await import('../src/index.js');
  const cache = createMemoryCache();
  const k1 = createKernel({ cache });
  const r = await k1.resolve('4246.0.tape');
  const site = await k1.openSite(r);
  assert.deepEqual(site.manifest.paths, ['index.html']);
  assert.equal(site.files.size, 0);
  const f = await site.get('');
  assert.equal(f.path, 'index.html'); assert.equal(f.verified, true); assert.equal(f.fromCache, false);
  assert.equal((await site.get('index.html')), f);   // 同一句柄第二次直接返回
  const k2 = createKernel({ cache });
  const r2 = await k2.resolve('4246.0.tape');   // 解析结果命中缓存
  const site2 = await k2.openSite(r2);
  const f2 = await site2.get('index.html');
  assert.equal(f2.fromCache, true); assert.equal(f2.sha256, INDEX_SHA);
});

test('双语状态', async () => {
  const k = createKernel({ locale: 'en' });
  const r = await k.resolve('999999999.0');
  assert.equal(r.status, 'no-such-token');
  assert.equal(k.statusText(r.status), 'This processor has no such circuit (#ID does not exist)');
  k.setLocale('zh');
  assert.equal(k.statusText(r.status), '这个处理器下没有这枚电路（#ID 不存在）');
});

test('watch：轮询链上哈希，没有更新就不回调，不报错', async () => {
  const r = await k.resolve('4246.0.tape');
  const site = await k.openSite(r);
  await site.get('');
  let changes = 0, errors = 0;
  const stop = k.watch(site, () => { changes++; }, { intervalMs: 1500, firstDelayMs: 0, onError: (e) => { errors++; console.log('  watch error', e.message); } });
  await new Promise((res) => setTimeout(res, 6000));
  stop();
  console.log('  watch: changes', changes, 'errors', errors);
  assert.equal(errors, 0); assert.equal(changes, 0);
});
