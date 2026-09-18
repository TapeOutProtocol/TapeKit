// TapeSend 桌面版（macOS / Windows）主进程。
// 两个隔离的网页：
//   1. 应用界面（app://tapesend/）——消息、钱包、钥匙都在这里；
//   2. TapeKit 浏览器视图（tape://<名字>.tape/）——运行链上网站。独立来源、独立会话、没有 preload，
//      链上网站的代码摸不到应用界面里的任何东西（TAP-10 §12：私钥逻辑绝不和"运行陌生人的网页"放在一起）。
import { app, BaseWindow, WebContentsView, Menu, protocol, ipcMain, shell, session, nativeTheme, dialog } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { createTapeProtocol } from './tape-protocol.mjs';
import { parseInput } from '../../../kernel/src/name.js';
import { BSC_MAINNET } from '../../../kernel/src/config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(here, '..', 'dist');  // 打包后 main.mjs 在 dist-electron/，界面在同级的 dist/
// 开发和冒烟测试用的环境变量：打包后的正式版一律不认
const DEV_URL = !app.isPackaged ? process.env.TAPESEND_DEV_URL || '' : '';
const DEV_ORIGIN = DEV_URL ? new URL(DEV_URL).origin : '';
const SMOKE_DIR = !app.isPackaged ? process.env.TAPESEND_SMOKE || '' : '';
const BLOCKLIST_URL = 'https://tapekit.org/.tape/blocklist.txt';
// 桌面界面不嵌任何框架（钱包来源核验在非网页版里跳过）：内嵌钱包等第三方框架一律不许加载
const UI_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data: https:; connect-src 'self' https: wss:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

