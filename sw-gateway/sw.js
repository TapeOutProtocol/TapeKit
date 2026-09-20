// tape:// 网关的 Service Worker（模块）。装好之后，这个来源下的每个请求都由它处理：
//   - 网站文件：从主机名推出链上名字，用内核读链、多节点核对、SHA-256 校验，再交给页面；
//   - 链外访问：放行并记录（钱包连接、视频流、外部接口都要用）；网站的代码（脚本）只能来自链上；
//   - /.tape/status：身份、校验、拦截、节点情况和设置；/.tape/settings：保存设置（表单 POST，无脚本）。
// 服务器只负责发引导页和这些静态文件（/sw.js、/.tape/kernel/…、/.tape/pages.js），从不经手链上内容。
//
// 主机名格式：<#ID>-<处理器编号>.<网关域名>，例如 4246-0.tape.example → 链上名字 4246.0.tape；
// 其他链带区号：1-2-344.tape.example → 1.2.344.tape（X Layer）。
// 用横线是因为通配证书只覆盖一层子域名。

import { createKernel, createIdbCache, createMemoryCache, InputError, RpcError, scanHtml, scanCss, setLocale, statusText, BSC_MAINNET, formatName, parseHostLabel, networkByArea, networkByChainId, siteNodes } from './.tape/kernel/index.js';
import { statusPage, messagePage, pickLocale, tr } from './.tape/pages.js';

const VERSION = '0.3.0';   // 0.3.0：链外访问放行并记录，脚本只能来自链上；0.2.0：三链（区号）、网站 CSP、去掉可被网站改写的节点设置
const NETWORK_PATHS = /^\/(sw\.js$|\.tape\/(kernel\/|boot\.js$|pages\.js$|policy\.html$|blocklist\.txt$|config\.json$))/;   // 这些从服务器取，其余都走链
const SETTINGS_KEY = 'gw-settings:v1';
const MAX_LOG = 200;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

