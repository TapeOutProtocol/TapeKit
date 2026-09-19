// 链上网站查看器（预览模式外壳）。读链、校验、缓存都交给内核；这里只负责：显示身份与状态、按需把校验过的文件交给沙盒渲染、监听更新、中英文界面。
import {
  createKernel, createIdbCache, createMemoryCache, statusText, scanHtml, scanCss, collectReferences, toChecksumAddress,
  InputError, setLocale, detectLocale, getLocale, t,
} from '../kernel/src/index.js';

const $ = (id) => document.getElementById(id);
const LOCAL = ['localhost', '127.0.0.1'].includes(location.hostname);
// 开发模式（只在本机、URL 带 ?dev 时）：允许预览还没开通（未付费）的名字，方便站长上线前自测
const DEV = LOCAL && new URLSearchParams(location.search).has('dev');

// ---- 界面文案（内核的状态/错误文案在内核里，这里只放查看器自己的）
const UI = {
  brandTitle: { zh: 'HashPort 纯链上网站查看器（预览模式）', en: 'HashPort on-chain site viewer (preview mode)' },
  placeholder: { zh: '输入链上名字，例如 4246.0、#4246@0、1.2.344（X Layer）或容器地址 0x…', en: 'Enter an on-chain name, e.g. 4246.0, #4246@0, 1.2.344 (X Layer), or a container address 0x…' },
  open: { zh: '打开', en: 'Open' }, details: { zh: '详情', en: 'Details' }, spec: { zh: '规范', en: 'Spec' },
  welcomeTitle: { zh: '直接从链上读网站（BNB Chain、X Layer、Base）', en: 'Read websites straight from the chain (BNB Chain, X Layer, Base)' },
  welcome1: { zh: '不经过域名、不经过 DNS、不经过网关。每个文件都与链上的 SHA-256 核对，至少两个节点结果一致才采用。', en: 'No domain, no DNS, no gateway. Every file is checked against its on-chain SHA-256, and at least two independent nodes must agree.' },
  welcome2: { zh: '这是预览模式：网站运行在隔离的沙盒里，不能保存数据，也不能连接钱包。', en: 'This is preview mode: sites run in an isolated sandbox, cannot store data, and cannot connect a wallet.' },
  resolving: { zh: '正在解析…', en: 'Resolving…' }, badInput: { zh: '地址写法不对', en: 'Invalid address' }, readFail: { zh: '读取失败', en: 'Read failed' },
  unpaidTitle: { zh: '这个链上名字还没开通', en: 'This on-chain name is not activated' },
  unpaid1: { zh: '没有查到 {name} 的有效付费（这个名字或这个容器都没有），所以不显示。', en: 'No valid payment found for {name} (neither the name nor its container), so it is not displayed.' },
  unpaid2: { zh: '开通方法：电路持有人在 {network} 上调用付费合约 DomainBinding.bind("{name}", 容器, 月数)，按 30 天付费（费用以合约为准），最多预付 10 年。容器已经为域名付过费的自动算作开通。', en: 'To activate: the circuit holder calls DomainBinding.bind("{name}", container, months) on {network}, paying per 30 days (the contract sets the fee), up to 10 years prepaid. A container that already paid for a domain counts as activated.' },
  container: { zh: '容器', en: 'Container' }, holder: { zh: '持有人', en: 'Holder' }, cannotShow: { zh: '无法显示', en: 'Cannot display' },
  loading: { zh: '正在从链上读取文件…', en: 'Reading files from chain…' }, preparing: { zh: '准备中', en: 'Preparing' },
  loadFail: { zh: '读取站点失败', en: 'Failed to load site' }, notFound: { zh: '404 · 链上没有这个文件', en: '404 · No such file on chain' }, home: { zh: '回首页', en: 'Home' },
  verified: { zh: '已与链上核对', en: 'verified against chain' }, unverified: { zh: '未校验', en: 'unverified' },
  renderFail: { zh: '渲染失败', en: 'Render failed' },
  leave: { zh: '这个链接会离开链上网站：\n\n{url}\n\n在新窗口打开？', en: 'This link leaves the on-chain site:\n\n{url}\n\nOpen in a new window?' },
  live: { zh: '已开通', en: 'Live' }, until: { zh: '至', en: 'until' }, viaContainer: { zh: '（容器已付费）', en: ' (container paid)' },
  filesBad: { zh: '{n} 个文件与链上不一致', en: '{n} file(s) do not match chain' }, filesNoHash: { zh: '{n} 个文件未声明哈希', en: '{n} file(s) without declared hash' },
  filesOk: { zh: '{n} 个文件全部与链上一致', en: 'all {n} file(s) match chain' }, filesLazy: { zh: '已读 {n} / {m} 个文件，全部与链上一致', en: '{n} / {m} files read, all match chain' },
  external: { zh: '引用了 {n} 处链外资源', en: '{n} off-chain reference(s)' }, pure: { zh: '100% 链上', en: '100% on-chain' },
  dev: { zh: '开发模式', en: 'dev mode' }, cached: { zh: '{n} 个来自本地缓存', en: '{n} from local cache' },
  processor: { zh: '{i} 号处理器{name} 的 #{id}', en: 'processor #{i}{name}, circuit #{id}' },
  url: { zh: '网址', en: 'URL' }, cpuContract: { zh: '处理器合约', en: 'Processor contract' }, block: { zh: '读取区块', en: 'Block read' },
  stores: { zh: '仓库实现', en: 'Store implementations' }, pinned: { zh: '已钉住', en: 'pinned' }, notPinned: { zh: '不在名单', en: 'not pinned' },
  files: { zh: '文件', en: 'Files' }, externalList: { zh: '链外资源', en: 'Off-chain references' }, runtimeBlocked: { zh: '被拦下的链外代码', en: 'off-chain code blocked' },
  updated: { zh: '站长更新了这个网站', en: 'The site has been updated on chain' }, reload: { zh: '重新读取', en: 'Reload' },
  nodes: { zh: '{chain} · {n} 个节点 · 至少 {q} 家一致', en: '{chain} · {n} nodes · at least {q} operators must agree' },
  cacheKind: { zh: '缓存：{k}', en: 'cache: {k}' },
};
let locale = 'zh';
try { locale = localStorage.getItem('hp-locale') || detectLocale(); } catch { locale = detectLocale(); }
setLocale(locale); locale = getLocale();
const ui = (k, vars) => String((UI[k] || {})[locale] ?? (UI[k] || {}).en ?? k).replace(/\{(\w+)\}/g, (m, key) => (vars && key in vars ? vars[key] : m));

