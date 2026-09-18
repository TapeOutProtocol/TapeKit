// Service Worker 网关的页面模板：状态页、开通提示、404、拦截说明、节点不足。全部是纯 HTML + 内联 CSS，**没有脚本**，
// 所以这些页面即使运行在网站自己的来源下也没有任何可被利用的代码。中英文按请求的 Accept-Language 或用户设置选择。

const T = {
  gw: { zh: 'tape:// 网关', en: 'tape:// gateway' },
  status: { zh: '状态', en: 'Status' },
  name: { zh: '链上名字', en: 'On-chain name' }, url: { zh: '网址', en: 'URL' },
  processor: { zh: '处理器', en: 'Processor' }, holder: { zh: '持有人', en: 'Holder' }, container: { zh: '容器', en: 'Container' },
  block: { zh: '读取区块', en: 'Block read' }, live: { zh: '开通状态', en: 'Activation' }, until: { zh: '至', en: 'until' },
  viaContainer: { zh: '容器已付费', en: 'container paid' }, viaName: { zh: '名字已付费', en: 'name paid' },
  files: { zh: '本次会话读到的文件', en: 'Files read this session' }, verified: { zh: '已与链上核对', en: 'verified against chain' },
  noHash: { zh: '未声明哈希（未校验）', en: 'no declared hash (unverified)' }, bad: { zh: '与链上不一致', en: 'mismatch with chain' },
  external: { zh: '链外资源', en: 'Off-chain references' }, externalNone: { zh: '静态扫描没有发现链外资源', en: 'Static scan found no off-chain references' },
  blocked: { zh: '运行时拦截的链外请求', en: 'Off-chain requests blocked at runtime' }, blockedNone: { zh: '没有', en: 'none' },
  allowed: { zh: '已放行的链外请求', en: 'Off-chain requests allowed' },
  pure: { zh: '100% 链上', en: '100% on-chain' }, notPure: { zh: '引用了链外资源', en: 'references off-chain resources' },
  nodes: { zh: '节点', en: 'Nodes' }, nodeOk: { zh: '成功', en: 'ok' }, nodeFail: { zh: '失败', en: 'failed' }, nodeRl: { zh: '限流', en: 'rate-limited' }, nodeMs: { zh: '最近耗时', en: 'last latency' }, nodeCool: { zh: '冷却中', en: 'cooling down' },
  quorum: { zh: '每次读取至少 {q} 家运营方给出相同结果才采用', en: 'Every read needs at least {q} independent operators to agree' },
  settings: { zh: '设置（只存在你的浏览器里）', en: 'Settings (stored only in your browser)' },
  offchain: { zh: '允许这个网站发起链外请求', en: 'Allow this site to make off-chain requests' },
  devPreview: { zh: '开发预览：显示还没开通的名字（站长自测用）', en: 'Dev preview: show names that are not activated yet (for site owners)' },
  rpcs: { zh: '节点列表（一行一个；留空用默认；不同运营方才算不同的票）', en: 'RPC nodes (one per line; empty = defaults; only different operators count as separate votes)' },
  lang: { zh: 'Language: English', en: '语言：中文' },
  save: { zh: '保存', en: 'Save' }, clearCache: { zh: '清空本机的链上文件缓存', en: 'Clear local on-chain file cache' },
  blockSite: { zh: '在本机屏蔽这个网站', en: 'Block this site on this device' }, unblockSite: { zh: '取消屏蔽', en: 'Unblock' },
  report: { zh: '举报这个网站', en: 'Report this site' },
  back: { zh: '返回网站', en: 'Back to site' },
  unpaidTitle: { zh: '这个链上名字还没开通', en: 'This on-chain name is not activated' },
  unpaid1: { zh: '没有查到 {name} 的有效付费（这个名字或这个容器都没有），所以网关不显示它。', en: 'No valid payment was found for {name} (neither the name nor its container), so the gateway does not display it.' },
  unpaid2: { zh: '开通方法：电路持有人调用付费合约 DomainBinding.bind("{name}", 容器, 月数)，每 30 天 0.08 BNB，最多预付 10 年。容器已经为域名付过费的自动算作开通。', en: 'To activate: the circuit holder calls DomainBinding.bind("{name}", container, months) — 0.08 BNB per 30 days, up to 10 years prepaid. A container that already paid for a domain counts as activated.' },
  cannotShow: { zh: '无法显示', en: 'Cannot display' },
  notFound: { zh: '404 · 链上没有这个文件', en: '404 · No such file on chain' },
  tooLarge: { zh: '文件超过上限，网关不读取', en: 'File exceeds the size limit; the gateway does not read it' },
  notVerified: { zh: '文件与链上记录不符（上传中或已损坏），不显示', en: 'File does not match its on-chain record (uploading or corrupted); not displayed' },
  badHost: { zh: '主机名写法不对', en: 'Invalid host name' },
  badHost1: { zh: '网站子域名要写成「#ID-处理器编号」，例如 4246-0.{host}', en: 'The site subdomain must be "#ID-processor", e.g. 4246-0.{host}' },
  rpcFail: { zh: '节点不足，读不到链', en: 'Not enough nodes; cannot read the chain' },
  rpcFail1: { zh: '需要至少 {q} 家运营方给出相同结果。刚才的错误：{err}', en: 'At least {q} independent operators must agree. Last error: {err}' },
  blockedReq: { zh: '这个请求指向链外，已被 tape 网关拦截。要放行请到网站状态页 /.tape/status 打开「允许链外请求」。', en: 'This request goes off-chain and was blocked by the tape gateway. To allow it, open /.tape/status and enable off-chain requests.' },
  devBanner: { zh: '开发预览：这个名字还没开通，只有打开了开发预览的浏览器能看到', en: 'Dev preview: this name is not activated; only browsers with dev preview enabled can see it' },
  statusLink: { zh: '这个网站的状态页：', en: 'Status page for this site:' },
  notice: { zh: '链上数据是公开的；网关只显示已开通的名字。「已与链上核对」只说明字节与链上一致，不说明网站可信。', en: 'On-chain data is public; the gateway only displays activated names. "Verified" means the bytes match the chain, not that the site is trustworthy.' },
};

