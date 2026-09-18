import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 正式构建的页面带内容安全策略（开发服务器要注入内联脚本，不加）。
// 网页托管时还应在响应头里加 frame-ancestors 'none'（meta 标签里无效）。
// 手机 App 不嵌任何框架（链上网站走系统安全浏览器）：frame-src 'none'，第三方框架够不到原生通道
const FRAMES = process.env.TAPESEND_TARGET === 'native' ? "'none'" : 'https://*.tapekit.org https://verify.walletconnect.org https://verify.walletconnect.com';
const CSP = `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data: https:; connect-src 'self' https: wss:; frame-src ${FRAMES}; object-src 'none'; base-uri 'none'; form-action 'none'`;
const csp = {
  name: 'tapesend-csp',
  apply: 'build' as const,
  transformIndexHtml: (html: string) => html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />\n    <meta name="tapesend-target" content="${process.env.TAPESEND_TARGET === 'native' ? 'native' : 'web'}" />`),
};

// base 用相对路径：同一份构建产物给网页、Electron（file://）和 Capacitor（本地 WebView）共用
export default defineConfig({
  base: './',
  plugins: [react(), csp],
  server: { port: 5190, fs: { allow: ['../..'] } },
  build: { target: 'es2022', outDir: process.env.TAPESEND_TARGET === 'native' ? 'dist-native' : 'dist', sourcemap: false },
});
