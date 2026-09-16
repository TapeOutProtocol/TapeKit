// 离线单元测试：不连网。ethers 只作为「独立的第二份实现」拿来交叉核对编解码结果（仓库里网关已经带了 ethers）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  keccakHex, toChecksumAddress, SEL, SIG, TOPIC, EVENT_SIG, parseInput, formatName, formatUrl, normalizePath, resolvePath,
  scanHtml, scanCss, isExternal, collectReferences, createRpc, sha256Hex, safeContentType,
  createMemoryCache, createFsCache, setLocale, getLocale, t, tt, both, statusText, createKernel, InputError,
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
    return { ok: true, json: async () => reqs.map((q) => ({ jsonrpc: '2.0', id: q.id, result: q.method === 'eth_blockNumber' ? '0x100' : '0x' + ('00'.repeat(31) + '01').repeat(3) })) };
  };
  // 假链：所有 eth_call 返回三个 1 → token() 报 chainId=1 ≠ 56 → not-tapeout（足够验证解析结果走缓存）
  const k = createKernel({ rpcUrls: ['a', 'b'], quorum: 2, fetchImpl, skipImplCheck: true, cache: createMemoryCache() });
  const r1 = await k.resolve('0x0000000000000000000000000000000000000001');
  const n1 = calls.length; assert.ok(n1 > 0);
  const r2 = await k.resolve('0x0000000000000000000000000000000000000001');
  assert.equal(calls.length, n1, '第二次解析应命中缓存');
  assert.deepEqual(r2.status, r1.status);
  assert.equal(typeof r2.block, 'string');
});

// 假链：只回答「缓存校验」这一个测试需要的调用。返回值在这里手写 ABI 编码，够用即可。
const word = (n) => BigInt(n).toString(16).padStart(64, '0');
const padHex = (bytes) => [...bytes].map((x) => x.toString(16).padStart(2, '0')).join('').padEnd(Math.ceil(bytes.length / 32) * 64, '0');
const abiDynamic = (bytes) => '0x' + word(32) + word(bytes.length) + padHex(bytes);
const abiString = (s) => abiDynamic(new TextEncoder().encode(s));
const abiStringArray = (arr) => {
  const items = arr.map((s) => new TextEncoder().encode(s));
  let head = word(32) + word(items.length), tail = '', off = items.length * 32;
  for (const b of items) {
    head += word(off);
    const hex = [...b].map((x) => x.toString(16).padStart(2, '0')).join('').padEnd(Math.ceil(b.length / 32) * 64, '0');
    tail += word(b.length) + hex; off += 32 + hex.length / 2;
  }
  return '0x' + head + tail;
};

test('缓存字节与链上不符：命中时重新核对，丢弃坏缓存并从链上重读', async () => {
  const CPU = '0x' + '50'.repeat(20), CONTAINER = '0x' + '86'.repeat(20), HOLDER = '0x' + '57'.repeat(20);
  const GOOD = new TextEncoder().encode('on-chain bytes, verified');
  const sha = await sha256Hex(GOOD);
  const BAD = new Uint8Array(GOOD); BAD[0] ^= 0x20;                  // 与 GOOD 等长，内容不同
  assert.equal(BAD.length, GOOD.length);
  assert.notEqual(await sha256Hex(BAD), sha);

  const cache = createMemoryCache();
  await cache.set('file:v1:' + sha, { size: GOOD.length }, BAD);     // 预置一条「键对、字节错」的缓存

  const CT = new TextEncoder().encode('text/html');
  const answers = {
    [SEL.cpuCount]: '0x' + word(1),
    [SEL.cpuAt]: '0x' + CPU.slice(2).padStart(64, '0'),
    [SEL.accountOf]: '0x' + CONTAINER.slice(2).padStart(64, '0'),
    [SEL.isOpened]: '0x' + word(1),
    [SEL.ownerOf]: '0x' + HOLDER.slice(2).padStart(64, '0'),
    [SEL.name]: abiString('Test CPU'),
    [SEL.isLive]: '0x' + word(0),
    [SEL.paidUntil]: '0x' + word(0),
    [SEL.isContainerLive]: '0x' + word(1),                            // 容器付过费 → status ok
    [SEL.containerPaidUntil]: '0x' + word(1791470091),
    [SEL.pathCount]: '0x' + word(1),
    [SEL.fallbackPath]: abiString('index.html'),
    [SEL.pathsRange]: abiStringArray(['index.html']),
    [SEL.fileInfo]: '0x' + word(GOOD.length) + word(160) + sha.slice(2) + word(1791470091) + word(1) + word(CT.length) + padHex(CT),
    [SEL.read]: abiDynamic(GOOD),
  };
  const fetchImpl = async (url, init) => {
    const reqs = JSON.parse(init.body);
    return { ok: true, json: async () => reqs.map((q) => ({ jsonrpc: '2.0', id: q.id, result: q.method === 'eth_blockNumber' ? '0x100' : answers[q.params[0].data.slice(0, 10)] })) };
  };

  const k = createKernel({ rpcUrls: ['a', 'b'], quorum: 2, fetchImpl, skipImplCheck: true, cache });
  const res = await k.resolve('4246.0.tape');
  assert.equal(res.status, 'ok');
  const f = await (await k.openSite(res)).get('index.html');
  assert.equal(f.status, 'ok');
  assert.equal(f.verified, true);
  assert.equal(f.sha256, sha);
  assert.equal(f.fromCache, false, '坏缓存必须丢弃，改为从链上重读');
  assert.equal(new TextDecoder().decode(f.bytes), 'on-chain bytes, verified');

  // 缓存里此时已是核对过的字节：换一个内核（模拟下次冷启动）应当命中缓存，且仍然是「已核对」
  const k2 = createKernel({ rpcUrls: ['a', 'b'], quorum: 2, fetchImpl, skipImplCheck: true, cache });
  const f2 = await (await k2.openSite(await k2.resolve('4246.0.tape'))).get('index.html');
  assert.equal(f2.fromCache, true);
  assert.equal(f2.verified, true);
  assert.equal(f2.sha256, sha);
  assert.equal(new TextDecoder().decode(f2.bytes), 'on-chain bytes, verified');
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
