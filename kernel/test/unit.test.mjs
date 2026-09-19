// 离线单元测试：不连网。ethers 只作为「独立的第二份实现」拿来交叉核对编解码结果（仓库里网关已经带了 ethers）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  keccakHex, toChecksumAddress, SEL, SIG, TOPIC, EVENT_SIG, parseInput, formatName, formatUrl, normalizePath, resolvePath,
  scanHtml, scanCss, isExternal, collectReferences, createRpc, sha256Hex, safeContentType,
  createMemoryCache, createFsCache, setLocale, getLocale, t, tt, both, statusText, createKernel, InputError,
  formatShort, formatLabel, formatHostLabel, parseHostLabel, BSC_MAINNET, XLAYER_MAINNET, BASE_MAINNET, NETWORKS, networkByArea, rpcOptionsFor,
  createIdentity,
} from '../src/index.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encodeCall, decodeResult } from '../src/abi.js';

const require = createRequire(import.meta.url);
const { ethers } = require('ethers');   // 仓库根目录的开发依赖，只用来做第二份实现交叉核对

test('keccak256 标准向量', () => {
  assert.equal(keccakHex(''), '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
  assert.equal(keccakHex('abc'), '0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45');
  const long = 'x'.repeat(300);   // 跨过 136 字节的吸收边界
  assert.equal(keccakHex(long), ethers.id(long));
  assert.equal(keccakHex('4246.0.tape'), ethers.id('4246.0.tape'));
});

test('写死的函数选择器与事件主题与签名一致', () => {
  for (const k of Object.keys(SIG)) assert.equal(SEL[k], keccakHex(SIG[k]).slice(0, 10), k);
  for (const k of Object.keys(EVENT_SIG)) assert.equal(TOPIC[k], keccakHex(EVENT_SIG[k]), k);
});

test('EIP-55 校验和与 ethers 一致', () => {
  for (const a of ['0x86ddaef00401e3f10418398d67d7189fc458ea95', '0xd006ffdd5ae313b17729621a00999cd3c71ce5e6', '0x50a994e71615474b55559ff4f500928fbc339dd9']) {
    assert.equal(toChecksumAddress(a), ethers.getAddress(a));
  }
});

test('ABI 编码与 ethers 逐字节一致', () => {
  const iface = new ethers.Interface([
    'function fileInfo(address,string)', 'function readRange(address,string,uint256,uint256)', 'function isLive(string,address)',
    'function paidUntil(bytes32,address)', 'function cpuAt(uint256)',
  ]);
  const c = '0x86ddaef00401e3f10418398d67d7189fc458ea95';
  const cases = [
    ['fileInfo', ['address', 'string'], [c, 'assets/中文-文件.js']],
    ['readRange', ['address', 'string', 'uint256', 'uint256'], [c, 'a'.repeat(70), 98304n, 98304n]],
    ['isLive', ['string', 'address'], ['4246.0.tape', c]],
    ['paidUntil', ['bytes32', 'address'], [keccakHex('4246.0.tape'), c]],
    ['cpuAt', ['uint256'], [0n]],
  ];
  for (const [fn, types, values] of cases) assert.equal(encodeCall(SEL[fn], types, values), iface.encodeFunctionData(fn, values), fn);
});

test('ABI 解码与 ethers 一致，并拒绝越界数据', () => {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const sha = '0x' + 'ab'.repeat(32);
  const enc1 = coder.encode(['uint32', 'string', 'bytes32', 'uint40', 'uint256'], [755, 'text/html; charset=utf-8', sha, 1757000000, 1]);
  assert.deepEqual(decodeResult(['uint', 'string', 'bytes32', 'uint', 'uint'], enc1), [755n, 'text/html; charset=utf-8', sha, 1757000000n, 1n]);
  const enc2 = coder.encode(['string[]'], [['index.html', 'assets/app.js', '中文.css', '']]);
  assert.deepEqual(decodeResult(['string[]'], enc2), [['index.html', 'assets/app.js', '中文.css', '']]);
  const enc3 = coder.encode(['bytes'], ['0x' + '00ff'.repeat(100)]);
  assert.equal(ethers.hexlify(decodeResult(['bytes'], enc3)[0]), '0x' + '00ff'.repeat(100));
  const enc4 = coder.encode(['uint256', 'address', 'uint256'], [56, '0x50A994E71615474b55559fF4F500928fbc339DD9', 4246]);
  assert.deepEqual(decodeResult(['uint', 'address', 'uint'], enc4), [56n, '0x50a994e71615474b55559ff4f500928fbc339dd9', 4246n]);
  // 恶意数据：偏移量指到数据外面、长度撑爆、脏地址、非 0/1 的 bool
  assert.throws(() => decodeResult(['string'], '0x' + (0x1000).toString(16).padStart(64, '0')));
  assert.throws(() => decodeResult(['string'], '0x' + '20'.padStart(64, '0') + 'ff'.repeat(32)));
  assert.throws(() => decodeResult(['address'], '0x' + 'ff'.repeat(32)));
  assert.throws(() => decodeResult(['bool'], '0x' + '02'.padStart(64, '0')));
  assert.throws(() => decodeResult(['uint'], '0x1234'));
});

test('输入解析：各种写法规范化到同一个名字', () => {
  for (const s of ['4246.0.tape', '4246.0', 'tape://4246.0/', 'tape://4246.0.tape/', '#4246@0', '4246@0', ' 4246.0.TAPE ']) {
    const r = parseInput(s);
    assert.equal(r.kind, 'name', s); assert.equal(r.tokenId, 4246n); assert.equal(r.cpu, 0n);
  }
  assert.equal(parseInput('tape://4246.0/assets/a.js?x=1#h').path, 'assets/a.js');
  assert.equal(parseInput('4246.0.tape/docs/').path, 'docs/');
  const c = parseInput('0x86DDaEF00401E3F10418398D67D7189fc458eA95/app');
  assert.equal(c.kind, 'container'); assert.equal(c.container, '0x86ddaef00401e3f10418398d67d7189fc458ea95'); assert.equal(c.path, 'app');
  const k = parseInput('0x50A994E71615474b55559fF4F500928fbc339DD9#4246');
  assert.equal(k.kind, 'circuit'); assert.equal(k.tokenId, 4246n);
  for (const bad of ['', '0.0.tape', '04246.0', '4246.00', 'abc.tape', '4246', '0x123', 'tape.4246.0', '1e3.0', '4246.-1']) assert.throws(() => parseInput(bad), bad);
  assert.equal(formatName(4246n, 0n), '4246.0.tape');
  assert.equal(formatUrl(4246n, 0n, 'index.html'), 'tape://4246.0.tape/index.html');
});

test('路径规范化与落地规则', () => {
  assert.equal(normalizePath(''), 'index.html');
  assert.equal(normalizePath('/'), 'index.html');
  assert.equal(normalizePath('docs/'), 'docs/index.html');
  assert.equal(normalizePath('/a//b.js'), 'a/b.js');
  assert.equal(normalizePath('%E4%B8%AD.css'), '中.css');
  assert.equal(normalizePath('café.html'), 'café.html');   // NFD → NFC
  for (const bad of ['../x', 'a/../b', './a', '%zz']) assert.equal(normalizePath(bad), null, bad);
  assert.equal(normalizePath('my file.html'), 'my file.html');   // 空格合法
  assert.equal(normalizePath('a\u0000b'), null);   // 控制字符拒绝
  assert.equal(normalizePath('a\u007fb'), null);
  const set = new Set(['index.html', 'docs/index.html', 'app.js']);
  assert.equal(resolvePath('app.js', set, 'index.html'), 'app.js');
  assert.equal(resolvePath('docs', set, 'index.html'), 'docs/index.html');
  assert.equal(resolvePath('swap/0x12', set, 'index.html'), 'index.html');   // 单页应用路由
  assert.equal(resolvePath('missing.png', set, 'index.html'), null);          // 有扩展名的不走 fallback
  assert.equal(resolvePath('swap', set, ''), null);
});

test('content-type 清洗', () => {
  assert.equal(safeContentType('text/html; charset=utf-8'), 'text/html; charset=utf-8');
  const injected = safeContentType('text/html\r\nX-Evil: 1');
  assert.equal(injected, 'text/htmlX-Evil 1');   // 换行和冒号被剥掉，头注入不成立
  assert.ok(!/[\r\n:]/.test(injected));
  assert.equal(safeContentType('<script>'), 'application/octet-stream');
  assert.equal(safeContentType(''), 'application/octet-stream');
});

test('纯链上静态检测', () => {
  assert.equal(isExternal('https://cdn.example/x.js'), true);
  assert.equal(isExternal('//cdn.example/x.js'), true);
  for (const u of ['/a.js', 'a.js', 'data:image/png;base64,xx', 'blob:x', '#top', 'mailto:a@b.c']) assert.equal(isExternal(u), false, u);
  const html = `<script src="https://cdn.x/a.js"></script><link href='/s.css'><img srcset="a.png 1x, https://i.x/b.png 2x">
    <div style="background:url(https://i.x/bg.png)"></div><meta http-equiv="refresh" content="0;url=https://evil.x">`;
  const ext = scanHtml(html).map((e) => e.url);
  assert.deepEqual(ext.sort(), ['https://cdn.x/a.js', 'https://evil.x', 'https://i.x/b.png', 'https://i.x/bg.png'].sort());
  assert.deepEqual(scanCss('@import "https://f.x/a.css"; .a{background:url("/local.png")}').map((e) => e.url), ['https://f.x/a.css']);
  assert.deepEqual(scanHtml('<script src="/app.js"></script><a href="#x">x</a>'), []);
});

test('SHA-256', async () => {
  assert.equal(await sha256Hex(new Uint8Array()), '0xe3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

// ---- 多节点法定人数：用假的 fetch 模拟节点
function fakeFetch(behaviour) {
  return async (url, init) => {
    const reqs = JSON.parse(init.body);
    const b = behaviour[url];
    if (b === 'down') throw new Error('connect refused');
    return { ok: true, json: async () => reqs.map((q) => ({ jsonrpc: '2.0', id: q.id, ...b(q) })) };
  };
}
const call = [{ to: '0x' + '11'.repeat(20), data: '0x12345678' }];

test('法定人数：两个节点一致才采用', async () => {
  const ok = () => ({ result: '0xaa' });
  const rpc = createRpc({ urls: ['a', 'b', 'c'], quorum: 2, shuffle: false, fetchImpl: fakeFetch({ a: ok, b: ok, c: ok }) });
  assert.deepEqual(await rpc.calls(call, '0x1'), [{ ok: true, value: '0xaa' }]);
});

test('法定人数：节点结果不一致直接拒绝（不取多数）', async () => {
  const rpc = createRpc({ urls: ['a', 'b', 'c'], quorum: 2, shuffle: false, fetchImpl: fakeFetch({ a: () => ({ result: '0xaa' }), b: () => ({ result: '0xbb' }), c: () => ({ result: '0xaa' }) }) });
  await assert.rejects(rpc.calls(call, '0x1'), /不一致/);
});

test('法定人数：一个节点宕机时自动问下一个', async () => {
  const ok = () => ({ result: '0xaa' });
  const rpc = createRpc({ urls: ['a', 'b', 'c'], quorum: 2, shuffle: false, fetchImpl: fakeFetch({ a: 'down', b: ok, c: ok }) });
  assert.deepEqual(await rpc.calls(call, '0x1'), [{ ok: true, value: '0xaa' }]);
});

test('法定人数：只剩一个节点可用时报错', async () => {
  const rpc = createRpc({ urls: ['a', 'b'], quorum: 2, shuffle: false, fetchImpl: fakeFetch({ a: 'down', b: () => ({ result: '0xaa' }) }) });
  await assert.rejects(rpc.calls(call, '0x1'), /节点不足/);
});

test('双语：状态与错误两种语言都有，切换生效', async () => {
  setLocale('en');
  assert.equal(getLocale(), 'en');
  assert.equal(statusText('unpaid'), 'This on-chain name is not activated (unpaid); official clients do not display it');
  assert.equal(t('rpc.short', { quorum: 2 }), 'Not enough nodes: 2 nodes must agree');
  let err; try { parseInput('04246.0'); } catch (e) { err = e; }
  assert.ok(err instanceof InputError);
  assert.equal(err.code, 'input');
  assert.match(err.message, /leading zeros/);
  assert.match(err.messages.zh, /前导 0/);
  setLocale('zh-CN');
  assert.equal(getLocale(), 'zh');
  assert.equal(statusText('ok'), '已开通');
  assert.deepEqual(statusText('ok', 'both'), { zh: '已开通', en: 'Live' });
  assert.equal(both('status.ok'), '已开通 / Live');
  assert.deepEqual(tt('site.too-large', { mb: '40.0', max: '32' }), { zh: '站点太大（40.0 MB，上限 32 MB）', en: 'Site too large (40.0 MB, limit 32 MB)' });
  const { messages } = await import('../src/i18n.js');
  for (const k of Object.keys(messages)) assert.ok(messages[k].zh && messages[k].en, k);
});

test('站内引用收集', () => {
  const html = `<link href="css/a.css"><script src="/js/app.js"></script><img srcset="i/x.png 1x, https://cdn.x/y.png 2x"><a href="#top">t</a><div style="background:url(../bg.png)"></div><script src="https://cdn.x/lib.js"></script>`;
  assert.deepEqual(collectReferences(html, 'html', 'sub/').sort(), ['bg.png', 'sub/i/x.png', 'js/app.js', 'sub/css/a.css'].sort());
  assert.deepEqual(collectReferences('@import "base.css"; a{background:url("/img/b.svg")}', 'css', 'css/').sort(), ['css/base.css', 'img/b.svg']);
});

test('持久缓存：内存与文件目录，LRU 淘汰', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-cache-'));
  for (const c of [createMemoryCache({ maxBytes: 2500 }), await createFsCache(dir, { maxBytes: 2500 })]) {
    await c.set('a', { n: 1 }, new Uint8Array(1000));
    await c.set('b', { n: 2 }, new Uint8Array(1000));
    const a = await c.get('a'); assert.equal(a.bytes.length, 1000); assert.deepEqual(a.meta, { n: 1 });
    await c.set('c', { n: 3 }, new Uint8Array(1000));   // 超限：淘汰最久没用的 b（a 刚被读过）
    assert.equal(await c.get('b'), undefined);
    assert.ok(await c.get('a')); assert.ok(await c.get('c'));
    await c.delete('a'); assert.equal(await c.get('a'), undefined);
    await c.set('big', {}, new Uint8Array(1500)); assert.equal(await c.get('big'), undefined);   // 单项超过一半上限不缓存
    await c.clear(); assert.equal(await c.get('c'), undefined);
  }
  const reopened = await createFsCache(dir); await reopened.set('k', { v: 1 }, new Uint8Array([1, 2, 3]));
  const again = await createFsCache(dir); assert.deepEqual([...(await again.get('k')).bytes], [1, 2, 3]);   // 重开目录还在
  fs.rmSync(dir, { recursive: true, force: true });
});

test('内核：解析结果与处理器编号表走缓存（第二次不再问节点）', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const reqs = JSON.parse(init.body); calls.push(...reqs.map((q) => q.method + ':' + (q.params[0]?.data || '').slice(0, 10)));
    const now = '0x' + Math.floor(Date.now() / 1000).toString(16);
    return { ok: true, json: async () => reqs.map((q) => ({ jsonrpc: '2.0', id: q.id, result: q.method === 'eth_blockNumber' ? '0x100' : q.method === 'eth_getBlockByNumber' ? { number: '0x100', timestamp: now } : '0x' + ('00'.repeat(31) + '01').repeat(3) })) };
  };
  // 假链：所有 eth_call 返回三个 1 → token() 报 chainId=1 ≠ 56 → not-tapeout（足够验证解析结果走缓存）
  const k = createKernel({ networks: [BSC_MAINNET], rpcUrls: ['a', 'b'], quorum: 2, fetchImpl, skipImplCheck: true, cache: createMemoryCache() });
  const r1 = await k.resolve('0x0000000000000000000000000000000000000001');
  const n1 = calls.length; assert.ok(n1 > 0);
  const r2 = await k.resolve('0x0000000000000000000000000000000000000001');
  assert.equal(calls.length, n1, '第二次解析应命中缓存');
  assert.deepEqual(r2.status, r1.status);
  assert.equal(typeof r2.block, 'string');
});

test('法定人数：一致的 revert 也是结果', async () => {
  const rv = () => ({ error: { code: 3, message: 'execution reverted', data: '0x08c379a0' } });
  const rpc = createRpc({ urls: ['a', 'b'], quorum: 2, shuffle: false, fetchImpl: fakeFetch({ a: rv, b: rv }) });
  assert.deepEqual(await rpc.calls(call, '0x1'), [{ revert: true, data: '0x08c379a0' }]);
});

test('钉块：取第 quorum 高的头部再退 2 块', async () => {
  const head = (n) => () => ({ result: '0x' + n.toString(16) });
  const rpc = createRpc({ urls: ['a', 'b', 'c'], quorum: 2, fetchImpl: fakeFetch({ a: head(100), b: head(105), c: head(99) }) });
  assert.equal(await rpc.pinBlock(), '0x' + (98).toString(16));
});

test('rpc：429 会退避重试，被限流的节点排到后面，stats() 有记录', async () => {
  let hits = { a: 0, b: 0 };
  const fetchImpl = async (url, init) => {
    hits[url]++;
    if (url === 'a' && hits.a === 1) return new Response('slow down', { status: 429 });
    const body = JSON.parse(init.body);
    return new Response(JSON.stringify(body.map((q) => ({ jsonrpc: '2.0', id: q.id, result: '0xaa' }))), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const rpc = createRpc({ urls: ['a', 'b'], quorum: 2, shuffle: false, fetchImpl, backoffMs: 5, retries: 2 });
  const [r] = await rpc.many([{ method: 'eth_call', params: [{ to: '0x' + '1'.repeat(40), data: '0x' }, 'latest'] }]);
  assert.equal(r.value, '0xaa');
  assert.equal(hits.a, 2, 'a 被限流一次后重试成功');
  const st = rpc.stats();
  assert.equal(st.a.rateLimited, 1); assert.equal(st.a.ok, 1); assert.equal(st.a.fail, 1); assert.ok(st.a.cooldownUntil > Date.now());
  assert.equal(st.b.ok, 1);
});

test('rpc：对象型结果（区块/回执）按规范化 JSON 跨节点比较，raw 保留原对象', async () => {
  const blk = (extra) => ({ number: '0x10', hash: '0xABC', ...extra });
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    const result = url === 'a' ? blk({ miner: '0xM1' }) : { miner: '0xm1', hash: '0xabc', number: '0x10' };   // 键序、大小写不同，但内容一致
    return new Response(JSON.stringify(body.map((q) => ({ jsonrpc: '2.0', id: q.id, result }))), { status: 200 });
  };
  const rpc = createRpc({ urls: ['a', 'b'], quorum: 2, shuffle: false, fetchImpl });
  const [r] = await rpc.many([{ method: 'eth_getBlockByNumber', params: ['0x10', false] }]);
  assert.equal(r.ok, true); assert.equal(r.raw.number, '0x10');
});

// ---------------------------------------------------------------- 多链（2026-09-19）

test('多链名字：区号写法、规范化与拒绝', () => {
  const n = (s) => { const r = parseInput(s); return [r.kind, String(r.tokenId), r.area, String(r.cpu), r.path]; };
  assert.deepEqual(n('4246.0'), ['name', '4246', null, '0', '']);
  assert.deepEqual(n('#4246@0'), ['name', '4246', null, '0', '']);
  for (const s of ['1.2.344', '#1@2.344', '1@2.344', '1.2.344.tape', 'tape://1.2.344.tape/', 'tape://1.2.344/', ' 1.2.344.TAPE ']) assert.deepEqual(n(s), ['name', '1', 2, '344', ''], s);
  assert.deepEqual(n('1.3.0/docs/a.html?x#y'), ['name', '1', 3, '0', 'docs/a.html']);
  assert.deepEqual(n('#7@3.12/x'), ['name', '7', 3, '12', 'x']);
  // 0、1 保留，未分配的区号、前导 0 都拒绝；拒绝时报的是区号
  for (const bad of ['1.0.5', '1.1.5', '1.4.5', '1.02.5', '#1@1.5', '#1@9.5', '1.2.3.4', '0.2.5', '1.2.05']) assert.throws(() => parseInput(bad), InputError, bad);
  let e; try { parseInput('1.4.5'); } catch (x) { e = x; }
  assert.match(e.messages.zh, /区号/);
  assert.equal(formatShort(4246n, 0n), '4246.0');
  assert.equal(formatShort(1n, 344n, 2), '1.2.344');
  assert.equal(formatName(1n, 344n, 'tape', 2), '1.2.344.tape');
  assert.equal(formatUrl(1n, 5n, 'a.html', 'tape', 3), 'tape://1.3.5.tape/a.html');
  assert.equal(formatLabel(1n, 344n, 2), '#1@2.344');
  assert.equal(formatLabel(4246n, 0n), '#4246@0');
  assert.equal(formatHostLabel(4246n, 0n), '4246-0');
  assert.equal(formatHostLabel(1n, 344n, 2), '1-2-344');
  const h = parseHostLabel('1-2-344');
  assert.deepEqual([String(h.tokenId), h.area, String(h.cpu)], ['1', 2, '344']);
  assert.equal(parseHostLabel('4246-0').area, null);
  for (const bad of ['1-1-3', '1-4-3', '4246-00', '0-0', 'a-0', '1-2-3-4', '']) assert.equal(parseHostLabel(bad), null, bad);
});

test('多链配置：区号、链号、节点上限与运营方', () => {
  assert.deepEqual(NETWORKS.map((n) => [n.key, n.chainId, n.area]), [['bnb', 56, null], ['xlayer', 196, 2], ['base', 8453, 3]]);
  assert.equal(networkByArea(null), BSC_MAINNET);
  assert.equal(networkByArea(2), XLAYER_MAINNET);
  assert.equal(networkByArea(3), BASE_MAINNET);
  assert.equal(networkByArea(1), null);
  assert.equal(BSC_MAINNET.pin, 'latest');
  for (const n of [XLAYER_MAINNET, BASE_MAINNET]) {
    assert.equal(n.pin, 'latest'); assert.equal(n.finality, 'safe');
    for (const [proxy, impls] of Object.entries(n.expectedImpl)) { assert.match(proxy, /^0x[0-9a-f]{40}$/); for (const i of impls) assert.match(i, /^0x[0-9a-f]{40}$/); }
    for (const u of n.rpcs) assert.ok(n.rpcLimits[u], '每个默认节点都登记了上限与运营方：' + u);
  }
  const o = rpcOptionsFor(XLAYER_MAINNET);
  assert.equal(o.operators['https://rpc.xlayer.tech'], o.operators['https://xlayerrpc.okx.com'], 'OKX 两个域名同一运营方');
  assert.equal(o.maxBatchByUrl['https://xlayer.drpc.org'], 3);
  assert.equal(o.pin, 'latest');
  const custom = rpcOptionsFor(XLAYER_MAINNET, ['https://my.node']);
  assert.deepEqual(custom.urls, ['https://my.node']);
  assert.deepEqual(custom.maxBatchByUrl, {});
});

test('rpc：按节点的单包上限分包；节点拒绝批量时自动缩小，缩到 1 就逐个发', async () => {
  const sizes = { a: [], b: [] };
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    if (!Array.isArray(body)) { sizes[url].push(1); return { ok: true, json: async () => ({ jsonrpc: '2.0', id: body.id, result: '0xaa' }) }; }
    sizes[url].push(body.length);
    if (url === 'b' && body.length > 1) return { ok: true, json: async () => body.map((q) => ({ jsonrpc: '2.0', id: q.id, error: { code: -32600, message: 'Batch of more than 1 requests are not allowed' } })) };
    return { ok: true, json: async () => body.map((q) => ({ jsonrpc: '2.0', id: q.id, result: '0xaa' })) };
  };
  const rpc = createRpc({ urls: ['a', 'b'], quorum: 2, shuffle: false, fetchImpl, maxBatchByUrl: { a: 3 } });
  const reqs = Array.from({ length: 7 }, () => ({ method: 'eth_call', params: [{ to: '0x' + '1'.repeat(40), data: '0x' }, 'latest'] }));
  const out = await rpc.many(reqs, { all: true });
  assert.equal(out.length, 7); assert.ok(out.every((x) => x.value === '0xaa'));
  assert.deepEqual(sizes.a, [3, 3, 1]);
  assert.ok(sizes.b.includes(1) && sizes.b.filter((n) => n === 1).length >= 7, 'b 最终逐个发：' + sizes.b);
  assert.equal(rpc.batchLimits().b, 1);
  // 整包一个错误对象（"maximum 10 requests"）也当作拒绝批量
  const c = { n: [] };
  const rpc2 = createRpc({ urls: ['c'], quorum: 1, strictQuorum: 1, fetchImpl: async (url, init) => {
    const body = JSON.parse(init.body);
    if (Array.isArray(body)) { c.n.push(body.length); return { ok: true, json: async () => (body.length > 4 ? { jsonrpc: '2.0', error: { code: -32014, message: 'maximum 4 requests' } } : body.map((q) => ({ jsonrpc: '2.0', id: q.id, result: '0x01' }))) }; }
    c.n.push(1); return { ok: true, json: async () => ({ jsonrpc: '2.0', id: body.id, result: '0x01' }) };
  } });
  const out2 = await rpc2.many(Array.from({ length: 9 }, () => reqs[0]));
  assert.ok(out2.every((x) => x.value === '0x01'));
  assert.equal(c.n[0], 9); assert.ok(rpc2.batchLimits().c <= 4);
});

test('钉块：pin=safe 读各节点的安全区块，取第 quorum 高的，不再往回退', async () => {
  const seen = [];
  const safe = (n) => (q) => { seen.push(q.method + ':' + (q.params[0] ?? '')); return { result: { number: '0x' + n.toString(16), hash: '0x' + '1'.repeat(64) } }; };
  const rpc = createRpc({ urls: ['a', 'b', 'c'], quorum: 2, pin: 'safe', fetchImpl: fakeFetch({ a: safe(100), b: safe(105), c: safe(99) }) });
  assert.equal(await rpc.pinBlock(), '0x' + (100).toString(16));
  assert.ok(seen.every((x) => x === 'eth_getBlockByNumber:safe'), seen.join());
});

test('身份：带区号的名字不能拿到别的链上解析', async () => {
  const id = createIdentity({ rpc: { many: async () => { throw new Error('不应读链'); } } });
  await assert.rejects(id.resolveIdentity(parseInput('1.2.344'), '0x1'), (e) => e instanceof InputError && /X Layer|BNB/.test(e.messages.zh + e.messages.en));
  const idX = createIdentity({ rpc: { many: async () => { throw new Error('不应读链'); } }, network: XLAYER_MAINNET });
  await assert.rejects(idX.resolveIdentity(parseInput('4246.0'), '0x1'), InputError);
});

test('多链内核：按区号选链，只问那条链的节点；容器地址在所有链上查', async () => {
  const hit = new Set();
  const fetchImpl = async (url, init) => {
    hit.add(url);
    const body = JSON.parse(init.body);
    const one = (q) => ({ jsonrpc: '2.0', id: q.id, result: q.method === 'eth_blockNumber' ? '0x100' : q.method === 'eth_getBlockByNumber' ? { number: '0x100', timestamp: '0x' + Math.floor(Date.now() / 1000).toString(16) } : '0x' + ('00'.repeat(31) + '01').repeat(3) });
    return { ok: true, json: async () => (Array.isArray(body) ? body.map(one) : one(body)) };
  };
  const k = createKernel({ fetchImpl, skipImplCheck: true, cache: createMemoryCache() });
  const hosts = (net) => net.rpcs.filter((u) => hit.has(u)).length;
  // 假链上 cpuCount = 1，处理器 344 不存在 → no-such-cpu；关键是只问了 X Layer 的节点
  const r = await k.resolve('1.2.344');
  assert.equal(r.status, 'no-such-cpu');
  assert.ok(hosts(XLAYER_MAINNET) > 0); assert.equal(hosts(BSC_MAINNET), 0); assert.equal(hosts(BASE_MAINNET), 0);
  hit.clear();
  const b = await k.resolve('4246.5');
  assert.equal(b.chainId, 56); assert.equal(b.status, 'no-such-cpu');
  assert.ok(hosts(BSC_MAINNET) > 0); assert.equal(hosts(XLAYER_MAINNET), 0); assert.equal(hosts(BASE_MAINNET), 0);
  hit.clear();
  const c = await k.resolve('0x0000000000000000000000000000000000000001');
  assert.equal(c.status, 'not-tapeout'); assert.equal(c.chainId, 56, '所有链都不是时返回 BNB 的结果');
  assert.ok(hosts(BSC_MAINNET) > 0 && hosts(XLAYER_MAINNET) > 0 && hosts(BASE_MAINNET) > 0);
  assert.equal(k.kernelFor(196).config.area, 2);
  assert.ok(k.rpc.urls.length >= 13);
  await assert.rejects(k.resolve('1.9.5'), InputError);
});

test('多链内核：处理器合约#ID 在两条链上都成立时报歧义；store-changed 不遮住别的链上的真结果', async () => {
  const { createKernel: ck } = await import('../src/kernel.js');
  const mk = (behave) => {
    const k = ck({ fetchImpl: async () => { throw new Error('不应联网'); }, skipImplCheck: true, cache: createMemoryCache() });
    for (const [id, fn] of Object.entries(behave)) k.kernelFor(Number(id)).resolve = fn;
    return k;
  };
  const ok = (chainId) => async () => ({ status: 'ok', chainId });
  const nt = (chainId) => async () => ({ status: 'not-tapeout', chainId });
  const sc = (chainId) => async () => ({ status: 'store-changed', chainId });
  const input = '0x839bdd6fa7a66416a609a735e11de5411b98574e#1';
  await assert.rejects(mk({ 56: nt(56), 196: ok(196), 8453: ok(8453) }).resolve(input), (e) => e instanceof InputError && /X Layer/.test(e.messages.zh) && /Base/.test(e.messages.zh));
  assert.equal((await mk({ 56: nt(56), 196: nt(196), 8453: ok(8453) }).resolve(input)).chainId, 8453);
  // BNB 实现变了（store-changed），真容器在 Base：返回 Base 的结果
  assert.equal((await mk({ 56: sc(56), 196: nt(196), 8453: ok(8453) }).resolve('0x' + '12'.repeat(20))).chainId, 8453);
  // 哪条链都没找到、有链 store-changed：报那条（拒绝显示）
  assert.equal((await mk({ 56: nt(56), 196: sc(196), 8453: nt(8453) }).resolve('0x' + '12'.repeat(20))).status, 'store-changed');
  // 处理器#ID：一条 L2 读失败时不猜
  await assert.rejects(mk({ 56: nt(56), 196: async () => { throw new Error('节点挂了'); }, 8453: ok(8453) }).resolve(input), /节点挂了/);
  // 不带链信息的写法不能指定区块
  await assert.rejects(mk({}).resolve('0x' + '12'.repeat(20), { block: '0x1' }), InputError);
});

test('钉块按运营方计票：同一运营方的多个节点只算一票，取它们的最低高度', async () => {
  const head = (n) => () => ({ result: '0x' + n.toString(16) });
  // X Layer 的情形：OKX 两个域名报 1000，dRPC 900、thirdweb（按 OKX 计）901 → 两家运营方：okx=min(1000,1000,901)=901、drpc=900 → 第 2 高 = 900 → 钉 898
  const rpc = createRpc({ urls: ['a', 'b', 'c', 'd'], quorum: 2, operators: { a: 'okx', b: 'okx', c: 'drpc', d: 'okx' }, fetchImpl: fakeFetch({ a: head(1000), b: head(1000), c: head(900), d: head(901) }) });
  assert.equal(await rpc.pinBlock(), '0x' + (898).toString(16));
  // 只有一家运营方回答：不够两家，拒绝
  const rpc2 = createRpc({ urls: ['a', 'b', 'c'], quorum: 2, operators: { a: 'okx', b: 'okx', c: 'drpc' }, fetchImpl: fakeFetch({ a: head(10), b: head(10), c: 'down' }), headGraceMs: 10 });
  await assert.rejects(rpc2.pinBlock());
});

test('节点表：BNB 四家独立运营方（thirdweb 按 dRPC 计）；X Layer 如实两家；网站能直接访问的节点不含路径读密钥的', async () => {
  const { siteNodes } = await import('../src/config.js');
  const ops = (n) => new Set(Object.values(rpcOptionsFor(n).operators)).size;
  assert.equal(ops(BSC_MAINNET), 4, 'thirdweb 保守按 dRPC 计');
  assert.equal(ops(XLAYER_MAINNET), 2);
  for (const n of NETWORKS) {
    for (const u of n.rpcs) assert.ok(n.rpcLimits[u] && n.rpcLimits[u].operator, '每个默认节点都登记了运营方：' + u);
    assert.ok(siteNodes(n).every((u) => !/thirdweb|tenderly|drpc|blastapi/.test(u)));
  }
});

test('拒绝批量的判断：回滚、限流不算拒绝；上限只降不升', async () => {
  const sizes = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    if (Array.isArray(body)) { sizes.push(body.length); return { ok: true, json: async () => body.map((q) => ({ jsonrpc: '2.0', id: q.id, error: { code: 3, message: 'execution reverted: batch too large' } })) }; }
    return { ok: true, json: async () => ({ jsonrpc: '2.0', id: body.id, error: { code: 3, message: 'execution reverted' } }) };
  };
  const rpc = createRpc({ urls: ['a'], quorum: 1, strictQuorum: 1, fetchImpl });
  const out = await rpc.many(Array.from({ length: 8 }, () => ({ method: 'eth_call', params: [{ to: '0x' + '1'.repeat(40), data: '0x' }, 'latest'] })));
  assert.ok(out.every((x) => x.revert));
  assert.equal(rpc.batchLimits().a, 20, '回滚文字里含 batch 也不降上限');
});

