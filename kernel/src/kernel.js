// HashPort 内核：链上名字 → 容器 → 文件清单 → 读取 → SHA-256 校验。
// 只做「读链」这一件事，不渲染、不连钱包；渲染与隔离由外壳负责（SPEC.md §7）。
//
// 本版新增：可插拔持久缓存（文件按链上 sha 内容寻址、处理器编号表、解析结果短缓存）、按需读取（openSite）、
// 链上更新监听（watch）、双语文案（i18n）。

import { BSC_MAINNET, IMPL_SLOT, LIMITS, NETWORKS, HOME_NETWORK, networkByArea, rpcOptionsFor } from './config.js';
import { createRpc, RpcError } from './rpc.js';
import { createIdentity } from './identity.js';
import { SEL } from './selectors.js';
import { parseInput, formatUrl, formatShort, formatLabel, InputError } from './name.js';
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

const big = (x) => (typeof x === 'bigint' ? x : BigInt(x));
// 解析结果里的 bigint 存进缓存要转字符串，取出来再转回
const freeze = (r) => JSON.parse(JSON.stringify(r, (k, v) => (typeof v === 'bigint' ? { $big: v.toString() } : v)));
const thaw = (r) => JSON.parse(JSON.stringify(r), (k, v) => (v && typeof v === 'object' && '$big' in v ? BigInt(v.$big) : v));

/**
 * 多链内核（默认）：每条链一个子内核，按名字里的区号选链（没有区号 = BNB）；容器地址、处理器合约#ID 这两种写法
 * 不带链的信息，就在所有链上同时查，取真正属于那条链的结果（容器的 token() 里写着链号，冒充不了）。
 * 解析结果 res 带 chainId，之后 openSite / manifest / getFile / watch 都自动交给那条链的子内核。
 *
 * 传 network 或 rpc 时退回单链内核（旧用法，测试用）。
 * rpcUrls：数组 = 只替换 BNB 的节点（旧用法）；对象 = 按链号或链名（bnb / xlayer / base）分别替换。
 *
 * @param {Parameters<typeof createChainKernel>[0] & { networks?: typeof NETWORKS, rpcUrls?: string[] | Record<string, string[]> }} [options]
 */