let blocklist = new Set();
const cache = await (async () => { try { return await createIdbCache('hashport-viewer'); } catch { return createMemoryCache(); } })();
const kernel = createKernel({ cache, locale, isBlocked: ({ container, name }) => blocklist.has(container.toLowerCase()) || blocklist.has(name) });
let current = null;       // { res, site, external: Map(path → [url]) }
let runtimeBlocked = [];  // 运行时被 CSP 拦截的链外代码（链外数据可以访问，脚本只能来自链上）
let openSeq = 0;
let frame = null;
let stopWatch = null;

function applyStaticText() {
  document.documentElement.lang = locale === 'zh' ? 'zh' : 'en';
  document.title = locale === 'zh' ? '链上网站查看器 · tape://' : 'On-chain site viewer · tape://';
  $('brand').title = ui('brandTitle');
  $('addr').placeholder = ui('placeholder');
  $('goBtn').textContent = ui('open');
  $('detailsSummary').textContent = ui('details');
  $('specLink').textContent = ui('spec');
  $('langBtn').textContent = locale === 'zh' ? 'English' : '中文';
  // 页脚：当前打开的网站在哪条链，就显示那条链的节点（还没打开网站时显示 BNB）
  const chainRpc = (current && current.chainId && kernel.kernelFor(current.chainId)?.rpc) || kernel.kernelFor(56)?.rpc || kernel.rpc;
  const chainNameOf = { 56: 'BNB Chain', 196: 'X Layer', 8453: 'Base' }[(current && current.chainId) || 56];
  $('net').textContent = ui('nodes', { chain: chainNameOf, n: chainRpc.urls.length, q: chainRpc.quorum }) + ' · ' + ui('cacheKind', { k: cache.kind });
  if (!current && $('message')) { $('message').innerHTML = `<h1>${esc(ui('welcomeTitle'))}</h1><p>${esc(ui('welcome1'))}</p><p class="hint">${esc(ui('welcome2'))}</p>`; }
}

