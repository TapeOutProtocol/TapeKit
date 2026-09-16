// 链上名字与网址（SPEC.md §2）。
//
//   链上名字   <#ID>.<处理器编号>.tape        例：4246.0.tape  = 0 号处理器（创世处理器）的 #4246
//   网址       tape://<#ID>.<处理器编号>.tape/<路径> 例：tape://4246.0.tape/index.html
//              （主机名就是完整的链上名字。Chromium 会把 4246.0 这种主机当 IPv4 解析，所以后缀不能省；输入仍接受 tape://4246.0/）
//
// 输入框接受的写法（都会被规范化成上面两种）：
//   4246.0.tape   4246.0   tape://4246.0/a.html   web+tape://4246.0/a.html   #4246@0   0x<容器地址>   0x<处理器合约>#4246

import { LIMITS } from './config.js';
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

/**
 * @returns {{kind:'name', tokenId:bigint, cpu:bigint, path:string}
 *         | {kind:'container', container:string, path:string}
 *         | {kind:'circuit', circuits:string, tokenId:bigint, path:string}}
 */
export function parseInput(raw) {
  let s = String(raw ?? '').trim();
  if (!s) throw new InputError('input.empty');
  // SPEC §2.3：web+tape:// 是 tape:// 的别名（网页只能用 web+ 开头的协议注册处理器），§2.4 要求外壳两种写法都接受。
  s = s.replace(/^(?:web\+)?tape:\/\//i, '');
  let m;
  if ((m = s.match(/^#?([0-9]+)@([0-9]+)(\/.*)?$/))) {
    return { kind: 'name', tokenId: decimal(m[1], 'what.tokenId', 1n, LIMITS.maxTokenId), cpu: decimal(m[2], 'what.cpu', 0n, LIMITS.maxCpuIndex), path: splitPath(m[3]) };
  }
  if ((m = s.match(/^([0-9]+)\.([0-9]+)(?:\.tape)?\.?(\/.*)?$/i))) {
    return { kind: 'name', tokenId: decimal(m[1], 'what.tokenId', 1n, LIMITS.maxTokenId), cpu: decimal(m[2], 'what.cpu', 0n, LIMITS.maxCpuIndex), path: splitPath(m[3]) };
  }
  if ((m = s.match(/^(0x[0-9a-fA-F]{40})#([0-9]+)(\/.*)?$/))) {
    return { kind: 'circuit', circuits: m[1].toLowerCase(), tokenId: decimal(m[2], 'what.tokenId', 1n, LIMITS.maxTokenId), path: splitPath(m[3]) };
  }
  if ((m = s.match(/^(0x[0-9a-fA-F]{40})(\/.*)?$/))) {
    return { kind: 'container', container: m[1].toLowerCase(), path: splitPath(m[2]) };
  }
  throw new InputError('input.unknown');
}

export const formatName = (tokenId, cpu, suffix = 'tape') => `${BigInt(tokenId)}.${BigInt(cpu)}.${suffix}`;
export const formatUrl = (tokenId, cpu, path = '', suffix = 'tape') => `tape://${BigInt(tokenId)}.${BigInt(cpu)}.${suffix}/${path}`;
