// Wallet hub files in the gateway layout, shared by build.mjs and dev-server.mjs so both serve the same bytes:
//   wallet/hub/*     → /.tape/wallet/*       (index.html, hub.js, hub.css, UI modules)
//   wallet/src/**    → /.tape/wallet/src/**  (router core)
// In the repo the wallet modules import the kernel as ../../kernel/src/<f>.js; in the gateway the kernel is at
// /.tape/kernel/<f>.js (no src/). gatewaySource() rewrites exactly those imports, computed from the resolved
// target, so the source files stay importable by `node --test`. The hub's own files use absolute
// /.tape/... imports (like boot.js) and are copied unchanged.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const WALLET_HUB_DIR = path.resolve(here, '..', 'wallet', 'hub');
export const WALLET_SRC_DIR = path.resolve(here, '..', 'wallet', 'src');
const KERNEL_SRC_DIR = path.resolve(here, '..', 'kernel', 'src');

const HUB_PREFIX = '/.tape/wallet/';
const SRC_PREFIX = '/.tape/wallet/src/';
const KERNEL_PREFIX = '/.tape/kernel/';

const inside = (dir, file) => file.startsWith(dir + path.sep);
const posix = (p) => p.split(path.sep).join('/');

/** '/.tape/wallet/…' → source file, or null when the path would leave its directory. */
export function hubSourceFile(urlPath) {
  const [dir, rest] = urlPath.startsWith(SRC_PREFIX) ? [WALLET_SRC_DIR, urlPath.slice(SRC_PREFIX.length)]
    : urlPath.startsWith(HUB_PREFIX) ? [WALLET_HUB_DIR, urlPath.slice(HUB_PREFIX.length)] : [null, ''];
  if (!dir || !rest) return null;
  const file = path.normalize(path.join(dir, rest));
  return inside(dir, file) ? file : null;
}

/** Source file → its gateway path, or null for files that are not part of the hub. */
export function gatewayPathOf(file) {
  if (inside(WALLET_SRC_DIR, file)) return SRC_PREFIX + posix(path.relative(WALLET_SRC_DIR, file));
  if (inside(WALLET_HUB_DIR, file)) return HUB_PREFIX + posix(path.relative(WALLET_HUB_DIR, file));
  return null;
}

// Static import / export-from / dynamic import with a relative specifier.
const RELATIVE_IMPORT = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])(\.{1,2}\/[^'"\n]+)\2/g;

/** File contents as served by the gateway: wallet/src modules get their kernel imports re-pointed. */
export function gatewaySource(file, contents) {
  if (!inside(WALLET_SRC_DIR, file) || !file.endsWith('.js')) return contents;
  const distDir = path.posix.dirname(gatewayPathOf(file));
  return String(contents).replace(RELATIVE_IMPORT, (match, lead, quote, spec) => {
    const target = path.resolve(path.dirname(file), spec);
    if (!inside(KERNEL_SRC_DIR, target)) return match;
    const rel = path.posix.relative(distDir, KERNEL_PREFIX + posix(path.relative(KERNEL_SRC_DIR, target)));
    return lead + quote + (rel.startsWith('.') ? rel : './' + rel) + quote;
  });
}

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));

/** Every hub file to ship: [source file, gateway path]. Tests and dotfiles are not shipped. */
export function hubFiles() {
  return [...walk(WALLET_HUB_DIR), ...walk(WALLET_SRC_DIR)]
    .filter((f) => !path.basename(f).startsWith('.'))
    .map((f) => [f, gatewayPathOf(f)]);
}
