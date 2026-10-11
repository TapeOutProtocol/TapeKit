// Cloudflare Worker 外壳。两档：
//   自验档   4246-0.网关域名        静态资源原样发（引导页 + Service Worker），服务器从不经手链上内容
//   兼容档   4246-0-open.网关域名   这里自己从链上读、核对哈希，直接把文件发回去
// 兼容档是给装不上 Service Worker 的浏览器用的（App 内置浏览器、隐私模式）：自验档在那些浏览器里
// 一个字都显示不出来，引导页会把它们跳到这里。代价是校验发生在网关，访问者要信任网关 —— 所以它是
// 单独的子域名（地址栏上看得见自己在哪一档），而不是悄悄降级。两档共用 serve.js 里那一份响应头。
import { createKernel, createMemoryCache, parseHostLabel, formatName, setLocale, statusText, InputError, KernelError } from '../kernel/src/index.js';
import { messagePage, pickLocale } from './pages.js';
import { OPEN_SUFFIX, GATEWAY_PATHS, LOCKED_CSP, docPage, fileResponse } from './serve.js';

/** 4246-0-open.网关域名 → 链上名字 + 自验档的主机名；不是兼容档的主机名返回 null */
function openHost(hostname) {
  if (hostname.endsWith('.')) return null;   // 结尾带点是另一个来源：交给静态那条路，按写法不对处理
  const parts = hostname.split('.');
  if (!parts[0].endsWith(OPEN_SUFFIX)) return null;
  const bare = parts[0].slice(0, -OPEN_SUFFIX.length);
  const p = parseHostLabel(bare);
  if (!p) return null;
  return { name: formatName(p.tokenId, p.cpu, 'tape', p.area), verifyHost: [bare, ...parts.slice(1)].join('.'), rootHost: parts.slice(1).join('.') };
}

// 内核在每个隔离实例里建一次（读过的文件按链上 sha 存在内存里，省掉重复的节点请求）
let booting = null, blocklist = new Set(), blocklistJob = null, blocklistAt = 0, hostConfig = {};
const assetText = (env, origin, path) => env.ASSETS.fetch(new URL(path, origin)).then((r) => (r.ok ? r.text() : ''));
function kernelOf(env, origin) {
  // 失败要把这个 promise 清掉：否则一次读不到配置，之后每个请求都拿到同一个已经失败的 promise
  booting ||= (async () => {
    hostConfig = JSON.parse((await assetText(env, origin, '/.tape/config.json')) || '{}');
    const rpcUrls = Array.isArray(hostConfig.rpcUrls) && hostConfig.rpcUrls.length ? hostConfig.rpcUrls : undefined;
    // 屏蔽名单在这一档也必须生效：否则兼容档就成了绕过名单的后门
    return createKernel({ cache: createMemoryCache(), rpcUrls, isBlocked: ({ container, name }) => blocklist.has(String(container).toLowerCase()) || blocklist.has(name) });
  })().catch((e) => { booting = null; throw e; });
  return booting;
}
// 名单取回来之前并发进来的请求必须等同一个 promise：只记时间的话，第一个请求还在取名单，
// 同时进来的请求会看到「刚取过」直接往下走，拿着空名单去解析 —— 被屏蔽的站点就漏出去了。
// 取失败则把时间戳清零，让下一个请求重试，而不是整整 10 分钟都当没有名单。
function refreshBlocklist(env, origin) {
  if (blocklistJob && Date.now() - blocklistAt < 10 * 60_000) return blocklistJob;
  blocklistAt = Date.now();
  const url = hostConfig.blocklistUrl || '/.tape/blocklist.txt';
  blocklistJob = (async () => {
    const text = url.startsWith('/') ? await assetText(env, origin, url) : await fetch(url).then((r) => (r.ok ? r.text() : ''));
    if (text) blocklist = new Set(text.split('\n').map((l) => l.trim().toLowerCase()).filter((l) => l && !l.startsWith('#')));
  })().catch(() => { blocklistAt = 0; });
  return blocklistJob;
}

