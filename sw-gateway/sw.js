// tape:// 网关的 Service Worker（模块）。装好之后，这个来源下的每个请求都由它处理：
//   - 网站文件：从主机名推出链上名字，用内核读链、多节点核对、SHA-256 校验，再交给页面；
//   - 链外请求：默认拦截并记录（SPEC §7.5），用户可在 /.tape/status 逐站放行；
//   - /.tape/status：身份、校验、拦截、节点情况和设置；/.tape/settings：保存设置（表单 POST，无脚本）。
// 服务器只负责发引导页和这些静态文件（/sw.js、/.tape/kernel/…、/.tape/pages.js），从不经手链上内容。
//
// 主机名格式：<#ID>-<处理器编号>.<网关域名>，例如 4246-0.tape.example → 链上名字 4246.0.tape。
// 用横线是因为通配证书只覆盖一层子域名。

import { createKernel, createIdbCache, createMemoryCache, InputError, RpcError, scanHtml, scanCss, setLocale, statusText, BSC_MAINNET } from './.tape/kernel/index.js';
import { statusPage, messagePage, pickLocale, tr } from './.tape/pages.js';

const VERSION = '0.1.0';
const LABEL = /^(0|[1-9][0-9]*)-(0|[1-9][0-9]*)$/;           // 子域名第一段：#ID-处理器编号
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
  settings.allowOffchain ||= {}; settings.userBlocklist ||= []; settings.rpcUrls ||= [];
  hostConfig = await fetch('/.tape/config.json', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
  const rpcUrls = settings.rpcUrls.length ? settings.rpcUrls : Array.isArray(hostConfig.rpcUrls) && hostConfig.rpcUrls.length ? hostConfig.rpcUrls : undefined;
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
  const h = old || { name, files: [], external: [], blocked: [], allowed: [], at: 0 };
  h.loading = (async () => {
    const res = await kernel.resolve(name, { fresh: fresh || !!old });
    const showable = res.status === 'ok' || (!!settings.devPreview && res.status === 'unpaid');
    // 解析结果变了（例如换了持有人、站长更新）就重开句柄；否则只更新时间
    if (!h.site || !h.res || h.res.block !== res.block || h.res.status !== res.status) { h.site = showable ? await kernel.openSite(res) : null; h.res = res; }
    h.at = Date.now(); h.showable = showable; h.loading = null;
    sites.set(name, h);
    return h;
  })();
  return h.loading;
}
const push = (arr, item, key = 'url') => { if (!arr.some((x) => x[key] === item[key])) { arr.push(item); if (arr.length > MAX_LOG) arr.shift(); } };
const labelOf = (hostname) => { const m = hostname.split('.')[0].match(LABEL); return m ? { name: `${m[1]}.${m[2]}.tape`, rootHost: hostname.split('.').slice(1).join('.') } : null; };
const withCharset = (ct) => (/^(text\/|application\/(javascript|json|xml))/i.test(ct) && !/charset=/i.test(ct) ? ct + '; charset=utf-8' : ct);
const isHtml = (f) => /html/i.test(f.contentType) || /\.html?$/i.test(f.path);
const isCss = (f) => /css/i.test(f.contentType) || /\.css$/i.test(f.path);
const html = (body, status = 200, headers = {}) => new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers } });
const localeFor = (req) => pickLocale(req.headers.get('accept-language'), settings.locale);
const statusTextOf = (locale) => (s) => { setLocale(locale); return statusText(s); };

// ---- 请求分发
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin === self.location.origin) {
    if (NETWORK_PATHS.test(url.pathname)) return;                     // 引导页资源：交给网络
    e.respondWith(own(e, url).catch((err) => html(`<!doctype html><meta charset="utf-8"><pre>${String(err?.stack || err).replace(/</g, '&lt;')}</pre>`, 500)));
  } else {
    e.respondWith(external(e, url));
  }
});