// ---- 设置与缓存（都在 IndexedDB，只存在用户浏览器里）
let cache = null, kernel = null, settings = null, hostConfig = null, blocklist = new Set(), blocklistAt = 0;
async function boot() {
  if (kernel) return;
  cache = await createIdbCache('hashport-gateway').catch(() => createMemoryCache());
  settings = (await cache.get(SETTINGS_KEY))?.meta || {};
  settings.userBlocklist ||= [];
  // "自定义节点"设置已去掉：设置存在网站自己的来源里，网站脚本能直接改它，换成自己的节点、让网关显示假内容（审计第三轮）。
  // "允许链外请求"也不再需要：链外访问现在默认放行并记录。旧版本存下的值一律作废
  delete settings.allowOffchain; delete settings.rpcUrls;
  hostConfig = await fetch('/.tape/config.json', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
  // 节点只来自网关运营方的配置（config.json），访客和网站都改不了
  const rpcUrls = Array.isArray(hostConfig.rpcUrls) && hostConfig.rpcUrls.length ? hostConfig.rpcUrls : undefined;
  kernel = createKernel({ cache, rpcUrls, locale: settings.locale, isBlocked: ({ container, name }) => blocklist.has(container.toLowerCase()) || blocklist.has(name) || settings.userBlocklist.includes(name) });
}
const saveSettings = () => cache.set(SETTINGS_KEY, settings, new Uint8Array());
async function refreshBlocklist() {
  if (Date.now() - blocklistAt < 10 * 60_000) return;
  blocklistAt = Date.now();
  try {
    const r = await fetch(hostConfig.blocklistUrl || '/.tape/blocklist.txt', { cache: 'no-store' });
    if (r.ok) blocklist = new Set((await r.text()).split('\n').map((l) => l.trim().toLowerCase()).filter((l) => l && !l.startsWith('#')));
  } catch { /* 没有名单就不屏蔽 */ }
}

// ---- 每个网站一个句柄：解析结果 + 按需读取 + 本次会话的记录（文件、链外引用、拦截）
const sites = new Map();   // name → handle
const HANDLE_MAX_AGE = 2 * 60_000;
async function siteFor(name, { fresh = false } = {}) {
  const old = sites.get(name);
  if (old && !fresh && Date.now() - old.at < HANDLE_MAX_AGE) return old;
  if (old && old.loading && !fresh) return old.loading;
  const h = old || { name, files: [], external: [], blocked: [], offchain: [], at: 0 };
  h.loading = (async () => {
   try {
    const res = await kernel.resolve(name, { fresh: fresh || !!old });
    const showable = res.status === 'ok' || (!!settings.devPreview && res.status === 'unpaid');
    // 解析结果变了（例如换了持有人、站长更新）就重开句柄；否则只更新时间
    if (!h.site || !h.res || h.res.block !== res.block || h.res.status !== res.status) { h.site = showable ? await kernel.openSite(res) : null; h.res = res; }
    h.at = Date.now(); h.showable = showable;
    sites.set(name, h);
    return h;
   } finally { h.loading = null; }   // 失败也要清掉：否则这个网站之后一直等一个已经失败的读取
  })();
  return h.loading;
}
// 满了丢**最新**的，不丢最早的：早期记录才是证据。原来丢最早的，网站发 200 条噪音就能把真证据挤掉（审计 2026-09-20）
const push = (arr, item, key = 'url') => { if (arr.length < MAX_LOG && !arr.some((x) => x[key] === item[key])) arr.push(item); };
// 子域名第一段：#ID-处理器编号（BNB），或 #ID-区号-处理器编号（X Layer = 2、Base = 3）
const labelOf = (hostname) => {
  if (hostname.endsWith('.')) return null;   // 4246-0.tapekit.org. 和不带点的是两个来源：拒绝
  const p = parseHostLabel(hostname.split('.')[0]);
  return p ? { name: formatName(p.tokenId, p.cpu, 'tape', p.area), area: p.area, rootHost: hostname.split('.').slice(1).join('.') } : null;
};
/** 链上网站可以直接访问的节点：只有它所在那条链的、不读调用方密钥的节点（所在链由主机名里的区号决定，不依赖内存状态） */
const siteNodeSet = (label) => { const net = label && networkByArea(label.area); return new Set((net ? siteNodes(net) : []).map((u) => new URL(u).href)); };
/**
 * 网站文件的内容安全策略。链外的数据可以访问：接口、图片、字体、样式、视频流、WebSocket、嵌入的播放器和
 * 钱包连接（WalletConnect 要连它的中继和验证页）——这些是网站能做起来的前提。
 * 但网站的代码只能来自链上：script-src 不放任何链外地址，Worker 只能是同源或 blob。
 * 子框架（沙盒、srcdoc、blob、data）继承这条策略，同样拉不到链外脚本。链外访问记在状态页，
 * 有链外访问的网站不显示「100% 链上」。
 */
const siteCsp = () => [
  "default-src 'self' blob: data:",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:",
  "style-src 'self' 'unsafe-inline' blob: data: https:",
  "img-src 'self' blob: data: https:", "font-src 'self' blob: data: https:", "media-src 'self' blob: data: https:",
  "connect-src 'self' blob: data: https: wss:",
  "frame-src 'self' https:", "worker-src 'self' blob:", "object-src 'none'", "base-uri 'self'", "form-action 'self' https:",
  // 只允许同源把自己嵌进框架：否则任何网页都能把链上网站整页框住做点击劫持（连钱包的站尤其要紧）
  "frame-ancestors 'self'",
  'report-uri /.tape/csp-report',
].join('; ');
// 网站所在链的节点（状态页只列这条链的）；还没解析出来时用汇总
/** 节点统计：只给主机名（不含路径、查询串），不给完整网址 */
const nodeSummary = (rpc) => Object.fromEntries(Object.entries(rpc.stats()).map(([u, s]) => [new URL(u).host, { ok: s.ok, fail: s.fail, rateLimited: s.rateLimited, lastMs: s.lastMs, cooldownUntil: s.cooldownUntil }]));
const chainRpc = (res) => (res && res.chainId && kernel.kernelFor && kernel.kernelFor(res.chainId)?.rpc) || kernel.rpc;
const withCharset = (ct) => (/^(text\/|application\/(javascript|json|xml))/i.test(ct) && !/charset=/i.test(ct) ? ct + '; charset=utf-8' : ct);
const isHtml = (f) => /html/i.test(f.contentType) || /\.html?$/i.test(f.path);
const isCss = (f) => /css/i.test(f.contentType) || /\.css$/i.test(f.path);
// 网关自己生成的页面（状态页、提示页、错误页）也必须带 CSP：否则网站可以把它们嵌进框架当跳板，
// 在里面再开子框架绕过网站的 CSP（审计第三轮）。这些页面没有脚本，只需要内联样式和同源表单
const DOC_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'self'; frame-src 'none'; base-uri 'none'; frame-ancestors 'none'";
// 数据类响应（状态 JSON、转给服务器的静态文件被当成文档打开时）：什么都不许
const LOCKED_CSP = "default-src 'none'; sandbox";
const html = (body, status = 200, headers = {}) => new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': DOC_CSP, ...headers } });
const DOCUMENT_DEST = new Set(['document', 'iframe', 'frame', 'embed', 'object']);
/** 转给服务器的文件：被当成文档打开（嵌进框架、新窗口）时加上 LOCKED_CSP */
async function passThrough(req) {
  const r = await fetch(req);
  if (!DOCUMENT_DEST.has(req.destination)) return r;
  const h = new Headers(r.headers);
  h.set('content-security-policy', LOCKED_CSP);
  return new Response(r.body, { status: r.status, statusText: r.statusText, headers: h });
}
const localeFor = (req) => pickLocale(req.headers.get('accept-language'), settings.locale);
const statusTextOf = (locale) => (s) => { setLocale(locale); return statusText(s); };

// ---- 请求分发
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin === self.location.origin) {
    if (NETWORK_PATHS.test(url.pathname)) return e.respondWith(passThrough(e.request));   // 引导页资源：交给网络（当成文档打开时加锁）
    e.respondWith(own(e, url).catch((err) => html(`<!doctype html><meta charset="utf-8"><pre>${String(err?.stack || err).replace(/</g, '&lt;')}</pre>`, 500)));
  } else {
    // 链外请求不经过 Service Worker 转手（视频的分段请求、流式响应、WebSocket 握手都由浏览器直接发），只记录
    e.waitUntil(noteExternal(e, url).catch(() => {}));
  }
});

