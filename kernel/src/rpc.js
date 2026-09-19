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

const quantity = (v) => {
  const n = BigInt(v);   // 非法数量（"0x"、"-0x1"、undefined）在这里抛错，整个回答按错误处理
  if (n < 0n) throw new Error('negative quantity');
  return n;
};

/** getLogs 的结果做规范化后再比较（不同节点字段顺序/大小写可能不同）。任何一条不合规就返回 null（按错误处理）。 */
function normalizeLogs(value) {
  if (!Array.isArray(value)) return null;
  try {
    return value.map((l) => {
      if (!l || typeof l !== 'object' || !Array.isArray(l.topics)) throw new Error('bad log');
      return {
        address: String(l.address).toLowerCase(), topics: l.topics.map((t) => String(t).toLowerCase()), data: String(l.data ?? '0x').toLowerCase(),
        blockNumber: quantity(l.blockNumber).toString(), blockHash: String(l.blockHash).toLowerCase(),
        transactionHash: String(l.transactionHash).toLowerCase(), logIndex: quantity(l.logIndex).toString(),
      };
    }).sort((a, b) => {
      const d = BigInt(a.blockNumber) - BigInt(b.blockNumber) || BigInt(a.logIndex) - BigInt(b.logIndex);
      return d < 0n ? -1 : d > 0n ? 1 : 0;
    });
  } catch {
    return null;
  }
}

/**
 * @param {{urls: string[], quorum?: number, timeoutMs?: number, hedgeMs?: number, maxBatch?: number,
 *          maxBatchByUrl?: Record<string, number>, operators?: Record<string, string>, pin?: 'latest'|'safe',
 *          fetchImpl?: typeof fetch, shuffle?: boolean}} o
 *   maxBatchByUrl：个别节点的单包上限（例如 dRPC 免费档 3 个）；节点拒绝批量时还会自动缩小，缩到 1 就逐个发。
 *   pin：pinBlock 钉哪种区块。'latest'（默认）= 最新块往回 2 块；'safe' = 节点报告的安全区块（L2 用：最新块还可能被排序器改写）。
 */
