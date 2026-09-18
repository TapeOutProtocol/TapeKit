// TAP-10 §4：从钱包签名派生 X25519 密钥。私钥不落地，每次需要时由同一个钱包重新签名得到。
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import {
  TapeSendError, ascii, addressBytes, bytesToHex, checksumAddress, concat, equalBytes, hexToBytes, uint256,
} from './bytes.js';

export const CHAIN_ID = 56;
const SECP256K1_N = secp256k1.Point.Fn.ORDER;
const HALF_N = SECP256K1_N >> 1n;

function decimal(value, min, name) {
  const v = BigInt(value);
  if (v < BigInt(min)) throw new TapeSendError('bad-input', `${name} must be >= ${min}`);
  return v.toString(10);
}

/** 签名文字里的域名。钱包会把它和发起签名的网站比对，不一致就警告（EIP-4361），这是防钓鱼的关键。 */
export const KEY_DOMAIN = 'www.tapesend.com';
export const KEY_ISSUED_AT = '2026-09-17T00:00:00Z';

/**
 * §4.2 第 1 步：要求钱包签名的固定文字（EIP-4361 格式）。所有字段都是固定值，所以同一钱包每次签出同一个签名。
 * @param {{tokenId: bigint|number|string, cpuIndex: bigint|number|string, container: string, holder: string, hub: string,
 *          chainId?: number, keyIndex?: number}} p
 */
export function keyDerivationText({ tokenId, cpuIndex, container, holder, hub, chainId = CHAIN_ID, keyIndex = 0 }) {
  const k = decimal(keyIndex, 0, 'keyIndex');
  if (BigInt(k) > 65535n) throw new TapeSendError('bad-input', 'keyIndex must be <= 65535');
  return [
    `${KEY_DOMAIN} wants you to sign in with your Ethereum account:`,
    checksumAddress(holder),
    '',
    `Create the TapeSend encryption key for #${decimal(tokenId, 1, 'tokenId')}@${decimal(cpuIndex, 0, 'cpuIndex')}. Anyone who obtains this signature can read your messages. Only sign this on ${KEY_DOMAIN} or in the official TapeSend app.`,
    '',
    `URI: https://${KEY_DOMAIN}`,
    'Version: 1',
    `Chain ID: ${decimal(chainId, 1, 'chainId')}`,
    `Nonce: tapesendkey${k}`,
    `Issued At: ${KEY_ISSUED_AT}`,
    'Resources:',
    `- tapesend:container:${checksumAddress(container)}`,
    `- tapesend:hub:${checksumAddress(hub)}`,
    `- tapesend:key-index:${k}`,
  ].join('\n');
}

/** EIP-191 personal_sign 的消息哈希 */
export function personalMessageHash(text) {
  const body = ascii(text);
  return keccak_256(concat(ascii(`\x19Ethereum Signed Message:\n${body.length}`), body));
}

function splitSignature(signature) {
  const sig = typeof signature === 'string' ? hexToBytes(signature, 65) : signature;
  if (!(sig instanceof Uint8Array) || sig.length !== 65) throw new TapeSendError('bad-signature', 'signature must be 65 bytes');
  const r = sig.slice(0, 32);
  const s = sig.slice(32, 64);
  let v = sig[64];
  if (v >= 27) v -= 27;
  if (v !== 0 && v !== 1) throw new TapeSendError('bad-signature', 'invalid recovery id');
  return { r, s, v };
}

function toBigInt(bytes) {
  return BigInt(bytesToHex(bytes));
}

/** 从 65 字节签名恢复以太坊地址（小写） */
export function recoverAddress(messageHash, signature) {
  const { r, s, v } = splitSignature(signature);
  const recovered = concat(Uint8Array.of(v), r, s);
  let pub;
  try {
    pub = secp256k1.recoverPublicKey(recovered, messageHash, { prehash: false });
  } catch {
    throw new TapeSendError('bad-signature', 'signature does not recover');
  }
  const uncompressed = secp256k1.Point.fromBytes(pub).toBytes(false);
  return bytesToHex(keccak_256(uncompressed.slice(1)).slice(12));
}

/** §4.2 第 4 步：低 s 规范化，返回 r ‖ s（64 字节） */
export function normalizedRS(signature) {
  const { r, s } = splitSignature(signature);
  let sv = toBigInt(s);
  if (sv === 0n || sv >= SECP256K1_N || toBigInt(r) === 0n || toBigInt(r) >= SECP256K1_N) {
    throw new TapeSendError('bad-signature', 'r or s out of range');
  }
  if (sv > HALF_N) sv = SECP256K1_N - sv;
  return concat(r, uint256(sv));
}

/** 两次签名规范化后是否相同（§4.2 确定性检查） */
export function isDeterministic(signatureA, signatureB) {
  return equalBytes(normalizedRS(signatureA), normalizedRS(signatureB));
}

/**
 * §4.2：由签名派生密钥对。
 * @param {{signature: string|Uint8Array, holder: string, tokenId: bigint|number|string, cpuIndex: bigint|number|string,
 *          container: string, hub: string, chainId?: number, keyIndex?: number}} p
 * @returns {{secretKey: Uint8Array, publicKey: Uint8Array, text: string}}
 */
export function deriveKeyPair(p) {
  const chainId = p.chainId ?? CHAIN_ID;
  // 端点号里链号占 8 字节：超出就拒绝，不能静默截断
  if (BigInt(chainId) <= 0n || BigInt(chainId) >= 1n << 64n) throw new TapeSendError('bad-input', 'chainId out of range');
  const keyIndex = p.keyIndex ?? 0;
  const text = keyDerivationText({ tokenId: p.tokenId, cpuIndex: p.cpuIndex, container: p.container, holder: p.holder, hub: p.hub, chainId, keyIndex });
  const signer = recoverAddress(personalMessageHash(text), p.signature);
  if (signer !== String(p.holder).toLowerCase()) {
    throw new TapeSendError('signer-mismatch', 'the signature was not made by the holder over the key text');
  }
  const ikm = normalizedRS(p.signature);
  // info = 端点号（uint32(0) ‖ uint64(主链 chainId) ‖ 容器）‖ k ‖ hub
  const endpoint = concat(new Uint8Array(4), uint256(chainId).slice(24), addressBytes(p.container));
  const info = concat(endpoint, uint256(keyIndex), addressBytes(p.hub));
  const secretKey = hkdf(sha256, ikm, ascii('TAP-10/key/v2'), info, 32);
  const publicKey = x25519.getPublicKey(secretKey);
  return { secretKey, publicKey, text };
}

/** 8 字节指纹 = SHA-256(公钥) 前 8 字节 */
export function fingerprint(publicKey) {
  return sha256(publicKey).slice(0, 8);
}
