// 组装网关的部署目录 dist/gateway/：按 README「部署」一节的路径布局放好这些文件，可直接上传到任何静态托管。
//   /index.html /sw.js /.tape/boot.js /.tape/pages.js /.tape/serve.js /.tape/config.json /.tape/blocklist.txt /.tape/kernel/*.js
//   /.tape/wallet/* (wallet hub: wallet/hub/*) /.tape/wallet/src/** (router core: wallet/src/**, see hub-files.mjs)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hubFiles, gatewaySource } from './hub-files.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT = path.resolve(here, '..', 'dist', 'gateway');

const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
// Static import / export-from / bare import / dynamic import, with a relative or absolute specifier.
const IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])([./][^'"\n]*)\1/g;
// Scripts and stylesheets referenced by the hub HTML (absolute paths only; the hub uses no relative ones).
const ASSET_REF = /\b(?:src|href)="(\/[^"]+)"/g;

/**
 * Self-check: required files exist, and every import in a shipped .js file (relative, or absolute from the
 * gateway root) and every asset in the hub HTML resolves to a file inside `out`. Throws on the first problem.
 */
export function checkGateway(out) {
  for (const f of ['sw.js', '.tape/boot.js', '.tape/pages.js', '.tape/serve.js', '.tape/kernel/index.js', '.tape/config.json', '.tape/wallet/index.html']) {
    if (!fs.existsSync(path.join(out, f))) throw new Error('缺文件 ' + f);
  }
  const resolves = (from, spec) => {
    const target = spec.startsWith('/') ? path.join(out, spec) : path.resolve(path.dirname(from), spec);
    return target.startsWith(out + path.sep) && fs.existsSync(target);
  };
  for (const f of walk(out)) {
    const rel = path.relative(out, f);
    if (f.endsWith('.js')) {
      for (const m of fs.readFileSync(f, 'utf8').matchAll(IMPORT)) {
        if (!resolves(f, m[2])) throw new Error(`导入越界或缺失：${rel} → ${m[2]}`);
      }
    } else if (f.endsWith('.html') && rel.startsWith(path.join('.tape', 'wallet'))) {
      for (const m of fs.readFileSync(f, 'utf8').matchAll(ASSET_REF)) {
        if (!resolves(f, m[1])) throw new Error(`引用的文件缺失：${rel} → ${m[1]}`);
      }
    }
  }
}

/** Build the gateway into `out` (default dist/gateway) and run the self-check. Returns `out`. */
export function buildGateway(out = DEFAULT_OUT) {
  fs.rmSync(out, { recursive: true, force: true });
  const write = (to, data) => { fs.mkdirSync(path.dirname(path.join(out, to)), { recursive: true }); fs.writeFileSync(path.join(out, to), data); };
  const put = (from, to) => write(to, fs.readFileSync(path.join(here, from)));
  put('index.html', 'index.html'); put('sw.js', 'sw.js');
  for (const f of ['boot.js', 'pages.js', 'serve.js', 'policy.html', 'config.json', 'blocklist.txt']) put(f, path.join('.tape', f));
  const k = path.resolve(here, '..', 'kernel', 'src');
  for (const f of fs.readdirSync(k)) if (f.endsWith('.js')) write(path.join('.tape', 'kernel', f), fs.readFileSync(path.join(k, f)));
  for (const [file, urlPath] of hubFiles()) write(urlPath.slice(1), gatewaySource(file, fs.readFileSync(file)));
  checkGateway(out);
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = buildGateway();
  console.log('网关部署目录：' + path.relative(process.cwd(), out));
}