export const pickLocale = (acceptLanguage, override) => {
  if (override) return String(override).toLowerCase().startsWith('zh') ? 'zh' : 'en';
  return /^\s*zh|,\s*zh/i.test(String(acceptLanguage || '')) ? 'zh' : 'en';
};
const fill = (s, v) => String(s).replace(/\{(\w+)\}/g, (m, k) => (v && k in v ? String(v[k]) : m));
export const tr = (locale) => (k, v) => fill((T[k] || {})[locale] ?? (T[k] || {}).en ?? k, v);
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const short = (a) => (a ? a.slice(0, 6) + '…' + a.slice(-4) : '');
const fmtBytes = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(2)} MB`);
const fmtDate = (sec, locale) => (sec ? new Date(Number(sec) * 1000).toLocaleDateString(locale === 'zh' ? 'zh-CN' : 'en-GB', { year: 'numeric', month: '2-digit', day: '2-digit' }) : '');

const CSS = `
:root{color-scheme:light dark}body{margin:0;font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Noto Sans CJK SC",sans-serif;background:#f6f7f9;color:#1b1f24}
@media(prefers-color-scheme:dark){body{background:#0f1115;color:#e6e8eb}.card{background:#171a20!important;border-color:#2a2f38!important}input,textarea{background:#0f1115;color:#e6e8eb;border-color:#2a2f38}}
main{max-width:860px;margin:0 auto;padding:28px 20px 60px}h1{font-size:22px;margin:0 0 6px}h2{font-size:15px;margin:26px 0 8px;opacity:.8;text-transform:uppercase;letter-spacing:.04em}
.card{background:#fff;border:1px solid #e3e6ea;border-radius:10px;padding:16px 18px;margin:12px 0}.kv{display:grid;grid-template-columns:max-content 1fr;gap:6px 16px;align-items:baseline}.kv b{font-weight:600;opacity:.75}
code,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;word-break:break-all}.chip{display:inline-block;padding:2px 9px;border-radius:999px;font-size:12px;margin-right:6px;background:#e9ecef;color:#333}
.ok{background:#d9f2e3;color:#116b3a}.bad{background:#fbe1e1;color:#8b1c1c}.warn{background:#fff1cf;color:#7a5200}.hint{opacity:.7;font-size:13px}
table{border-collapse:collapse;width:100%;font-size:13px}td,th{text-align:left;padding:5px 8px;border-bottom:1px solid #e3e6ea}th{opacity:.7;font-weight:600}
form{margin:0}label{display:block;margin:8px 0}textarea,input[type=text]{width:100%;box-sizing:border-box;padding:8px;border:1px solid #cfd4da;border-radius:6px;font:inherit}
button{font:inherit;padding:7px 14px;border-radius:7px;border:1px solid #cfd4da;background:#fff;cursor:pointer;margin:4px 6px 0 0}button.primary{background:#1b1f24;color:#fff;border-color:#1b1f24}
.row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}ul{padding-left:20px;margin:6px 0}a{color:inherit}
`;

const shell = (locale, title, body) => `<!doctype html><html lang="${locale === 'zh' ? 'zh' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; form-action 'self'"><title>${esc(title)}</title><style>${CSS}</style></head><body><main>${body}</main></body></html>`;

const identityCard = (t, locale, res, extra = '') => {
  if (!res || !res.name) return '';
  const cpu = `${res.cpu}${res.cpuName ? ' · ' + esc(res.cpuName) : ''}`;
  const live = res.status === 'ok'
    ? `<span class="chip ok">${esc(res.statusText || res.status)}</span>` : `<span class="chip bad">${esc(res.statusText || res.status)}</span>`;
  return `<div class="card"><div class="kv">
<b>${t('name')}</b><span class="mono">${esc(res.name)}</span>
<b>${t('url')}</b><span class="mono">${esc(res.url || '')}</span>
<b>${t('processor')}</b><span>#${cpu}</span>
<b>${t('holder')}</b><span class="mono">${esc(res.holder || '')}</span>
<b>${t('container')}</b><span class="mono">${esc(res.container || '')}</span>
<b>${t('block')}</b><span class="mono">${res.block ? parseInt(res.block, 16) : ''}</span>
<b>${t('live')}</b><span>${res.paid ? `<span class="chip ok">${esc(res.paidVia === 'container' ? t('viaContainer') : t('viaName'))}</span> ${t('until')} ${fmtDate(res.paidUntil, locale)}` : `<span class="chip bad">${esc(res.statusText || res.status)}</span>`}</span>
</div>${extra}</div>`;
};

/** 状态页：身份、文件校验、链外资源、拦截记录、节点、设置。 */
export function statusPage({ locale, res, host, files, external, blocked, allowed, nodes, quorum, settings, blockedByUser, reportUrl, statusTextOf }) {
  const t = tr(locale);
  const st = res ? { ...res, statusText: statusTextOf ? statusTextOf(res.status) : res.status } : null;
  const nOk = files.filter((f) => f.status === 'ok').length, nNo = files.filter((f) => f.status === 'no-hash').length, nBad = files.filter((f) => f.status !== 'ok' && f.status !== 'no-hash').length;
  const pure = external.length === 0 && blocked.length === 0 && allowed.length === 0;
  const fileRows = files.slice(0, 200).map((f) => `<tr><td class="mono">${esc(f.path)}</td><td>${fmtBytes(f.size || 0)}</td><td>${f.status === 'ok' ? `<span class="chip ok">${t('verified')}</span>` : f.status === 'no-hash' ? `<span class="chip warn">${t('noHash')}</span>` : `<span class="chip bad">${esc(f.status)}</span>`}</td></tr>`).join('');
  const nodeRows = Object.entries(nodes).map(([u, s]) => `<tr><td class="mono">${esc(u)}</td><td>${s.ok}</td><td>${s.fail}</td><td>${s.rateLimited}${s.cooldownUntil > Date.now() ? ` <span class="chip warn">${t('nodeCool')}</span>` : ''}</td><td>${s.lastMs == null ? '' : s.lastMs + ' ms'}</td><td class="hint">${esc(s.lastError || '')}</td></tr>`).join('');
  const list = (items, none) => (items.length ? `<ul>${items.slice(0, 100).map((x) => `<li class="mono">${esc(typeof x === 'string' ? x : x.url)}${x.path ? ` <span class="hint">← ${esc(x.path)}</span>` : ''}${x.where ? ` <span class="hint">(${esc(x.where)})</span>` : ''}</li>`).join('')}</ul>` : `<p class="hint">${none}</p>`);
  const body = `
<h1>${t('gw')} · ${t('status')}</h1>
<p class="hint">${esc(host)}</p>
${st ? identityCard(t, locale, st, st.status === 'ok' ? `<p style="margin:10px 0 0"><a href="/">${t('back')}</a></p>` : '') : ''}
${st && st.status === 'ok' ? `
<h2>${t('files')}</h2>
<div class="card"><p class="row"><span class="chip ${nBad ? 'bad' : 'ok'}">${nOk} ${t('verified')}</span>${nNo ? `<span class="chip warn">${nNo} ${t('noHash')}</span>` : ''}${nBad ? `<span class="chip bad">${nBad} ${t('bad')}</span>` : ''}<span class="chip ${pure ? 'ok' : 'warn'}">${pure ? t('pure') : t('notPure')}</span></p>
${files.length ? `<table><tr><th>path</th><th>size</th><th></th></tr>${fileRows}</table>` : ''}</div>
<h2>${t('external')}</h2><div class="card">${list(external, t('externalNone'))}</div>
<h2>${t('blocked')}</h2><div class="card">${list(blocked, t('blockedNone'))}${allowed.length ? `<p><b>${t('allowed')}</b></p>${list(allowed, '')}` : ''}</div>` : ''}
<h2>${t('nodes')}</h2>
<div class="card"><p class="hint">${t('quorum', { q: quorum })}</p><table><tr><th>URL</th><th>${t('nodeOk')}</th><th>${t('nodeFail')}</th><th>${t('nodeRl')}</th><th>${t('nodeMs')}</th><th></th></tr>${nodeRows}</table></div>
<h2>${t('settings')}</h2>
<div class="card"><form method="post" action="/.tape/settings">
<label><input type="checkbox" name="offchain" value="1" ${settings.offchain ? 'checked' : ''}> ${t('offchain')}</label>
<label><input type="checkbox" name="devPreview" value="1" ${settings.devPreview ? 'checked' : ''}> ${t('devPreview')}</label>
<label>${t('rpcs')}<textarea name="rpcs" rows="4">${esc((settings.rpcUrls || []).join('\n'))}</textarea></label>
<input type="hidden" name="back" value="/.tape/status">
<div class="row"><button class="primary" type="submit">${t('save')}</button>
<button type="submit" name="action" value="lang">${t('lang')}</button>
<button type="submit" name="action" value="clearCache">${t('clearCache')}</button>
<button type="submit" name="action" value="${blockedByUser ? 'unblock' : 'block'}">${blockedByUser ? t('unblockSite') : t('blockSite')}</button>
${reportUrl ? `<a href="${esc(reportUrl)}" target="_blank" rel="noopener noreferrer">${t('report')}</a>` : ''}</div>
</form></div>
<p class="hint">${t('notice')}</p>`;
  return shell(locale, `${t('status')} · ${res && res.name ? res.name : host}`, body);
}

/** 未开通 / 不能显示 / 404 / 节点不足 等说明页 */
export function messagePage({ locale, kind, res, host, vars = {}, statusTextOf }) {
  const t = tr(locale);
  const st = res ? { ...res, statusText: statusTextOf ? statusTextOf(res.status) : res.status } : null;
  let title, html = '';
  switch (kind) {
    case 'unpaid': title = t('unpaidTitle'); html = `<p>${t('unpaid1', { name: esc(res.name) })}</p><p class="hint">${t('unpaid2', { name: esc(res.name) })}</p>`; break;
    case 'status': title = t('cannotShow'); html = `<p>${esc(st.statusText)}</p>`; break;
    case 'not-found': title = t('notFound'); html = `<p><a href="/">${t('back')}</a></p>`; break; // 路径任何人都能构造，不回显，免得在知名网站名下显示攻击者的文字
    case 'too-large': title = t('tooLarge'); html = `<p class="mono">${esc(vars.path || '')}</p>`; break;
    case 'not-verified': title = t('notVerified'); html = `<p class="mono">${esc(vars.path || '')}</p>`; break;
    case 'bad-host': title = t('badHost'); html = `<p>${t('badHost1', { host: esc(vars.root || host) })}</p>`; break;
    case 'rpc': title = t('rpcFail'); html = `<p>${t('rpcFail1', { q: vars.quorum, err: esc(vars.err || '') })}</p>`; break;
    case 'blocked-request': title = t('blockedReq'); break;
    default: title = kind;
  }
  const body = `<h1>${esc(title)}</h1>${html}${st ? identityCard(t, locale, st) : ''}<p class="hint">${t('statusLink')} <a href="/.tape/status">/.tape/status</a> · <a href="/.tape/policy.html">${t('report')}</a></p>`;
  return shell(locale, title, body);
}
