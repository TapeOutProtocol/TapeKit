// 极简 ABI 编解码：只覆盖内核实际要用的类型。节点返回的数据一律当成不可信输入：
// 所有偏移量都做越界检查，长度上限写死，任何不合规就抛错，绝不死循环、绝不越界读。

const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: true });
const MAX_DYNAMIC = 16 * 1024 * 1024;   // 单个 bytes/string 最长 16 MB
const MAX_ARRAY = 100_000;

export function hexToBytes(hex) {
  const h = String(hex).startsWith('0x') ? String(hex).slice(2) : String(hex);
  if (h.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(h)) throw new Error('abi: bad hex');
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}
export const bytesToHex = (b) => '0x' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

const word = (n) => {
  const v = BigInt(n);
  if (v < 0n || v >= 1n << 256n) throw new Error('abi: uint out of range');
  return v.toString(16).padStart(64, '0');
};

function encodeStatic(type, value) {
  switch (type) {
    case 'address': {
      if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error('abi: bad address');
      return value.slice(2).toLowerCase().padStart(64, '0');
    }
    case 'uint256': return word(value);
    case 'bool': return word(value ? 1 : 0);
    case 'bytes32': {
      const b = hexToBytes(value);
      if (b.length !== 32) throw new Error('abi: bytes32 length');
      return bytesToHex(b).slice(2);
    }
    default: throw new Error('abi: unsupported type ' + type);
  }
}

/** selector 形如 "0x6c609107"；types 支持 address / uint256 / bool / bytes32 / string / bytes */
export function encodeCall(selector, types = [], values = []) {
  if (!/^0x[0-9a-f]{8}$/.test(selector)) throw new Error('abi: bad selector');
  if (types.length !== values.length) throw new Error('abi: arity');
  let head = '';
  let tail = '';
  const headBytes = types.length * 32;
  types.forEach((t, i) => {
    if (t === 'string' || t === 'bytes') {
      const b = t === 'string' ? enc.encode(String(values[i])) : hexToBytes(values[i]);
      head += word(headBytes + tail.length / 2);
      tail += word(b.length) + bytesToHex(b).slice(2).padEnd(Math.ceil(b.length / 32) * 64, '0');
    } else {
      head += encodeStatic(t, values[i]);
    }
  });
  return selector + head + tail;
}

function u256(b, off) {
  if (!Number.isSafeInteger(off) || off < 0 || off + 32 > b.length) throw new Error('abi: out of bounds');
  let n = 0n;
  for (let i = 0; i < 32; i++) n = (n << 8n) | BigInt(b[off + i]);
  return n;
}
function toOffset(n) {
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('abi: offset too large');
  return Number(n);
}
function bytesAt(b, pos) {
  const len = toOffset(u256(b, pos));
  if (len > MAX_DYNAMIC || pos + 32 + len > b.length) throw new Error('abi: bad dynamic length');
  return b.slice(pos + 32, pos + 32 + len);
}

function readType(b, type, off) {
  switch (type) {
    case 'uint': return u256(b, off);
    case 'bool': {
      const n = u256(b, off);
      if (n > 1n) throw new Error('abi: bad bool');
      return n === 1n;
    }
    case 'address': {
      const n = u256(b, off);
      if (n >> 160n) throw new Error('abi: dirty address');
      return '0x' + n.toString(16).padStart(40, '0');
    }
    case 'bytes32': {
      if (off + 32 > b.length) throw new Error('abi: out of bounds');
      return bytesToHex(b.subarray(off, off + 32));
    }
    case 'bytes': return bytesAt(b, toOffset(u256(b, off)));
    case 'string': return dec.decode(bytesAt(b, toOffset(u256(b, off))));
    case 'string[]': {
      const p = toOffset(u256(b, off));
      const n = toOffset(u256(b, p));
      if (n > MAX_ARRAY) throw new Error('abi: array too long');
      const base = p + 32;
      const out = [];
      for (let i = 0; i < n; i++) out.push(dec.decode(bytesAt(b, base + toOffset(u256(b, base + i * 32)))));
      return out;
    }
    default: throw new Error('abi: unsupported output type ' + type);
  }
}

/** 按顶层类型列表解码返回值。types 支持 uint / bool / address / bytes32 / bytes / string / string[] */
export function decodeResult(types, hex) {
  const b = hexToBytes(hex);
  if (b.length < types.length * 32) throw new Error('abi: short return data');
  return types.map((t, i) => readType(b, t, i * 32));
}
