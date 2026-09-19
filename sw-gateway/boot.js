// 引导脚本（由 index.html 加载）。两种角色：
//   网站子域名（4246-0.网关域名）：注册 /sw.js，等它接管，然后刷新——之后就再也不需要服务器了；
//   网关根域名：首页，输入链上名字跳到子域名；可把 web+tape:// 链接注册给这个网关处理。
import { parseHostLabel, parseInput, formatName, formatHostLabel } from '/.tape/kernel/name.js';
const zh = /^zh/i.test(navigator.language || '');
const t = (z, e) => (zh ? z : e);
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const host = location.hostname;
const first = host.split('.')[0];
const m = host.endsWith('.') ? null : parseHostLabel(first);   // 结尾带点：另一个来源，按写法不对处理   // 4246-0（BNB）或 1-2-344（带区号：X Layer = 2、Base = 3）

if (m) siteBoot(formatName(m.tokenId, m.cpu, 'tape', m.area));
else if (/^[0-9]+(-[0-9]+){1,2}$/.test(first) || host.endsWith('.')) badHost();   // 像网站段但不合规（前导 0、未分配的区号）：明确报错，不当首页
else landing();

function badHost() {
  document.title = t('主机名写法不对', 'Invalid host name');
  const root = host.split('.').slice(1).join('.');
  $('main').innerHTML = `<h1>${t('主机名写法不对', 'Invalid host name')}</h1><p>${t('网站子域名要写成「#ID-处理器编号」（其他链是「#ID-区号-处理器编号」，X Layer 区号 2、Base 区号 3），都是不带前导 0 的十进制数，例如', 'The site subdomain must be "#ID-processor" (on other chains "#ID-area-processor"; X Layer is area 2, Base is area 3), all decimal without leading zeros, e.g.')} <span class="mono">4246-0.${esc(root)}</span>、<span class="mono">1-2-344.${esc(root)}</span></p>`;
}

async function siteBoot(name) {
  document.title = name;
  const say = (s, cls) => { $('msg').textContent = s; $('msg').className = cls || ''; };
  say(t(`正在准备 ${name}…`, `Preparing ${name}…`));
  if (!('serviceWorker' in navigator)) return fail(t('这个浏览器不支持 Service Worker，打不开链上网站。请用最近两年的 Chrome、Edge、Firefox 或 Safari。', 'This browser has no Service Worker support. Use a recent Chrome, Edge, Firefox or Safari.'));
  if (!window.isSecureContext) return fail(t('需要 https（或 localhost）才能装 Service Worker。', 'Service Workers need https (or localhost).'));
  try {
    const reg = await navigator.serviceWorker.register('/sw.js', { type: 'module', scope: '/', updateViaCache: 'none' });
    await navigator.serviceWorker.ready;
    if (navigator.serviceWorker.controller) return location.reload();
    await new Promise((res, rej) => {
      navigator.serviceWorker.addEventListener('controllerchange', res, { once: true });
      setTimeout(() => rej(new Error('timeout')), 15_000);
      if (reg.active) reg.active.postMessage({ type: 'claim' });
    });
    location.reload();
  } catch (e) {
    fail(t('装不上 Service Worker：', 'Could not install the Service Worker: ') + (e && e.message || e));
  }
  function fail(s) {
    $('main').innerHTML = `<h1>${esc(name)}</h1><p class="err">${esc(s)}</p><p class="hint">${t('如果你刚按了「强制刷新」（Shift+刷新），浏览器会绕过 Service Worker 一次，再普通刷新一下就好。', 'If you just did a hard reload (Shift+Reload), the browser bypassed the Service Worker once; a normal reload will fix it.')}</p>`;
  }
}

