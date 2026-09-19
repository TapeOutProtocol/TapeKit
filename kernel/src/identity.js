// TapeKit 核心：身份解析。链上名字 / #ID@编号 / 容器地址 / 处理器合约#ID → (处理器, #ID, 容器, 持有人, 是否开通)。
// 对应 SPEC.md §3.2 第 1–4 步与 §3.3 第 1–4 步。网页内核（kernel.js）和 TapeSend（TAP-10 §2.3）共用这一份代码，
// 两边不各写一套：同一个名字在两个产品里必须解析出同一个容器。
//
// 这里不做仓库实现核对、封禁、付费开通判定——那些只属于网页（SPEC §3.2 第 5–7 步、§4.3），由 kernel.js 在此之后接着做。

import { BSC_MAINNET } from './config.js';
import { encodeCall, decodeResult } from './abi.js';
import { SEL } from './selectors.js';
import { formatName, formatLabel, InputError } from './name.js';
import { createMemoryCache } from './cache.js';
import { KernelError } from './i18n.js';

export const callRequest = (it, block) => ({ method: 'eth_call', params: [{ to: it.to, data: encodeCall(it.sel, it.types || [], it.values || []) }, block] });
export const decodeOutcome = (out, oc) => {
  if (!oc.ok) return { revert: true, data: oc.data };
  if (oc.value === '0x') return { revert: true, empty: true };   // 地址上没有代码
  return decodeResult(out, oc.value);
};

/**
 * @param {{ rpc: { many: Function }, network?: Partial<typeof BSC_MAINNET>, cache?: any,
 *           fail?: (what: string) => never, strict?: boolean }} o
 *   strict：所有读取都用严格模式（问所有节点、任何分歧都拒绝）。TapeSend 必须开：名字解析错了，消息就会加密给别人。
 */
