// 弹出窗口：①打开链上网站 ②校验当前 https 网页是否与链上发布的字节一致（BEP 草案 §3.5 的简化版）。
// 校验方式：读 DNS 里的 _frontend / _tapeout 记录找到容器 → 链上确认该域名为这个容器付费有效 →
// 把当前页面加载过的「会执行的资源」（页面本身、脚本）重新下载，与链上文件逐个比对 SHA-256。
import { createKernel, sha256Hex, toChecksumAddress } from '../kernel/src/index.js';
import { getGateway, setGateway, targetUrl } from '../gateway.js';

const $ = (id) => document.getElementById(id);
const kernel = createKernel();
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cs = (a) => { try { return toChecksumAddress(a); } catch { return a; } };

$('open').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $('q').value.trim();
  if (q) chrome.tabs.create({ url: targetUrl(q, await getGateway()) });
});
getGateway().then((g) => { $('gateway').value = g; $('mode').textContent = g ? `经网关 ${g} 打开（真实来源，可存数据、可用钱包）` : '在扩展内的沙盒查看器打开（预览模式，不能存数据、不能用钱包）'; });
$('gateway').addEventListener('change', async () => { await setGateway($('gateway').value); const g = await getGateway(); $('mode').textContent = g ? `经网关 ${g} 打开（真实来源，可存数据、可用钱包）` : '在扩展内的沙盒查看器打开（预览模式，不能存数据、不能用钱包）'; });

let tab = null;
chrome.tabs.query({ active: true, currentWindow: true }).then(([t]) => {
  tab = t;
  try { const u = new URL(t.url); $('host').textContent = u.hostname || t.url; if (!/^https?:$/.test(u.protocol)) $('check').disabled = true; }
  catch { $('check').disabled = true; }
});

function show(kind, title, html = '') {
  const r = $('result');
  r.hidden = false; r.className = 'result ' + kind;
  r.innerHTML = `<h3>${esc(title)}</h3>${html}`;
}

const DOH = ['https://cloudflare-dns.com/dns-query', 'https://dns.google/resolve'];
async function txt(name) {
  for (const base of DOH) {
    try {
      const r = await fetch(`${base}?name=${encodeURIComponent(name)}&type=TXT`, { headers: { accept: 'application/dns-json' } });
      if (!r.ok) continue;
      const j = await r.json();
      if (j.Status === 3) return [];
      if (j.Status !== 0) continue;
      return (j.Answer || []).filter((a) => a.type === 16).map((a) => String(a.data).replace(/^"|"$/g, '').replace(/"\s*"/g, ''));
    } catch { /* 换下一家 */ }
  }
  throw new Error('DNS 查询失败');
}

// _frontend.<host> "v=1 chain=56 store=0x… site=0x…"（BEP 草案），或旧格式 _tapeout.<host> 里的一个 0x 地址
async function candidates(host) {
  const out = [];
  const store = kernel.config.registries[0];
  for (const rec of await txt('_frontend.' + host)) {
    const kv = Object.fromEntries(rec.split(/\s+/).map((p) => p.split('=')).filter((p) => p.length === 2));
    if (kv.v === '1' && kv.chain === '56' && /^0x[0-9a-fA-F]{40}$/.test(kv.site || '') && String(kv.store || '').toLowerCase() === store) out.push(kv.site.toLowerCase());
  }
  for (const rec of await txt('_tapeout.' + host)) for (const m of rec.toLowerCase().match(/(?<![0-9a-z])0x[0-9a-f]{40}(?![0-9a-z])/g) || []) out.push(m);
  return [...new Set(out)].slice(0, 5);
}

$('check').addEventListener('click', async () => {
  if (!tab) return;
  $('check').disabled = true;
  show('', '正在核对…');
  try {
    const page = new URL(tab.url);
    const host = page.hostname.toLowerCase();
    const cands = await candidates(host);
    let container = null;
    for (const c of cands) if (await kernel.domainLive(host, c)) { container = c; break; }
    if (!container) return show('', '未绑定', `<p class="hint">${esc(host)} 没有登记链上版本（没有 _frontend / _tapeout 记录，或没有有效付费）。</p>`);
    const res = await kernel.resolve(container);
    if (!res.name) return show('bad', '容器无效', `<p class="mono">${esc(cs(container))}</p>`);
    const man = await kernel.manifest(res);

    const [{ result: seen }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => ({
        href: location.href,
        scripts: [...document.scripts].map((s) => s.src).filter(Boolean),
        preloads: [...document.querySelectorAll('link[rel="modulepreload"][href]')].map((l) => l.href),
        loaded: performance.getEntriesByType('resource').filter((e) => e.initiatorType === 'script').map((e) => e.name),
      }),
    });
    const exec = [...new Set([seen.href, ...seen.scripts, ...seen.preloads, ...seen.loaded])];
    const cross = exec.filter((u) => { try { return new URL(u).origin !== page.origin; } catch { return true; } });
    const same = exec.filter((u) => !cross.includes(u));

    const rows = [];
    let mismatch = 0;
    for (const u of same) {
      const path = new URL(u).pathname;
      const onChain = await kernel.getFile(res, man, path);
      const r = await fetch(u, { cache: 'no-store', credentials: 'omit' });
      const got = await sha256Hex(new Uint8Array(await r.arrayBuffer()));
      const ok = !!onChain && onChain.verified && onChain.sha256 === got;
      if (!ok) mismatch++;
      rows.push(`<li>${ok ? '✓' : '✗'} ${esc(path)}${onChain ? '' : '（链上没有）'}</li>`);
    }
    const who = `<p class="mono">${esc(res.name)} · ${esc(res.cpuName || '')} #${res.tokenId}<br>容器 ${esc(cs(res.container))}${res.holder ? `<br>持有人 ${esc(cs(res.holder))}` : ''}</p>`;
    const list = `<ul>${rows.join('')}${cross.map((u) => `<li>⚠ 跨域脚本：${esc(u)}</li>`).join('')}</ul>`;
    if (mismatch) show('bad', `与链上不一致（${mismatch} 个文件）`, who + list);
    else if (cross.length) show('warn', '无法完整校验：页面加载了跨域脚本', who + list);
    else show('ok', `已发布上链：${same.length} 个文件与链上一致`, who + list + '<p class="hint">「已发布」只说明字节与链上一致，不代表网站可信；请核对名字和持有人。</p>');
  } catch (e) {
    show('bad', '核对失败', `<p class="hint">${esc(e.message || e)}</p>`);
  } finally {
    $('check').disabled = false;
  }
});
