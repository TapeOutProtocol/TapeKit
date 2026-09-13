// 多节点 JSON-RPC 客户端。默认每个请求至少 quorum 个节点给出**完全相同**的结果才采用；
// 只要有两个节点给出不同结果就报错（不投票、不取多数）——这是防「单个节点作假」的最低线。
// 所有读取钉在同一个区块高度，一次打开网站的全部读取看到的是同一个链上状态。
// 速度：先问 quorum 个节点，hedgeMs 内凑不齐一致结果就追加问下一个（慢节点不拖累整体）。

import { KernelError } from './i18n.js';

export class RpcError extends KernelError {
  constructor(key, vars, detail) { super('rpc', key, vars, detail); this.name = 'RpcError'; }
}

const isRevertError = (e) => e && (e.code === 3 || /revert/i.test(String(e.message || '')));

/** 对象结果（区块、交易、回执）跨节点比较用：键排序、字符串小写，得到确定性的 JSON 文本 */
export function canonicalJson(v) {
  const norm = (x) => (Array.isArray(x) ? x.map(norm) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, norm(x[k])])) : typeof x === 'string' ? x.toLowerCase() : x);
  return JSON.stringify(norm(v));
}

function shuffled(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

/** getLogs 的结果做规范化后再比较（不同节点字段顺序/大小写可能不同） */
function normalizeLogs(value) {
  if (!Array.isArray(value)) return null;
  return value.map((l) => ({
    address: String(l.address || '').toLowerCase(), topics: (l.topics || []).map((t) => String(t).toLowerCase()), data: String(l.data || '0x').toLowerCase(),
    blockNumber: String(l.blockNumber || '').toLowerCase(), transactionHash: String(l.transactionHash || '').toLowerCase(), logIndex: String(l.logIndex || '').toLowerCase(),
  })).sort((a, b) => (a.blockNumber + a.logIndex).localeCompare(b.blockNumber + b.logIndex));
}

/**
 * @param {{urls: string[], quorum?: number, timeoutMs?: number, hedgeMs?: number, maxBatch?: number, fetchImpl?: typeof fetch, shuffle?: boolean}} o
 */
export function createRpc(o) {
  const urls = [...new Set(o.urls || [])];
  if (!urls.length) throw new RpcError('rpc.none');
  const quorum = Math.max(1, Math.min(o.quorum ?? 2, urls.length));
  const timeoutMs = o.timeoutMs ?? 10_000;
  const hedgeMs = o.hedgeMs ?? 1_500;
  const maxBatch = o.maxBatch ?? 40;
  const fetchImpl = o.fetchImpl || globalThis.fetch.bind(globalThis);
  const retries = o.retries ?? 2;                 // 429 / 5xx / 网络错误时的重试次数（每次退避加倍，带抖动）
  const backoffMs = o.backoffMs ?? 400;
  const cooldownMs = o.cooldownMs ?? 20_000;      // 被限流的节点先靠后排这么久，不是不用
  // 每个节点的统计：状态页显示用；也用来把最近出问题的节点排到后面
  const stats = Object.fromEntries(urls.map((u) => [u, { ok: 0, fail: 0, rateLimited: 0, lastMs: null, lastError: null, cooldownUntil: 0 }]));
  const order = () => {
    const base = o.shuffle === false ? [...urls] : shuffled(urls);
    const now = Date.now();
    return base.sort((a, b) => (stats[a].cooldownUntil > now ? 1 : 0) - (stats[b].cooldownUntil > now ? 1 : 0));
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function postOnce(url, body) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    const t0 = Date.now();
    try {
      const r = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: ctl.signal });
      if (!r.ok) { const e = new Error('HTTP ' + r.status); e.status = r.status; throw e; }
      const j = await r.json();
      stats[url].ok++; stats[url].lastMs = Date.now() - t0; stats[url].lastError = null;
      return j;
    } catch (e) {
      stats[url].fail++; stats[url].lastMs = Date.now() - t0; stats[url].lastError = String(e?.message || e);
      if (e && e.status === 429) { stats[url].rateLimited++; stats[url].cooldownUntil = Date.now() + cooldownMs; }
      throw e;
    } finally { clearTimeout(t); }
  }
  // 限流（429）、服务端错误（5xx）和网络错误会重试；4xx 其它错误和超时不重试（超时说明节点慢，换下一个更划算）
  async function post(url, body) {
    let last;
    for (let i = 0; ; i++) {
      try { return await postOnce(url, body); }
      catch (e) {
        last = e;
        const retriable = e && (e.status === 429 || (e.status >= 500 && e.status <= 599) || (!e.status && e.name !== 'AbortError'));
        if (!retriable || i >= retries) throw last;
        await sleep(backoffMs * 2 ** i * (0.7 + Math.random() * 0.6));
      }
    }
  }

  // 在一个节点上跑一组请求 → 每个请求一个结果：{ok,value} | {revert,data} | {err}。永不抛错。
  async function runOn(url, reqs) {
    const out = [];
    for (let i = 0; i < reqs.length; i += maxBatch) {
      const part = reqs.slice(i, i + maxBatch).map((q, k) => ({ jsonrpc: '2.0', id: i + k + 1, method: q.method, params: q.params }));
      let resp;
      try { resp = await post(url, part); } catch (e) { for (let k = 0; k < part.length; k++) out.push({ err: String(e?.message || e) }); continue; }
      if (!Array.isArray(resp)) { for (let k = 0; k < part.length; k++) out.push({ err: 'bad batch response' }); continue; }
      const byId = new Map(resp.filter((x) => x && typeof x === 'object').map((x) => [x.id, x]));
      for (const q of part) {
        const x = byId.get(q.id);
        if (!x) out.push({ err: 'missing response' });
        else if (x.error) out.push(isRevertError(x.error) ? { revert: true, data: typeof x.error.data === 'string' ? x.error.data : '0x' } : { err: String(x.error.message || 'rpc error') });
        else if (q.method === 'eth_getLogs') { const logs = normalizeLogs(x.result); out.push(logs ? { ok: true, value: JSON.stringify(logs), logs } : { err: 'bad logs' }); }
        else if (typeof x.result === 'string') out.push({ ok: true, value: x.result });
        else if (x.result === null || typeof x.result === 'boolean' || typeof x.result === 'number' || typeof x.result === 'object') out.push({ ok: true, value: canonicalJson(x.result), raw: x.result });   // 区块、交易、回执等对象结果：按规范化 JSON 比较
        else out.push({ err: 'bad result' });
      }
    }
    return out;
  }

  function tally(outcomes) {
    const groups = new Map();
    for (const oc of outcomes) {
      if (!oc || oc.err) continue;
      const key = oc.ok ? 'v:' + oc.value.toLowerCase() : 'r:' + String(oc.data).toLowerCase();
      const g = groups.get(key) || { n: 0, oc };
      g.n++; groups.set(key, g);
    }
    if (groups.size > 1) return { status: 'conflict' };
    if (!groups.size) return { status: 'short' };
    const [g] = groups.values();
    return g.n >= quorum ? { status: 'ok', outcome: g.oc } : { status: 'short' };
  }

  /** 一组请求，按法定人数核对。返回每个请求的结果 {ok,value} 或 {revert,data}。 */
  function many(reqs) {
    if (!reqs.length) return Promise.resolve([]);
    const nodes = order();
    const answers = [];
    let next = 0, inflight = 0, done = false, timer = null;
    return new Promise((resolve, reject) => {
      const finish = (fn, v) => { if (done) return; done = true; clearTimeout(timer); fn(v); };
      const launch = () => {
        if (next >= nodes.length) return false;
        const url = nodes[next++];
        inflight++;
        runOn(url, reqs).then((a) => { inflight--; answers.push(a); check(); });
        return true;
      };
      const check = () => {
        if (done) return;
        const verdicts = reqs.map((_, i) => tally(answers.map((a) => a[i])));
        const bad = verdicts.findIndex((v) => v.status === 'conflict');
        if (bad >= 0) return finish(reject, new RpcError('rpc.conflict', {}, { request: reqs[bad] }));
        if (verdicts.every((v) => v.status === 'ok')) return finish(resolve, verdicts.map((v) => v.outcome));
        if (inflight === 0 && !launch()) {
          const errs = answers.flatMap((a) => a.filter((x) => x && x.err).map((x) => x.err));
          finish(reject, new RpcError('rpc.short', { quorum }, { errors: [...new Set(errs)].slice(0, 5) }));
        }
      };
      const arm = () => { timer = setTimeout(() => { if (!done && launch()) arm(); }, hedgeMs); };
      for (let i = 0; i < quorum; i++) launch();
      arm();
    });
  }

  /** 选一个至少 quorum 个节点都已经有的区块高度（第 quorum 高的头部再往回 2 个块，避开刚出的块被重组）。
   *  凑够 quorum 个回复后最多再等 400 ms，不等最慢的节点。 */
  async function pinBlock() {
    const heads = [];
    await new Promise((resolve) => {
      let pending = urls.length, grace = null;
      const done = () => { clearTimeout(grace); resolve(); };
      for (const u of urls) {
        runOn(u, [{ method: 'eth_blockNumber', params: [] }]).then((r) => {
          const x = r[0];
          if (x && x.ok && /^0x[0-9a-f]+$/i.test(x.value)) heads.push(BigInt(x.value));
          pending--;
          if (pending === 0) done();
          else if (heads.length >= quorum && !grace) grace = setTimeout(done, 400);
        });
      }
    });
    heads.sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));
    if (heads.length < quorum) throw new RpcError('rpc.heads', { n: heads.length });
    return '0x' + (heads[quorum - 1] - 2n).toString(16);
  }

  const calls = (items, block) => many(items.map((it) => ({ method: 'eth_call', params: [{ to: it.to, data: it.data }, block] })));
  const storageAt = (addr, slot, block) => many([{ method: 'eth_getStorageAt', params: [addr, slot, block] }]).then((r) => r[0]);
  /** 事件日志（按法定人数核对）。公共节点对范围有限制，调用方自己分段。 */
  const getLogs = (filter) => many([{ method: 'eth_getLogs', params: [filter] }]).then((r) => (r[0].ok ? r[0].logs : []));

  /** 每个节点的成功/失败/限流次数、最近一次耗时与错误、冷却到期时间（状态页显示用） */
  const getStats = () => Object.fromEntries(urls.map((u) => [u, { ...stats[u] }]));

  return { urls, quorum, many, calls, storageAt, pinBlock, getLogs, stats: getStats };
}
