// 组装浏览器扩展：dist/extension/ = 扩展外壳 + 查看器 + 内核（扩展不能引用自身目录以外的文件）。
// Chrome：打开 chrome://extensions → 开启「开发者模式」→「加载已解压的扩展程序」→ 选 dist/extension。
// Wallet routing (wallet router design §10.1): the background and popup modules in wallet/extension/ and the
// wallet/src modules they import are copied with the same relative layout (dist/extension/wallet/...), and the
// three content scripts are bundled into classic scripts (dist/extension/wallet/{inpage,relay,hub-relay}.js).
//
//   node build-extension.mjs          dist/extension: no host access at install; the user enables routing
//   node build-extension.mjs --test   dist/extension-test, for wallet/test/e2e-extension.mjs only: host access
//                                     to http://*.localhost and the wallet scripts declared statically, because
//                                     a test cannot click Chrome's permission dialog. Never ship this build.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { bundleContentScripts } from './wallet/extension/bundle.mjs';
import { gatewayInfo, contentScriptsFor, SCRIPT_FILES } from './wallet/extension/routing.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const TEST = process.argv.includes('--test');
const out = path.join(root, 'dist', TEST ? 'extension-test' : 'extension');
fs.rmSync(out, { recursive: true, force: true });

const copy = (from, to) => { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); };
const copyDir = (from, to, filter = () => true) => {
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, e.name), b = path.join(to, e.name);
    if (e.isDirectory()) copyDir(a, b, filter);
    else if (filter(e.name)) copy(a, b);
  }
};
const RELATIVE_IMPORT = /\bfrom\s+['"](\.[^'"]+)['"]|\bimport\s*\(\s*['"](\.[^'"]+)['"]/g;

/** Copy wallet modules and everything they import from wallet/, keeping their paths relative to the repo root. */
function copyWithImports(entries) {
  const walletDir = path.join(root, 'wallet');
  const todo = entries.map((f) => path.join(root, f));
  const done = new Set();
  while (todo.length) {
    const file = todo.pop();
    if (done.has(file)) continue;
    done.add(file);
    if (!file.startsWith(walletDir + path.sep)) continue;   // the kernel is copied as a whole below
    copy(file, path.join(out, path.relative(root, file)));
    for (const m of fs.readFileSync(file, 'utf8').matchAll(RELATIVE_IMPORT)) todo.push(path.resolve(path.dirname(file), m[1] || m[2]));
  }
}

copyDir(path.join(root, 'extension'), out);
copyDir(path.join(root, 'kernel', 'src'), path.join(out, 'kernel', 'src'), (n) => n.endsWith('.js'));
for (const f of ['index.html', 'viewer.js', 'viewer.css', 'frame.html', 'blocklist.txt']) copy(path.join(root, 'viewer', f), path.join(out, 'viewer', f));
for (const f of ['SPEC.md', 'SPEC.zh.md']) copy(path.join(root, f), path.join(out, f));
copyWithImports(['wallet/extension/background.js', 'wallet/extension/routing.js', 'wallet/extension/snapshot.js', 'wallet/src/ext-protocol.js']);
const scripts = bundleContentScripts();
for (const [name, code] of Object.entries(scripts)) fs.writeFileSync(path.join(out, 'wallet', name), code);

const manifestFile = path.join(out, 'manifest.json');
if (TEST) {
  // Static equivalents of what routing.js registers after the user enables routing for a localhost gateway.
  const info = gatewayInfo('localhost');
  const toManifest = (s) => ({ matches: s.matches, ...(s.excludeMatches ? { exclude_matches: s.excludeMatches } : {}), js: s.js, run_at: 'document_start', all_frames: false, world: s.world });
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  fs.writeFileSync(manifestFile, JSON.stringify({
    ...manifest,
    name: manifest.name + ' (wallet e2e test build)',
    host_permissions: [info.sitesPattern],
    content_scripts: contentScriptsFor(info).map(toManifest),
  }, null, 2) + '\n');
}

// 自检：manifest 合法、引用的文件都在包里、没有指向包外的相对导入
const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
const must = [manifest.background.service_worker, manifest.action.default_popup, ...manifest.sandbox.pages, 'viewer/index.html', 'kernel/src/index.js', ...Object.values(SCRIPT_FILES)];
for (const f of must) if (!fs.existsSync(path.join(out, f))) throw new Error('扩展缺文件：' + f);
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
for (const f of walk(out).filter((f) => f.endsWith('.js'))) {
  const src = fs.readFileSync(f, 'utf8');
  for (const m of src.matchAll(RELATIVE_IMPORT)) {
    const target = path.resolve(path.dirname(f), m[1] || m[2]);
    if (!target.startsWith(out + path.sep) || !fs.existsSync(target)) throw new Error(`导入越界或缺失：${path.relative(out, f)} → ${m[1] || m[2]}`);
  }
}
// Content scripts are classic scripts: they must compile as such and use no module syntax at all.
for (const name of Object.keys(scripts)) {
  const src = fs.readFileSync(path.join(out, 'wallet', name), 'utf8');
  new vm.Script(src, { filename: name });
  if (/^\s*(import|export)\b/m.test(src) || /\bimport\s*\(/.test(src)) throw new Error('content script uses module syntax: wallet/' + name);
}
// Host access: never at install time in the real build (the user grants it per gateway when enabling routing).
if (!Array.isArray(manifest.optional_host_permissions) || !manifest.optional_host_permissions.length) throw new Error('manifest: optional_host_permissions missing');
if (!TEST && (manifest.host_permissions || manifest.content_scripts)) throw new Error('manifest: install-time host_permissions / content_scripts are only allowed in the --test build');
console.log('扩展已组装：' + path.relative(root, out) + `（${walk(out).length} 个文件）`);