async function own(e, url) {
  await boot();
  const req = e.request;
  const locale = localeFor(req);
  const label = labelOf(url.hostname);
  if (url.pathname === '/.tape/settings' && req.method === 'POST') return saveFromForm(req, label);
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
    if (url.searchParams.has('json')) return new Response(JSON.stringify(statusJson(h, label), null, 2), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
    return html(statusPage({ locale, res, host: url.hostname, files: h.files, external: h.external, blocked: h.blocked, allowed: h.allowed, nodes: kernel.rpc.stats(), quorum: kernel.rpc.quorum, settings: { offchain: !!settings.allowOffchain[label.name], devPreview: !!settings.devPreview, rpcUrls: settings.rpcUrls }, blockedByUser: settings.userBlocklist.includes(label.name), reportUrl: hostConfig.reportUrl ? String(hostConfig.reportUrl).replace('{name}', encodeURIComponent(label.name)) : '', statusTextOf: statusTextOf(locale) }));
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
  } });
}

/** 链外请求：默认拦截并记录；节点地址放行（页面里的 dapp 逻辑可能自己读链）；用户逐站放行后照常发出 */
async function external(e, url) {
  await boot();
  let name = null;
  try { const c = await self.clients.get(e.clientId || e.resultingClientId); if (c) name = labelOf(new URL(c.url).hostname)?.name || null; } catch {}
  const h = name && sites.get(name);
  const nodeOrigins = new Set(kernel.rpc.urls.map((u) => new URL(u).origin));
  if (nodeOrigins.has(url.origin) || (name && settings.allowOffchain[name])) {
    if (h && !nodeOrigins.has(url.origin)) push(h.allowed, { url: url.href });
    return fetch(e.request);
  }
  if (h) push(h.blocked, { url: url.href, type: e.request.destination || e.request.mode });
  if (e.request.mode === 'navigate' || e.request.destination === 'document' || e.request.destination === 'iframe') return html(messagePage({ locale: localeFor(e.request), kind: 'blocked-request', host: url.hostname }), 403);
  return new Response('blocked by tape gateway: off-chain request', { status: 403, headers: { 'content-type': 'text/plain; charset=utf-8', 'x-tape-blocked': '1' } });
}

function statusJson(h, label) {
  const r = h.res || {};
  return {
    version: VERSION, name: label.name, status: r.status, url: r.url, cpu: r.cpu?.toString(), cpuName: r.cpuName, holder: r.holder, container: r.container, block: r.block,
    paid: r.paid, paidUntil: r.paidUntil?.toString(), paidVia: r.paidVia, stores: r.stores, showable: h.showable, devPreview: !!settings.devPreview,
    files: h.files, external: h.external, blocked: h.blocked, allowed: h.allowed, nodes: kernel.rpc.stats(), quorum: kernel.rpc.quorum, rpcUrls: kernel.rpc.urls, cache: cache.kind,
    settings: { offchain: !!settings.allowOffchain[label.name], userBlocklist: settings.userBlocklist, locale: settings.locale || null },
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
    if (label) { if (form.get('offchain')) settings.allowOffchain[label.name] = true; else delete settings.allowOffchain[label.name]; }
    const wasDev = !!settings.devPreview; settings.devPreview = !!form.get('devPreview');
    const rpcs = String(form.get('rpcs') || '').split('\n').map((s) => s.trim()).filter((s) => /^https:\/\//i.test(s));
    const changedRpc = JSON.stringify(rpcs) !== JSON.stringify(settings.rpcUrls);
    settings.rpcUrls = rpcs;
    if (changedRpc) { kernel = null; sites.clear(); }        // 下次请求用新节点重建内核
    else if (wasDev !== settings.devPreview) sites.clear();
  }
  if (kernel) kernel.setLocale(settings.locale || 'zh');
  await saveSettings();
  if (!kernel) await boot();
  return Response.redirect(String(form.get('back') || '/.tape/status'), 303);
}
