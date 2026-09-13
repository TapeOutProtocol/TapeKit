// Cloudflare Worker 外壳：所有请求交给静态资源；只补两个响应头。服务器（这里是 Cloudflare 边缘）从不经手链上内容。
export default {
  async fetch(request, env) {
    const res = await env.ASSETS.fetch(request);
    const h = new Headers(res.headers);
    h.set('x-content-type-options', 'nosniff');
    h.set('cache-control', 'no-cache');
    return new Response(res.body, { status: res.status, headers: h });
  },
};
