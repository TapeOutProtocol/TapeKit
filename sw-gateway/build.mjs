// 组装网关的部署目录 dist/gateway/：按 README「部署」一节的路径布局放好 7 类文件，可直接上传到任何静态托管。
//   /index.html /sw.js /.tape/boot.js /.tape/pages.js /.tape/config.json /.tape/blocklist.txt /.tape/kernel/*.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(here, '..', 'dist', 'gateway');
fs.rmSync(out, { recursive: true, force: true });
const put = (from, to) => { fs.mkdirSync(path.dirname(path.join(out, to)), { recursive: true }); fs.copyFileSync(path.join(here, from), path.join(out, to)); };
put('index.html', 'index.html'); put('sw.js', 'sw.js');
for (const f of ['boot.js', 'pages.js', 'config.json', 'blocklist.txt']) put(f, path.join('.tape', f));
const k = path.resolve(here, '..', 'kernel', 'src');
for (const f of fs.readdirSync(k)) if (f.endsWith('.js')) { fs.mkdirSync(path.join(out, '.tape', 'kernel'), { recursive: true }); fs.copyFileSync(path.join(k, f), path.join(out, '.tape', 'kernel', f)); }
// 自检：sw.js 与 boot.js 引用的都在
for (const f of ['sw.js', '.tape/boot.js', '.tape/pages.js', '.tape/kernel/index.js', '.tape/config.json']) if (!fs.existsSync(path.join(out, f))) throw new Error('缺文件 ' + f);
console.log('网关部署目录：' + path.relative(process.cwd(), out));
