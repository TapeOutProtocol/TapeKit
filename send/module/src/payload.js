// TAP-10 §5：载荷的编码、封装（加密）与打开（解密）。
import { x25519 } from '@noble/curves/ed25519.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { TapeSendError, addressBytes, ascii, concat, equalBytes, hexToBytes, uint256 } from './bytes.js';
import { fingerprint, CHAIN_ID } from './keys.js';

export const MAGIC = Uint8Array.of(0x54, 0x53);
export const FORMAT_VERSION = 0x02; // v2：DeWEB 跨链版，绑定端点号（v1 为 TAP-10 v0.5 单链版，已不再使用）
export const KIND_PUBLIC = 0x00;
export const KIND_SEALED = 0x01;
export const MAX_PAYLOAD = 16_000;
export const MAX_SLOTS = 16;
const PREAMBLE = 93;
const SLOT = 56;
const TAG = 16;

const ZERO_REF = new Uint8Array(32);
const P_FIELD = (2n ** 255n) - 19n;

/**
 * 端点号（32 字节）：uint32(0) ‖ uint64(chainId) ‖ 容器地址。
 * 传 20 字节地址时，按 chainId 所在链上的容器处理；传 32 字节时原样使用（可以是其他链上的端点）。
 */
export function endpointBytes(endpoint, chainId = CHAIN_ID) {
  const s = String(endpoint);
  if (/^0x[0-9a-fA-F]{64}$/.test(s)) {
    const b = hexToBytes(s, 32);
    if (b[0] | b[1] | b[2] | b[3]) throw new TapeSendError('bad-input', 'endpoint reserved bits must be zero');
    // 与 parseEndpointId 同一规则：链号不能为 0，容器不能是全零地址
    if (b.slice(4, 12).every((x) => x === 0) || b.slice(12).every((x) => x === 0)) throw new TapeSendError('bad-input', 'endpoint chain id and container must be non-zero');
    return b;
  }
  if (!(BigInt(chainId) >= 1n && BigInt(chainId) < 1n << 64n)) throw new TapeSendError('bad-input', 'chainId must fit in 64 bits');
  return concat(new Uint8Array(4), uint256(chainId).slice(24), addressBytes(s));
}

/**
 * X = "TAP-10/X/v2" ‖ to 端点号 ‖ from 端点号 ‖ ref ‖ hub（DeWEB 跨链消息层）。
 * 发出链就是 from 端点号里的链号；hub 用来区分同一条链上的新旧中枢。
 */
function context({ to, from, hub, ref, chainId = CHAIN_ID }) {
  const refBytes = ref === undefined || ref === null ? ZERO_REF : typeof ref === 'string' ? hexToBytes(ref, 32) : ref;
  if (!(refBytes instanceof Uint8Array) || refBytes.length !== 32) throw new TapeSendError('bad-input', 'ref must be 32 bytes');
  return concat(ascii('TAP-10/X/v2'), endpointBytes(to, chainId), endpointBytes(from, chainId), refBytes, addressBytes(hub));
}

/** TAP-10 §4.4：公钥必须是规范编码（最高位为 0、u < p）且不是低阶点 */
export function assertValidPublicKey(publicKey) {
  if (!(publicKey instanceof Uint8Array) || publicKey.length !== 32) throw new TapeSendError('bad-key', 'public key must be 32 bytes');
  if (publicKey[31] & 0x80) throw new TapeSendError('bad-key', 'public key top bit set');
  let u = 0n;
  for (let i = 31; i >= 0; i--) u = (u << 8n) | BigInt(publicKey[i]);
  if (u >= P_FIELD) throw new TapeSendError('bad-key', 'public key not canonical');
  // 低阶点：与任意私钥协商都会失败（noble 抛错或得到全零）
  sharedSecret(Uint8Array.of(...new Uint8Array(31).fill(0x11), 0x41), publicKey);
}

/** 内容密钥承诺：所有槽位必须解出同一把 K（防止发件人给不同收件人看不同内容） */
function commitment(K) {
  return sha256(concat(ascii('TAP-10/commit/v2'), K));
}

function sharedSecret(secretKey, publicKey) {
  let ss;
  try {
    ss = x25519.getSharedSecret(secretKey, publicKey);
  } catch {
    // noble 对低阶点直接抛错；任何错误都当作拒绝（TAP-10 §4.4）
    throw new TapeSendError('bad-key', 'X25519 key agreement failed (invalid or low-order key)');
  }
  if (ss.every((b) => b === 0)) throw new TapeSendError('bad-key', 'all-zero X25519 shared secret');
  return ss;
}

function kek(ss, E, R, T) {
  return hkdf(sha256, ss, ascii('TAP-10/wrap/v2'), concat(E, R, T), 32);
}

/** §5.2 公开消息 */
export function encodePublic(content) {
  const payload = concat(MAGIC, Uint8Array.of(FORMAT_VERSION, KIND_PUBLIC), content);
  if (payload.length > MAX_PAYLOAD) throw new TapeSendError('too-large', `payload ${payload.length} > ${MAX_PAYLOAD}`);
  return payload;
}

/**
 * §5.3 封装。
 * @param {{content: Uint8Array, recipients: Uint8Array[], to: string, from: string, hub: string, ref?: string|Uint8Array, chainId?: number,
 *          random?: (n: number) => Uint8Array}} p  random 仅供测试向量注入，生产必须用默认的安全随机数
 */