export function createKernel(options = {}) {
  if (options.network || options.rpc) return createChainKernel(options);
  if (options.locale) setLocale(options.locale);
  const nets = options.networks || NETWORKS;
  const cache = options.cache || createMemoryCache({ maxBytes: options.cacheBytes ?? 64 * 1024 * 1024 });
  const urlsFor = (net) => {
    const r = options.rpcUrls;
    if (!r) return undefined;
    if (Array.isArray(r)) return net.chainId === HOME_NETWORK.chainId && r.length ? r : undefined;
    const u = r[net.chainId] || r[String(net.chainId)] || r[net.key];
    return u && u.length ? u : undefined;
  };
  const kernels = new Map(nets.map((net) => [net.chainId, createChainKernel({ ...options, locale: undefined, network: net, cache, rpcUrls: urlsFor(net) })]));
  const home = kernels.get(HOME_NETWORK.chainId) || kernels.values().next().value;
  /** 某条链的子内核；不认识的链返回 null */
  const kernelFor = (chainId) => kernels.get(Number(chainId)) || null;
  const mustKernel = (chainId) => {
    const k = kernelFor(chainId);
    if (!k) throw new SiteError('chain', 'site.chain-call', { what: `chain ${chainId}` });
    return k;
  };

  async function resolve(input, opts = {}) {
    const parsed = typeof input === 'string' ? parseInput(input) : input;
    if (opts.chainId !== undefined) return mustKernel(opts.chainId).resolve(input, opts);
    if (parsed.kind === 'name') {
      const net = networkByArea(parsed.area);
      const k = net && kernelFor(net.chainId);
      if (!k) throw new InputError('input.area', { value: String(parsed.area) });
      return k.resolve(input, opts);
    }
    // 容器地址 / 处理器合约#ID：所有链同时查（不带链信息的写法）。同一个区块号在别的链上没有意义
    if (opts.block) throw new InputError('input.needs-chain', {});
    const list = [...kernels.values()];
    const isFound = (v) => !['not-tapeout', 'store-changed'].includes(v.status);
    const tasks = list.map((k) => k.resolve(input, opts).then((v) => ({ k, ok: true, v }), (e) => ({ k, ok: false, e })));
    if (parsed.kind === 'container') {
      // 容器地址里含链号，只可能属于一条链：哪条链先确认身份成立就立刻用它，不等最慢的链
      const first = await new Promise((done) => {
        let left = tasks.length;
        for (const t of tasks) t.then((x) => { if (x.ok && isFound(x.v)) done(x); else if (--left === 0) done(null); });
      });
      if (first) return first.v;
    }
    const got = await Promise.all(tasks);
    const found = got.filter((x) => x.ok && isFound(x.v));
    if (parsed.kind === 'circuit') {
      // 处理器地址只在"同一个工厂"的链之间可能相同（两条 L2 的工厂地址、部署顺序相同；BNB 的工厂不同）。
      // 同一工厂的链里：两条都成立 → 歧义，不替用户选；有链读失败或因实现变了没法核对 → 不能确定它不在那条链上，不猜
      const factoryOf = (x) => String(x.k.config.factory).toLowerCase();
      for (const f of found) {
        const peers = got.filter((x) => x !== f && factoryOf(x) === factoryOf(f));
        const clash = peers.filter((x) => x.ok && isFound(x.v));
        if (clash.length) throw new InputError('input.ambiguous', { chains: [f, ...clash].map((x) => x.k.config.name).join(' / ') });
        const unsure = peers.find((x) => !x.ok || x.v.status === 'store-changed');
        if (unsure) { if (!unsure.ok) throw unsure.e; return unsure.v; }
      }
    }
    if (found.length > 1) throw new InputError('input.ambiguous', { chains: found.map((x) => x.k.config.name).join(' / ') });
    if (found.length === 1) return found[0].v;
    // 哪条链都没找到：有链因为合约实现变了没法核对，就报那条（拒绝显示，而不是说"不是 TapeOut"）；
    // 有链读失败（节点问题）时不能断言"不是 TapeOut"：那条链上可能就是它
    const changed = got.find((x) => x.ok && x.v.status === 'store-changed');
    if (changed) return changed.v;
    const failed = got.find((x) => !x.ok);
    if (failed) throw failed.e;
    const home = got.find((x) => x.k.config.chainId === HOME_NETWORK.chainId) || got[0];
    return home.v;
  }

  const byRes = (res) => mustKernel(res.chainId ?? HOME_NETWORK.chainId);
  // 汇总各链节点：状态页、CSP 放行的节点来源用。每条链自己的节点在 kernelFor(chainId).rpc
  const rpc = {
    get urls() { return [...new Set([...kernels.values()].flatMap((k) => k.rpc.urls))]; },
    quorum: home.rpc.quorum,
    stats: () => Object.assign({}, ...[...kernels.values()].map((k) => k.rpc.stats())),
    forChain: (chainId) => mustKernel(chainId).rpc,
  };

  return {
    config: home.config, networks: nets, kernelFor, rpc, cache, parseInput, resolve,
    manifest: (res, o) => byRes(res).manifest(res, o),
    getFile: (res, man, p) => byRes(res).getFile(res, man, p),
    openSite: (res, o) => byRes(res).openSite(res, o),
    loadSite: (res, o) => byRes(res).loadSite(res, o),
    watch: (site, onChange, o) => byRes(site.res).watch(site, onChange, o),
    checkStores: (block, o = {}) => mustKernel(o.chainId ?? HOME_NETWORK.chainId).checkStores(block),
    domainLive: (domain, container, o = {}) => mustKernel(o.chainId ?? HOME_NETWORK.chainId).domainLive(domain, container, o),
    cpuIndexOf: (circuits, block, o = {}) => mustKernel(o.chainId ?? HOME_NETWORK.chainId).cpuIndexOf(circuits, block),
    cpuAt: (cpu, block, o = {}) => mustKernel(o.chainId ?? HOME_NETWORK.chainId).cpuAt(cpu, block),
    normalizePath, resolvePath, setLocale, getLocale, statusText,
  };
}

/**
 * 单链内核。
 * @param {{
 *   network?: Partial<typeof BSC_MAINNET>, rpcUrls?: string[], quorum?: number, rpc?: ReturnType<typeof createRpc>,
 *   fetchImpl?: typeof fetch, isBlocked?: (x:{container:string,name:string}) => Promise<boolean>|boolean,
 *   cache?: import('./cache.js').createMemoryCache extends (...a:any)=>infer R ? R : never, cacheBytes?: number,
 *   resolveTtlMs?: number, skipImplCheck?: boolean, locale?: string,
 * }} [options]
 */
