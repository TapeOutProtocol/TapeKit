// 字节工具：十六进制、拼接、定长整数、地址。全部返回 Uint8Array，十六进制一律小写带 0x。
import { keccak_256 } from '@noble/hashes/sha3.js';

export class TapeSendError extends Error {
  /** @param {string} code  机器可读的错误码 @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'TapeSendError';
    this.code = code;
  }
}

export function hexToBytes(hex, expectedLength) {
  if (typeof hex !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(hex)) throw new TapeSendError('bad-input', `not 0x hex: ${String(hex).slice(0, 20)}`);
  const out = new Uint8Array((hex.length - 2) / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(2 + i * 2, 4 + i * 2), 16);
  if (expectedLength !== undefined && out.length !== expectedLength) {
    throw new TapeSendError('bad-input', `expected ${expectedLength} bytes, got ${out.length}`);
  }
  return out;
}

export function bytesToHex(bytes) {
  let s = '0x';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

export function concat(...parts) {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** 32 字节大端 */
export function uint256(value) {
  let v = BigInt(value);
  if (v < 0n || v >= 1n << 256n) throw new TapeSendError('bad-input', 'uint256 out of range');
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

export function ascii(text) {
  return new TextEncoder().encode(text);
}

export function equalBytes(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** 20 字节地址；接受任意大小写的 0x 地址 */
export function addressBytes(address) {
  return hexToBytes(String(address).toLowerCase(), 20);
}

/** EIP-55 校验和地址 */
export function checksumAddress(address) {
  const lower = String(address).toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(lower)) throw new TapeSendError('bad-input', `not an address: ${address}`);
  const hash = keccak_256(ascii(lower.slice(2)));
  let out = '0x';
  for (let i = 0; i < 40; i++) {
    const nibble = (hash[i >> 1] >> (i % 2 === 0 ? 4 : 0)) & 0x0f;
    const ch = lower[2 + i];
    out += nibble >= 8 ? ch.toUpperCase() : ch;
  }
  return out;
}
