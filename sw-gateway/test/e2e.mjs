// 端到端测试：真 Chrome（无头）+ 本机网关 + 主网只读。
// 跑法：node test/e2e.mjs   （需要本机装有 Google Chrome；不发交易、不需要密钥）
// 检查：Service Worker 接管、样例站字节与链上 SHA-256 一致、独立来源可存数据、两个网站互不可见、
//       前端路由回退、404、链外请求被拦截并能逐站放行、状态页、未开通名字不显示、根域名首页。
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

  // 4) 链外请求：默认拦截并记录；状态页放行后能发出
  const ext = await evalIn(`fetch('https://example.com/', {mode:'cors'}).then(r => ({ status: r.status, blocked: r.headers.get('x-tape-blocked') })).catch(e => ({ err: String(e) }))`);
  check('链外 fetch 被拦截（403）', ext.status === 403 && ext.blocked === '1', JSON.stringify(ext));
  const img = await evalIn(`new Promise(res => { const i = new Image(); i.onload = () => res('loaded'); i.onerror = () => res('error'); i.src = 'https://example.com/x.png?' + Math.random(); })`);
  check('链外图片被拦截', img === 'error', img);
  let st = await evalIn(`fetch('/.tape/status?json=1', {cache:'no-store'}).then(r => r.json())`);
  check('状态页 JSON：身份正确', st.name === '4246.0.tape' && st.status === 'ok' && st.container === '0x86ddaef00401e3f10418398d67d7189fc458ea95' && st.cpu === '0', `${st.cpuName} · holder ${st.holder}`);
  check('状态页记录了被拦截的请求', st.blocked.some((b) => b.url.startsWith('https://example.com/')), st.blocked.map((b) => b.url).join(', '));
  check('状态页记录了已校验文件', st.files.some((f) => f.path === 'index.html' && f.status === 'ok'), JSON.stringify(st.files.map((f) => f.path + ':' + f.status)));
  check('节点统计有数据', Object.values(st.nodes).some((n) => n.ok > 0), Object.entries(st.nodes).map(([u, n]) => `${new URL(u).hostname}:${n.ok}/${n.fail}/${n.rateLimited}`).join(' '));
  const statusHtml = await evalIn(`fetch('/.tape/status', {cache:'no-store'}).then(r => r.text())`);
  check('状态页 HTML 显示名字与持有人', statusHtml.includes('4246.0.tape') && statusHtml.includes(st.holder), `${statusHtml.length} chars`);
  await evalIn(`fetch('/.tape/settings', {method:'POST', body: new URLSearchParams({ offchain: '1', rpcs: '', back: '/.tape/status' }), redirect: 'manual'}).then(r => r.type)`);
  const ext2 = await evalIn(`fetch('https://example.com/', {mode:'no-cors'}).then(r => ({ type: r.type, status: r.status })).catch(e => ({ err: String(e) }))`);
  check('放行后链外请求能发出', ext2.type === 'opaque' || ext2.status === 200, JSON.stringify(ext2));
  st = await evalIn(`fetch('/.tape/status?json=1', {cache:'no-store'}).then(r => r.json())`);
  check('放行记录出现在状态页', st.settings.offchain === true && st.allowed.length > 0);
  await evalIn(`fetch('/.tape/settings', {method:'POST', body: new URLSearchParams({ rpcs: '', back: '/.tape/status' }), redirect: 'manual'}).then(r => r.type)`);   // 撤销放行

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

  // 7) 主机名写错
  await goto(`http://04246-0.localhost:${PORT}/`);
  await sleep(1500);
  const bad = await evalIn(`document.body.innerText`);
  check('前导 0 的主机名被拒绝', /主机名|host/i.test(bad), bad.slice(0, 60).replace(/\n/g, ' '));
} catch (e) {
  check('测试脚本异常', false, String(e && e.stack || e));
} finally {
  try { ws.close(); } catch {}
  chrome.kill('SIGKILL');
  server.close();
  // Windows：kill 之后 Chrome 的子进程还会短暂占着 user-data-dir，立刻删除会得到 EPERM（macOS/Linux 上不会）。
  // 先等它退场（最多 5 秒），再带重试删；仍然删不掉就放过——它在系统临时目录里，清理不该让测试结果变成失败。
  await new Promise((done) => {
    if (chrome.exitCode !== null) return done();
    chrome.once('exit', done);
    setTimeout(done, 5000);
  });
  try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
  catch (e) { console.log(`临时目录未能删除，留给系统清理：${profile}（${e && e.code || e}）`); }
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