export function seal(p) {
  const rand = p.random ?? randomBytes;
  const keys = p.recipients;
  if (!Array.isArray(keys) || keys.length < 1 || keys.length > MAX_SLOTS) {
    throw new TapeSendError('bad-input', `1..${MAX_SLOTS} recipient keys required`);
  }
  for (let i = 0; i < keys.length; i++) {
    assertValidPublicKey(keys[i]);
    for (let j = 0; j < i; j++) if (equalBytes(keys[i], keys[j])) throw new TapeSendError('bad-input', 'duplicate recipient key');
  }
  const T = context(p);
  const e = rand(32);
  const E = x25519.getPublicKey(e);
  const N = rand(24);
  const K = rand(32);
  const P = concat(MAGIC, Uint8Array.of(FORMAT_VERSION, KIND_SEALED), E, N, commitment(K), Uint8Array.of(keys.length));

  const slots = keys.map((R) => {
    const kk = kek(sharedSecret(e, R), E, R, T);
    if (equalBytes(kk, K)) throw new TapeSendError('bad-input', 'content key collides with a key-encryption key');
    const wrapped = xchacha20poly1305(kk, N, concat(P, T)).encrypt(K);
    return concat(fingerprint(R), wrapped);
  });
  const S = concat(...slots);
  const C = xchacha20poly1305(K, N, concat(P, S, T)).encrypt(p.content);
  const payload = concat(P, S, C);
  if (payload.length > MAX_PAYLOAD) throw new TapeSendError('too-large', `payload ${payload.length} > ${MAX_PAYLOAD}`);
  return payload;
}

/**
 * 解析头部，不解密。
 * @returns {{kind: 'public', content: Uint8Array} | {kind: 'sealed', E: Uint8Array, N: Uint8Array, slots: {fingerprint: Uint8Array, wrapped: Uint8Array}[], P: Uint8Array, S: Uint8Array, C: Uint8Array}}
 */
export function parsePayload(payload) {
  if (!(payload instanceof Uint8Array) || payload.length < 4) throw new TapeSendError('unsupported', 'payload too short');
  if (payload.length > MAX_PAYLOAD) throw new TapeSendError('unsupported', 'payload too large');
  if (payload[0] !== MAGIC[0] || payload[1] !== MAGIC[1] || payload[2] !== FORMAT_VERSION) {
    throw new TapeSendError('unsupported', 'unknown magic or version');
  }
  if (payload[3] === KIND_PUBLIC) return { kind: 'public', content: payload.slice(4) };
  if (payload[3] !== KIND_SEALED) throw new TapeSendError('unsupported', 'unknown kind');
  if (payload.length < PREAMBLE) throw new TapeSendError('damaged', 'sealed payload too short');
  const n = payload[92];
  if (n < 1 || n > MAX_SLOTS || payload.length < PREAMBLE + SLOT * n + TAG) {
    throw new TapeSendError('damaged', 'bad slot count or length');
  }
  const slots = [];
  for (let i = 0; i < n; i++) {
    const at = PREAMBLE + SLOT * i;
    slots.push({ fingerprint: payload.slice(at, at + 8), wrapped: payload.slice(at + 8, at + SLOT) });
  }
  return {
    kind: 'sealed',
    E: payload.slice(4, 36),
    N: payload.slice(36, 60),
    commit: payload.slice(60, 92),
    slots,
    P: payload.slice(0, PREAMBLE),
    S: payload.slice(PREAMBLE, PREAMBLE + SLOT * n),
    C: payload.slice(PREAMBLE + SLOT * n),
  };
}

/**
 * §5.3 打开。
 * @param {{payload: Uint8Array, secretKey?: Uint8Array, to: string, from: string, hub: string, ref?: string|Uint8Array, chainId?: number}} p
 * @returns {{kind: 'public'|'sealed', content: Uint8Array}}
 */
export function openPayload(p) {
  const parsed = parsePayload(p.payload);
  if (parsed.kind === 'public') return { kind: 'public', content: parsed.content };
  // 临时公钥不规范或是低阶点：对所有人都判为损坏（包括手里没有钥匙的客户端），不让不同实现给出不同结论
  try {
    assertValidPublicKey(parsed.E);
  } catch {
    throw new TapeSendError('damaged', 'ephemeral key is invalid');
  }
  if (!p.secretKey) throw new TapeSendError('not-for-key', 'a secret key is required to open a sealed message');
  const T = context(p);
  const R = x25519.getPublicKey(p.secretKey);
  const fp = fingerprint(R);
  let K = null;
  let ss = null;
  let matched = false;
  for (const slot of parsed.slots) {
    if (!equalBytes(slot.fingerprint, fp)) continue;
    matched = true;
    ss ??= sharedSecret(p.secretKey, parsed.E);
    let candidate;
    try {
      candidate = xchacha20poly1305(kek(ss, parsed.E, R, T), parsed.N, concat(parsed.P, T)).decrypt(slot.wrapped);
    } catch {
      continue; // 指纹碰撞或被篡改的槽位：继续尝试下一个
    }
    if (!equalBytes(commitment(candidate), parsed.commit)) continue;
    K = candidate;
    break;
  }
  if (!K) {
    // 有槽位指纹对上却解不开（或承诺不符）：这条消息被改过或是伪造的，不是"钥匙不对"
    if (matched) throw new TapeSendError('damaged', 'a key slot for this key did not open');
    throw new TapeSendError('not-for-key', 'no key slot opens with this key');
  }
  try {
    return { kind: 'sealed', content: xchacha20poly1305(K, parsed.N, concat(parsed.P, parsed.S, T)).decrypt(parsed.C) };
  } catch {
    throw new TapeSendError('damaged', 'content failed authentication');
  }
}
