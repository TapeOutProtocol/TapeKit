// HashPort 内核：链上名字 → 容器 → 文件清单 → 读取 → SHA-256 校验。
// 只做「读链」这一件事，不渲染、不连钱包；渲染与隔离由外壳负责（SPEC.md §7）。
//
// 本版新增：可插拔持久缓存（文件按链上 sha 内容寻址、处理器编号表、解析结果短缓存）、按需读取（openSite）、
// 链上更新监听（watch）、双语文案（i18n）。

import { BSC_MAINNET, IMPL_SLOT, LIMITS } from './config.js';
import { createRpc } from './rpc.js';
import { encodeCall, decodeResult } from './abi.js';
import { SEL } from './selectors.js';
import { parseInput, formatName, formatUrl } from './name.js';
import { normalizePath, resolvePath, safeContentType } from './path.js';
import { sha256Hex } from './sha.js';
import { keccakHex } from './keccak.js';
import { createMemoryCache } from './cache.js';
import { KernelError, t, tt, setLocale, getLocale } from './i18n.js';

const ZERO32 = '0x' + '0'.repeat(64);
const STATUSES = ['ok', 'unpaid', 'not-opened', 'no-such-cpu', 'no-such-token', 'not-tapeout', 'blocked', 'store-changed'];

export class SiteError extends KernelError {
  constructor(code, key, vars) { super(code, key, vars); this.name = 'SiteError'; }
}

/** 各状态的说明：statusText(status) 当前语言；statusText(status, 'both') 两种语言的对象 */
export function statusText(status, mode) {
  if (!STATUSES.includes(status)) return mode === 'both' ? { zh: status, en: status } : status;
  return mode === 'both' ? tt('status.' + status) : t('status.' + status);
}
/** 兼容旧接口：当前语言的一张表 */
export const STATUS_TEXT = new Proxy({}, { get: (_, k) => (typeof k === 'string' && STATUSES.includes(k) ? t('status.' + k) : undefined), ownKeys: () => STATUSES, getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }) });

const callReq = (it, block) => ({ method: 'eth_call', params: [{ to: it.to, data: encodeCall(it.sel, it.types || [], it.values || []) }, block] });
const decodeOutcome = (out, oc) => {
  if (!oc.ok) return { revert: true, data: oc.data };
  if (oc.value === '0x') return { revert: true, empty: true };   // 地址上没有代码
  return decodeResult(out, oc.value);
};
const big = (x) => (typeof x === 'bigint' ? x : BigInt(x));
// 解析结果里的 bigint 存进缓存要转字符串，取出来再转回
const freeze = (r) => JSON.parse(JSON.stringify(r, (k, v) => (typeof v === 'bigint' ? { $big: v.toString() } : v)));
const thaw = (r) => JSON.parse(JSON.stringify(r), (k, v) => (v && typeof v === 'object' && '$big' in v ? BigInt(v.$big) : v));

/**
 * @param {{
 *   network?: Partial<typeof BSC_MAINNET>, rpcUrls?: string[], quorum?: number, rpc?: ReturnType<typeof createRpc>,
 *   fetchImpl?: typeof fetch, isBlocked?: (x:{container:string,name:string}) => Promise<boolean>|boolean,
 *   cache?: import('./cache.js').createMemoryCache extends (...a:any)=>infer R ? R : never, cacheBytes?: number,
 *   resolveTtlMs?: number, skipImplCheck?: boolean, locale?: string,
 * }} [options]
 */
