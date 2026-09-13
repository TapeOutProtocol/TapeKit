// 本机开发服务器：只监听 127.0.0.1，静态端出 onchain/ 目录（查看器 + 内核）。不要部署到公网（见 README「为什么不上线查看器」）。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ROOT 可指向别的目录（例如 ../dist，用来打开升级页）；默认是 onchain/ 本身
const root = process.env.ROOT ? path.resolve(process.env.ROOT) : path.dirname(fileURLToPath(import.meta.url));
const viewerMode = !process.env.ROOT;
const port = Number(process.env.PORT || 8095);
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png',
};

http.createServer((req, res) => {
  let p;
  try { p = decodeURIComponent(new URL(req.url, 'http://local').pathname); } catch { res.writeHead(400); return res.end(); }
  if (p === '/' && viewerMode) { res.writeHead(302, { location: '/viewer/' }); return res.end(); }
  if (p.endsWith('/')) p += 'index.html';
  const file = path.normalize(path.join(root, p));
  if (!file.startsWith(root + path.sep) || file.includes(`${path.sep}node_modules${path.sep}`)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('not found'); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(data);
  });
}).listen(port, '127.0.0.1', () => console.log(`查看器：http://127.0.0.1:${port}/viewer/`));
