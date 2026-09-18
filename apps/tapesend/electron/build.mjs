// 桌面版主进程构建：把构建时的环境（索引器、节点地址）写进主进程，用来生成 DNS 白名单
import { build } from 'esbuild';
import { loadEnv } from 'vite';
import fs from 'node:fs/promises';

// 和界面构建读同一套配置：.env、.env.production 里的 VITE_ 变量，再叠加进程环境变量
const env = { ...loadEnv('production', process.cwd(), 'VITE_'), ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('VITE_'))) };
const hostOf = (u) => { try { return new URL(u).hostname; } catch { return ''; } };
const extra = [env.VITE_TAPESEND_INDEXER, env.VITE_BSC_RPC].map(hostOf).filter(Boolean);
console.log(`桌面版 DNS 白名单额外主机：${extra.length ? extra.join(', ') : '（无）'}`);

await build({
  entryPoints: ['electron/main.mjs'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['electron'],
  outfile: 'dist-electron/main.mjs',
  define: { __UI_EXTRA_HOSTS__: JSON.stringify(extra) },
  logLevel: 'warning',
});
for (const f of ['preload.cjs', 'site-preload.cjs']) await fs.copyFile(`electron/${f}`, `dist-electron/${f}`);
await fs.copyFile('../../sw-gateway/blocklist.txt', 'dist-electron/blocklist.txt');