function landing() {
  const open = new URLSearchParams(location.search).get('open');
  if (open) { const target = toSiteUrl(open); if (target) return location.replace(target); }
  document.title = t('tape:// 网关', 'tape:// gateway');
  $('main').innerHTML = `
<h1>${t('打开去中心化网站（BNB Chain、X Layer、Base）', 'Open a decentralised website (BNB Chain, X Layer, Base)')}</h1>
<p>${t('网站存在 TapeOut 的电路容器里。输入它的链上地址，地址由两个数字组成：<b>电路编号</b>（#ID）和<b>处理器编号</b>（也就是项目编号）。两种写法都可以：', 'The website lives in a TapeOut circuit container. Enter its on-chain address, made of two numbers: the <b>circuit #ID</b> and the <b>processor number</b> (the project number). Either form works:')}</p>
<p><span class="mono">#4246@0</span> ${t('—— 0 号处理器（Genesis CPU）上的第 4246 枚电路；', '— circuit #4246 on processor 0 (Genesis CPU);')}<br><span class="mono">4246.0.tape</span> ${t('—— 同一个地址，写成名字的形式（电路编号.处理器编号.tape，例如 123.30.tape 就是 30 号处理器 TapeOut 上的第 123 枚）。', '— the same address written as a name (circuit.processor.tape; for example 123.30.tape is circuit #123 on processor 30, TapeOut).')}</p>
<p>${t('X Layer 和 Base 上的网站在处理器编号前加区号：X Layer 是 2，Base 是 3。例如 <span class="mono">#1@2.344</span>（也可以写 <span class="mono">1.2.344</span>）就是 X Layer 上 344 号处理器的第 1 枚电路。BNB Chain 不带区号。', 'Sites on X Layer and Base put an area code before the processor number: 2 for X Layer, 3 for Base. For example <span class="mono">#1@2.344</span> (or <span class="mono">1.2.344</span>) is circuit #1 on processor 344 on X Layer. BNB Chain has no area code.')}</p>
<p>${t('所有网页文件都存在链上。这个页面只负责读取链上数据，不经手任何内容。', 'Every file of the website is stored on chain. This page only reads on-chain data and never handles any content.')}</p>
<div class="card"><form id="go"><input id="addr" class="mono" autofocus placeholder="4246.0 / #4246@0 / 1.2.344" spellcheck="false"><button type="submit">${t('打开', 'Open')}</button></form>
<p class="hint" id="err"></p></div>
<div class="card"><div class="row"><span>${t('让浏览器把 <span class="mono">web+tape://</span> 链接交给这个网关打开', 'Let the browser open <span class="mono">web+tape://</span> links with this gateway')}</span> <button class="plain" id="reg">${t('注册', 'Register')}</button></div><p class="hint" id="regMsg" style="margin:10px 0 0"></p></div>
<p class="hint">${t('每个文件都从链上读、和链上指纹核对，改过就不显示。网站不在这台服务器上，在链上。钱包可以直接用。', 'Every file is read from the chain and checked against its on-chain fingerprint; anything altered is not shown. The website is not on this server, it is on the chain. Your wallet works directly.')} <a href="/.tape/policy.html">${t('屏蔽规则与举报', 'Blocking policy & reporting')}</a></p>`;
  $('go').addEventListener('submit', (e) => {
    e.preventDefault();
    const target = toSiteUrl($('addr').value);
    if (target) location.href = target; else $('err').textContent = t('看不懂这个地址。例子：4246.0、#4246@0、1.2.344（X Layer）、tape://4246.0.tape/（容器地址暂不支持，请先在查看器里反查出名字）', 'Unrecognised address. Examples: 4246.0, #4246@0, 1.2.344 (X Layer), tape://4246.0.tape/ (container addresses: look up the name in the viewer first)');
  });
  $('reg').addEventListener('click', () => {
    try { navigator.registerProtocolHandler('web+tape', location.origin + '/?open=%s'); $('regMsg').textContent = t('已请求注册，请在浏览器的提示里确认。', 'Requested; confirm in the browser prompt.'); }
    catch (e) { $('regMsg').textContent = String(e && e.message || e); }
  });
}

/** 把用户输入（链上名字、#ID@编号、tape:// 网址、web+tape:// 网址）变成本网关的子域名网址 */
function toSiteUrl(raw) {
  const s = String(raw || '').trim().replace(/^(web\+)?tape:\/\//i, '');
  let p;
  try { p = parseInput(s); } catch { return null; }
  if (p.kind !== 'name') return null;
  const rest = s.includes('/') ? s.slice(s.indexOf('/')) : '';   // 路径原样带上（含查询串和 #）
  return `${location.protocol}//${formatHostLabel(p.tokenId, p.cpu, p.area)}.${host}${location.port ? ':' + location.port : ''}${rest || '/'}`;
}
