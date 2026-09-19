// Cloudflare Worker 外壳：所有请求交给静态资源；只补两个响应头。服务器（这里是 Cloudflare 边缘）从不经手链上内容。
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // 网站沙盒框架里的 CSP 违规报告不经过 Service Worker、会直接发到这里：不记录（里面可能带访客数据），直接 204
    if (url.pathname === '/.tape/csp-report') return new Response(null, { status: 204 });
    const res = await env.ASSETS.fetch(request);
    const h = new Headers(res.headers);
    h.set('x-content-type-options', 'nosniff');
    h.set('cache-control', 'no-cache');
    // 引导页（/、/index.html）要跑脚本，Service Worker 脚本（/sw.js）要读链，不加；其余静态文件被当成文档打开时什么都不许做
    if (!['/', '/index.html', '/sw.js'].includes(url.pathname)) h.set('content-security-policy', "default-src 'none'; sandbox");
    return new Response(res.body, { status: res.status, headers: h });
  },
};
