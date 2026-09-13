// 路径规则（SPEC.md §6），与 HashPort 网关服务的 cleanPath 保持一致。

/** 规范化请求路径。非法（含 .. 段、控制字符、坏的 %xx）返回 null。空路径与以 / 结尾补 index.html。 */
export function normalizePath(raw) {
  let p;
  try { p = decodeURIComponent(String(raw ?? '').split(/[?#]/)[0]); } catch { return null; }
  p = p.normalize('NFC').replace(/\/+/g, '/');
  if (/[\0-\x1f\x7f]/.test(p)) return null;
  if (p.split('/').some((seg) => seg === '..' || seg === '.')) return null;
  if (p === '' || p === '/' || p.endsWith('/')) p = p.replace(/\/?$/, '/') + 'index.html';
  return p.replace(/^\/+/, '');
}

const hasExtension = (p) => /\.[^/]+$/.test(p.split('/').pop() || '');

/**
 * 把请求路径落到站点里真实存在的文件：
 *   1. 精确命中；
 *   2. 最后一段没有扩展名：试 <路径>/index.html；
 *   3. 仍然没有、且没有扩展名：退回站长设置的 fallbackPath（单页应用前端路由）；
 *   否则返回 null（404）。
 */
export function resolvePath(requested, pathSet, fallbackPath) {
  const p = normalizePath(requested);
  if (p === null) return null;
  if (pathSet.has(p)) return p;
  if (!hasExtension(p)) {
    const idx = p + '/index.html';
    if (pathSet.has(idx)) return idx;
    if (fallbackPath && pathSet.has(fallbackPath)) return fallbackPath;
  }
  return null;
}

/** 站长写的 content-type 只放行常规字符（防头注入、防奇怪的 MIME），不合规一律当二进制。 */
export function safeContentType(ct) {
  const s = String(ct || '').replace(/[^\w.+/;=\- ]/g, '').slice(0, 100);
  return /^[\w.+-]+\/[\w.+-]+/.test(s) ? s : 'application/octet-stream';
}
