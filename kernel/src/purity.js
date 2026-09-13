// 「纯链上」静态检测（SPEC.md §8）：找出页面里指向链外的资源引用。
// 这是静态扫描，抓不到运行时拼出来的地址；运行时由渲染器的 CSP 兜底拦截并上报（查看器会显示被拦截的请求）。

const ATTR = /\b(?:src|href|action|poster|data|formaction|background)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
const SRCSET = /\bsrcset\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const CSS_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/gi;
const CSS_IMPORT = /@import\s+(?:"([^"]*)"|'([^']*)')/gi;
const META_REFRESH = /<meta[^>]+http-equiv\s*=\s*["']?refresh[^>]*content\s*=\s*["'][^"']*url=([^"'>\s]+)/gi;

/** 链外：带协议的绝对地址（http/https/ws/wss/ftp）或协议相对的 //host。data:、blob:、#锚点、mailto: 等不算。 */
export function isExternal(url) {
  const u = String(url || '').trim();
  return /^(?:https?|wss?|ftp):/i.test(u) || u.startsWith('//');
}

function collect(re, text, out, where) {
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text))) {
    const v = (m[1] ?? m[2] ?? m[3] ?? '').trim();
    if (!v) continue;
    const candidates = re === SRCSET ? v.split(',').map((s) => s.trim().split(/\s+/)[0]) : [v];
    for (const c of candidates) if (isExternal(c)) out.push({ url: c, where });
  }
}

export function scanHtml(text) {
  const out = [];
  collect(ATTR, text, out, 'html');
  collect(SRCSET, text, out, 'html');
  collect(CSS_URL, text, out, 'inline-css');
  collect(CSS_IMPORT, text, out, 'inline-css');
  collect(META_REFRESH, text, out, 'meta-refresh');
  return out;
}

export function scanCss(text) {
  const out = [];
  collect(CSS_URL, text, out, 'css');
  collect(CSS_IMPORT, text, out, 'css');
  return out;
}

/** 汇总一个站点：files 是 Map(path → {bytes, contentType})。返回 {pure, external:[{path,url,where}]} */
export function scanSite(files) {
  const td = new TextDecoder('utf-8', { fatal: false });
  const external = [];
  for (const [path, f] of files) {
    const ct = String(f.contentType || '');
    if (/html/i.test(ct) || /\.html?$/i.test(path)) for (const e of scanHtml(td.decode(f.bytes))) external.push({ path, ...e });
    else if (/css/i.test(ct) || /\.css$/i.test(path)) for (const e of scanCss(td.decode(f.bytes))) external.push({ path, ...e });
  }
  return { pure: external.length === 0, external };
}

/**
 * 站内引用收集（按需读取用）：从 HTML/CSS 文本里找出所有**站内**资源路径（相对路径或以 / 开头），
 * 已解析成相对站点根的路径，去重。链外地址不在结果里。fromDir 是这个文件所在目录（以 / 结尾或空）。
 */
export function collectReferences(text, kind, fromDir = '') {
  const refs = [];
  const push = (v) => { if (v) refs.push(v); };
  const grab = (re, s) => { re.lastIndex = 0; let m; while ((m = re.exec(s))) { const v = (m[1] ?? m[2] ?? m[3] ?? '').trim(); if (re === SRCSET) v.split(',').forEach((x) => push(x.trim().split(/\s+/)[0])); else push(v); } };
  if (kind === 'html') { grab(ATTR, text); grab(SRCSET, text); grab(CSS_URL, text); grab(CSS_IMPORT, text); }
  else { grab(CSS_URL, text); grab(CSS_IMPORT, text); }
  const out = new Set();
  for (const r of refs) {
    if (!r || isExternal(r) || /^(data:|blob:|#|mailto:|tel:|javascript:|about:)/i.test(r)) continue;
    let u; try { u = new URL(r, 'https://site.tape.invalid/' + fromDir); } catch { continue; }
    if (u.origin !== 'https://site.tape.invalid') continue;
    let p; try { p = decodeURIComponent(u.pathname).normalize('NFC').replace(/^\/+/, ''); } catch { continue; }
    if (p === '' || p.endsWith('/')) p += 'index.html';
    out.add(p);
  }
  return [...out];
}
