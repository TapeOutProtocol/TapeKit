import { parseInput, formatHostLabel } from './kernel/src/name.js';

// 网关域名设置：设了之后，链上网站在「<#ID>-<处理器编号>.<网关域名>」（其他链：<#ID>-<区号>-<处理器编号>）这个真实来源下打开
// （Service Worker 网关，能存数据、能用钱包扩展）；没设就退回扩展内的沙盒查看器（预览模式）。
export const getGateway = async () => { try { const { gateway } = await chrome.storage.sync.get('gateway'); return String(gateway || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, ''); } catch { return ''; } };
export const setGateway = (v) => chrome.storage.sync.set({ gateway: String(v || '').trim() });

/** 用户输入 → 目标网址：有网关走网关子域名；容器地址等网关不认的写法、或没设网关，走沙盒查看器 */
export function targetUrl(input, gateway) {
  const q = String(input || '').trim();
  const viewer = chrome.runtime.getURL('viewer/index.html') + '#/' + encodeURIComponent(q);
  if (!gateway) return viewer;
  const s = q.replace(/^(web\+)?tape:\/\//i, '');
  let p;
  try { p = parseInput(s); } catch { return viewer; }
  if (p.kind !== 'name') return viewer;
  // 路径原样带上（含查询串和 #，单页应用要用）；名字部分不含 /
  const rest = s.includes('/') ? s.slice(s.indexOf('/')) : '';
  const scheme = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(gateway) ? 'http' : 'https';
  return `${scheme}://${formatHostLabel(p.tokenId, p.cpu, p.area)}.${gateway}${rest || '/'}`;
}
