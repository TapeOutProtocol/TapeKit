// 引导脚本（由 index.html 加载）。两种角色：
//   网站子域名（4246-0.网关域名）：注册 /sw.js，等它接管，然后刷新——之后就再也不需要服务器了；
//   网关根域名：首页，输入链上名字跳到子域名；可把 web+tape:// 链接注册给这个网关处理。
const LABEL = /^(0|[1-9][0-9]*)-(0|[1-9][0-9]*)$/;
const zh = /^zh/i.test(navigator.language || '');
const t = (z, e) => (zh ? z : e);
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const host = location.hostname;
const first = host.split('.')[0];
const m = first.match(LABEL);

if (m) siteBoot(`${m[1]}.${m[2]}.tape`);
else if (/^[0-9]+-[0-9]+$/.test(first)) badHost();   // 像网站段但不合规（前导 0）：明确报错，不当首页
else landing();

function badHost() {
  document.title = t('主机名写法不对', 'Invalid host name');
  const root = host.split('.').slice(1).join('.');
  $('main').innerHTML = `<h1>${t('主机名写法不对', 'Invalid host name')}</h1><p>${t('网站子域名要写成「#ID-处理器编号」，两段都是不带前导 0 的十进制数，例如', 'The site subdomain must be "#ID-processor", both decimal without leading zeros, e.g.')} <span class="mono">4246-0.${esc(root)}</span></p>`;
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
<h1>${t('打开去中心化网站（基于 BNB Chain）', 'Open a decentralised website (on BNB Chain)')}</h1>
<p>${t('网站存在 TapeOut 的电路容器里。输入它的链上地址，地址由两个数字组成：<b>电路编号</b>（#ID）和<b>处理器编号</b>（也就是项目编号）。两种写法都可以：', 'The website lives in a TapeOut circuit container. Enter its on-chain address, made of two numbers: the <b>circuit #ID</b> and the <b>processor number</b> (the project number). Either form works:')}</p>
<p><span class="mono">#4246@0</span> ${t('—— 0 号处理器（Genesis CPU）上的第 4246 枚电路；', '— circuit #4246 on processor 0 (Genesis CPU);')}<br><span class="mono">4246.0.tape</span> ${t('—— 同一个地址，写成名字的形式（电路编号.处理器编号.tape，例如 123.30.tape 就是 30 号处理器 TapeOut 上的第 123 枚）。', '— the same address written as a name (circuit.processor.tape; for example 123.30.tape is circuit #123 on processor 30, TapeOut).')}</p>
<p>${t('所有网页文件都存在 BNB Chain 上。这个页面只负责读取链上数据，不经手任何内容。', 'Every file of the website is stored on BNB Chain. This page only reads on-chain data and never handles any content.')}</p>
<div class="card"><form id="go"><input id="addr" class="mono" autofocus placeholder="4246.0.tape / #4246@0 / 0x…" spellcheck="false"><button type="submit">${t('打开', 'Open')}</button></form>
<p class="hint" id="err"></p></div>
<div class="card"><div class="row"><span>${t('让浏览器把 <span class="mono">web+tape://</span> 链接交给这个网关打开', 'Let the browser open <span class="mono">web+tape://</span> links with this gateway')}</span> <button class="plain" id="reg">${t('注册', 'Register')}</button></div><p class="hint" id="regMsg" style="margin:10px 0 0"></p></div>
<p class="hint">${t('每个网站都在独立的来源下运行（可以保存数据、可以用你的钱包扩展）。文件与链上 SHA-256 逐个核对，至少两家节点运营方结果一致才采用。链外请求默认拦截，可在每个网站的 /.tape/status 查看和放行。', 'Each site runs in its own origin (it can store data and use your wallet extension). Every file is checked against its on-chain SHA-256, and at least two independent node operators must agree. Off-chain requests are blocked by default; see and allow them at each site\'s /.tape/status.')}</p>`;
  $('go').addEventListener('submit', (e) => {
    e.preventDefault();
    const target = toSiteUrl($('addr').value);
    if (target) location.href = target; else $('err').textContent = t('看不懂这个地址。例子：4246.0.tape、#4246@0、tape://4246.0.tape/、0x…（容器地址暂不支持，请先在查看器里反查出名字）', 'Unrecognised address. Examples: 4246.0.tape, #4246@0, tape://4246.0.tape/ (container addresses: look up the name in the viewer first)');
  });
  $('reg').addEventListener('click', () => {
    try { navigator.registerProtocolHandler('web+tape', location.origin + '/?open=%s'); $('regMsg').textContent = t('已请求注册，请在浏览器的提示里确认。', 'Requested; confirm in the browser prompt.'); }
    catch (e) { $('regMsg').textContent = String(e && e.message || e); }
  });
}

/** 把用户输入（链上名字、#ID@编号、tape:// 网址、web+tape:// 网址）变成本网关的子域名网址 */
function toSiteUrl(raw) {
  let s = String(raw || '').trim().replace(/^(web\+)?tape:\/\//i, '');
  let mm, id, cpu, rest = '';
  if ((mm = s.match(/^#?([0-9]+)@([0-9]+)(\/.*)?$/))) { id = mm[1]; cpu = mm[2]; rest = mm[3] || ''; }
  else if ((mm = s.match(/^([0-9]+)\.([0-9]+)(?:\.tape)?\.?(\/.*)?$/i))) { id = mm[1]; cpu = mm[2]; rest = mm[3] || ''; }
  else return null;
  if (!/^(0|[1-9][0-9]*)$/.test(id) || !/^(0|[1-9][0-9]*)$/.test(cpu) || id === '0') return null;
  return `${location.protocol}//${id}-${cpu}.${host}${location.port ? ':' + location.port : ''}${rest || '/'}`;
}