export function createChainKernel(options = {}) {
  if (options.locale) setLocale(options.locale);
  const net = { ...BSC_MAINNET, ...(options.network || {}) };
  const rpc = options.rpc || createRpc({ ...rpcOptionsFor(net, options.rpcUrls), quorum: options.quorum, fetchImpl: options.fetchImpl });
  const isBlocked = options.isBlocked || (() => false);
  const cache = options.cache || createMemoryCache({ maxBytes: options.cacheBytes ?? 64 * 1024 * 1024 });
  const resolveTtl = options.resolveTtlMs ?? 60_000;
  const fileKey = (sha) => `file:v1:${sha}`;
  // 解析结果只放内存（见 resolve 里的说明）：落盘到网站来源的存储里会被网站脚本改写
  const resolveMem = new Map();

  // 身份解析、处理器编号表、多节点读调用都来自 TapeKit 核心（identity.js），与 TapeSend 共用
  const identity = createIdentity({ rpc, network: net, cache, fail: (what) => { throw new SiteError('chain', 'site.chain-call', { what }); } });
  const { batch, one, cpuIndexOf, cpuAt } = identity;
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

  /**
   * 解析输入（链上名字 / #ID@编号 / 容器地址 / 处理器合约#ID），返回解析结果。status 见 statusText()。
   * 同一次解析内所有读取钉在 block；不传则取一个多数节点都已有的块。结果缓存 resolveTtlMs（默认 60 秒）。
   */
  async function resolve(input, opts = {}) {
    const parsed = typeof input === 'string' ? parseInput(input) : input;
    const inputKey = typeof input === 'string' ? input.trim().toLowerCase() : JSON.stringify(freeze(parsed));
    if (!opts.fresh && !opts.block) {
      // ★ 解析结果（持有人、付费状态、容器地址）只放内存，不落盘：
      //   落在网站自己的来源里时，网站脚本能改写它——伪造持有人、把 unpaid 改成 ok、
      //   把时间戳改到未来让它永不过期，还能绕过屏蔽名单（审计 2026-09-20 实测复现）
      const hit = resolveMem.get(inputKey);
      if (hit && hit.at <= Date.now() && Date.now() - hit.at < resolveTtl) {
        // 屏蔽名单每次都查：名单是后来才更新的，命中缓存不能跳过
        const blocked = isBlocked && hit.res.container && isBlocked({ container: hit.res.container, name: hit.res.name });
        if (!blocked) return thaw(hit.res);
        resolveMem.delete(inputKey);
      }
    }
    const res = await resolveUncached(parsed, typeof input === 'string' ? input : '', opts);
    if (!opts.block) {
      resolveMem.set(inputKey, { at: Date.now(), res: freeze(res) });
      if (resolveMem.size > 200) resolveMem.delete(resolveMem.keys().next().value);
    }
    return res;
  }

  /**
   * 钉块并检查它够不够新：钉住的块比"各运营方报的最高块"落后太多就拒绝。
   * 只有两三家运营方的链上，一家报很旧的高度就能把钉块压到过去、读到旧网站。
   * 按块数比较，不看本机时钟（电脑时间不准时不会误报），也不多一次往返
   */
  async function pinFresh() {
    const block = await rpc.pinBlock();
    const max = net.maxPinLagBlocks;
    const lag = typeof rpc.pinLag === 'function' ? rpc.pinLag() : 0n;
    if (max && lag > BigInt(max)) throw new RpcError('rpc.stale', { n: String(lag) });
    return block;
  }

  async function resolveUncached(parsed, input, opts) {
    const block = opts.block || (await pinFresh());
    const res = { input, path: parsed.path, block, chainId: net.chainId, network: net.key || null, area: net.area ?? null };

    // 仓库实现核对与身份解析的第一步合成一次多节点请求；实现不在钉住名单里就不再往下读
    const addrs = storeAddrs();
    const { identity: id } = await identity.resolveIdentity(parsed, block, {
      prepend: addrs.map((a) => ({ method: 'eth_getStorageAt', params: [a, IMPL_SLOT, block] })),
      afterFirst: (outcomes) => { res.stores = judgeStores(addrs, outcomes); return res.stores.ok; },
    });
    if (!res.stores.ok) return { ...res, status: 'store-changed' };
    if (id.status !== 'ok' && id.status !== 'no-such-token') return { ...res, ...id };

    const { name, container, tokenId, cpu } = id;
    const base = {
      ...res, name, url: formatUrl(tokenId, cpu, parsed.path, net.nameSuffix, net.area), short: formatShort(tokenId, cpu, net.area),
      label: formatLabel(tokenId, cpu, net.area), cpu, cpuName: id.cpuName,
      circuits: id.circuits, tokenId, container, holder: id.holder, opened: id.opened, paid: false, paidUntil: 0n, paidVia: null,
    };
    if (id.status === 'no-such-token') return { ...base, status: 'no-such-token' };
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
    // ★ 必须重新算哈希：缓存所在的来源就是网站代码运行的来源（Service Worker 网关），
    //   网站脚本能直接改写 IndexedDB。不重算的话，它就能让网关给链上没有的内容盖"已核对"的章。
    //   几 MB 的文件只要几毫秒，比重新读链便宜得多（审计 2026-09-20 实测复现）
    const actual = await sha256Hex(hit.bytes);
    if (actual !== info.sha) { await cache.delete(fileKey(info.sha)); return null; }
    return { path, bytes: hit.bytes, size: info.size, contentType: safeContentType(info.contentType), declaredSha: info.sha, sha256: actual, updatedAt: info.updatedAt, verified: true, status: 'ok', fromCache: true };
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
    const block = opts.block || (await pinFresh());
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
        const block = await pinFresh();
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
            for (const k of [res.input, res.name, res.container].filter(Boolean)) resolveMem.delete(String(k).trim().toLowerCase());
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
