// 组装浏览器扩展：dist/extension/ = 扩展外壳 + 查看器 + 内核（扩展不能引用自身目录以外的文件）。
// Chrome：打开 chrome://extensions → 开启「开发者模式」→「加载已解压的扩展程序」→ 选 dist/extension。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(root, 'dist', 'extension');
fs.rmSync(out, { recursive: true, force: true });

const copy = (from, to) => { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); };
const copyDir = (from, to, filter = () => true) => {
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, e.name), b = path.join(to, e.name);
    if (e.isDirectory()) copyDir(a, b, filter);
    else if (filter(e.name)) copy(a, b);
  }
};

copyDir(path.join(root, 'extension'), out);
copyDir(path.join(root, 'kernel', 'src'), path.join(out, 'kernel', 'src'), (n) => n.endsWith('.js'));
for (const f of ['index.html', 'viewer.js', 'viewer.css', 'frame.html', 'blocklist.txt']) copy(path.join(root, 'viewer', f), path.join(out, 'viewer', f));
copy(path.join(root, 'SPEC.md'), path.join(out, 'SPEC.md'));

// 自检：manifest 合法、引用的文件都在包里、没有指向包外的相对导入
const manifest = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
const must = [manifest.background.service_worker, manifest.action.default_popup, ...manifest.sandbox.pages, 'viewer/index.html', 'kernel/src/index.js'];
for (const f of must) if (!fs.existsSync(path.join(out, f))) throw new Error('扩展缺文件：' + f);
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
for (const f of walk(out).filter((f) => f.endsWith('.js'))) {
  const src = fs.readFileSync(f, 'utf8');
  for (const m of src.matchAll(/\bfrom\s+['"](\.[^'"]+)['"]|\bimport\s*\(\s*['"](\.[^'"]+)['"]/g)) {
    const target = path.resolve(path.dirname(f), m[1] || m[2]);
    if (!target.startsWith(out + path.sep) || !fs.existsSync(target)) throw new Error(`导入越界或缺失：${path.relative(out, f)} → ${m[1] || m[2]}`);
  }
}
console.log('扩展已组装：' + path.relative(root, out) + `（${walk(out).length} 个文件）`);
