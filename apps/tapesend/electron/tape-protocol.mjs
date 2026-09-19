// tape:// 协议处理器：把内核接到 Electron 的网络层。
// 页面请求 tape://4246.0.tape/index.html（X Layer、Base 上的网站：tape://1.2.344.tape/…）→ 内核按区号选链、解析名字 → 从链上读文件、校验哈希 → 作为 HTTP 响应交给渲染进程。
// 每个站点是一个真实来源（origin），所以 localStorage、cookie、钱包 provider 都按站点隔离。
import { createKernel, createFsCache, statusText, InputError, RpcError, SiteError } from '../../../kernel/src/index.js';

const RESOLVE_TTL_MS = 30_000;
const NETWORK_NAMES = { 56: 'BNB Chain', 196: 'X Layer', 8453: 'Base' };
const MAX_HANDLES = 64;

/** 插进 HTML 的一切值都要转义 */
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/** 提示页只用内联样式，不允许任何脚本、图片、外部请求 */
const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";

export async function createTapeProtocol({ cacheDir, locale = 'zh', rpcUrls, isBlocked } = {}) {
  const cache = await createFsCache(cacheDir, { maxBytes: 512 * 1024 * 1024 });
  const kernel = createKernel({ cache, locale, ...(rpcUrls ? { rpcUrls } : {}), ...(isBlocked ? { isBlocked } : {}) });
  // 提示页的语言：跟随应用界面（界面里切换中英文时由主进程改）
  let lang = locale === 'en' ? 'en' : 'zh';
  const L = (zh, en) => (lang === 'en' ? en : zh);
  // 网站所在链的节点；还没解析出来时用 BNB 的
  const chainRpc = (res) => (res && res.chainId && kernel.kernelFor(res.chainId)?.rpc) || kernel.kernelFor(56)?.rpc || kernel.rpc;
  const stText = (s) => statusText(s, 'both')[lang] ?? s;
  /** name → { at, res, site, served: Map<path, SiteFile>, pages: Map<path, string>, offchain: Set<string>, error } */
  const handles = new Map();
  let activeName = null;     // 网站视图正在打开的顶层网站
  const newNameTimes = [];   // 最近一分钟里解析过的"非顶层"新名字的时间
  let committedName = null;  // 网站视图已经显示出来的顶层网站：两者的校验记录都不能被别的请求挤掉
  const remember = (name, h) => {
    handles.delete(name);
    handles.set(name, h);
    for (const key of handles.keys()) {
      if (handles.size <= MAX_HANDLES) break;
      if (key !== activeName && key !== committedName && key !== name) handles.delete(key);
    }
  };

  function nameOf(url) {
    // 主机名就是链上名字：4246.0.tape、1.2.344.tape；宽容接受 4246.0（用户手输）
    const host = url.hostname.toLowerCase();
    return host.endsWith('.tape') ? host : `${host}.tape`;
  }

  // 同一个名字同一时间只解析一次：并发的几百个子请求共用同一次读链
  const inflight = new Map();
  function handle(name, { fresh = false } = {}) {
    const h = handles.get(name);
    if (h && !fresh && Date.now() - h.at < RESOLVE_TTL_MS) return Promise.resolve(h);
    const key = `${fresh ? 'f' : 'c'}:${name}`;
    let p = inflight.get(key);
    if (!p) {
      p = resolveHandle(name, fresh).finally(() => inflight.delete(key));
      inflight.set(key, p);
    }
    return p;
  }

  async function resolveHandle(name, fresh) {
    const now = Date.now();
    let h = handles.get(name);
    try {
      // 缓存过期只走内核自己的缓存；只有用户点刷新（fresh）才强制重新读链
      const res = await kernel.resolve(name, { fresh });
      if (h && h.site && h.res.block === res.block && h.res.status === res.status) {
        h.at = now;
        h.res = res;
        remember(name, h);
        return h;
      }
      const site = res.status === 'ok' ? await kernel.openSite(res) : null;
      h = { at: now, res, site, served: h?.served ?? new Map(), pages: h?.pages ?? new Map(), offchain: h?.offchain ?? new Set(), error: null };
    } catch (error) {
      h = { at: now, res: null, site: null, served: h?.served ?? new Map(), pages: h?.pages ?? new Map(), offchain: h?.offchain ?? new Set(), error };
    }
    // 并发的另一次解析（例如用户点的刷新）已经写回了更新的区块：不拿旧结果覆盖它
    const cur = handles.get(name);
    try {
      if (cur && cur !== h && cur.res && h.res && BigInt(cur.res.block) > BigInt(h.res.block)) return cur;
      if (cur && cur.res && !h.res && cur.at >= now) return cur;
    } catch {
      // 区块号异常时按原逻辑写回
    }
    remember(name, h);
    return h;
  }

  const textResponse = (body, status, type = 'text/html; charset=utf-8', extra = {}) =>
    new Response(body, { status, headers: { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': PAGE_CSP, ...extra } });

  /** lines 里的每一行是已经转义好的 HTML：只能由 html`` 拼出来，外部值一律经过 esc */
  function messagePage(title, lines, meta = '') {
    return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>body{margin:0;font:15px/1.6 -apple-system,"PingFang SC",Helvetica,sans-serif;background:#f7f7f5;color:#16171a;display:flex;min-height:100vh;align-items:center;justify-content:center}
main{max-width:560px;padding:32px}h1{font-size:20px;margin:0 0 12px}p{margin:6px 0;color:#5d6068}code{color:#0f7b55}small{color:#8b8e96}
@media (prefers-color-scheme: dark){body{background:#111214;color:#ececef}p{color:#a7aab2}code{color:#3ddc97}small{color:#767982}}</style></head>
<body><main><h1>${esc(title)}</h1>${lines.map((l) => `<p>${l}</p>`).join('')}<p><small>${esc(meta)}</small></p></main></body></html>`;
  }

  function errorPage(name, error) {
    const msg = esc(error && (error.messages ? error.messages[lang] || error.messages.zh : error.message) || String(error));
    if (error instanceof InputError) return textResponse(messagePage(L('名字格式不对', 'Invalid name'), [L(`<code>${esc(name)}</code> 不是有效的链上名字。`, `<code>${esc(name)}</code> is not a valid on-chain name.`), L('格式：<code>&lt;#ID&gt;.&lt;处理器编号&gt;</code>，例如 <code>4246.0</code>。', 'Format: <code>&lt;#ID&gt;.&lt;processor number&gt;</code>, for example <code>4246.0</code>.')]), 400);
    if (error instanceof RpcError) return textResponse(messagePage(L('暂时读不到链', 'Cannot read the chain right now'), [L('内核要求至少两家互不隶属的节点给出一致答案，现在没凑够。', 'At least two independent node operators must give the same answer, and not enough did.'), `${L('节点法定人数', 'Node quorum')}: ${esc(kernel.rpc.quorum)}`, `<code>${msg}</code>`], L('稍后重试，或在设置里换节点。', 'Try again later, or change nodes in settings.')), 502, undefined, { 'retry-after': '5' });
    if (error instanceof SiteError) return textResponse(messagePage(L('站点读取失败', 'Cannot read the site'), [`<code>${msg}</code>`]), 502);
    return textResponse(messagePage(L('出错了', 'Something went wrong'), [`<code>${msg}</code>`]), 500);
  }

  function statusPage(h, name) {
    const res = h.res;
    const st = stText(res.status);
    const code = res.status === 'blocked' ? 451 : res.status === 'unpaid' ? 402 : res.status === 'store-changed' ? 503 : 404;
    const lines = [`${L('状态', 'Status')}: <b>${esc(st)}</b> (${esc(res.status)})`];
    const chain = NETWORK_NAMES[res.chainId];
    if (chain) lines.push(`${L('所在链', 'Chain')}: ${esc(chain)}`);
    if (res.container) lines.push(`${L('容器', 'Container')}: <code>${esc(res.container)}</code>`);
    if (res.holder) lines.push(`${L('持有人', 'Holder')}: <code>${esc(res.holder)}</code>`);
    if (res.status === 'unpaid') lines.push(L('这个容器还没有付费开通网站，持有人付费后即可访问。', 'This container has not paid for a website yet. It opens once the holder pays.'));
    if (res.status === 'store-changed') lines.push(L('链上合约实现地址与内核内置名单不一致，内核拒绝显示（fail-closed）。', 'The on-chain contract implementation does not match the built-in list, so the page is refused (fail-closed).'));
    return textResponse(messagePage(res.short || name, lines, `${L('区块', 'Block')} ${BigInt(res.block)}`), code, undefined, { 'x-tape-status': res.status });
  }

  function summary(h, name, pagePath, { forSite = false } = {}) {
    const res = h && h.res;
    const files = h ? [...h.served.values()] : [];
    return {
      name,
      // 当前页面本身的结果：verified / unverified / not-found / error / status。只有 verified 才能显示"已验证"
      page: h && pagePath !== undefined ? h.pages.get(pagePath) ?? null : null,
      offchain: h ? [...h.offchain].slice(0, 50) : [],
      status: res ? res.status : (h && h.error ? 'error' : 'loading'),
      statusText: res ? stText(res.status) : (h && h.error ? String(h.error.message || h.error) : ''),
      block: res ? BigInt(res.block).toString() : null,
      container: res ? res.container || null : null,
      holder: res ? res.holder || null : null,
      paidUntil: res && res.paidUntil !== undefined ? res.paidUntil.toString() : null,
      cpuName: res ? res.cpuName || null : null,
      files: files.length,
      verified: files.filter((f) => f.verified).length,
      unverified: files.filter((f) => !f.verified).map((f) => f.path),
      chainId: res ? res.chainId : null,
      network: res ? res.network || null : null,
      short: res ? res.short || null : null,
      quorum: chainRpc(res).quorum,
      // 节点地址只给应用界面看，不给网站（以后换成带密钥的节点时会泄露）。只列这个网站所在链的节点
      ...(forSite ? {} : { nodes: Object.entries(chainRpc(res).stats()).map(([url, s]) => ({ url, ok: s.ok, fail: s.fail })) }),
      cache: cache.kind,
    };
  }

  async function respond(request) {
    const url = new URL(request.url);
    // 主机名结尾带点（4246.0.tape.）：和正规地址看起来一样、却是另一个来源，直接拒绝，不当作同一个网站
    if (url.hostname.endsWith('.')) return textResponse(messagePage(L('地址格式不对', 'Invalid address'), [L('地址的主机名结尾多了一个点。请去掉它再打开。', 'The host name ends with an extra dot. Remove it and try again.')]), 400);
    const name = nameOf(url);
    const rawPath = url.pathname || '/';
    // 超长路径直接拒绝，也不记录：网站能用它把主进程内存撑爆
    if (rawPath.length > 2048) return textResponse(messagePage(L('地址太长', 'Address too long'), [L('这个路径太长了。', 'This path is too long.')]), 414);
    let shown;
    try {
      shown = decodeURIComponent(rawPath);
    } catch {
      return textResponse(messagePage(L('地址格式不对', 'Invalid address'), [L('路径里有无效的百分号编码。', 'The path contains invalid percent-encoding.')]), 400);
    }
    // 顶层网站以外的名字（页面里引用别的链上网站的图片、脚本）限速：每分钟最多解析 20 个新名字。
    // 否则一个页面塞上千个 <img src="tape://N.0.tape/x"> 就能让主进程反复读链，把公共节点的额度耗光
    if (name !== activeName && name !== committedName && !handles.has(name)) {
      const now = Date.now();
      while (newNameTimes.length && now - newNameTimes[0] > 60_000) newNameTimes.shift();
      if (newNameTimes.length >= 20) return textResponse(messagePage('429', [L('这个页面引用了太多别的链上网站，稍后再试。', 'This page references too many other on-chain sites. Try again later.')]), 429, undefined, { 'retry-after': '30' });
      newNameTimes.push(now);
    }
    if (rawPath === '/.tape/status') {
      const h = await handle(name);
      return textResponse(JSON.stringify(summary(h, name, undefined, { forSite: true }), null, 2), 200, 'application/json; charset=utf-8');
    }
    // 不再接受 ?__fresh：刷新只能由应用界面发起（browser:reload），网站不能逼内核反复读链
    const h = await handle(name);
    const mark = (state) => {
      // 只给顶层网站记页面状态（徽章只看它）：别的名字的请求不能把主进程内存越撑越大
      if (name !== activeName && name !== committedName) return;
      h.pages.delete(rawPath);
      h.pages.set(rawPath, state);
      // 超出上限时丢最早的记录，但失败记录优先保留（不让大量 404 请求把"未通过校验"挤掉）；失败记录自己也有上限
      for (const [k, v] of h.pages) {
        if (h.pages.size <= 2000) break;
        if (v !== 'unverified' && k !== rawPath) h.pages.delete(k);
      }
      for (const k of h.pages.keys()) {
        if (h.pages.size <= 2500) break;
        if (k !== rawPath) h.pages.delete(k);
      }
    };
    if (h.error) { mark('error'); return errorPage(name, h.error); }
    if (!h.site) { mark('status'); return statusPage(h, name); }
    let file;
    try {
      file = await h.site.get(rawPath);
    } catch (error) {
      mark('error');
      return errorPage(name, error);
    }
    if (file === null) {
      mark('not-found');
      // 路径是任何人都能构造的，不回显，免得被用来在知名网站名下显示攻击者的文字
      return textResponse(messagePage('404', [L('这个路径不在站点里。', 'This path is not part of the site.')], `tape://${name}`), 404);
    }
    if (file.status === 'too-large') { mark('error'); return textResponse(messagePage(L('文件太大', 'File too large'), [L(`<code>${esc(file.path)}</code> 超过内核单文件上限。`, `<code>${esc(file.path)}</code> exceeds the per-file limit.`)]), 413); }
    // 只记是否通过校验（徽章要用），不留文件内容：内容已经在响应里交出去了，没必要在主进程里再存一份
    h.served.set(file.path, { path: file.path, verified: file.verified });
    if (!file.verified) {
      mark('unverified');
      // 哈希对不上：绝不渲染，明确告诉用户
      return textResponse(messagePage(L('校验失败，拒绝显示', 'Verification failed, not shown'), [L(`<code>${esc(file.path)}</code> 从链上读出的内容与登记的 SHA-256 不一致。`, `The content of <code>${esc(file.path)}</code> read from chain does not match its registered SHA-256.`), L('这个文件可能残缺，或者你连的节点在撒谎；内核不会显示对不上的内容。', 'The file may be incomplete, or a node may be lying. Content that does not match is never shown.')], `tape://${name} ${L('区块', 'block')} ${BigInt(h.res.block)}`), 502, undefined, { 'x-tape-verified': '0' });
    }
    mark('verified');
    const ct = /^(text\/|application\/(javascript|json|xml))/.test(file.contentType) && !/charset=/i.test(file.contentType)
      ? `${file.contentType}; charset=utf-8`
      : file.contentType;
    return new Response(file.bytes, {
      status: 200,
      headers: {
        'content-type': ct,
        'content-length': String(file.bytes.length),
        'cache-control': 'no-cache',
        'x-content-type-options': 'nosniff',
        // 链上网站可以访问链外数据（钱包连接、视频流、接口），但代码只能来自链上：script-src、worker-src 不放链外地址
        // （空白子框架、Worker 继承这条策略）。sandbox 不带 allow-modals / allow-downloads：页面和它新建的空白子框架都不能弹打印面板等模态窗口
        'content-security-policy': "script-src 'self' tape: 'unsafe-inline' 'unsafe-eval' blob:; worker-src 'self' tape: blob:; object-src 'none'; sandbox allow-scripts allow-same-origin allow-forms allow-popups",
        'x-tape-name': name,
        'x-tape-sha256': file.sha256,
        'x-tape-verified': '1',
        'x-tape-block': BigInt(h.res.block).toString(),
      },
    });
  }

  return {
    kernel,
    respond,
    nameOf,
    summary: async (name, pagePath) => summary(await handle(name), name, pagePath),
    /** 记录被拦下的链下请求（由主进程的请求过滤器调用） */
    setActive: (name) => { activeName = name; },
    setCommitted: (name) => { committedName = name; },
    clearPage: (name, path) => { handles.get(name)?.pages.delete(path); },
    noteOffchain: (name, url) => { const h = handles.get(name); if (h) { h.offchain.add(url); if (h.offchain.size > 200) h.offchain.delete(h.offchain.values().next().value); } },
    refresh: (name) => handle(name, { fresh: true }),
    /** 提示页语言跟随应用界面 */
    setLocale: (l) => { lang = l === 'en' ? 'en' : 'zh'; },
  };
}
