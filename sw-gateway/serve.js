// 两种外壳共用的一份：内容安全策略、把一个链上文件变成 Response、兼容档的子域名后缀。
//
// 网关有两档:
//   自验档   4246-0.网关域名        Service Worker 在用户浏览器里读链、核对哈希（默认，不需要信任网关）
//   兼容档   4246-0-open.网关域名   Cloudflare Worker 在服务器上读链、核对哈希（装不上 Service Worker 的
//                                  浏览器用：App 内置浏览器、隐私模式。代价是校验发生在网关，要信任网关）
// 两档的响应头必须完全一样：只要有一处不同，其中一档的沙盒就比另一档弱。所以这里只有一份，
// sw.js（运行在浏览器）和 worker.js（运行在边缘）都从这里拿。为了两处都能解析，这个文件不 import 任何东西。

/**
 * 网关自己的文件：这些路径永远从服务器取，站点顶不掉。
 * 两档必须用同一份。兼容档上这份曾经漏掉，于是 /sw.js 是从链上取的 ——
 * 站点可以把自己的 Service Worker 放上链，在兼容档的来源上注册、接管整个来源，
 * 之后连网关的状态页和「这一档是服务器读的」说明页都能伪造，还能活过链上内容的更新。
 */
export const GATEWAY_PATHS = /^\/(sw\.js$|\.tape\/(kernel\/|boot\.js$|pages\.js$|serve\.js$|policy\.html$|blocklist\.txt$|config\.json$))/;

/** 兼容档的子域名后缀。改它要同时想到：boot.js 跳转、worker.js 分发、通配证书只覆盖一层子域名（所以是后缀不是新一级域名）。 */
export const OPEN_SUFFIX = '-open';

/**
 * 网站文件的内容安全策略。链外的数据可以访问：接口、图片、字体、样式、视频流、WebSocket、嵌入的播放器和
 * 钱包连接（WalletConnect 要连它的中继和验证页）——这些是网站能做起来的前提。
 * 但网站的代码只能来自链上：script-src 不放任何链外地址，Worker 只能是同源或 blob。
 * 子框架（沙盒、srcdoc、blob、data）继承这条策略，同样拉不到链外脚本。链外访问记在状态页，
 * 有链外访问的网站不显示「100% 链上」。
 */
export const SITE_CSP = [
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

// 网关自己生成的页面（状态页、提示页、错误页）也必须带 CSP：否则网站可以把它们嵌进框架当跳板，
// 在里面再开子框架绕过网站的 CSP（审计第三轮）。这些页面没有脚本，只需要内联样式和同源表单
export const DOC_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'self'; frame-src 'none'; base-uri 'none'; frame-ancestors 'none'";
// 数据类响应（状态 JSON、转给服务器的静态文件被当成文档打开时）：什么都不许
export const LOCKED_CSP = "default-src 'none'; sandbox";

export const withCharset = (ct) => (/^(text\/|application\/(javascript|json|xml))/i.test(ct) && !/charset=/i.test(ct) ? ct + '; charset=utf-8' : ct);
export const isHtml = (f) => /html/i.test(f.contentType) || /\.html?$/i.test(f.path);
export const isCss = (f) => /css/i.test(f.contentType) || /\.css$/i.test(f.path);

/** 网关自己生成的页面 */
export const docPage = (body, status = 200, headers = {}) => new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': DOC_CSP, ...headers } });

/**
 * 一个校验过的链上文件。mode 记在 x-tape-mode 里：client = 你的浏览器自己校验的，server = 网关校验的。
 * @param {{bytes:Uint8Array,contentType:string,sha256:string,verified:boolean}} file
 * @param {Record<string,string>} idHeaders 身份头（名字、状态、容器、区块）
 * @param {'client'|'server'} mode 哪一档读的
 */
export const fileResponse = (file, idHeaders, mode) => new Response(file.bytes, { status: 200, headers: {
  'content-type': withCharset(file.contentType), 'content-length': String(file.bytes.length), 'cache-control': 'no-cache',
  'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-tape-sha256': file.sha256, 'x-tape-verified': file.verified ? '1' : '0', 'x-tape-mode': mode, ...idHeaders,
  'content-security-policy': SITE_CSP,
} });
