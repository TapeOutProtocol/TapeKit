// 链上名字与网址（SPEC.md §2）。
//
//   BNB Smart Chain（不带区号）
//     名字     <#ID>.<处理器编号>            例：4246.0     = #4246@0
//   其他链（带区号：X Layer = 2，Base = 3，见 config.js）
//     名字     <#ID>.<区号>.<处理器编号>      例：1.2.344    = #1@2.344（X Layer 上 344 号处理器的 #1）
//
//   链上名字   名字后加 .tape：4246.0.tape、1.2.344.tape（付费合约里登记的就是这个字符串）
//   网址       tape://<链上名字>/<路径>        例：tape://4246.0.tape/index.html
//              （主机名是完整的链上名字。Chromium 会把 4246.0 这种主机当 IPv4 解析，所以网址里后缀不能省；
//               地址栏只显示 4246.0，输入也接受 tape://4246.0/）
//   网关主机   <#ID>-<处理器编号>.<网关域名> 或 <#ID>-<区号>-<处理器编号>.<网关域名>，例：4246-0.tapekit.org、1-2-344.tapekit.org
//
// 输入框接受的写法（都会被规范化成上面几种）：
//   4246.0.tape   4246.0   tape://4246.0/a.html   #4246@0   1.2.344   #1@2.344   0x<容器地址>   0x<处理器合约>#4246

import { LIMITS, networkByArea } from './config.js';
import { KernelError, t } from './i18n.js';

export class InputError extends KernelError {
  constructor(key, vars) { super('input', key, vars); this.name = 'InputError'; }
}

const DEC = /^(0|[1-9][0-9]*)$/;

function decimal(s, whatKey, min, max) {
  if (!DEC.test(s)) throw new InputError('input.decimal', { what: t(whatKey), value: s });
  const n = BigInt(s);
  if (n < min || n > max) throw new InputError('input.range', { what: t(whatKey), value: s });
  return n;
}

function splitPath(rest) {
  if (!rest) return '';
  return rest.replace(/^\/+/, '').split(/[?#]/)[0];
}

/** 区号：必须是已分配的（本客户端认识的）区号；BNB 不带区号，所以 0、1 以及未分配的都拒绝 */
function areaOf(s) {
  if (s === undefined) return null;
  const n = decimal(s, 'what.area', 0n, 1_000_000n);
  if (!networkByArea(Number(n))) throw new InputError('input.area', { value: s });
  return Number(n);
}

const nameOf = (id, area, cpu, rest) => ({
  kind: 'name', tokenId: decimal(id, 'what.tokenId', 1n, LIMITS.maxTokenId), area: areaOf(area),
  cpu: decimal(cpu, 'what.cpu', 0n, LIMITS.maxCpuIndex), path: splitPath(rest),
});

/**
 * @returns {{kind:'name', tokenId:bigint, cpu:bigint, area:number|null, path:string}
 *         | {kind:'container', container:string, path:string}
 *         | {kind:'circuit', circuits:string, tokenId:bigint, path:string}}
 */
export function parseInput(raw) {
  let s = String(raw ?? '').trim();
  if (!s) throw new InputError('input.empty');
  s = s.replace(/^(web\+)?tape:\/\//i, '');
  let m;
  // #ID@编号、#ID@区号.编号
  if ((m = s.match(/^#?([0-9]+)@(?:([0-9]+)\.)?([0-9]+)(\/.*)?$/))) return nameOf(m[1], m[2], m[3], m[4]);
  // ID.编号、ID.区号.编号（可带 .tape 后缀）
  if ((m = s.match(/^([0-9]+)(?:\.([0-9]+))?\.([0-9]+)(?:\.tape)?\.?(\/.*)?$/i))) return nameOf(m[1], m[2], m[3], m[4]);
  if ((m = s.match(/^(0x[0-9a-fA-F]{40})#([0-9]+)(\/.*)?$/))) {
    return { kind: 'circuit', circuits: m[1].toLowerCase(), tokenId: decimal(m[2], 'what.tokenId', 1n, LIMITS.maxTokenId), path: splitPath(m[3]) };
  }
  if ((m = s.match(/^(0x[0-9a-fA-F]{40})(\/.*)?$/))) {
    return { kind: 'container', container: m[1].toLowerCase(), path: splitPath(m[2]) };
  }
  throw new InputError('input.unknown');
}

/** @param {number|null|undefined} area */
const areaPart = (area) => (area === null || area === undefined ? '' : `${Number(area)}.`);
/** 显示用的名字：4246.0、1.2.344（地址栏显示这个） */
/** @param {bigint|number|string} tokenId @param {bigint|number|string} cpu @param {number|null} [area] */
export const formatShort = (tokenId, cpu, area = null) => `${BigInt(tokenId)}.${areaPart(area)}${BigInt(cpu)}`;
/** 链上名字：4246.0.tape、1.2.344.tape */
/** @param {bigint|number|string} tokenId @param {bigint|number|string} cpu @param {string} [suffix] @param {number|null} [area] */
export const formatName = (tokenId, cpu, suffix = 'tape', area = null) => `${formatShort(tokenId, cpu, area)}.${suffix}`;
/** @param {bigint|number|string} tokenId @param {bigint|number|string} cpu @param {string} [path] @param {string} [suffix] @param {number|null} [area] */
export const formatUrl = (tokenId, cpu, path = '', suffix = 'tape', area = null) => `tape://${formatName(tokenId, cpu, suffix, area)}/${path}`;
/** #ID@编号、#ID@区号.编号 */
/** @param {bigint|number|string} tokenId @param {bigint|number|string} cpu @param {number|null} [area] */
export const formatLabel = (tokenId, cpu, area = null) => `#${BigInt(tokenId)}@${areaPart(area)}${BigInt(cpu)}`;
/** 网关主机名的第一段：4246-0、1-2-344 */
/** @param {bigint|number|string} tokenId @param {bigint|number|string} cpu @param {number|null} [area] */
export const formatHostLabel = (tokenId, cpu, area = null) => [BigInt(tokenId), ...(area === null || area === undefined ? [] : [Number(area)]), BigInt(cpu)].join('-');
/** 网关主机名第一段 → 名字输入；格式不对返回 null（不抛错） */
export function parseHostLabel(label) {
  const m = /^([1-9][0-9]*)-(?:([1-9][0-9]*)-)?(0|[1-9][0-9]*)$/.exec(String(label || ''));
  if (!m) return null;
  try { return nameOf(m[1], m[2], m[3], ''); } catch { return null; }
}