async function own(e, url) {
  await boot();
  const req = e.request;
  const locale = localeFor(req);
  const label = labelOf(url.hostname);
  if (url.pathname === '/.tape/settings' && req.method === 'POST') return saveFromForm(req, label);
  // 浏览器按网站 CSP 拦下链外请求时发来的违规报告：记进这个网站的"已拦截"列表（状态页显示）。
  // 这些请求 Service Worker 本身看不到（被浏览器先拦了，或出自子框架）
  if (url.pathname === '/.tape/csp-report' && req.method === 'POST') {
    try {
      // 只收浏览器自己发的同源报告：别的网站用表单伪造的报告（Sec-Fetch-Site 不是 same-origin）不记；正文先看长度再读
      const sfs = req.headers.get('sec-fetch-site');
      const ct = String(req.headers.get('content-type') || '');
      const lenHeader = req.headers.get('content-length');
      const lenOk = lenHeader === null || (Number(lenHeader) > 0 && Number(lenHeader) < 20_000);
      let body = '';
      if ((sfs === 'same-origin' || sfs === null) && /application\/(csp-report|json)/i.test(ct) && lenOk) {
        // 没有长度头时边读边数，超过 20 KB 就丢弃
        const reader = req.body ? req.body.getReader() : null;
        let n = 0; const parts = [];
        while (reader) { const { done, value } = await reader.read(); if (done) break; n += value.length; if (n >= 20_000) { parts.length = 0; break; } parts.push(value); }
        body = new TextDecoder().decode(parts.length ? new Uint8Array(parts.flatMap((x) => [...x])) : new Uint8Array());
      }
      if (body && body.length < 20_000 && label) {
        const r = JSON.parse(body)['csp-report'] || {};
        const blockedUri = String(r['blocked-uri'] || '');
        const h = sites.get(label.name);
        if (h && /^(https?|wss?):/i.test(blockedUri)) push(h.blocked, { url: blockedUri.slice(0, 500), type: String(r['effective-directive'] || r['violated-directive'] || 'csp').slice(0, 40) });
      }
    } catch { /* 格式不对就不记 */ }
    return new Response(null, { status: 204 });
  }
  if (!label) {
    // 网关根域名（没有网站段）：由引导页自己当首页；其它路径按 404
    if (url.pathname === '/' || url.pathname === '/index.html') return fetch(req);
    return html(messagePage({ locale, kind: 'bad-host', host: url.hostname, vars: { root: url.hostname } }), 400);
  }
  await refreshBlocklist();
  let h;
  try { h = await siteFor(label.name, { fresh: url.searchParams.has('tape-reload') && req.mode === 'navigate' }); }
  catch (err) {
    if (err instanceof InputError) return html(messagePage({ locale, kind: 'bad-host', host: url.hostname, vars: { root: label.rootHost } }), 400);
    return html(messagePage({ locale, kind: 'rpc', host: url.hostname, vars: { quorum: kernel.rpc.quorum, err: err?.message || String(err) } }), 502, { 'retry-after': '5' });
  }
  const res = h.res;
  if (url.pathname === '/.tape/status') {
    if (url.searchParams.has('json')) return new Response(JSON.stringify(statusJson(h, label), null, 2), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': LOCKED_CSP } });
    return html(statusPage({ locale, res, host: url.hostname, files: h.files, external: h.external, blocked: h.blocked, offchain: h.offchain, nodes: nodeSummary(chainRpc(res)), quorum: chainRpc(res).quorum, settings: { devPreview: !!settings.devPreview }, blockedByUser: settings.userBlocklist.includes(label.name), reportUrl: hostConfig.reportUrl ? String(hostConfig.reportUrl).replace('{name}', encodeURIComponent(label.name)) : '', statusTextOf: statusTextOf(locale) }));
  }
  if (!h.showable) {
    const code = res.status === 'blocked' ? 451 : res.status === 'unpaid' ? 402 : res.status === 'store-changed' ? 503 : 404;
    return html(messagePage({ locale, kind: res.status === 'unpaid' ? 'unpaid' : 'status', res, host: url.hostname, statusTextOf: statusTextOf(locale) }), code, { 'x-tape-name': res.name || '', 'x-tape-status': res.status });
  }
  const file = await h.site.get(url.pathname);
  const idHeaders = { 'x-tape-name': res.name, 'x-tape-status': res.status, 'x-tape-container': res.container, 'x-tape-block': res.block };
  if (!file) return html(messagePage({ locale, kind: 'not-found', res, host: url.hostname, vars: { path: url.pathname }, statusTextOf: statusTextOf(locale) }), 404, idHeaders);
  if (file.status === 'too-large') return html(messagePage({ locale, kind: 'too-large', res, host: url.hostname, vars: { path: file.path }, statusTextOf: statusTextOf(locale) }), 413, idHeaders);
  if (file.status !== 'ok' && file.status !== 'no-hash') return html(messagePage({ locale, kind: 'not-verified', res, host: url.hostname, vars: { path: file.path }, statusTextOf: statusTextOf(locale) }), 502, idHeaders);
  push(h.files, { path: file.path, size: file.size, status: file.status, sha: file.sha256 }, 'path');
  if (isHtml(file) || isCss(file)) {
    const text = new TextDecoder('utf-8', { fatal: false }).decode(file.bytes);
    for (const x of (isHtml(file) ? scanHtml(text) : scanCss(text))) push(h.external, { ...x, path: file.path });
  }
  return new Response(file.bytes, { status: 200, headers: {
    'content-type': withCharset(file.contentType), 'content-length': String(file.bytes.length), 'cache-control': 'no-cache',
    'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-tape-sha256': file.sha256, 'x-tape-verified': file.verified ? '1' : '0', ...idHeaders,
    'content-security-policy': siteCsp(),
  } });
}

/** 链外请求：浏览器照常发出，这里只记进这个网站的"链外访问"列表（状态页显示）。节点地址不记 */
async function noteExternal(e, url) {
  await boot();
  let name = null;
  try { const c = await self.clients.get(e.clientId || e.resultingClientId); if (c) name = labelOf(new URL(c.url).hostname)?.name || null; } catch {}
  // 这个 Service Worker 只管自己这一个来源（一个网站一个子域名）：客户端网址取不到时（blob Worker、srcdoc 框架）按自己的主机名算
  name ||= labelOf(self.location.hostname)?.name || null;
  if (siteNodeSet(labelOf(self.location.hostname)).has(url.href)) return;   // 本链节点不算链外
  // 句柄不在就先建一个：Service Worker 空闲几十秒就会被浏览器回收，重启后 sites 是空的，
  // 原来这里直接 return，于是"页面放着不动、之后才发的链外请求"一律不记录（审计 2026-09-20 实测）
  let h = name && sites.get(name);
  if (!h && name) { h = { name, files: [], external: [], blocked: [], offchain: [], at: 0 }; sites.set(name, h); }
  if (!h) return;
  push(h.offchain, { url: (url.origin + url.pathname).slice(0, 300), type: e.request.destination || e.request.mode });
}

function statusJson(h, label) {
  const r = h.res || {};
  return {
    version: VERSION, name: label.name, short: r.short, label: r.label, chainId: r.chainId, network: r.network, status: r.status, url: r.url, cpu: r.cpu?.toString(), cpuName: r.cpuName, holder: r.holder, container: r.container, block: r.block,
    paid: r.paid, paidUntil: r.paidUntil?.toString(), paidVia: r.paidVia, stores: r.stores, showable: h.showable, devPreview: !!settings.devPreview,
    files: h.files, external: h.external, blocked: h.blocked, offchain: h.offchain, nodes: nodeSummary(chainRpc(r)), quorum: chainRpc(r).quorum, nodeHosts: (networkByChainId(r.chainId)?.rpcs ?? []).map((u) => new URL(u).host), cache: cache.kind,
    settings: { userBlocklist: settings.userBlocklist, locale: settings.locale || null },
  };
}

/** 状态页表单：保存设置后回到状态页。只接受同源表单（Service Worker 只收到本来源的请求；再核对 Sec-Fetch-Site）。 */
async function saveFromForm(req, label) {
  const sfs = req.headers.get('sec-fetch-site');
  if (sfs && sfs !== 'same-origin' && sfs !== 'none') return new Response('forbidden', { status: 403 });
  const form = await req.formData();
  const action = form.get('action');
  if (action === 'lang') settings.locale = (settings.locale || pickLocale(req.headers.get('accept-language'))) === 'zh' ? 'en' : 'zh';
  else if (action === 'clearCache') { await cache.clear(); await saveSettings(); sites.clear(); }
  else if (action === 'block' && label) { if (!settings.userBlocklist.includes(label.name)) settings.userBlocklist.push(label.name); sites.delete(label.name); }
  else if (action === 'unblock' && label) { settings.userBlocklist = settings.userBlocklist.filter((n) => n !== label.name); sites.delete(label.name); }
  else {
    // 开发预览只接受用户真的点了按钮的提交：Sec-Fetch-User: ?1 只有真实用户交互才会带上，
    // 网站脚本 fetch 出来的 POST 带不了它。原来网站能自己打开它，等名字欠费后照样给老访客显示（审计 2026-09-20）
    if (req.headers.get('sec-fetch-user') !== '?1') return new Response('forbidden', { status: 403 });
    const wasDev = !!settings.devPreview; settings.devPreview = !!form.get('devPreview');
    if (wasDev !== settings.devPreview) sites.clear();
  }
  if (kernel) kernel.setLocale(settings.locale || 'zh');
  await saveSettings();
  if (!kernel) await boot();
  return Response.redirect(String(form.get('back') || '/.tape/status'), 303);
}