async function loadBlocklist() {
  try {
    const r = await fetch('blocklist.txt', { cache: 'no-store' });
    if (!r.ok) return;
    blocklist = new Set((await r.text()).split('\n').map((l) => l.trim().toLowerCase()).filter((l) => l && !l.startsWith('#')));
  } catch { /* 没有名单就不屏蔽 */ }
}

const short = (a) => (a ? a.slice(0, 6) + '…' + a.slice(-4) : '');
const cs = (a) => { try { return toChecksumAddress(a); } catch { return a || ''; } };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtBytes = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(2)} MB`);
const fmtDate = (sec) => new Date(Number(sec) * 1000).toLocaleDateString(locale === 'zh' ? 'zh-CN' : 'en-GB', { year: 'numeric', month: '2-digit', day: '2-digit' });

function message(kind, title, html = '', actions = []) {
  clearFrame();
  const box = document.createElement('div');
  box.id = 'message'; box.className = 'message ' + (kind || '');
  box.innerHTML = `<h1>${esc(title)}</h1>${html}`;
  if (actions.length) {
    const row = document.createElement('div'); row.className = 'actions';
    for (const [label, fn] of actions) { const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.addEventListener('click', fn); row.append(b); }
    box.append(row);
  }
  $('stage').replaceChildren(box);
  return box;
}

function clearFrame() { if (frame) { frame.remove(); frame = null; } }

const isHtml = (f) => /html/i.test(f.contentType) || /\.html?$/i.test(f.path);
const isCss = (f) => /css/i.test(f.contentType) || /\.css$/i.test(f.path);
function scanFile(f) {
  const td = new TextDecoder('utf-8', { fatal: false });
  if (isHtml(f)) return scanHtml(td.decode(f.bytes)).map((e) => e.url);
  if (isCss(f)) return scanCss(td.decode(f.bytes)).map((e) => e.url);
  return [];
}

function setIdentity(res, extra = {}) {
  $('identity').hidden = false;
  $('idName').textContent = res.name || res.input || '';
  $('idTitle').textContent = extra.title ? '— ' + extra.title : '';
  $('idSub').textContent = res.name
    ? `${ui('processor', { i: res.cpu, name: res.cpuName ? (locale === 'zh' ? `（${res.cpuName}）` : ` (${res.cpuName})`) : '', id: res.tokenId })} · ${ui('container')} ${short(cs(res.container))}${res.holder ? ` · ${ui('holder')} ${short(cs(res.holder))}` : ''}`
    : '';
  const badges = [];
  const add = (cls, text) => badges.push(`<li class="${cls}">${esc(text)}</li>`);
  if (res.status === 'ok') add('ok', `${ui('live')}${res.paidVia === 'container' ? ui('viaContainer') : ''}${res.paidUntil ? ` · ${ui('until')} ${fmtDate(res.paidUntil)}` : ''}`);
  else if (res.status) add(res.status === 'unpaid' ? 'warn' : 'bad', statusText(res.status));
  if (current && current.site) {
    const files = [...current.site.files.values()];
    const bad = files.filter((f) => f.status === 'incomplete' || f.status === 'too-large').length;
    const noHash = files.filter((f) => f.status === 'no-hash').length;
    const total = current.site.manifest.paths.length;
    if (bad) add('bad', ui('filesBad', { n: bad }));
    else if (noHash) add('warn', ui('filesNoHash', { n: noHash }));
    else if (files.length < total) add('ok', ui('filesLazy', { n: files.length, m: total }));
    else add('ok', ui('filesOk', { n: files.length }));
    const fromCache = files.filter((f) => f.fromCache).length;
    if (fromCache) add('', ui('cached', { n: fromCache }));
    const ext = [...current.external.values()].reduce((s, a) => s + a.length, 0) + runtimeBlocked.length;
    add(ext ? 'warn' : 'ok', ext ? ui('external', { n: ext }) : ui('pure'));
  }
  if (DEV) add('warn', ui('dev'));
  $('badges').innerHTML = badges.join('');

  const rows = [];
  const row = (k, v) => rows.push(`<dt>${esc(k)}</dt><dd>${v}</dd>`);
  if (res.name) row(ui('url'), esc(res.url || ''));
  if (res.circuits) row(ui('cpuContract'), esc(cs(res.circuits)));
  if (res.container) row(ui('container'), esc(cs(res.container)));
  if (res.holder) row(ui('holder'), esc(cs(res.holder)));
  if (res.block) row(ui('block'), '#' + BigInt(res.block).toString());
  if (res.stores) row(ui('stores'), res.stores.stores.map((s) => `${esc(short(s.address))} → ${esc(short(s.impl || '?'))} ${s.ok ? '✓ ' + ui('pinned') : '✗ ' + ui('notPinned')}`).join('<br>'));
  if (current && current.site) {
    const list = [...current.site.files.values()].map((f) => `<li>${esc(f.path)} · ${fmtBytes(f.size)} · ${f.verified ? 'sha256 ✓' : ui('unverified')}${f.fromCache ? ' · cache' : ''} <span title="${esc(f.sha256 || '')}">${esc((f.sha256 || '').slice(0, 12))}…</span></li>`);
    row(ui('files'), `<ul>${list.join('')}</ul>`);
    const ext = [...[...current.external].flatMap(([p, urls]) => urls.map((u) => `${p}: ${u}`)), ...runtimeBlocked.map((u) => `${ui('runtimeBlocked')}: ${u}`)];
    if (ext.length) row(ui('externalList'), `<ul>${ext.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`);
  }
  $('idDetails').innerHTML = rows.join('');
}

function hashFor(res, path) { return '#/' + res.name + (path ? '/' + path : ''); }

// 把一个文件登记到 current（扫描链外引用），返回它引用的站内路径
function admit(f) {
  if (!current || !f || !(f.status === 'ok' || f.status === 'no-hash')) return [];
  if (!current.external.has(f.path)) { const ext = scanFile(f); if (ext.length) current.external.set(f.path, ext); }
  const td = new TextDecoder('utf-8', { fatal: false });
  const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/') + 1) : '';
  return isHtml(f) ? collectReferences(td.decode(f.bytes), 'html', dir) : isCss(f) ? collectReferences(td.decode(f.bytes), 'css', dir) : [];
}

// 读入口文件和它（递归）引用到的站内资源；每一层用 prefetch 合并请求
async function loadEntry(site, entryPath, onProgress) {
  const entry = await site.get(entryPath);
  if (!entry) return null;
  // 脚本必须在渲染前全部到位：import map 一旦开始加载模块就不能再改，所以站点里所有 .js/.mjs 都预取；
  // 图片、字体、媒体、其它页面才真正按需（沙盒运行时通过 hp-need 向外壳要）
  const scripts = site.manifest.paths.filter((p) => /\.(m?js)$/i.test(p) && !site.files.has(p));
  if (scripts.length) await site.prefetch(scripts, onProgress);
  for (const p of scripts) { const f = site.files.get(p); if (f) admit(f); }
  let refs = admit(entry);
  const seen = new Set([entry.path]);
  for (let depth = 0; depth < 4 && refs.length; depth++) {
    const todo = refs.filter((p) => !seen.has(p)); todo.forEach((p) => seen.add(p));
    if (!todo.length) break;
    await site.prefetch(todo, onProgress);
    refs = todo.flatMap((p) => { const f = site.files.get(p); return f ? admit(f) : []; });
  }
  return entry;
}

async function open(input, opts = {}) {
  const seq = ++openSeq;
  if (stopWatch) { stopWatch(); stopWatch = null; }
  current = null; runtimeBlocked = [];
  $('addr').value = input;
  $('identity').hidden = true;
  message('', ui('resolving'), `<p>${esc(input)}</p>`);
  let res;
  try { res = await kernel.resolve(input, { fresh: !!opts.fresh }); }
  catch (e) {
    if (seq !== openSeq) return;
    return message('bad', e instanceof InputError ? ui('badInput') : ui('readFail'), `<p>${esc(e.message)}</p>`);
  }
  if (seq !== openSeq) return;
  setIdentity(res);
  if (res.name) {
    $('addr').value = res.name + (res.path ? '/' + res.path : '');
    const h = hashFor(res, res.path);
    if (location.hash !== h) history.replaceState(null, '', h);
  }
  if (res.status !== 'ok' && !(DEV && res.status === 'unpaid')) {
    if (res.status === 'unpaid') {
      return message('warn', ui('unpaidTitle'),
        `<p>${esc(ui('unpaid1', { name: res.name }))}</p><p>${esc(ui('unpaid2', { name: res.name, network: ({ 56: 'BNB Chain', 196: 'X Layer', 8453: 'Base' })[res.chainId] || 'BNB Chain' }))}</p><p class="hint">${ui('container')} ${esc(cs(res.container))}</p>`);
    }
    return message('bad', statusText(res.status) || ui('cannotShow'), res.name ? `<p>${esc(res.name)}</p>` : '');
  }
  const box = message('', ui('loading'), `<p id="prog">${esc(ui('preparing'))}</p><div class="progress"><div id="bar"></div></div>`);
  const onProgress = ({ done, total, files }) => {
    if (seq !== openSeq) return;
    const p = box.querySelector('#prog'); const b = box.querySelector('#bar');
    if (p) p.textContent = `${files} · ${fmtBytes(done)} / ${fmtBytes(total)}`;
    if (b) b.style.width = (total ? Math.round((done / total) * 100) : 100) + '%';
  };
  let site;
  try {
    site = await kernel.openSite(res);
    current = { res, site, external: new Map() };
    await loadEntry(site, res.path || '', onProgress);
  } catch (e) {
    if (seq !== openSeq) return;
    current = null;
    return message('bad', ui('loadFail'), `<p>${esc(e.message)}</p>`);
  }
  if (seq !== openSeq) return;
  setIdentity(res);
  render(res.path, seq);
  stopWatch = kernel.watch(site, () => {
    if (seq !== openSeq) return;
    const bar = document.createElement('div'); bar.className = 'update-bar';
    bar.innerHTML = `<span>${esc(ui('updated'))}</span>`;
    const b = document.createElement('button'); b.type = 'button'; b.textContent = ui('reload'); b.addEventListener('click', () => open(res.name + (res.path ? '/' + res.path : ''), { fresh: true }));
    bar.append(b); $('identity').append(bar);
  }, { intervalMs: 30_000, firstDelayMs: 30_000 });
}

function render(path, seq = openSeq) {
  if (!current) return;
  const { res, site } = current;
  const entry = kernel.resolvePath(path || '', site.manifest.pathSet, site.manifest.fallback);
  const file = entry && site.files.get(entry);
  if (!file) return message('bad', ui('notFound'), `<p>${esc(res.name)}/${esc(path || '')}</p>`, [[ui('home'), () => navigate('')]]);
  if (!isHtml(file)) {
    return message('', entry, `<p>${esc(file.contentType)} · ${fmtBytes(file.size)} · ${file.verified ? ui('verified') : ui('unverified')}</p><p class="hint">sha256 ${esc(file.sha256)}</p>`, [[ui('home'), () => navigate('')]]);
  }
  clearFrame();
  frame = document.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-scripts');           // 不带 allow-same-origin：不透明来源（SPEC.md §7.1）
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.setAttribute('title', res.name);
  frame.src = 'frame.html';
  $('stage').replaceChildren(frame);
  const target = frame;
  const onMsg = async (ev) => {
    if (!target.isConnected) { removeEventListener('message', onMsg); return; }
    if (ev.source !== target.contentWindow || !ev.data || typeof ev.data.type !== 'string') return;
    const m = ev.data;
    if (m.type === 'hp-ready') {
      const files = [...site.files.values()].filter((f) => f.status === 'ok' || f.status === 'no-hash').map((f) => ({ path: f.path, type: f.contentType, bytes: f.bytes.slice().buffer }));
      target.contentWindow.postMessage({ type: 'hp-render', files, entry, known: site.manifest.paths }, '*', files.map((f) => f.bytes));
    } else if (m.type === 'hp-need' && typeof m.path === 'string') {
      let f = null;
      try { f = await site.get(m.path); } catch { f = null; }
      if (!target.isConnected) return;
      if (f && (f.status === 'ok' || f.status === 'no-hash')) { admit(f); setIdentity(res); const bytes = f.bytes.slice().buffer; target.contentWindow.postMessage({ type: 'hp-file', id: m.id, path: m.path, ok: true, bytes, contentType: f.contentType }, '*', [bytes]); }
      else target.contentWindow.postMessage({ type: 'hp-file', id: m.id, path: m.path, ok: false }, '*');
    } else if (m.type === 'hp-nav' && typeof m.path === 'string') {
      navigate(m.path);
    } else if (m.type === 'hp-external' && typeof m.url === 'string') {
      if (/^https?:\/\//i.test(m.url) && confirm(ui('leave', { url: m.url }))) window.open(m.url, '_blank', 'noopener,noreferrer');
    } else if (m.type === 'hp-csp' && typeof m.url === 'string') {
      if (m.url && !runtimeBlocked.includes(m.url)) { runtimeBlocked.push(m.url); setIdentity(res); }
    } else if (m.type === 'hp-title' && typeof m.title === 'string') {
      setIdentity(res, { title: m.title.slice(0, 120) });
    } else if (m.type === 'hp-error') {
      message('bad', ui('renderFail'), `<p>${esc(String(m.message || ''))}</p>`);
    }
  };
  addEventListener('message', onMsg);
}

async function navigate(path) {
  if (!current) return;
  const { res, site } = current;
  const h = hashFor(res, path);
  history.pushState(null, '', h);
  $('addr').value = res.name + (path ? '/' + path : '');
  const entry = kernel.resolvePath(path || '', site.manifest.pathSet, site.manifest.fallback);
  if (entry && !site.files.has(entry)) { try { await loadEntry(site, path || '', () => {}); } catch { /* render 会显示 404 */ } }
  setIdentity(res);
  render(path);
}

function fromHash() {
  const raw = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
  return raw || null;
}

$('go').addEventListener('submit', (e) => { e.preventDefault(); const v = $('addr').value.trim(); if (v) open(v); });
$('langBtn').addEventListener('click', () => {
  locale = locale === 'zh' ? 'en' : 'zh';
  try { localStorage.setItem('hp-locale', locale); } catch {}
  setLocale(locale); kernel.setLocale(locale);
  applyStaticText();
  if (current) setIdentity(current.res);
});
addEventListener('popstate', () => {
  const target = fromHash();
  if (!target) return;
  if (current && (target === current.res.name || target.startsWith(current.res.name + '/'))) navigate(target.slice(current.res.name.length + 1));
  else open(target);
});

applyStaticText();
await loadBlocklist();
const initial = fromHash();
if (initial) open(initial);
else $('addr').focus();
