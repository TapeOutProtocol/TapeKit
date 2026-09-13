// 网关的本机开发服务器（127.0.0.1:8096）。行为与正式部署的静态服务器一样：
//   /sw.js、/.tape/boot.js、/.tape/pages.js、/.tape/config.json、/.tape/blocklist.txt → 本目录；/.tape/kernel/* → ../kernel/src；
//   其它任何路径、任何子域名 → index.html（引导页）。
// Chrome 把 *.localhost 都解析到本机，所以 http://4246-0.localhost:8096/ 就能测端到端。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const kernelDir = path.resolve(here, '../kernel/src');
const port = Number(process.env.PORT || 8096);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8' };
const STATIC = { '/sw.js': 'sw.js', '/.tape/boot.js': 'boot.js', '/.tape/pages.js': 'pages.js', '/.tape/config.json': 'config.json', '/.tape/blocklist.txt': 'blocklist.txt' };

export function mapPath(p) {
  if (STATIC[p]) return path.join(here, STATIC[p]);
  if (p.startsWith('/.tape/kernel/')) { const f = path.normalize(path.join(kernelDir, p.slice('/.tape/kernel/'.length))); return f.startsWith(kernelDir + path.sep) ? f : null; }
  return path.join(here, 'index.html');
}

const server = http.createServer((req, res) => {
  let p;
  try { p = decodeURIComponent(new URL(req.url, 'http://local').pathname); } catch { res.writeHead(400); return res.end(); }
  const file = mapPath(p);
  if (!file) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('not found'); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'service-worker-allowed': '/' });
    res.end(data);
  });
});
if (process.argv[1] === fileURLToPath(import.meta.url)) server.listen(port, '127.0.0.1', () => console.log(`网关：http://localhost:${port}/   样例站：http://4246-0.localhost:${port}/`));
export default server;
