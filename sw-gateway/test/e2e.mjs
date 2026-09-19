// 端到端测试：真 Chrome（无头）+ 本机网关 + 主网只读。
// 跑法：node test/e2e.mjs   （需要本机装有 Google Chrome；不发交易、不需要密钥）
// 检查：Service Worker 接管、样例站字节与链上 SHA-256 一致、独立来源可存数据、两个网站互不可见、
//       前端路由回退、404、链外数据放行并记录、链外脚本被拦、状态页、未开通名字不显示、根域名首页。
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import server from '../dev-server.mjs';

const PORT = 8096;
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SITE = `http://4246-0.localhost:${PORT}`;
const OTHER = `http://1-0.localhost:${PORT}`;
const ROOT = `http://localhost:${PORT}`;
const INDEX_SHA = 'ec444c899bd9229f9173082fff362da66dd297179482a58b30b6f53ce9f7a0b6';   // SPEC §14：4246.0.tape 的 index.html

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? '✅' : '❌'} ${name}${detail ? '  — ' + detail : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tape-e2e-'));
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
const wsUrl = await new Promise((res, rej) => {
  let buf = '';
  chrome.stderr.on('data', (d) => { buf += d; const m = buf.match(/DevTools listening on (ws:\/\/\S+)/); if (m) res(m[1]); });
  chrome.on('exit', (c) => rej(new Error('chrome exited ' + c)));
  setTimeout(() => rej(new Error('chrome did not start: ' + buf)), 15000);
});

// ---- 极简 CDP 客户端
const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener('open', r));
let seq = 0; const waiting = new Map(); const listeners = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && waiting.has(m.id)) { const { res, rej } = waiting.get(m.id); waiting.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
  else if (m.method) for (const l of listeners) l(m);
});
const send = (method, params = {}, sessionId) => new Promise((res, rej) => { const id = ++seq; waiting.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params, sessionId })); });
const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
await send('Page.enable', {}, sessionId);
await send('Runtime.enable', {}, sessionId);
const evalIn = async (expr) => {
  // 所有值以 JSON 文本传回，避免 CDP 对大数组/对象序列化的差异
  const r = await send('Runtime.evaluate', { expression: `(async () => JSON.stringify(await (${expr})) ?? 'null')()`, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  const v = r.result.value;
  return typeof v === 'string' ? JSON.parse(v) : v;
};
const goto = async (url) => { await send('Page.navigate', { url }, sessionId); await sleep(300); };
const waitFor = async (expr, ms = 30000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await evalIn(expr)) return true; } catch {} await sleep(250); } return false; };