export function createIdentity(o) {
  const net = { ...BSC_MAINNET, ...(o.network || {}) };
  const rpc = o.rpc;
  const cache = o.cache || createMemoryCache({ maxBytes: 1024 * 1024 });
  const fail = o.fail || ((what) => { throw new KernelError('chain', 'site.chain-call', { what }); });
  const cpuByIndex = new Map();   // 处理器编号 → 合约地址（小写）
  const indexByCpu = new Map();   // 合约地址 → 编号
  let cpuTableLoaded = false;
  const CPU_KEY = `cpu-index:v1:${net.chainId}:${net.factory}`;

  const readOpts = o.strict ? { all: true } : undefined;
  async function batch(items, block) {
    const outcomes = await rpc.many(items.map((it) => callRequest(it, block)), readOpts);
    return outcomes.map((oc, i) => decodeOutcome(items[i].out, oc));
  }
  const one = async (item, block) => (await batch([item], block))[0];
  const must = (r, what) => { if (r.revert) fail(what); return r; };

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
   * 在 block 上解析身份。
   * @param parsed  parseInput() 的结果
   * @param block   钉住的区块（0x 十六进制）
   * @param opts.prepend      和第一轮查询合并发出的额外请求（网页内核用它顺带读仓库实现槽，省一次往返）
   * @param opts.afterFirst   拿到 prepend 的结果后调用；返回 false 就不再往下解析（返回 null）
   * @returns {Promise<{ prepended: any[], identity: null | {
   *   status: 'ok'|'no-such-cpu'|'no-such-token'|'not-tapeout', tokenId?: bigint, cpu?: bigint, circuits?: string,
   *   container?: string, holder?: string|null, opened?: boolean, cpuName?: string, name?: string } }>}
   *   status 为 ok 表示身份成立（电路存在）；是否开通看 opened，由调用方决定怎么处理。
   */
  async function resolveIdentity(parsed, block, opts = {}) {
    // 带区号的名字只能在那条链上解析：拿 1.2.344 去 BNB 上查，会查到另一枚毫不相干的电路
    if (parsed.kind === 'name' && (parsed.area ?? null) !== (net.area ?? null)) {
      throw new InputError('input.wrong-network', { name: formatLabel(parsed.tokenId, parsed.cpu, parsed.area), network: net.name || `chain ${net.chainId}` });
    }
    const prepend = opts.prepend || [];
    const first = parsed.kind === 'name'
      ? [{ to: net.factory, sel: SEL.cpuCount, out: ['uint'] }, { to: net.factory, sel: SEL.cpuAt, types: ['uint256'], values: [parsed.cpu], out: ['address'] }]
      : parsed.kind === 'container'
        ? [{ to: parsed.container, sel: SEL.token, out: ['uint', 'address', 'uint'] }]
        : [{ to: net.factory, sel: SEL.isCPU, types: ['address'], values: [parsed.circuits], out: ['bool'] }];
    const outcomes = await rpc.many([...prepend, ...first.map((it) => callRequest(it, block))], readOpts);
    const prepended = outcomes.slice(0, prepend.length);
    if (opts.afterFirst && opts.afterFirst(prepended) === false) return { prepended, identity: null };
    const r1 = outcomes.slice(prepend.length).map((oc, i) => decodeOutcome(first[i].out, oc));

    let circuits, tokenId, cpu, container = null;
    if (parsed.kind === 'name') {
      tokenId = parsed.tokenId; cpu = parsed.cpu;
      const [count] = must(r1[0], 'cpuCount');
      if (cpu >= count || r1[1].revert) return { prepended, identity: { tokenId, cpu, status: 'no-such-cpu' } };
      [circuits] = r1[1];
      await loadCpuTable();
      if (!cpuByIndex.has(Number(cpu))) { cpuByIndex.set(Number(cpu), circuits); indexByCpu.set(circuits, cpu); await saveCpuTable(); }
    } else {
      if (parsed.kind === 'circuit') {
        circuits = parsed.circuits; tokenId = parsed.tokenId;
        if (r1[0].revert || !r1[0][0]) return { prepended, identity: { circuits, status: 'not-tapeout' } };
      } else {
        container = parsed.container;
        const tk = r1[0];
        if (tk.revert || tk[0] !== BigInt(net.chainId)) return { prepended, identity: { container, status: 'not-tapeout' } };
        [, circuits, tokenId] = tk;
        const isCpu = await one({ to: net.factory, sel: SEL.isCPU, types: ['address'], values: [circuits], out: ['bool'] }, block);
        if (isCpu.revert || !isCpu[0]) return { prepended, identity: { container, circuits, status: 'not-tapeout' } };
      }
      cpu = await cpuIndexOf(circuits, block);
      if (cpu === null) return { prepended, identity: { container, circuits, status: 'not-tapeout' } };
    }

    const [acct, opened, owner, cpuName] = await batch([
      { to: net.opener, sel: SEL.accountOf, types: ['address', 'uint256'], values: [circuits, tokenId], out: ['address'] },
      { to: net.opener, sel: SEL.isOpened, types: ['address', 'uint256'], values: [circuits, tokenId], out: ['bool'] },
      { to: circuits, sel: SEL.ownerOf, types: ['uint256'], values: [tokenId], out: ['address'] },
      { to: circuits, sel: SEL.name, out: ['string'] },
    ], block);
    const derived = must(acct, 'accountOf')[0];
    // 容器地址输入：必须能从 (处理器, #ID) 精确算回同一个地址，否则是冒充的合约
    if (container && derived !== container) return { prepended, identity: { container, circuits, status: 'not-tapeout' } };
    const identity = {
      name: formatName(tokenId, cpu, net.nameSuffix, net.area), area: net.area ?? null, chainId: net.chainId, cpu, cpuName: cpuName.revert ? '' : cpuName[0],
      circuits, tokenId, container: derived, holder: owner.revert ? null : owner[0], opened: !opened.revert && opened[0] === true,
      status: owner.revert ? 'no-such-token' : 'ok',
    };
    return { prepended, identity };
  }

  return { network: net, batch, one, cpuAt, cpuIndexOf, resolveIdentity };
}