// tape 协议不开放 Service Worker：网站注册的后台脚本能拦截请求，绕过逐文件校验、屏蔽和付费状态
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
  { scheme: 'tape', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.woff2': 'font/woff2' };

/** 地址栏输入 → 浏览器视图要打开的 URL；普通网址交给系统浏览器（需确认） */
function toTapeUrl(raw) {
  const s = String(raw || '').trim();
  try {
    const p = parseInput(s);
    if (p.kind === 'name') return { tape: `tape://${p.tokenId}.${p.cpu}.tape/${p.path || ''}` };
  } catch {
    // 不是链上名字
  }
  if (/^https?:\/\//i.test(s)) return { external: s };
  if (/^[a-z0-9.-]+\.[a-z]{2,}(\/\S*)?$/i.test(s)) return { external: `https://${s}` };
  return null;
}

const NOTICE_PREFIX = 'data:text/html;charset=utf-8,';
// 界面语言：默认跟随系统；界面里切换中英文时由界面告诉主进程（弹窗、提示页跟着变）
let uiLocale = null;
const isZh = () => (uiLocale ?? (app.getLocale().startsWith('zh') ? 'zh' : 'en')) === 'zh';
function displayOf(url) {
  if ((url || '').startsWith(NOTICE_PREFIX)) return isZh() ? '已停止加载' : 'Stopped loading';
  const m = /^tape:\/\/(\d+)\.(\d+)\.tape(\/.*)?$/i.exec(url || '');
  // 地址栏只显示 4246.0：.tape 只是内部网址用的（纯数字主机名会被当成 IP 地址），不给用户看
  if (m) return `${m[1]}.${m[2]}${m[3] && m[3] !== '/' ? m[3] : ''}`;
  if (/^tape:\/\//i.test(url || '')) {
    // 非规范地址原样显示（包括结尾多出的点），不能修饰成和正规地址一样
    try { const u = new URL(url); return u.hostname + (u.pathname && u.pathname !== '/' ? u.pathname : ''); } catch { /* 无效地址 */ }
  }
  return url || '';
}

/* global __UI_EXTRA_HOSTS__ */
// DNS 白名单：Chromium 网络栈只解析界面自己要连的主机（节点、索引器、钱包连接服务）。
// 链上网站写 <link rel=dns-prefetch>、或让 WebRTC 解析 TURN 主机名，都会发出 DNS 查询，
// 攻击者的域名服务器能借此收发数据、追踪访客；代理管不到 DNS。这里让其它名字一律解析失败（含 .local 的 mDNS）。
// 主进程里内核读链用的是 Node 自己的网络栈，不受这条规则影响。
const UI_HOSTS = [
  ...BSC_MAINNET.rpcs.map((u) => new URL(u).hostname),
  ...(typeof __UI_EXTRA_HOSTS__ !== 'undefined' ? __UI_EXTRA_HOSTS__ : []),
  '*.walletconnect.org', '*.walletconnect.com', 'walletconnect.org', 'walletconnect.com',
  '*.reown.com', 'reown.com', '*.web3modal.org', '*.web3modal.com',
  '*.coinbase.com', '*.cb-w.com', '*.bscscan.com',
  // 开发模式（未打包、设置了开发地址）才放行开发服务器
  ...(DEV_ORIGIN ? [new URL(DEV_ORIGIN).hostname] : []),
];
app.commandLine.appendSwitch('host-resolver-rules', ['MAP * ~NOTFOUND', ...[...new Set(UI_HOSTS)].map((h) => `EXCLUDE ${h}`)].join(', '));

// 正式包拒绝带调试参数启动：fuses 挡不住 Chromium 的 --remote-debugging-*，
// 带上它启动，同一用户下的任何本机程序都能在界面里执行代码（界面持有钥匙、连着钱包）
if (app.isPackaged && ['remote-debugging-port', 'remote-debugging-pipe', 'remote-allow-origins', 'inspect', 'inspect-brk'].some((s) => app.commandLine.hasSwitch(s))) {
  app.exit(1);
}

// Windows / Linux：点系统里的 tape:// 链接会再启动一个实例，交给已经开着的那个处理
// 拿不到单实例锁就立刻退出，不再往下建窗口、清存储（会和已经开着的那个同时写缓存）
// 冒烟测试用独立的数据目录：不和正在运行的桌面版抢单实例锁、不动它的数据
if (SMOKE_DIR) app.setPath('userData', path.join(SMOKE_DIR, 'userdata'));
const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) app.exit(0);

// macOS 冷启动时 open-url 可能在窗口准备好之前就发出：先存下来，准备好再处理
let openUrlHandler = null;
const pendingOpenUrls = [];
app.on('will-finish-launching', () => {
  app.on('open-url', (event, url) => {
    event.preventDefault();
    if (openUrlHandler) openUrlHandler(url);
    else pendingOpenUrls.push(url);
  });
});

/** 屏蔽名单：和 tapekit.org 网关同一份，10 分钟刷新；拉不到时用上次存下的副本 */
function createBlocklist(file) {
  let names = new Set();
  let at = 0;
  const parse = (text) => new Set(text.split('\n').map((l) => l.trim().toLowerCase()).filter((l) => l && !l.startsWith('#')));
  // 先用上次存下的副本，没有就用安装包里带的初始名单：第一次离线启动也不会放行已屏蔽的网站
  const load = fs.readFile(file, 'utf8')
    .catch(() => fs.readFile(path.join(here, 'blocklist.txt'), 'utf8'))
    .then((t) => { names = parse(t); })
    .catch(() => {});
  async function refresh() {
    if (Date.now() - at < 10 * 60_000) return;
    at = Date.now();
    try {
      const r = await fetch(BLOCKLIST_URL, { cache: 'no-store', signal: AbortSignal.timeout(10_000) });
      if (!r.ok) return;
      const text = await r.text();
      if (text.length > 1_000_000) return;
      names = parse(text);
      await fs.writeFile(file, text).catch(() => {});
    } catch {
      // 拉不到就沿用旧名单
    }
  }
  const ready = load.then(() => refresh());
  return {
    isBlocked: async ({ container, name }) => {
      await ready;
      void refresh();
      return names.has(String(container).toLowerCase()) || names.has(String(name).toLowerCase());
    },
  };
}

async function main() {
  await app.whenReady();
  nativeTheme.themeSource = 'system';

  // 应用界面：只从打包好的 dist 目录读文件
  protocol.handle('app', async (request) => {
    const url = new URL(request.url);
    let rel;
    try {
      rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    } catch {
      return new Response('bad request', { status: 400 });
    }
    const file = path.normalize(path.join(distDir, rel));
    if (!file.startsWith(distDir + path.sep)) return new Response('forbidden', { status: 403 });
    try {
      const body = await fs.readFile(file);
      const headers = { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'x-content-type-options': 'nosniff' };
      if (path.extname(file) === '.html') headers['content-security-policy'] = UI_CSP;
      return new Response(body, { headers });
    } catch {
      return new Response('not found', { status: 404 });
    }
  });

  // 链上网站用单独的会话：cookie、存储、缓存都与应用界面分开
  const siteSession = session.fromPartition('persist:tapekit-sites');
  // 以前版本可能让网站注册过 Service Worker：启动时清掉
  await siteSession.clearStorageData({ storages: ['serviceworkers', 'cachestorage'] }).catch(() => {});
  // 网站会话走一个连不上的代理：WebRTC 的 TCP 中继（TURN over TCP）等不经过请求过滤器的连接也出不去。
  // 配合 disable_non_proxied_udp，UDP 也不许直连。tape:// 是本地协议处理器，不走代理，不受影响
  // 代理端口由主进程自己占住：收到连接立刻断开。不用固定端口，免得本机别的进程抢先监听、真的转发出去
  const sink = net.createServer((socket) => socket.destroy());
  await new Promise((resolve) => sink.listen(0, '127.0.0.1', resolve));
  await siteSession.setProxy({ proxyRules: `socks5://127.0.0.1:${sink.address().port}`, proxyBypassRules: '<-loopback>' });
  const blocklist = createBlocklist(path.join(app.getPath('userData'), 'blocklist.txt'));
  const tape = await createTapeProtocol({
    cacheDir: path.join(app.getPath('userData'), 'tape-cache'),
    locale: app.getLocale().startsWith('zh') ? 'zh' : 'en',
    isBlocked: blocklist.isBlocked,
  });
  siteSession.protocol.handle('tape', (request) => tape.respond(request));

  const win = new BaseWindow({
    width: 1180, height: 820, minWidth: 380, minHeight: 560, title: 'TapeSend',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 16, y: 20 },
  });

  // 正式包：换掉 Electron 默认菜单（里面有"切换开发者工具""重新加载"，快捷键 Cmd+Option+I），两个视图也关掉开发者工具。
  // 骗子常用的话术是"按这个快捷键，把这段代码粘进控制台领空投"
  if (app.isPackaged) {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      ...(process.platform === 'darwin' ? [{ role: 'appMenu', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] }] : []),
      { role: 'editMenu' },
      { role: 'windowMenu' },
    ]));
  }
  const ui = new WebContentsView({ webPreferences: { preload: path.join(here, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, devTools: !app.isPackaged } });
  // 网站视图的预加载脚本不暴露任何接口，只拿掉 WebRTC 等实时通道（纵深防御：空白子框架和 Worker 里它管不到，
  // 真正挡住链下连接的是下面的代理、UDP 策略、请求过滤器和 connect-src）
  // disableDialogs：网站不能弹系统原生的 alert/confirm/prompt（藏在后台时也能弹，会盖住整个窗口，可用来钓鱼或锁死窗口）
  const site = new WebContentsView({ webPreferences: { session: siteSession, preload: path.join(here, 'site-preload.cjs'), nodeIntegrationInSubFrames: true, contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, disableDialogs: true, devTools: !app.isPackaged } });
  // WebRTC 不许走没有代理的 UDP，不暴露本机和公网 IP
  site.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
  // 网站视图加载时的底色与消息页一致（默认是白色，页面出来之前会闪一下）
  const pageBg = () => (nativeTheme.shouldUseDarkColors ? '#111214' : '#f7f7f5');
  site.setBackgroundColor(pageBg());
  nativeTheme.on('updated', () => site.setBackgroundColor(pageBg()));
  win.contentView.addChildView(ui);
  win.contentView.addChildView(site);
  site.setVisible(false);
  let siteWanted = false;   // 界面希望显示网站视图
  let overlay = false;      // 界面上开着弹窗（钱包连接等）：网站视图必须让开，不能盖住它
  const applyVisibility = () => {
    site.setVisible(siteWanted && !overlay);
    // 切到消息页、主页或弹窗打开时，后台的网站不许出声
    site.webContents.setAudioMuted(!siteWanted);
  };

  const layout = () => {
    const { width, height } = win.getContentBounds();
    ui.setBounds({ x: 0, y: 0, width, height });
  };
  layout();
  win.on('resize', layout);

  const siteName = () => {
    try {
      const u = new URL(site.webContents.getURL());
      return u.protocol === 'tape:' ? tape.nameOf(u) : null;
    } catch {
      return null;
    }
  };

  // 网页用 beforeunload 取消卸载就能把视图锁死（地址栏、后退、系统链接全部静默失效）：永远允许离开
  site.webContents.on('will-prevent-unload', (event) => event.preventDefault());

  // 离开链上网站必须先确认，并写明目标地址（SPEC §7.6）。同一时间只弹一个；用户拒绝后 30 秒内的同类请求直接丢弃
  let asking = false;
  // 冷却按来源分开：网站被拒后刷弹窗，不能连带让界面自己的外链（查看交易等）失效
  const quietUntil = { site: 0, ui: 0 };
  async function confirmExternal(url, from) {
    // from 为 null：界面发起；否则是网站视图发起（网站名，读不到时为空字符串）
    const src = from === null ? 'ui' : 'site';
    // 网站视图不在前台时（用户在消息页或主页），网站发起的外链一律丢弃，不弹窗
    if (src === 'site' && !(siteWanted && !overlay)) return;
    if (!/^https?:\/\//i.test(url) || asking || Date.now() < quietUntil[src]) return;
    asking = true;
    try {
      const zh = isZh();
      const { response } = await dialog.showMessageBox(win, {
        type: 'warning',
        buttons: zh ? ['取消', '在系统浏览器打开'] : ['Cancel', 'Open in system browser'],
        defaultId: 0,
        cancelId: 0,
        message: zh ? '即将离开链上网站' : 'Leaving the on-chain site',
        detail: `${from ? (zh ? `来自：${from}\n` : `From: ${from}\n`) : ''}${zh ? '目标（不在链上，未经校验）：' : 'Destination (not on chain, not verified):'}\n${url.slice(0, 500)}`,
      });
      if (response === 1) {
        await shell.openExternal(url);
        quietUntil[src] = Date.now() + 5_000;
      } else quietUntil[src] = Date.now() + 30_000;
    } finally {
      asking = false;
    }
  }

  // 应用界面里的外链：同样确认后交给系统浏览器，界面本身不跳转
  ui.webContents.setWindowOpenHandler(({ url }) => {
    void confirmExternal(url, null);
    return { action: 'deny' };
  });
  ui.webContents.on('will-navigate', (event, url) => {
    let origin = '';
    try { origin = new URL(url).origin; } catch { /* 无效地址 */ }
    if (!(url.startsWith('app://tapesend/') || (DEV_ORIGIN && origin === DEV_ORIGIN))) event.preventDefault();
  });

  // 浏览器视图：只允许 tape:// 内部跳转；离开链上网站需要确认
  site.webContents.setWindowOpenHandler(({ url }) => {
    if (/^tape:\/\//i.test(url)) {
      // window.open 由主进程 loadURL 执行，不带发起页面，绕得过下面的"用户导航保护"：
      // 用户刚在地址栏去别的网站时（20 秒内），网站发起的打开一律丢弃，免得地址栏显示 A、页面却是 B
      if (userTarget && Date.now() - userNavAt < 20_000) return { action: 'deny' };
      // 后台的网站也不许自己换页
      if (!(siteWanted && !overlay)) return { action: 'deny' };
      void site.webContents.loadURL(url);
    } else void confirmExternal(url, siteName() ?? '');
    return { action: 'deny' };
  });
  site.webContents.on('will-navigate', (event, url) => {
    if (/^tape:\/\//i.test(url)) return;
    event.preventDefault();
    void confirmExternal(url, siteName() ?? '');
  });
  // 主框架只能去 tape://；其它一律取消，http(s) 走确认框（SPEC §7.6：离开链上网站必须提示），不能悄悄丢弃，
  // 也不许跳到 about:blank 这类没有徽章的空白页。子框架另外允许空白、srcdoc、data:、blob:
  // 顶层开始导航就标记当前网站：它的校验记录不能被新页面发出的大量请求挤掉（不等状态推送）
  let lastTapeUrl = '';
  site.webContents.on('did-start-navigation', (details) => {
    // 用户导航进行中，网页自己又发起了一个顶层跳转（例如在 beforeunload 里跳回自己）：它会取消用户的导航，立刻把用户的目标重新打开（有次数上限）
    if (details.isMainFrame && !details.isSameDocument && userTarget && Date.now() - userNavAt < 20_000 && details.url !== userTarget && details.initiator) {
      if (userRetries < 5) {
        userRetries += 1;
        const target = userTarget;
        setTimeout(() => { void site.webContents.loadURL(target); }, 0);
      } else {
        // 重试用尽：结束保护，让自动退回和提示页接管，不要停在没有徽章的空白页
        userNavAt = 0;
        userTarget = '';
        userRetries = 0;
      }
    }
    // 页内跳转（锚点、pushState）不是用户那次导航的结果，不能用它来结束保护
    if (details.isMainFrame && details.isSameDocument && userTarget && details.url === userTarget) { userNavAt = 0; userTarget = ''; userRetries = 0; }
    if (details.isMainFrame && /^tape:\/\//i.test(details.url)) {
      try {
        const u = new URL(details.url);
        tape.setActive(tape.nameOf(u));
        // 先清掉这个路径上次的结果：这次没记下时显示"无记录"，而不是沿用过期的"已验证"。页内跳转（锚点、pushState）不重新读文件，不清
        if (!details.isSameDocument) tape.clearPage(tape.nameOf(u), u.pathname || '/');
      } catch { /* 无效地址 */ }
    }
  });
  // about:blank、about:srcdoc 这类导航不经过 will-frame-navigate：顶层一旦落到不是 tape:// 的地址，就退回上一个链上页面，
  // 并从历史里删掉那条空白记录（否则后退会反复掉进去）。短时间内反复发生就停下，显示本地提示页
  let fallbacks = [];
  let userNavAt = 0;   // 用户从地址栏、后退、前进发起的导航开始时间：完成（到达 tape 页或失败）或 20 秒前，自动退回不能打断它
  let userTarget = '';  // 用户要去的地址（地址栏和系统链接）
  let userRetries = 0;
  const cleanHistory = () => {
    const history = site.webContents.navigationHistory;
    for (let i = history.length() - 1; i >= 0; i--) {
      const entry = history.getEntryAtIndex(i);
      if (entry && !/^tape:\/\//i.test(entry.url) && i !== history.getActiveIndex()) history.removeEntryAtIndex(i);
    }
  };
  const fallback = () => {
    if (Date.now() - userNavAt < 20_000) return;
    const now = Date.now();
    // 按 30 秒窗口计数：每秒跳一次这种慢节奏也会被识别出来
    fallbacks = fallbacks.filter((t) => now - t < 30_000);
    fallbacks.push(now);
    if (fallbacks.length > 3 || !lastTapeUrl) {
      void site.webContents.loadURL(`${NOTICE_PREFIX}${encodeURIComponent('<!doctype html><meta charset=utf-8><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'"><body style="font:15px -apple-system,sans-serif;padding:32px;color:#888;background:#f7f7f5;margin:0">' + (isZh() ? '这个网站反复离开链上页面，已停止加载。请在地址栏输入别的地址。' : 'This site kept leaving on-chain pages, so loading stopped. Enter another address.') + '</body>')}`);
      return;
    }
    void site.webContents.loadURL(lastTapeUrl);
  };
  site.webContents.on('did-navigate', (_event, url) => {
    if (/^tape:\/\//i.test(url)) {
      if (!userTarget || url === userTarget) { userNavAt = 0; userTarget = ''; userRetries = 0; }
      lastTapeUrl = url;
      tape.setCommitted(tape.nameOf(new URL(url)));
      // 回到链上页面后，把历史里的空白和提示页记录删掉，后退不会再掉进去
      cleanHistory();
      return;
    }
    if (url.startsWith(NOTICE_PREFIX)) {
      // 停在提示页时也清掉空白记录和出问题的网站：后退不会再掉回循环；计数清零，不连累下一个网站
      fallbacks = [];
      const bad = lastTapeUrl;
      const badName = bad ? tape.nameOf(new URL(bad)) : '';
      cleanHistory();
      const history = site.webContents.navigationHistory;
      for (let i = history.length() - 1; i >= 0; i--) {
        const entry = history.getEntryAtIndex(i);
        let entryName = '';
        try { entryName = entry && /^tape:\/\//i.test(entry.url) ? tape.nameOf(new URL(entry.url)) : ''; } catch { /* 无效地址 */ }
        if (entry && badName && entryName === badName && i !== history.getActiveIndex()) history.removeEntryAtIndex(i);
      }
      lastTapeUrl = '';
      return;
    }
    fallback();
  });
  site.webContents.on('did-fail-load', (_event, _code, _desc, url, isMainFrame) => {
    if (!isMainFrame) return;
    // 只有用户要去的那个地址本身加载失败，才结束保护（网页自己制造的失败不算）
    if (_code !== -3 && (!userTarget || url === userTarget)) { userNavAt = 0; userTarget = ''; userRetries = 0; }
    if (url && !/^tape:\/\//i.test(url) && !url.startsWith(NOTICE_PREFIX)) fallback();
  });
  site.webContents.on('will-frame-navigate', (event) => {
    const url = event.url;
    // 用户正在去别的地址时，网页自己发起的顶层跳转一律挡掉（否则它能不停地把用户拉回自己）
    if (event.isMainFrame && event.initiator && userTarget && url !== userTarget && Date.now() - userNavAt < 20_000) {
      event.preventDefault();
      return;
    }
    // 藏在后台的网站不许自己换顶层页面（与 window.open 规则一致）
    if (event.isMainFrame && event.initiator && !(siteWanted && !overlay)) {
      event.preventDefault();
      return;
    }
    if (/^tape:\/\//i.test(url)) return;
    // 本地提示页只能由主进程打开
    if (event.isMainFrame && url.startsWith(NOTICE_PREFIX) && !event.initiator) return;
    if (event.isMainFrame) {
      event.preventDefault();
      void confirmExternal(url, siteName() ?? '');
      return;
    }
    if (!/^(about:blank|about:srcdoc|data:|blob:)/i.test(url)) event.preventDefault();
  });
  // 链上网站不能申请摄像头、定位等权限，也不能下载文件
  siteSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  siteSession.setPermissionCheckHandler(() => false);
  // 界面会话同样收紧：Electron 默认全部放行（摄像头、麦克风、读剪贴板…），这里只留写剪贴板
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => callback(permission === 'clipboard-sanitized-write'));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'clipboard-sanitized-write');
  siteSession.on('will-download', (event) => event.preventDefault());
  // 界面本身也不下载任何东西（界面没有下载功能，出现下载一定是异常）
  session.defaultSession.on('will-download', (event) => event.preventDefault());

  let pushing = null;
  let pushAgain = false;
  async function pushState() {
    // 读链期间又来了事件：结束后按最新状态再推一次，不能丢
    if (pushing) { pushAgain = true; return pushing; }
    pushing = (async () => {
      const wc = site.webContents;
      const url = wc.getURL();
      let tapeState = null;
      if (/^tape:\/\//i.test(url)) {
        try {
          const u = new URL(url);
          tapeState = await tape.summary(tape.nameOf(u), u.pathname || '/');
        } catch (e) {
          tapeState = { status: 'error', statusText: String(e?.message || e) };
        }
      }
      if (!ui.webContents.isDestroyed()) {
        ui.webContents.send('browser:state', { url, display: displayOf(url), loading: wc.isLoading(), canBack: wc.navigationHistory.canGoBack(), canForward: wc.navigationHistory.canGoForward(), tape: tapeState });
      }
    })().finally(() => {
      pushing = null;
      if (pushAgain) { pushAgain = false; void pushState(); }
    });
    return pushing;
  }
  // 高频来源（子框架反复开关触发的 did-start-loading、被拦的链下请求）合并成每 250 毫秒最多推一次，
  // 网站可以每秒制造几百次，不能让持有钥匙的界面跟着一直重新渲染
  let throttleTimer = null;
  const pushSoon = () => {
    if (throttleTimer) return;
    throttleTimer = setTimeout(() => { throttleTimer = null; void pushState(); }, 250);
  };
  for (const ev of ['did-navigate', 'did-navigate-in-page', 'did-stop-loading', 'did-fail-load']) site.webContents.on(ev, () => void pushState());
  site.webContents.on('did-start-loading', pushSoon);

  // 链下请求默认全部拦下，并记进网站状态（SPEC §7.5）：否则一行链下脚本就能换掉整个网站，徽章却还显示已验证
  siteSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, callback) => {
    const name = siteName();
    if (name) tape.noteOffchain(name, details.url.slice(0, 300));
    callback({ cancel: true });
    // 网站在后台时不推（记录已记下，回到前台的下一次推送会带上）
    if (siteWanted && !overlay) pushSoon();
  });

  // 只接受应用界面发来的指令
  // 只接受界面主框架、并且当前地址是应用自己的页面发来的指令（子框架或被导航走的页面都不行）
  const fromUi = (event) => {
    if (event.sender !== ui.webContents) return false;
    const frame = event.senderFrame;
    const main = ui.webContents.mainFrame;
    if (!frame || !main || frame.processId !== main.processId || frame.routingId !== main.routingId) return false;
    const url = frame.url || '';
    return url.startsWith('app://tapesend/') || Boolean(DEV_ORIGIN && !app.isPackaged && url.startsWith(DEV_ORIGIN + '/'));
  };
  ipcMain.on('browser:show', (event, b) => {
    if (!fromUi(event) || !b) return;
    const n = (v) => (Number.isFinite(v) ? Math.max(0, Math.min(100_000, Math.round(v))) : 0);
    const r = { x: n(b.x), y: n(b.y), width: n(b.width), height: n(b.height) };
    site.setBounds(r);
    siteWanted = true;
    applyVisibility();
  });
  ipcMain.on('browser:hide', (event) => { if (fromUi(event)) { siteWanted = false; applyVisibility(); } });
  ipcMain.on('ui:overlay', (event, open) => { if (fromUi(event)) { overlay = Boolean(open); applyVisibility(); } });
  ipcMain.on('ui:locale', (event, l) => { if (fromUi(event) && (l === 'zh' || l === 'en')) { uiLocale = l; tape.setLocale(l); } });
  const openTape = (raw) => {
    const t = toTapeUrl(raw);
    if (t?.tape) {
      userTarget = t.tape;
      userRetries = 0;
      userNavAt = Date.now();
      void site.webContents.loadURL(t.tape);
    }
    else if (t?.external) void confirmExternal(t.external, null);
    return Boolean(t?.tape);
  };
  ipcMain.on('browser:navigate', (event, raw) => { if (fromUi(event)) openTape(raw); });
  // 后退、前进也是用户导航：目标设成历史里那一条的地址，上面三道"用户导航保护"都会生效
  // （否则网站能在这段时间用 window.open 打断后退，把用户带到别的网站）
  const historyUrl = (delta) => {
    try {
      const h = site.webContents.navigationHistory;
      return h.getEntryAtIndex(h.getActiveIndex() + delta)?.url ?? '';
    } catch {
      return '';
    }
  };
  ipcMain.on('browser:back', (event) => { if (fromUi(event) && site.webContents.navigationHistory.canGoBack()) { userNavAt = Date.now(); userTarget = historyUrl(-1); userRetries = 0; site.webContents.navigationHistory.goBack(); } });
  ipcMain.on('browser:forward', (event) => { if (fromUi(event) && site.webContents.navigationHistory.canGoForward()) { userNavAt = Date.now(); userTarget = historyUrl(1); userRetries = 0; site.webContents.navigationHistory.goForward(); } });
  ipcMain.on('browser:reload', (event) => {
    if (!fromUi(event)) return;
    const url = site.webContents.getURL();
    if (/^tape:\/\//i.test(url)) void tape.refresh(tape.nameOf(new URL(url))).then(() => site.webContents.reload());
  });

  // 系统里点 tape:// 链接：在浏览器标签打开（macOS 走 open-url，Windows 走第二个实例的命令行）
  const openFromSystem = (url) => {
    if (typeof url !== 'string') return;
    const m = /^tape:\/\/(\d+)\.(\d+)\.tape(\/\S*)?$/i.exec(url.trim());
    if (!m) return;
    if (openTape(`${m[1]}.${m[2]}${m[3] && m[3] !== '/' ? m[3] : ''}`) && !ui.webContents.isDestroyed()) ui.webContents.send('browser:opened');
    win.focus();
  };
  openUrlHandler = openFromSystem;
  app.on('second-instance', (_event, argv) => openFromSystem(argv.find((a) => /^tape:\/\//i.test(a))));

  // 开发版可以把界面的控制台输出打到终端，便于排查
  if (!app.isPackaged && process.env.TAPESEND_UI_LOG) {
    ui.webContents.on('console-message', (_e, level, message, line, source) => {
      console.log(`[ui:${level}] ${message} (${source}:${line})`);
    });
  }
  await ui.webContents.loadURL(DEV_URL || 'app://tapesend/index.html');
  openFromSystem(process.argv.find((a) => /^tape:\/\//i.test(a)));
  for (const url of pendingOpenUrls.splice(0)) openFromSystem(url);

  // 冒烟测试（仅开发版）：TAPESEND_SMOKE=<输出目录> 时打开 4246.0，截两张图并打印状态后退出
  if (SMOKE_DIR) {
    const out = SMOKE_DIR;
    await new Promise((r) => setTimeout(r, 2000));
    await fs.mkdir(out, { recursive: true });
    await fs.writeFile(path.join(out, 'ui.png'), (await ui.webContents.capturePage()).toPNG());
    const { width, height } = win.getContentBounds();
    site.setBounds({ x: 0, y: 120, width, height: height - 184 });
    siteWanted = true;
    applyVisibility();
    await site.webContents.loadURL(process.env.TAPESEND_SMOKE_URL || 'tape://4246.0.tape/').catch(() => {});
    await new Promise((r) => setTimeout(r, Number(process.env.TAPESEND_SMOKE_WAIT_MS || 8000)));
    const u = new URL(site.webContents.getURL());
    const text = await site.webContents.executeJavaScript('document.body ? document.body.innerText.slice(0, 200) : ""').catch((e) => `error: ${e.message}`);
    // 探测：网站能否注册 Service Worker、能否发出链下请求（都应当失败）
    const sw = await site.webContents.executeJavaScript("navigator.serviceWorker ? navigator.serviceWorker.register('/sw.js').then(() => 'registered', (e) => 'refused: ' + e.message) : 'no api'").catch((e) => `error: ${e.message}`);
    const offchain = await site.webContents.executeJavaScript("fetch('https://example.com/probe').then(() => 'fetched', (e) => 'blocked: ' + e.message)").catch((e) => `error: ${e.message}`);
    const rtc = await site.webContents.executeJavaScript("typeof RTCPeerConnection + '/' + typeof WebTransport").catch((e) => `error: ${e.message}`);
    // 界面仍能连节点（DNS 白名单生效后）；网站的 DNS 预取发不出去由审计脚本另测
    const uiRpc = await ui.webContents.executeJavaScript("fetch('https://bsc-dataseed.bnbchain.org', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }) }).then((r) => r.json()).then((j) => j.result, (e) => 'failed: ' + e.message)").catch((e) => `error: ${e.message}`);
    // 顶层跳 about:blank：应当退回链上页面，历史里不留空白记录
    await site.webContents.executeJavaScript("setTimeout(() => { location.href = 'about:blank'; }, 10); 1").catch(() => {});
    await new Promise((r) => setTimeout(r, 3000));
    const afterBlank = site.webContents.getURL();
    const historyUrls = Array.from({ length: site.webContents.navigationHistory.length() }, (_, i) => site.webContents.navigationHistory.getEntryAtIndex(i)?.url);
    const uiOther = await ui.webContents.executeJavaScript("fetch('https://example.com/').then(() => 'reached', (e) => 'blocked: ' + e.message)").catch((e) => `error: ${e.message}`);
    await new Promise((r) => setTimeout(r, 500));
    // 界面主框架发的指令主进程要收得到（fromUi 的框架核对不能误伤正常界面）
    const before = uiLocale;
    await ui.webContents.executeJavaScript("window.tapesendDesktop && window.tapesendDesktop.setLocale ? (window.tapesendDesktop.setLocale('en'), 'sent') : 'no api'").catch((e) => `error: ${e.message}`);
    await new Promise((r) => setTimeout(r, 300));
    const ipcFromUi = uiLocale === 'en';
    uiLocale = before;
    tape.setLocale(before);
    // 结尾带点的主机名应当被拒（400），不能当成同一个网站
    await site.webContents.loadURL('tape://4246.0.tape./').catch(() => {});
    await new Promise((r) => setTimeout(r, 1500));
    const trailingDot = await site.webContents.executeJavaScript('document.body ? document.body.innerText.slice(0, 80) : ""').catch((e) => `error: ${e.message}`);
    const state = await tape.summary(tape.nameOf(u), u.pathname || '/');
    console.log(JSON.stringify({ ipcFromUi, trailingDot, ui: ui.webContents.getURL(), site: site.webContents.getURL(), title: site.webContents.getTitle(), text, serviceWorker: sw, offchainFetch: offchain, realtime: rtc, uiRpc, uiOther, afterBlank, historyUrls, status: state.status, page: state.page, verified: state.verified, files: state.files, unverified: state.unverified, offchainBlocked: state.offchainBlocked }));
    for (let i = 0; i < 5; i++) {
      try {
        await fs.writeFile(path.join(out, 'site.png'), (await site.webContents.capturePage()).toPNG());
        break;
      } catch (e) {
        console.log(`capture retry ${i + 1}: ${e.message}`);
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    app.quit();
  }
}

app.on('window-all-closed', () => app.quit());
if (primaryInstance) {
  main().catch((error) => {
    console.error(error);
    app.exit(1);
  });
}