try {
  // 1) 样例站：引导页 → Service Worker 接管 → 页面来自链上
  await goto(SITE + '/');
  const took = await waitFor(`navigator.serviceWorker && navigator.serviceWorker.controller && !document.getElementById('msg')`);
  check('Service Worker 接管并渲染样例站', took, await evalIn('location.href'));
  check('来源是独立的子域名', (await evalIn('location.origin')) === SITE, await evalIn('location.origin'));
  const page = await evalIn(`fetch('/index.html', {cache:'no-store'}).then(async r => ({ status: r.status, name: r.headers.get('x-tape-name'), verified: r.headers.get('x-tape-verified'), sha: r.headers.get('x-tape-sha256'), ct: r.headers.get('content-type'), bytes: Array.from(new Uint8Array(await r.arrayBuffer())) }))`);
  const sha = createHash('sha256').update(Buffer.from(page.bytes)).digest('hex');
  check('index.html 字节与链上声明的 SHA-256 一致（网关已校验）', '0x' + sha === page.sha && page.verified === '1', `${page.bytes.length} B · ${sha.slice(0, 12)}… · ${page.ct}`);
  check('与规范 §14 的测试向量一致', sha === INDEX_SHA, sha === INDEX_SHA ? '' : `链上文件已更新：现在 ${page.bytes.length} B，sha ${sha}；规范里的向量要跟着改`);
  check('响应头带链上名字', page.name === '4246.0.tape', page.name);
  const docSha = createHash('sha256').update(Buffer.from(await evalIn(`fetch(location.href, {cache:'no-store'}).then(r => r.arrayBuffer()).then(b => Array.from(new Uint8Array(b)))`))).digest('hex');
  check('当前页面本身也是链上那份', docSha === sha);

  // 2) 真实来源：能保存数据，刷新后还在
  await evalIn(`(localStorage.setItem('tape-e2e', 'kept'), 'ok')`);
  await goto(SITE + '/');
  await waitFor(`!document.getElementById('msg')`);
  check('localStorage 刷新后仍在', (await evalIn(`localStorage.getItem('tape-e2e')`)) === 'kept');

  // 3) 路径规则：前端路由回退到 index.html；带扩展名的缺失文件 404
  const route = await evalIn(`fetch('/some/route', {cache:'no-store'}).then(async r => ({ status: r.status, sha: r.headers.get('x-tape-sha256') }))`);
  check('无扩展名路径回退到 index.html', route.status === 200 && route.sha === '0x' + sha, JSON.stringify(route));
  const missing = await evalIn(`fetch('/missing.png', {cache:'no-store'}).then(r => r.status)`);
  check('缺失文件 404', missing === 404, String(missing));

  // 4) 链外访问：数据（接口、图片）放行并记录；链外脚本被拦
  const ext = await evalIn(`fetch('https://example.com/', {mode:'no-cors'}).then(r => ({ type: r.type })).catch(e => ({ err: String(e) }))`);
  check('链外 fetch 能发出', ext.type === 'opaque', JSON.stringify(ext));
  const img = await evalIn(`new Promise(res => { const i = new Image(); i.onload = () => res('loaded'); i.onerror = () => res('error'); i.src = 'https://www.google.com/favicon.ico?' + Math.random(); })`);
  check('链外图片能加载', img === 'loaded', img);
  const ws = await evalIn(`new Promise(res => { try { const w = new WebSocket('wss://echo.websocket.org'); w.onopen = () => { res('open'); w.close(); }; w.onclose = (e) => res('close:' + e.code); w.onerror = () => res('error'); setTimeout(() => res('timeout'), 8000); } catch (e) { res('threw:' + e.message); } })`);
  check('链外 WebSocket 能连上（钱包连接要用）', ws === 'open', String(ws));
  const script = await evalIn(`new Promise(res => { const s = document.createElement('script'); s.src = 'https://cdn.jsdelivr.net/npm/lodash@4.17.21/lodash.min.js'; s.onload = () => res('loaded'); s.onerror = () => res('blocked'); document.head.appendChild(s); setTimeout(() => res('timeout'), 8000); })`);
  check('链外脚本被拦（代码只能来自链上）', script === 'blocked', script);
  const imp = await evalIn(`import('https://cdn.jsdelivr.net/npm/lodash@4.17.21/lodash.min.js').then(() => 'loaded', () => 'blocked')`);
  check('链外脚本用 import() 也被拦', imp === 'blocked', imp);
  await sleep(1500);   // 等浏览器把 CSP 违规报告发给网关
  let st = await evalIn(`fetch('/.tape/status?json=1', {cache:'no-store'}).then(r => r.json())`);
  check('状态页 JSON：身份正确', st.name === '4246.0.tape' && st.status === 'ok' && st.container === '0x86ddaef00401e3f10418398d67d7189fc458ea95' && st.cpu === '0', `${st.cpuName} · holder ${st.holder}`);
  check('状态页记录了链外访问（不含查询参数）', st.offchain.some((b) => b.url === 'https://example.com/') && st.offchain.every((b) => !b.url.includes('?')), st.offchain.map((b) => b.url).join(', '));
  check('状态页记录了被拦的链外脚本', st.blocked.some((b) => b.url.startsWith('https://cdn.jsdelivr.net/')), st.blocked.map((b) => b.url).join(', '));
  check('状态页记录了已校验文件', st.files.some((f) => f.path === 'index.html' && f.status === 'ok'), JSON.stringify(st.files.map((f) => f.path + ':' + f.status)));
  check('节点统计有数据', Object.values(st.nodes).some((n) => n.ok > 0), Object.entries(st.nodes).map(([h, n]) => `${h}:${n.ok}/${n.fail}/${n.rateLimited}`).join(' '));
  check('状态 JSON 不含节点完整网址（只有主机名）', !('rpcUrls' in st) && Object.keys(st.nodes).every((h) => !h.includes('/')) && Array.isArray(st.nodeHosts), Object.keys(st.nodes).join(' '));
  const statusHtml = await evalIn(`fetch('/.tape/status', {cache:'no-store'}).then(r => r.text())`);
  check('状态页 HTML 显示名字、持有人，有链外访问时不显示「100% 链上」', statusHtml.includes('4246.0.tape') && statusHtml.includes(st.holder) && !statusHtml.includes('100% 链上') && !statusHtml.includes('100% on-chain'), `${statusHtml.length} chars`);
  // 网站脚本想换成自己的节点：这个设置已经不存在，提交了也没用
  await evalIn(`fetch('/.tape/settings', {method:'POST', body: new URLSearchParams({ rpcs: 'https://evil-node.example/rpc', back: '/.tape/status' }), redirect: 'manual'}).then(r => r.type)`);
  await goto(SITE + '/');
  await waitFor(`navigator.serviceWorker && navigator.serviceWorker.controller`);
  st = await evalIn(`fetch('/.tape/status?json=1', {cache:'no-store'}).then(r => r.json())`);
  check('网站提交的节点没有生效（仍是默认节点）', !Object.keys(st.nodes).some((h) => /evil/.test(h)) && st.quorum >= 2, Object.keys(st.nodes).join(' '));

  // 4b) 网站自己开的沙盒 srcdoc / blob / data 子框架：Service Worker 管不到，要靠网站响应的 CSP（子框架继承）拦链外脚本
  await goto(SITE + '/');
  await waitFor(`navigator.serviceWorker && navigator.serviceWorker.controller`);
  const frameProbe = await evalIn(`new Promise((done) => {
    const got = {}; let n = 0;
    addEventListener('message', (ev) => { if (ev.data && ev.data.probe) { got[ev.data.probe] = ev.data.r; if (++n >= 4) done(got); } });
    const code = (tag) => "<script>var s=document.createElement('script');s.src='https://cdn.jsdelivr.net/npm/lodash@4.17.21/lodash.min.js';s.onload=function(){parent.postMessage({probe:'" + tag + "',r:'loaded'},'*')};s.onerror=function(){parent.postMessage({probe:'" + tag + "',r:'blocked'},'*')};document.head.appendChild(s)<\/script>";
    const a = document.createElement('iframe'); a.sandbox = 'allow-scripts'; a.srcdoc = code('srcdoc-sandbox'); document.body.appendChild(a);
    const b = document.createElement('iframe'); b.srcdoc = code('srcdoc'); document.body.appendChild(b);
    const c = document.createElement('iframe'); c.src = URL.createObjectURL(new Blob([code('blob')], { type: 'text/html' })); document.body.appendChild(c);
    const d = document.createElement('iframe'); d.src = 'data:text/html,' + encodeURIComponent(code('data')); document.body.appendChild(d);
    setTimeout(() => done(got), 6000);
  })`);
  // 跳板：把同源里网关自己生成的文档（状态 JSON、状态页、配置、内核脚本、sw.js）嵌进框架，在里面再开沙盒子框架往外发
  const springboard = await evalIn(`Promise.all(['/.tape/status?json=1', '/.tape/status', '/.tape/config.json', '/.tape/kernel/index.js', '/sw.js', '/nope-404'].map((p) => new Promise((done) => {
    const f = document.createElement('iframe'); f.src = p;
    f.onload = () => {
      try {
        const d = f.contentDocument; if (!d || !d.body) return done(p + ':no-doc');
        const s = d.createElement('iframe'); s.sandbox = 'allow-scripts';
        s.srcdoc = "<script src='https://cdn.jsdelivr.net/npm/lodash@4.17.21/lodash.min.js' onload=\\x22parent.parent.postMessage({sb:'${'$'}{p}',r:'sent'},'*')\\x22 onerror=\\x22parent.parent.postMessage({sb:'${'$'}{p}',r:'blocked'},'*')\\x22><\/script>";
        const on = (ev) => { if (ev.data && ev.data.sb === p) { removeEventListener('message', on); done(p + ':' + ev.data.r); } };
        addEventListener('message', on); d.body.appendChild(s);
        setTimeout(() => done(p + ':no-run'), 4000);
      } catch (e) { done(p + ':err'); }
    };
    document.body.appendChild(f);
  })))`);
  check('同源文档当跳板也加载不了链外脚本', springboard.every((x) => !x.endsWith(':sent')), springboard.join(' '));
  // blob、data 子框架本身就被 frame-src 挡住，里面的代码根本不运行；srcdoc 子框架能运行，但继承了 CSP，拉不到链外脚本
  check('网站开的沙盒/srcdoc/blob/data 子框架加载不了链外脚本', frameProbe['srcdoc'] === 'blocked' && frameProbe['srcdoc-sandbox'] === 'blocked' && !Object.values(frameProbe).includes('loaded'), JSON.stringify(frameProbe));
  const nodeDirect = await evalIn(`Promise.all([
    fetch('https://bsc-dataseed.bnbchain.org/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }) }).then((r) => r.status, () => 'blocked'),
    fetch('https://56.rpc.thirdweb.com/somekey', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then((r) => r.status, () => 'blocked'),
  ])`);
  check('网站能直连链上节点', nodeDirect[0] === 200, JSON.stringify(nodeDirect));

  // 5) 另一个名字：未开通/未开通容器 → 不显示；来源隔离
  await goto(OTHER + '/');
  await waitFor(`navigator.serviceWorker && navigator.serviceWorker.controller && !document.getElementById('msg')`);
  // 说明页自带 default-src 'none' 的 CSP（没有脚本），页面里发不了 fetch，所以看页面文本和 HTML
  const other = await evalIn(`({ text: document.body.innerText, html: document.documentElement.outerHTML })`);
  check('1.0.tape 不显示（非 ok 状态页，无脚本）', /1\.0\.tape/.test(other.text) && /Cannot display|无法显示/.test(other.text) && !/<script/i.test(other.html), other.text.split('\n').slice(0, 3).join(' / '));
  await goto(OTHER + '/.tape/status?json=1');
  await sleep(1500);
  const otherJson = JSON.parse(await evalIn(`document.body.innerText`));
  check('1.0.tape 状态为 not-opened 且 showable=false', otherJson.status === 'not-opened' && otherJson.showable === false, otherJson.status);
  await goto(OTHER + '/');
  await sleep(1000);
  check('另一个来源看不到前一个网站的 localStorage', (await evalIn(`localStorage.getItem('tape-e2e')`)) === null);

  // 6) 根域名首页 + 输入跳转
  await goto(ROOT + '/');
  await waitFor(`document.getElementById('addr')`);
  check('根域名显示首页', await evalIn(`!!document.getElementById('addr')`));
  await evalIn(`(document.getElementById('addr').value = 'tape://4246.0/docs/', document.getElementById('go').requestSubmit(), 'ok')`);
  await sleep(800);
  check('输入 tape://4246.0/docs/ 跳到子域名', (await evalIn('location.href')).startsWith(SITE + '/docs/'), await evalIn('location.href'));
  await goto(ROOT + '/?open=' + encodeURIComponent('web+tape://4246.0.tape/a.html'));
  await sleep(800);
  check('web+tape 链接经 ?open= 跳转', (await evalIn('location.href')) === SITE + '/a.html', await evalIn('location.href'));

  // 6b) 带区号的名字：X Layer（区号 2）、Base（区号 3）。两条链上还没有处理器，应读到 no-such-cpu，且读的是那条链
  for (const [area, chainId, net] of [[2, 196, 'xlayer'], [3, 8453, 'base']]) {
    const L2 = `http://1-${area}-0.localhost:${PORT}`;
    await goto(L2 + '/');
    await waitFor(`navigator.serviceWorker && navigator.serviceWorker.controller && !document.getElementById('msg')`, 60_000);
    await goto(L2 + '/.tape/status?json=1');
    await sleep(2500);
    const j = JSON.parse(await evalIn(`document.body.innerText`));
    check(`1-${area}-0 → 1.${area}.0.tape 在 ${net} 上解析（chainId ${chainId}）`, j.name === `1.${area}.0.tape` && j.chainId === chainId && j.network === net && j.showable === false, `${j.name} ${j.chainId} ${j.status}`);
    check(`1.${area}.0 状态页只列 ${net} 的节点`, Array.isArray(j.nodeHosts) && j.nodeHosts.length > 0 && !j.nodeHosts.some((u) => /bsc|bnbchain|defibit|ninicoin/.test(u)), (j.nodeHosts || []).join(' '));
  }
  await goto(ROOT + '/');
  await waitFor(`document.getElementById('addr')`);
  await evalIn(`(document.getElementById('addr').value = '#1@2.344/a?x=1', document.getElementById('go').requestSubmit(), 'ok')`);
  await sleep(800);
  check('输入 #1@2.344/a?x=1 跳到 1-2-344 子域名（查询串保留）', (await evalIn('location.href')) === `http://1-2-344.localhost:${PORT}/a?x=1`, await evalIn('location.href'));

  // 7) 主机名写错
  await goto(`http://04246-0.localhost:${PORT}/`);
  await sleep(1500);
  const bad = await evalIn(`document.body.innerText`);
  check('前导 0 的主机名被拒绝', /主机名|host/i.test(bad), bad.slice(0, 60).replace(/\n/g, ' '));
  await goto(`http://1-1-0.localhost:${PORT}/`);
  await sleep(1500);
  const bad2 = await evalIn(`document.body.innerText`);
  check('未分配的区号（1）被拒绝', /主机名|host/i.test(bad2), bad2.slice(0, 60).replace(/\n/g, ' '));
} catch (e) {
  check('测试脚本异常', false, String(e && e.stack || e));
} finally {
  try { ws.close(); } catch {}
  chrome.kill('SIGKILL');
  server.close();
  fs.rmSync(profile, { recursive: true, force: true });
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