export function createKernel(options = {}) {
  if (options.locale) setLocale(options.locale);
  const net = { ...BSC_MAINNET, ...(options.network || {}) };
  const rpc = options.rpc || createRpc({ urls: options.rpcUrls || net.rpcs, quorum: options.quorum, fetchImpl: options.fetchImpl });
  const isBlocked = options.isBlocked || (() => false);
  const cache = options.cache || createMemoryCache({ maxBytes: options.cacheBytes ?? 64 * 1024 * 1024 });
  const resolveTtl = options.resolveTtlMs ?? 60_000;
  const cpuByIndex = new Map();   // 处理器编号 → 合约地址（小写）
  const indexByCpu = new Map();   // 合约地址 → 编号
  let cpuTableLoaded = false;
  const CPU_KEY = `cpu-index:v1:${net.chainId}:${net.factory}`;
  const fileKey = (sha) => `file:v1:${sha}`;
  const resolveKey = (input) => `resolve:v1:${net.chainId}:${input}`;

  async function batch(items, block) {
    const outcomes = await rpc.many(items.map((it) => callReq(it, block)));
    return outcomes.map((oc, i) => decodeOutcome(items[i].out, oc));
  }
  const one = async (item, block) => (await batch([item], block))[0];
  const must = (r, what) => { if (r.revert) throw new SiteError('chain', 'site.chain-call', { what }); return r; };

  const storeAddrs = () => (options.skipImplCheck ? [] : Object.keys(net.expectedImpl || {}));
  function judgeStores(addrs, outcomes) {
    const stores = addrs.map((address, i) => {
      const oc = outcomes[i];
      const impl = oc && oc.ok ? '0x' + oc.value.slice(-40).toLowerCase() : null;
      const expected = net.expectedImpl[address];
      return { address, impl, expected, ok: !!impl && expected.includes(impl) };
    });
    return { ok: stores.every((s) => s.ok), stores };
  }

  /** 核对网站仓库与付费合约的代理实现（ERC-1967 槽），不在钉住名单里就拒绝（fail-closed）。 */
  async function checkStores(block) {
    const addrs = storeAddrs();
    return judgeStores(addrs, await rpc.many(addrs.map((a) => ({ method: 'eth_getStorageAt', params: [a, IMPL_SLOT, block] }))));
  }

  // ---- 处理器编号表：第一次整表扫描后存进缓存，以后只补扫新增的编号
  async function loadCpuTable() {
    if (cpuTableLoaded) return;
    cpuTableLoaded = true;
    const saved = await cache.get(CPU_KEY);
    if (saved && saved.meta && Array.isArray(saved.meta.cpus)) saved.meta.cpus.forEach((a, i) => { if (a) { cpuByIndex.set(i, a); indexByCpu.set(a, BigInt(i)); } });
  }
  async function saveCpuTable() {
    const n = Math.max(-1, ...cpuByIndex.keys()) + 1;
    const cpus = Array.from({ length: n }, (_, i) => cpuByIndex.get(i) || null);
    await cache.set(CPU_KEY, { cpus, savedAt: Date.now() }, new Uint8Array());
  }
  /** 处理器合约 → 编号。工厂没有反查表，按下标分批扫描；扫过的都进缓存。 */
  async function cpuIndexOf(circuits, block) {
    const key = circuits.toLowerCase();
    await loadCpuTable();
    if (indexByCpu.has(key)) return indexByCpu.get(key);
    const [count] = must(await one({ to: net.factory, sel: SEL.cpuCount, out: ['uint'] }, block), 'cpuCount');
    const n = Number(count);
    let changed = false;
    for (let start = 0; start < n; start += 80) {
      const idx = [];
      for (let i = start; i < Math.min(n, start + 80); i++) if (!cpuByIndex.has(i)) idx.push(i);
      if (!idx.length) continue;
      const rs = await batch(idx.map((i) => ({ to: net.factory, sel: SEL.cpuAt, types: ['uint256'], values: [i], out: ['address'] })), block);
      rs.forEach((r, k) => { if (!r.revert) { cpuByIndex.set(idx[k], r[0]); indexByCpu.set(r[0], BigInt(idx[k])); changed = true; } });
      if (indexByCpu.has(key)) break;
    }
    if (changed) await saveCpuTable();
    return indexByCpu.has(key) ? indexByCpu.get(key) : null;
  }
  /** 编号 → 处理器合约，带缓存 */
  async function cpuAt(cpu, block) {
    await loadCpuTable();
    const i = Number(cpu);
    if (cpuByIndex.has(i)) return cpuByIndex.get(i);
    const r = await one({ to: net.factory, sel: SEL.cpuAt, types: ['uint256'], values: [cpu], out: ['address'] }, block);
    if (r.revert) return null;
    cpuByIndex.set(i, r[0]); indexByCpu.set(r[0], BigInt(i)); await saveCpuTable();
    return r[0];
  }

  /**
   * 解析输入（链上名字 / #ID@编号 / 容器地址 / 处理器合约#ID），返回解析结果。status 见 statusText()。
   * 同一次解析内所有读取钉在 block；不传则取一个多数节点都已有的块。结果缓存 resolveTtlMs（默认 60 秒）。
   */
  async function resolve(input, opts = {}) {
    const parsed = typeof input === 'string' ? parseInput(input) : input;
    const inputKey = typeof input === 'string' ? input.trim().toLowerCase() : JSON.stringify(freeze(parsed));
    if (!opts.fresh && !opts.block) {
      const hit = await cache.get(resolveKey(inputKey));
      if (hit && hit.meta && Date.now() - hit.meta.at < resolveTtl) return thaw(hit.meta.res);
    }
    const res = await resolveUncached(parsed, typeof input === 'string' ? input : '', opts);
    if (!opts.block) await cache.set(resolveKey(inputKey), { at: Date.now(), res: freeze(res) }, new Uint8Array());
    return res;
  }

  async function resolveUncached(parsed, input, opts) {
    const block = opts.block || (await rpc.pinBlock());
    const res = { input, path: parsed.path, block, chainId: net.chainId };

    // 第一轮：仓库实现核对 + 按输入类型的第一步查询，合成一次多节点请求
    const addrs = storeAddrs();
    const first = parsed.kind === 'name'
      ? [{ to: net.factory, sel: SEL.cpuCount, out: ['uint'] }, { to: net.factory, sel: SEL.cpuAt, types: ['uint256'], values: [parsed.cpu], out: ['address'] }]
      : parsed.kind === 'container'
        ? [{ to: parsed.container, sel: SEL.token, out: ['uint', 'address', 'uint'] }]
        : [{ to: net.factory, sel: SEL.isCPU, types: ['address'], values: [parsed.circuits], out: ['bool'] }];
    const outcomes = await rpc.many([...addrs.map((a) => ({ method: 'eth_getStorageAt', params: [a, IMPL_SLOT, block] })), ...first.map((it) => callReq(it, block))]);
    res.stores = judgeStores(addrs, outcomes);
    if (!res.stores.ok) return { ...res, status: 'store-changed' };
    const r1 = outcomes.slice(addrs.length).map((oc, i) => decodeOutcome(first[i].out, oc));

    let circuits, tokenId, cpu, container = null;
    if (parsed.kind === 'name') {
      tokenId = parsed.tokenId; cpu = parsed.cpu;
      const [count] = must(r1[0], 'cpuCount');
      if (cpu >= count || r1[1].revert) return { ...res, tokenId, cpu, status: 'no-such-cpu' };
      [circuits] = r1[1];
      await loadCpuTable();
      if (!cpuByIndex.has(Number(cpu))) { cpuByIndex.set(Number(cpu), circuits); indexByCpu.set(circuits, cpu); await saveCpuTable(); }
    } else {
      if (parsed.kind === 'circuit') {
        circuits = parsed.circuits; tokenId = parsed.tokenId;
        if (r1[0].revert || !r1[0][0]) return { ...res, circuits, status: 'not-tapeout' };
      } else {
        container = parsed.container;
        const tk = r1[0];
        if (tk.revert || tk[0] !== BigInt(net.chainId)) return { ...res, container, status: 'not-tapeout' };
        [, circuits, tokenId] = tk;
        const isCpu = await one({ to: net.factory, sel: SEL.isCPU, types: ['address'], values: [circuits], out: ['bool'] }, block);
        if (isCpu.revert || !isCpu[0]) return { ...res, container, circuits, status: 'not-tapeout' };
      }
      cpu = await cpuIndexOf(circuits, block);
      if (cpu === null) return { ...res, container, circuits, status: 'not-tapeout' };
    }

    const [acct, opened, owner, cpuName] = await batch([
      { to: net.opener, sel: SEL.accountOf, types: ['address', 'uint256'], values: [circuits, tokenId], out: ['address'] },
      { to: net.opener, sel: SEL.isOpened, types: ['address', 'uint256'], values: [circuits, tokenId], out: ['bool'] },
      { to: circuits, sel: SEL.ownerOf, types: ['uint256'], values: [tokenId], out: ['address'] },
      { to: circuits, sel: SEL.name, out: ['string'] },
    ], block);
    const derived = must(acct, 'accountOf')[0];
    // 容器地址输入：必须能从 (处理器, #ID) 精确算回同一个地址，否则是冒充的合约
    if (container && derived !== container) return { ...res, container, circuits, status: 'not-tapeout' };
    container = derived;
    const name = formatName(tokenId, cpu, net.nameSuffix);
    const base = {
      ...res, name, url: formatUrl(tokenId, cpu, parsed.path), cpu, cpuName: cpuName.revert ? '' : cpuName[0],
      circuits, tokenId, container, holder: owner.revert ? null : owner[0], opened: !opened.revert && opened[0] === true, paid: false, paidUntil: 0n, paidVia: null,
    };
    if (owner.revert) return { ...base, status: 'no-such-token' };
    if (!base.opened) return { ...base, status: 'not-opened' };
    if (await isBlocked({ container, name })) return { ...base, status: 'blocked' };
    // 开通判据（任一条即可，SPEC §3.4）：① 这个名字 × 由名字算出的这个容器 付费未到期；② 这个容器为任何名字或域名付过费且未到期。
    //   ② 由 2026-09-13 起的 DomainBinding 实现提供；旧实现上调用会回滚，当作「没有」。
    const [live, until, cLive, cUntil] = await batch([
      { to: net.binding, sel: SEL.isLive, types: ['string', 'address'], values: [name, container], out: ['bool'] },
      { to: net.binding, sel: SEL.paidUntil, types: ['bytes32', 'address'], values: [keccakHex(name), container], out: ['uint'] },
      { to: net.binding, sel: SEL.isContainerLive, types: ['address'], values: [container], out: ['bool'] },
      { to: net.binding, sel: SEL.containerPaidUntil, types: ['address'], values: [container], out: ['uint'] },
    ], block);
    const nameLive = !live.revert && live[0] === true;
    const containerLive = !cLive.revert && cLive[0] === true;
    const paid = nameLive || containerLive;
    const paidUntil = [until, cUntil].filter((r) => !r.revert).reduce((m, r) => (r[0] > m ? r[0] : m), 0n);
    return { ...base, paid, paidUntil, paidVia: nameLive ? 'name' : containerLive ? 'container' : null, status: paid ? 'ok' : 'unpaid' };
  }

  /** 站点文件清单：先命中（pathCount > 0）的仓库为准。第一页与数量、fallback 一次取回。 */
  async function manifest(res, opts = {}) {
    const block = opts.block || res.block;
    const PAGE = 200;
    for (let ri = 0; ri < net.registries.length; ri++) {
      const registry = net.registries[ri];
      const [cnt, fb, page0] = await batch([
        { to: registry, sel: SEL.pathCount, types: ['address'], values: [res.container], out: ['uint'] },
        { to: registry, sel: SEL.fallbackPath, types: ['address'], values: [res.container], out: ['string'] },
        { to: registry, sel: SEL.pathsRange, types: ['address', 'uint256', 'uint256'], values: [res.container, 0, PAGE], out: ['string[]'] },
      ], block);
      const count = Number(must(cnt, 'pathCount')[0]);
      if (count === 0 && ri < net.registries.length - 1) continue;
      const n = Math.min(count, LIMITS.maxManifestPaths);
      const paths = [...must(page0, 'pathsRange')[0]].slice(0, n);
      const more = [];
      for (let from = PAGE; from < n; from += PAGE) more.push({ to: registry, sel: SEL.pathsRange, types: ['address', 'uint256', 'uint256'], values: [res.container, from, Math.min(PAGE, n - from)], out: ['string[]'] });
      if (more.length) for (const r of await batch(more, block)) paths.push(...must(r, 'pathsRange')[0]);
      return { registry, paths, pathSet: new Set(paths), fallback: fb.revert ? '' : fb[0], truncated: count > n, block };
    }
    return { registry: net.registries[0], paths: [], pathSet: new Set(), fallback: '', truncated: false, block };
  }

  async function fileInfos(res, man, paths) {
    if (!paths.length) return [];
    const rs = await batch(paths.map((p) => ({ to: man.registry, sel: SEL.fileInfo, types: ['address', 'string'], values: [res.container, p], out: ['uint', 'string', 'bytes32', 'uint', 'uint'] })), man.block);
    return rs.map((r) => {
      const [size, contentType, sha, updatedAt, chunkCount] = must(r, 'fileInfo');
      return { size: Number(size), contentType, sha: sha.toLowerCase(), updatedAt: Number(updatedAt), chunkCount: Number(chunkCount) };
    });
  }

  const fileFromCache = async (path, info) => {
    if (info.sha === ZERO32) return null;
    const hit = await cache.get(fileKey(info.sha));
    if (!hit || hit.bytes.length !== info.size) return null;
    return { path, bytes: hit.bytes, size: info.size, contentType: safeContentType(info.contentType), declaredSha: info.sha, sha256: info.sha, updatedAt: info.updatedAt, verified: true, status: 'ok', fromCache: true };
  };

  async function verify(path, info, bytes) {
    const actual = await sha256Hex(bytes);
    const declared = info.sha;
    const complete = bytes.length === info.size;
    const hashed = declared !== ZERO32;
    const status = !complete || (hashed && declared !== actual) ? 'incomplete' : hashed ? 'ok' : 'no-hash';
    const file = { path, bytes, size: info.size, contentType: safeContentType(info.contentType), declaredSha: declared, sha256: actual, updatedAt: info.updatedAt, verified: status === 'ok', status, fromCache: false };
    if (status === 'ok') await cache.set(fileKey(declared), { contentType: info.contentType, size: info.size }, bytes);
    return file;
  }

  // 读若干文件的全部字节：小文件按「每批 ≤ 1 MB」合并请求，大文件分段 readRange（钉在同一块）
  async function readFiles(res, man, entries, onFile) {
    const small = [], large = [];
    for (const e of entries) (e.info.size <= LIMITS.rangeBytes ? small : large).push(e);
    for (let i = 0; i < small.length;) {
      const group = []; let bytes = 0;
      while (i < small.length && (group.length === 0 || bytes + small[i].info.size <= 1024 * 1024) && group.length < 32) { bytes += small[i].info.size; group.push(small[i++]); }
      const rs = await batch(group.map((e) => ({ to: man.registry, sel: SEL.read, types: ['address', 'string'], values: [res.container, e.path], out: ['bytes'] })), man.block);
      for (let k = 0; k < group.length; k++) await onFile(await verify(group[k].path, group[k].info, must(rs[k], 'read')[0]));
    }
    for (const e of large) {
      const items = [];
      for (let o = 0; o < e.info.size; o += LIMITS.rangeBytes) items.push({ to: man.registry, sel: SEL.readRange, types: ['address', 'string', 'uint256', 'uint256'], values: [res.container, e.path, o, LIMITS.rangeBytes], out: ['bytes'] });
      const parts = [];
      for (let k = 0; k < items.length; k += 8) for (const r of await batch(items.slice(k, k + 8), man.block)) parts.push(must(r, 'readRange')[0]);
      const all = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
      let off = 0; for (const p of parts) { all.set(p, off); off += p.length; }
      await onFile(await verify(e.path, e.info, all));
    }
  }

  /** 读一个文件（按 §6 规则落到真实路径）。不存在返回 null；status: ok / no-hash / incomplete / too-large */
  async function getFile(res, man, requestedPath) {
    const p = resolvePath(requestedPath, man.pathSet, man.fallback);
    if (p === null) return null;
    const [info] = await fileInfos(res, man, [p]);
    if (info.chunkCount === 0) return null;
    if (info.size > LIMITS.maxFileBytes) return { path: p, status: 'too-large', size: info.size, verified: false };
    const hit = await fileFromCache(p, info);
    if (hit) return hit;
    let out = null;
    await readFiles(res, man, [{ path: p, info }], (f) => { out = f; });
    return out;
  }

  /**
   * 按需读取的站点句柄：只先取清单；get(path) 用到哪个读哪个；同一路径并发只读一次；prefetch 批量预取。
   * 想改成整站预读，就 prefetch(manifest.paths)。
   */
  async function openSite(res, opts = {}) {
    const man = await manifest(res, opts);
    const inflight = new Map();
    const files = new Map();   // 真实路径 → 文件
    const infos = new Map();   // 真实路径 → fileInfo
    async function info(p) {
      if (infos.has(p)) return infos.get(p);
      const [i] = await fileInfos(res, man, [p]); infos.set(p, i); return i;
    }
    async function get(requestedPath) {
      const p = resolvePath(requestedPath, man.pathSet, man.fallback);
      if (p === null) return null;
      if (files.has(p)) return files.get(p);
      if (inflight.has(p)) return inflight.get(p);
      const job = (async () => {
        const i = await info(p);
        if (i.chunkCount === 0) return null;
        if (i.size > LIMITS.maxFileBytes) return { path: p, status: 'too-large', size: i.size, verified: false };
        let f = await fileFromCache(p, i);
        if (!f) await readFiles(res, man, [{ path: p, info: i }], (x) => { f = x; });
        files.set(p, f); return f;
      })();
      inflight.set(p, job);
      try { return await job; } finally { inflight.delete(p); }
    }
    /** 批量预取（合并请求）。返回 {loaded, problems} */
    async function prefetch(paths, onProgress) {
      const real = [...new Set(paths.map((x) => resolvePath(x, man.pathSet, man.fallback)).filter((x) => x && !files.has(x)))];
      const is = await fileInfos(res, man, real);
      real.forEach((p, k) => infos.set(p, is[k]));
      const todo = []; const problems = []; let done = 0; const total = is.reduce((s, i) => s + i.size, 0);
      for (let k = 0; k < real.length; k++) {
        const p = real[k], i = is[k];
        if (i.chunkCount === 0) continue;
        if (i.size > LIMITS.maxFileBytes) { problems.push({ path: p, status: 'too-large' }); continue; }
        const hit = await fileFromCache(p, i);
        if (hit) { files.set(p, hit); done += i.size; } else todo.push({ path: p, info: i });
      }
      onProgress?.({ done, total, files: files.size });
      await readFiles(res, man, todo, (f) => {
        if (f.status === 'ok' || f.status === 'no-hash') files.set(f.path, f);
        if (f.status !== 'ok') problems.push({ path: f.path, status: f.status });
        done += f.size; onProgress?.({ done, total, files: files.size });
      });
      return { loaded: files, problems };
    }
    return { res, manifest: man, files, get, prefetch, info };
  }

  /** 整站读取（小站用）。超过上限直接报错，不做半截渲染。 */
  async function loadSite(res, opts = {}) {
    const maxBytes = opts.maxBytes ?? 32 * 1024 * 1024;
    const maxFiles = opts.maxFiles ?? 2000;
    const site = await openSite(res, opts);
    const man = site.manifest;
    if (man.paths.length > maxFiles) throw new SiteError('too-many-files', 'site.too-many-files', { n: man.paths.length, max: maxFiles });
    const infos = await fileInfos(res, man, man.paths);
    const total = infos.reduce((s, i) => s + (i.chunkCount ? i.size : 0), 0);
    if (total > maxBytes) throw new SiteError('too-large', 'site.too-large', { mb: (total / 1048576).toFixed(1), max: (maxBytes / 1048576).toFixed(0) });
    const { problems } = await site.prefetch(man.paths, opts.onProgress && ((p) => opts.onProgress({ ...p, count: man.paths.length })));
    return { manifest: man, files: site.files, problems, totalBytes: total, site };
  }

  /** 普通域名（经网关访问）是否为这个容器付费有效：DomainBinding.isLive(域名, 容器)。扩展校验当前网页时用。 */
  async function domainLive(domain, container, opts = {}) {
    const block = opts.block || (await rpc.pinBlock());
    const r = await one({ to: net.binding, sel: SEL.isLive, types: ['string', 'address'], values: [String(domain).toLowerCase(), container], out: ['bool'] }, block);
    return !r.revert && r[0] === true;
  }

  /**
   * 监听站点更新。公共节点大多不提供事件查询（eth_getLogs），所以用普通读调用轮询：每 intervalMs 把
   * 文件数、回退路径、以及已知路径（清单前 maxPaths 个 + 已读过的）的 fileInfo 重新读一遍，任何一项变了就
   * 让解析缓存失效并回调 onChange({changed, added, removed, block})。返回 stop()。
   * site 是 openSite() 的句柄（要用它的清单快照）。
   */
  function watch(site, onChange, opts = {}) {
    const intervalMs = opts.intervalMs ?? 30_000;
    const maxPaths = opts.maxPaths ?? 200;
    const res = site.res; const man = site.manifest;
    const known = new Map();   // path → { sha, updatedAt }
    let count = man.paths.length, fallback = man.fallback;
    let stopped = false, timer = null, primed = false;
    const watched = () => [...new Set([...man.paths.slice(0, maxPaths), ...site.files.keys()])];
    async function snapshot(block) {
      const paths = watched();
      const [cnt, fb, ...infos] = await batch([
        { to: man.registry, sel: SEL.pathCount, types: ['address'], values: [res.container], out: ['uint'] },
        { to: man.registry, sel: SEL.fallbackPath, types: ['address'], values: [res.container], out: ['string'] },
        ...paths.map((p) => ({ to: man.registry, sel: SEL.fileInfo, types: ['address', 'string'], values: [res.container, p], out: ['uint', 'string', 'bytes32', 'uint', 'uint'] })),
      ], block);
      const files = new Map();
      paths.forEach((p, i) => { const r = infos[i]; if (!r.revert) files.set(p, { sha: String(r[2]).toLowerCase(), updatedAt: Number(r[3]), exists: Number(r[4]) > 0 }); });
      return { count: cnt.revert ? count : Number(cnt[0]), fallback: fb.revert ? fallback : fb[0], files };
    }
    const tick = async () => {
      if (stopped) return;
      try {
        const block = await rpc.pinBlock();
        const snap = await snapshot(block);
        if (!primed) { primed = true; for (const [p, v] of snap.files) known.set(p, v); count = snap.count; fallback = snap.fallback; }
        else {
          const changed = [], removed = [];
          for (const [p, v] of snap.files) {
            const old = known.get(p);
            if (!old) { known.set(p, v); continue; }
            if (old.exists && !v.exists) removed.push(p);
            else if (v.exists && (old.sha !== v.sha || old.updatedAt !== v.updatedAt)) changed.push(p);
            known.set(p, v);
          }
          const added = snap.count > count;
          const fbChanged = snap.fallback !== fallback;
          count = snap.count; fallback = snap.fallback;
          if (changed.length || removed.length || added || fbChanged) {
            for (const k of [res.input, res.name, res.container].filter(Boolean)) await cache.delete(resolveKey(String(k).trim().toLowerCase()));
            await onChange({ changed, removed, added, fallbackChanged: fbChanged, count: snap.count, block });
          }
        }
      } catch (e) { opts.onError?.(e); }
      if (!stopped) timer = setTimeout(tick, intervalMs);
    };
    timer = setTimeout(tick, opts.firstDelayMs ?? 0);
    return () => { stopped = true; clearTimeout(timer); };
  }

  return { config: net, rpc, cache, parseInput, resolve, manifest, getFile, openSite, loadSite, checkStores, cpuIndexOf, cpuAt, domainLive, watch, normalizePath, resolvePath, setLocale, getLocale, statusText };
}