/** 兼容档：从链上读出这条路径的文件，核对过哈希再返回 */
async function fromChain(request, env, url, site) {
  const locale = pickLocale(request.headers.get('accept-language'));
  setLocale(locale);   // 内核抛出的错误串也要按这个请求的语言生成（错误页会把它原样显示）
  const statusTextOf = (s) => { setLocale(locale); return statusText(s); };
  const page = (kind, status, extra = {}, headers = {}) => docPage(messagePage({ locale, kind, host: url.hostname, statusTextOf, ...extra }), status, headers);
  const kernel = await kernelOf(env, url.origin);
  await refreshBlocklist(env, url.origin);

  // 读清单、读文件一样会撞上节点不足（服务器上所有访客共用一个出口 IP，比浏览器里更容易撞），
  // 所以整段都要在 try 里：漏在外面的话这种常见故障会变成一个光秃秃的 500，没有说明也没有 retry-after
  try {
    const res = await kernel.resolve(site.name);
    // 这一档说明自己是怎么读的，并指回自验档。没有「开发预览」：那是存在访问者浏览器里的设置，服务器上没有
    if (url.pathname === '/.tape/status') return page('server-read', 200, { res, vars: { verifyHost: site.verifyHost } });
    if (res.status !== 'ok') {
      const code = res.status === 'blocked' ? 451 : res.status === 'unpaid' ? 402 : res.status === 'store-changed' ? 503 : 404;
      return page(res.status === 'unpaid' ? 'unpaid' : 'status', code, { res }, { 'x-tape-name': res.name || '', 'x-tape-status': res.status });
    }
    const idHeaders = { 'x-tape-name': res.name, 'x-tape-status': res.status, 'x-tape-container': res.container, 'x-tape-block': res.block };
    const file = await (await kernel.openSite(res)).get(url.pathname);
    if (!file) return page('not-found', 404, { res, vars: { path: url.pathname } }, idHeaders);
    if (file.status === 'too-large') return page('too-large', 413, { res, vars: { path: file.path } }, idHeaders);
    if (file.status !== 'ok' && file.status !== 'no-hash') return page('not-verified', 502, { res, vars: { path: file.path } }, idHeaders);
    return fileResponse(file, idHeaders, 'server');
  } catch (err) {
    if (err instanceof InputError) return page('bad-host', 400, { vars: { root: site.rootHost } });
    if (!(err instanceof KernelError)) throw err;   // 真·意外交给 500，不要伪装成「节点不足」
    return page('rpc', 502, { vars: { quorum: kernel.rpc.quorum, err: err.message } }, { 'retry-after': '5' });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // 网站沙盒框架里的 CSP 违规报告不经过 Service Worker、会直接发到这里：不记录（里面可能带访客数据），直接 204
    if (url.pathname === '/.tape/csp-report') return new Response(null, { status: 204 });
    const site = openHost(url.hostname);
    // 网关自己的那几个路径（/sw.js、/.tape/ 下的）两档都从服务器取，站点顶不掉；其余都走链
    if (site && !GATEWAY_PATHS.test(url.pathname)) {
      return fromChain(request, env, url, site).catch((err) => docPage(`<pre>${String(err?.message || err).replace(/</g, '&lt;')}</pre>`, 500));
    }
    const res = await env.ASSETS.fetch(request);
    const h = new Headers(res.headers);
    h.set('x-content-type-options', 'nosniff');
    h.set('cache-control', 'no-cache');
    // 引导页（/、/index.html）要跑脚本，Service Worker 脚本（/sw.js）要读链，不加；其余静态文件被当成文档打开时什么都不许做
    if (!['/', '/index.html', '/sw.js'].includes(url.pathname)) h.set('content-security-policy', LOCKED_CSP);
    return new Response(res.body, { status: res.status, headers: h });
  },
};