test('查看器的节点名单和配置一致；网站框架放行链外数据、不放链外脚本', async () => {
  const { siteNodes } = await import('../src/config.js');
  const fsx = (await import('node:fs')).default;
  const list = (f) => new Set((fsx.readFileSync(new URL(f, import.meta.url), 'utf8').match(/connect-src ([^;"]*)/)[1]).split(/\s+/).filter((x) => x.startsWith('https://')));
  const all = new Set(NETWORKS.flatMap((n) => n.rpcs));
  const site = new Set(NETWORKS.flatMap((n) => siteNodes(n)));
  assert.deepEqual([...list('../../viewer/index.html')].sort(), [...all].sort());
  // 链上网站所在的沙盒框架：链外数据（含节点）都可以访问，脚本只能来自链上
  const csp = (f) => fsx.readFileSync(new URL(f, import.meta.url), 'utf8').match(/default-src 'none'; script-src[^"]*/)[0];
  for (const f of ['../../viewer/frame.html', '../../extension/manifest.json']) {
    assert.match(csp(f), /connect-src blob: data: https: wss:/);
    assert.match(csp(f), /script-src 'unsafe-inline' 'unsafe-eval' blob:;/);
  }
});

test('钉住的块比各运营方报的最高块落后太多就拒绝读取（不看本机时钟）', async () => {
  const head = (n) => () => ({ result: '0x' + n.toString(16) });
  // 一家（b）报很旧的高度：两家都要一致，钉块被压到 1000，比最高 5000 落后 4000 块 > 400
  const fetchImpl = async (url, init) => {
    const reqs = JSON.parse(init.body);
    return { ok: true, json: async () => reqs.map((q) => ({ jsonrpc: '2.0', id: q.id, result: q.method === 'eth_blockNumber' ? (url === 'a' ? '0x1388' : '0x3e8') : '0x' })) };
  };
  const k = createKernel({ networks: [BSC_MAINNET], rpcUrls: ['a', 'b'], quorum: 2, fetchImpl, skipImplCheck: true, cache: createMemoryCache(), });
  await assert.rejects(k.resolve('4246.5'), (e) => e.code === 'rpc' && /落后|behind/.test(e.message));
  void head;
});

test('web+tape:// 前缀也接受', () => {
  const p = parseInput('web+tape://1.2.344.tape/a');
  assert.deepEqual([String(p.tokenId), p.area, String(p.cpu), p.path], ['1', 2, '344', 'a']);
});

test('按块号查区块头回 null（节点没同步到）当作没答上，不算分歧', async () => {
  const blk = { number: '0x10', hash: '0x' + 'ab'.repeat(32), parentHash: '0x' + 'cd'.repeat(32), timestamp: '0x1' };
  const rpc = createRpc({ urls: ['a', 'b', 'c'], quorum: 2, strictQuorum: 2, operators: { a: 'x', b: 'y', c: 'z' }, fetchImpl: fakeFetch({ a: () => ({ result: blk }), b: () => ({ result: blk }), c: () => ({ result: null }) }) });
  const [r] = await rpc.many([{ method: 'eth_getBlockByNumber', params: ['0x10', false] }], { all: true });
  assert.ok(r.ok);
});

test('多链内核：处理器#ID 只在同一工厂的链之间判断歧义；L2 读失败不连累 BNB；容器地址找到就返回', async () => {
  const { createKernel: ck } = await import('../src/kernel.js');
  const mk = (behave) => {
    const k = ck({ fetchImpl: async () => { throw new Error('不应联网'); }, skipImplCheck: true, cache: createMemoryCache() });
    for (const [id, fn] of Object.entries(behave)) k.kernelFor(Number(id)).resolve = fn;
    return k;
  };
  const ok = (chainId) => async () => ({ status: 'ok', chainId });
  const nt = (chainId) => async () => ({ status: 'not-tapeout', chainId });
  const boom = async () => { throw new Error('节点挂了'); };
  const input = '0x839bdd6fa7a66416a609a735e11de5411b98574e#1';
  assert.equal((await mk({ 56: ok(56), 196: boom, 8453: nt(8453) }).resolve(input)).chainId, 56, 'BNB 的处理器：X Layer 读失败不影响');
  await assert.rejects(mk({ 56: nt(56), 196: boom, 8453: ok(8453) }).resolve(input), /节点挂了/);
  await assert.rejects(mk({ 56: nt(56), 196: async () => ({ status: 'store-changed', chainId: 196 }), 8453: ok(8453) }).resolve(input).then((r) => { if (r.status === 'store-changed') throw new Error('store-changed'); return r; }), /store-changed/);
  // 容器地址：BNB 先找到就返回，不等 X Layer（它要 5 秒）
  const t0 = Date.now();
  const r = await mk({ 56: ok(56), 196: () => new Promise((res) => setTimeout(() => res({ status: 'not-tapeout', chainId: 196 }), 5000)), 8453: nt(8453) }).resolve('0x' + '12'.repeat(20));
  assert.equal(r.chainId, 56); assert.ok(Date.now() - t0 < 1000);
});