export function createRpc(o) {
  const urls = [...new Set(o.urls || [])];
  if (!urls.length) throw new RpcError('rpc.none');
  const quorum = Math.max(1, Math.min(o.quorum ?? 2, urls.length));
  const timeoutMs = o.timeoutMs ?? 10_000;
  const hedgeMs = o.hedgeMs ?? 1_500;
  // BNB 官方公共节点（bsc-dataseed*）一包超过 30 多个 eth_call 就整包拒绝（"method eth_call in batch triggered rate limit"，2026-09-18 实测），留足余量
  const maxBatch = o.maxBatch ?? 20;
  const pinTag = o.pin === 'safe' ? 'safe' : 'latest';
  // 每个节点当前的单包上限：从配置值开始，节点拒绝批量时减半（最低 1 = 不用批量，逐个发，最多 4 个并发）
  const batchCap = Object.fromEntries(urls.map((u) => [u, Math.max(1, Math.min(maxBatch, (o.maxBatchByUrl && o.maxBatchByUrl[u]) || maxBatch))]));
  const SINGLE_CONCURRENCY = 4;
  const fetchImpl = o.fetchImpl || globalThis.fetch.bind(globalThis);
  const retries = o.retries ?? 2;                 // 429 / 5xx / 网络错误时的重试次数（每次退避加倍，带抖动）
  const backoffMs = o.backoffMs ?? 400;
  const cooldownMs = o.cooldownMs ?? 20_000;      // 被限流的节点先靠后排这么久，不是不用
  const headGraceMs = o.headGraceMs ?? 1_500;     // 钉区块时凑够 quorum 个头部后再等其余节点多久（防一个快节点报很旧的高度）
  // 严格模式（opts.all）的总时限：一个挂住的节点不能让读取无限等下去。默认模式不设总时限——
  // 大网站一次要几千个请求，按节点串行分批，设了反而会让健康节点上的正常读取失败。
  const strictDeadlineMs = o.strictDeadlineMs ?? Math.round(timeoutMs * 1.5);
  // 严格模式至少要这么多个节点一致回答（默认 3，节点不足 3 个时要求全部）：报错或太慢的节点被忽略，
  // 只要求 quorum(2) 个时，两个串通节点在诚实节点被限流的那一刻就能过关。
  // 运营方：同一家的多个节点只算一票（TAP-10 §8.3、SPEC §4.1）。优先用 o.operators 显式指定；
  // 没指定时按主机名猜：去掉结尾的点，IP 地址各算一家，域名取最后两段。
  const operatorOf = (url) => {
    if (o.operators && o.operators[url]) return String(o.operators[url]);
    let host;
    try { host = new URL(url).hostname.toLowerCase().replace(/\.+$/, ''); } catch { return url; }
    if (/^\[.*\]$/.test(host) || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return host;
    return host.split('.').slice(-2).join('.');
  };
  const operatorCount = new Set(urls.map(operatorOf)).size;
  // 钉块至少要这么多家运营方报了高度（quorum 家，运营方不足时全部）
  const pinNeed = Math.max(1, Math.min(quorum, operatorCount));
  // 严格模式至少 2 家、最多 3 家运营方一致；不足 2 家时严格读取一律失败（宁可读不到，不信任单个节点）。
  // 显式传入 strictQuorum 时照用（本地单节点测试用）。
  const strictQuorum = o.strictQuorum !== undefined ? Math.max(1, o.strictQuorum) : Math.max(2, Math.min(3, operatorCount));
  // 每个节点的统计：状态页显示用；也用来把最近出问题的节点排到后面
  const stats = Object.fromEntries(urls.map((u) => [u, { ok: 0, fail: 0, rateLimited: 0, lastMs: null, lastError: null, cooldownUntil: 0 }]));
  const order = () => {
    const base = o.shuffle === false ? [...urls] : shuffled(urls);
    const now = Date.now();
    base.sort((a, b) => (stats[a].cooldownUntil > now ? 1 : 0) - (stats[b].cooldownUntil > now ? 1 : 0));
    // 同一运营方的节点往后排：先问的几个尽量来自不同运营方，凑法定人数时不会一家的几个域名先占满
    const seen = new Set(), first = [], rest = [];
    for (const u of base) { const op = operatorOf(u); if (seen.has(op)) rest.push(u); else { seen.add(op); first.push(u); } }
    return [...first, ...rest];
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

  // 节点拒绝批量的几种回答：整包一个错误对象（"maximum 10"、"too many"），或每一项都是"batch ... not allowed"
  // 只认明确的"批量太大/不支持批量"：错误码 -32014、-32600，或文字里说批量超限；回滚（code 3、revert）和限流不算
  const refusalText = /batch|too many|maximum \d+|exceeds? .*(limit|size)/i;
  const isRefusal = (e) => e && typeof e === 'object' && !isRevertError(e) && e.code !== -32005 && !/rate.?limit/i.test(String(e.message || ''))
    && (e.code === -32014 || e.code === -32600 || refusalText.test(String(e.message || '')));
  const batchRefused = (resp, n) => n > 1 && (
    (!Array.isArray(resp) && resp && typeof resp === 'object' && isRefusal(resp.error))
    || (Array.isArray(resp) && resp.length > 0 && resp.every((x) => x && isRefusal(x.error))));
  // 不用批量：逐个发，限制并发。返回与批量相同形状的数组
  async function postSingles(url, part) {
    const res = new Array(part.length);
    let k = 0;
    const worker = async () => {
      while (k < part.length) {
        const i = k++;
        try { res[i] = await post(url, part[i]); } catch (e) { res[i] = { id: part[i].id, transport: String(e?.message || e) }; }
      }
    };
    await Promise.all(Array.from({ length: Math.min(SINGLE_CONCURRENCY, part.length) }, worker));
    return res;
  }

  // 在一个节点上跑一组请求 → 每个请求一个结果：{ok,value} | {revert,data} | {err}。永不抛错。
  async function runOn(url, reqs) {
    const out = [];
    for (let i = 0; i < reqs.length;) {
      const size = batchCap[url];
      // 上限为 1 时逐个发：一次拿一大段交给 postSingles，才能真的 4 个并发
      const src = reqs.slice(i, i + (size === 1 ? 20 : size));
      const part = src.map((q, k) => ({ jsonrpc: '2.0', id: i + k + 1, method: q.method, params: q.params }));
      if (size === 1) {
        const resp = await postSingles(url, part);
        pushResults(out, src, part, resp.map((x, k) => (x && x.transport ? { id: part[k].id, error: { message: x.transport } } : x)));
        i += part.length;
        continue;
      }
      let resp;
      // BNB 官方公共节点按秒限流整包请求：超限时返回一个 id 为 null 的 -32005 错误（"... in batch triggered rate limit"），
      // 整包都没有结果。等一会儿整包重试，最多 3 次（2026-09-18 实测：连续几包就会触发）
      for (let attempt = 0; ; attempt++) {
        try { resp = await post(url, part); } catch (e) { resp = e; break; }
        const limited = Array.isArray(resp) && resp.length < part.length && resp.some((x) => x && x.id === null && x.error && x.error.code === -32005);
        if (!limited || attempt >= 3) break;
        stats[url].rateLimited++;
        await sleep(600 * 2 ** attempt * (0.7 + Math.random() * 0.6));
      }
      if (!(resp instanceof Error) && batchRefused(resp, part.length)) {
        batchCap[url] = Math.max(1, Math.min(batchCap[url], Math.floor(part.length / 2)));   // 缩小后重发这一段（并发请求不会把它抬回去）
        continue;
      }
      i += part.length;
      if (resp instanceof Error) { for (let k = 0; k < part.length; k++) out.push({ err: String(resp?.message || resp) }); continue; }
      if (!Array.isArray(resp)) { for (let k = 0; k < part.length; k++) out.push({ err: 'bad batch response' }); continue; }
      pushResults(out, src, part, resp);
    }
    return out;
  }

  function pushResults(out, src, part, resp) {
    const byId = new Map(resp.filter((x) => x && typeof x === 'object').map((x) => [x.id, x]));
    for (const [k, q] of part.entries()) try {
      const x = byId.get(q.id);
      const normalize = src[k].normalize;
      if (!x) out.push({ err: 'missing response' });
      else if (x.error) out.push(isRevertError(x.error) ? { revert: true, data: typeof x.error.data === 'string' ? x.error.data : '0x' } : { err: String(x.error.message || 'rpc error') });
      else if (q.method === 'eth_getLogs') { const logs = normalizeLogs(x.result); out.push(logs ? { ok: true, value: JSON.stringify(logs), logs } : { err: 'bad logs' }); }
      else if (typeof x.result === 'string') out.push({ ok: true, value: x.result });
      // 按块号查区块头回 null：这个节点还没同步到那一块，按"没答上"处理，不当成一个不同的答案（否则严格读取会误判分歧）
      else if (x.result === null && q.method === 'eth_getBlockByNumber' && /^0x[0-9a-f]+$/i.test(String(q.params?.[0] ?? ''))) out.push({ err: 'block not available on this node' });
      // 区块、交易、回执等对象结果：按规范化 JSON 比较。不同节点会多带或算法不同的无关字段（例如区块 size），
      // 请求可以带 normalize(raw) 只取需要核对的字段；raw 原样返回给调用方。
      else if (x.result === null || typeof x.result === 'boolean' || typeof x.result === 'number' || typeof x.result === 'object') {
        // 带 normalize 时，返回给调用方的就是规范化后的对象：只有被所有节点核对过的字段，没有任何单个节点能控制的字段
        const picked = normalize && x.result !== null ? normalize(x.result) : x.result;
        if (picked === undefined) throw new Error('normalize returned nothing');
        out.push({ ok: true, value: canonicalJson(picked), raw: picked });
      }
      else out.push({ err: 'bad result' });
    } catch (e) {
      out.push({ err: 'bad result: ' + String(e?.message || e) });
    }
  }

  /** outcomes[i] 附带 op（运营方）；一致的回答按不同运营方计数 */
  function tally(outcomes, need = quorum) {
    const groups = new Map();
    for (const oc of outcomes) {
      if (!oc || oc.err) continue;
      const key = oc.ok ? 'v:' + oc.value.toLowerCase() : 'r:' + String(oc.data).toLowerCase();
      const g = groups.get(key) || { ops: new Set(), oc };
      g.ops.add(oc.op); groups.set(key, g);
    }
    if (groups.size > 1) return { status: 'conflict' };
    if (!groups.size) return { status: 'short' };
    const [g] = groups.values();
    const { op: _op, ...outcome } = g.oc;   // 运营方只用来计数，不交给调用方
    return g.ops.size >= need ? { status: 'ok', outcome } : { status: 'short' };
  }

  /**
   * 一组请求，按法定人数核对。返回每个请求的结果 {ok,value} 或 {revert,data}。
   * opts.all：问所有节点、等它们都回答（或超过 strictDeadlineMs），收到的回答里只要有分歧就拒绝，
   *   且一致的回答不少于 strictQuorum 个（默认 3）。
   *   用在"少数节点串通就能造假"的读取上（TapeSend 的消息核验、公钥读取）：默认模式凑够 quorum 个一致就采用，
   *   串通的 quorum 个节点抢先回答时，诚实节点根本不会被问到。
   */
  function many(reqs, opts = {}) {
    if (!reqs.length) return Promise.resolve([]);
    const nodes = order();
    const answers = [];
    let next = 0, inflight = 0, done = false, timer = null, deadline = null;
    return new Promise((resolve, reject) => {
      const finish = (fn, v) => { if (done) return; done = true; clearTimeout(timer); clearTimeout(deadline); fn(v); };
      const need = opts.all ? strictQuorum : quorum;
      const shortError = () => {
        const errs = answers.flatMap((a) => a.filter((x) => x && x.err).map((x) => x.err));
        return new RpcError('rpc.short', { quorum: need }, { errors: [...new Set(errs)].slice(0, 5) });
      };
      const launch = () => {
        if (next >= nodes.length) return false;
        const url = nodes[next++];
        inflight++;
        const op = operatorOf(url);
        runOn(url, reqs)
          .catch((e) => reqs.map(() => ({ err: String(e?.message || e) })))
          .then((a) => { inflight--; answers.push(a.map((x) => (x ? { ...x, op } : x))); check(); });
        return true;
      };
      const verdictsNow = () => reqs.map((_, i) => tally(answers.map((a) => a[i]), need));
      const check = (final = false) => {
        if (done) return;
        const verdicts = verdictsNow();
        const bad = verdicts.findIndex((v) => v.status === 'conflict');
        if (bad >= 0) return finish(reject, new RpcError('rpc.conflict', {}, { request: reqs[bad] }));
        if (opts.all) {
          if (inflight > 0 && !final) return;
          return verdicts.every((v) => v.status === 'ok') ? finish(resolve, verdicts.map((v) => v.outcome)) : finish(reject, shortError());
        }
        if (verdicts.every((v) => v.status === 'ok')) return finish(resolve, verdicts.map((v) => v.outcome));
        if (inflight === 0 && !launch()) finish(reject, shortError());
      };
      if (opts.all) {
        deadline = setTimeout(() => check(true), strictDeadlineMs);
        while (launch());
        return;
      }
      const arm = () => { timer = setTimeout(() => { if (!done && launch()) arm(); }, hedgeMs); };
      for (let i = 0; i < quorum; i++) launch();
      arm();
    });
  }

  /** 选一个至少 quorum 个节点都已经有的区块高度（第 quorum 高的头部再往回 2 个块，避开刚出的块被重组）。
   *  pin 为 'safe' 时改读各节点的安全区块，取第 quorum 高的那个、不再往回退。
   *  凑够 quorum 个回复后最多再等 headGraceMs（默认 1.5 秒）让其余节点回答：只等 400 ms 时，
   *  一个抢先回答、故意报很旧高度的节点就能把钉住的区块压到过去。 */
  let lastPinLag = 0n;
  async function pinBlock() {
    const heads = [];   // { op, n }
    await new Promise((resolve) => {
      let pending = urls.length, grace = null;
      const done = () => { clearTimeout(grace); resolve(); };
      for (const u of urls) {
        const req = pinTag === 'safe'
          ? { method: 'eth_getBlockByNumber', params: ['safe', false], normalize: (b) => ({ number: String(b.number) }) }
          : { method: 'eth_blockNumber', params: [] };
        runOn(u, [req]).then((r) => {
          const x = r[0];
          const v = x && x.ok ? (pinTag === 'safe' ? x.raw && x.raw.number : x.value) : null;
          if (typeof v === 'string' && /^0x[0-9a-f]+$/i.test(v)) heads.push({ op: operatorOf(u), n: BigInt(v) });
          pending--;
          if (pending === 0) done();
          else if (new Set(heads.map((h) => h.op)).size >= pinNeed && !grace) grace = setTimeout(done, headGraceMs);
        });
      }
    });
    // 按运营方计票：同一运营方的多个节点只算一票，取它们报的最低高度（X Layer 的 OKX 有两个域名、又是排序器，
    // 按节点计票时它一家就能决定钉在哪个块）。再在运营方之间取第 pinNeed 高的
    const byOp = new Map();
    for (const h of heads) if (!byOp.has(h.op) || h.n < byOp.get(h.op)) byOp.set(h.op, h.n);
    const ops = [...byOp.values()].sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));
    if (ops.length < pinNeed) throw new RpcError('rpc.heads', { n: ops.length });
    const n = pinTag === 'safe' ? ops[pinNeed - 1] : ops[pinNeed - 1] - 2n;
    // 记下这次钉块离"各运营方报的最高块"差多少块：一家报很旧的高度能把钉块压到过去，调用方据此拒绝（不依赖本机时钟）
    lastPinLag = ops[0] - n;
    return '0x' + n.toString(16);
  }

  const calls = (items, block) => many(items.map((it) => ({ method: 'eth_call', params: [{ to: it.to, data: it.data }, block] })));
  const storageAt = (addr, slot, block) => many([{ method: 'eth_getStorageAt', params: [addr, slot, block] }]).then((r) => r[0]);
  /** 事件日志（按法定人数核对）。公共节点对范围有限制，调用方自己分段。 */
  const getLogs = (filter, opts) => many([{ method: 'eth_getLogs', params: [filter] }], opts).then((r) => (r[0].ok ? r[0].logs : []));

  /** 每个节点的成功/失败/限流次数、最近一次耗时与错误、冷却到期时间（状态页显示用） */
  const getStats = () => Object.fromEntries(urls.map((u) => [u, { ...stats[u] }]));

  return { urls, quorum, strictQuorum, operatorCount, operatorOf, many, calls, storageAt, pinBlock, pinLag: () => lastPinLag, getLogs, stats: getStats, pin: pinTag, batchLimits: () => ({ ...batchCap }) };
}
