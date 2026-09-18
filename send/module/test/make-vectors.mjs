// 生成 TAP-10 §13 测试向量：node test/make-vectors.mjs > test/vectors.json
// 中间值（kek、承诺、包装后的密钥）在这里用 noble 原语独立重算一遍，和 seal() 的输出交叉核对，
// 这样向量本身就证明了"规范文字 = 参考实现"。
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import {
  bytesToHex, hexToBytes, keyDerivationText, personalMessageHash, normalizedRS, deriveKeyPair, seal, encodePublic,
  encodeContent, messageId, fingerprint,
} from '../src/index.js';

const enc = new TextEncoder();
const u256 = (n) => hexToBytes('0x' + BigInt(n).toString(16).padStart(64, '0'), 32);
const cat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
const hex = bytesToHex;
// BNB 主网（56）上容器的端点号：uint32(0) ‖ uint64(56) ‖ 地址
const ep = (a) => cat(new Uint8Array(4), u256(56).slice(24), hexToBytes(a, 20));
const assertEq = (a, b, what) => { if (hex(a) !== hex(b)) throw new Error(`vector self-check failed: ${what}`); };

const HUB = '0xf50632b57a84274483b26ccccfe8491d6e3836a8';
const CONTAINER_A = '0x86ddaef00401e3f10418398d67d7189fc458ea95'; // #4246@0
const CONTAINER_B = '0x1111111111111111111111111111111111111111';
const REF = '0x' + 'ab'.repeat(32);

// ---- §4.2 密钥派生（固定的 secp256k1 测试私钥，RFC 6979 确定性签名）
const walletSk = hexToBytes('0x' + '42'.repeat(32), 32);
const holder = hex(keccak_256(secp256k1.getPublicKey(walletSk, false).slice(1)).slice(12));
const sign = (text) => {
  const rec = secp256k1.sign(personalMessageHash(text), walletSk, { prehash: false, format: 'recovered' });
  return cat(rec.slice(1), Uint8Array.of(rec[0] + 27));
};
const keyVectors = [0, 1].map((k) => {
  const p = { tokenId: 4246n, cpuIndex: 0n, container: CONTAINER_A, holder, hub: HUB, keyIndex: k };
  const text = keyDerivationText(p);
  const signature = sign(text);
  const rs = normalizedRS(signature);
  const info = cat(ep(CONTAINER_A), u256(k), hexToBytes(HUB, 20));
  const seed = hkdf(sha256, rs, enc.encode('TAP-10/key/v2'), info, 32);
  const kp = deriveKeyPair({ ...p, signature });
  assertEq(seed, kp.secretKey, 'seed');
  return {
    input: { tokenId: '4246', processorNumber: '0', container: CONTAINER_A, holder, hub: HUB, keyIndex: k, walletPrivateKey: hex(walletSk) },
    text,
    textBytes: hex(enc.encode(text)),
    textLength: enc.encode(text).length,
    textSha256: hex(sha256(enc.encode(text))),
    personalMessageHash: hex(personalMessageHash(text)),
    signature: hex(signature),
    normalizedRS: hex(rs),
    kdfInfo: hex(info),
    seed: hex(seed),
    publicKey: hex(kp.publicKey),
  };
});

// ---- §5.3 封装：固定 e、N、K，两个收件公钥
const r1 = hexToBytes('0x' + '11'.repeat(32), 32);
const r2 = hexToBytes('0x' + '22'.repeat(32), 32);
const R1 = x25519.getPublicKey(r1);
const R2 = x25519.getPublicKey(r2);
const e = hexToBytes('0x' + '33'.repeat(32), 32);
const N = hexToBytes('0x' + '44'.repeat(24), 24);
const K = hexToBytes('0x' + '55'.repeat(32), 32);
const queue = [e, N, K];
const content = encodeContent({ subject: 'Hello 你好', body: 'TAP-10 test vector.\nSecond line.', ts: 1789603200000 });
const payload = seal({ content, recipients: [R1, R2], to: CONTAINER_B, from: CONTAINER_A, hub: HUB, ref: REF, random: () => queue.shift() });

const E = x25519.getPublicKey(e);
const T = cat(enc.encode('TAP-10/X/v2'), ep(CONTAINER_B), ep(CONTAINER_A), hexToBytes(REF, 32), hexToBytes(HUB, 20));
const commit = sha256(cat(enc.encode('TAP-10/commit/v2'), K));
const P = cat(Uint8Array.of(0x54, 0x53, 0x02, 0x01), E, N, commit, Uint8Array.of(2));
const slots = [R1, R2].map((R) => {
  const ss = x25519.getSharedSecret(e, R);
  const kek = hkdf(sha256, ss, enc.encode('TAP-10/wrap/v2'), cat(E, R, T), 32);
  const wrapped = xchacha20poly1305(kek, N, cat(P, T)).encrypt(K);
  return { recipientPublicKey: hex(R), sharedSecret: hex(ss), kek: hex(kek), fingerprint: hex(fingerprint(R)), wrapped: hex(wrapped), slot: hex(cat(fingerprint(R), wrapped)) };
});
const S = cat(...slots.map((s) => hexToBytes(s.slot)));
const C = xchacha20poly1305(K, N, cat(P, S, T)).encrypt(content);
assertEq(cat(P, S, C), payload, 'sealed payload');

// ---- 打开时的各种结果（给第二个实现核对状态判定）
const openWith = (bytes, which) => ({ payload: hex(bytes), secretKey: hex(which), to: CONTAINER_B, from: CONTAINER_A, hub: HUB, ref: REF });
const variant = (mutate) => { const b = new Uint8Array(payload); mutate(b); return b; };
const other = hexToBytes('0x' + '77'.repeat(32), 32);
// 承诺不符：用 K2 包装第二个槽位（其余不变），第二个收件人解出 K2 与 D 不符
const K2 = hexToBytes('0x' + '66'.repeat(32), 32);
const mismatchSlot = (() => {
  const ss = x25519.getSharedSecret(e, R2);
  const kek = hkdf(sha256, ss, enc.encode('TAP-10/wrap/v2'), cat(E, R2, T), 32);
  return cat(fingerprint(R2), xchacha20poly1305(kek, N, cat(P, T)).encrypt(K2));
})();
const lowOrderE = new Uint8Array(32); lowOrderE[0] = 1;
const nonCanonicalE = new Uint8Array(E); nonCanonicalE[31] |= 0x80;
const openingCases = [
  { name: 'recipient 1 opens', ...openWith(payload, r1), expect: 'ok' },
  { name: 'unrelated key', ...openWith(payload, other), expect: 'not-for-key' },
  { name: 'wrong ref for a matching slot', ...openWith(payload, r1), ref: '0x' + 'ac'.repeat(32), expect: 'damaged' },
  { name: 'commitment mismatch in slot 2', ...openWith(variant((b) => b.set(mismatchSlot, 93 + 56)), r2), expect: 'damaged' },
  { name: 'altering slot 2 also breaks slot 1 (the content AAD covers S)', ...openWith(variant((b) => b.set(mismatchSlot, 93 + 56)), r1), expect: 'damaged' },
  { name: 'n = 0', ...openWith(variant((b) => { b[92] = 0; }), r1), expect: 'damaged' },
  { name: 'n = 17', ...openWith(variant((b) => { b[92] = 17; }), r1), expect: 'damaged' },
  { name: 'low-order ephemeral key', ...openWith(variant((b) => b.set(lowOrderE, 4)), other), expect: 'damaged' },
  { name: 'non-canonical ephemeral key', ...openWith(variant((b) => b.set(nonCanonicalE, 4)), r1), expect: 'damaged' },
  { name: 'truncated by one byte', ...openWith(payload.slice(0, payload.length - 1), r1), expect: 'damaged' },
  { name: 'unknown version', ...openWith(variant((b) => { b[2] = 3; }), r1), expect: 'unsupported' },
  { name: 'old single-chain version 1', ...openWith(variant((b) => { b[2] = 1; }), r1), expect: 'unsupported' },
];
// 第二个槽位被换掉之后，内容认证数据里的 S 也变了，所以第一个收件人同样打不开内容 —— 上面据此标为 damaged
const rejectedKeys = [
  { name: 'all zero', key: hex(new Uint8Array(32)) },
  { name: 'u = 1', key: hex(lowOrderE) },
  { name: 'top bit set', key: hex(nonCanonicalE) },
  { name: 'u = p (non-canonical)', key: '0xedffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f' },
  { name: 'order-8 point', key: '0xe0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800' },
];
// 同一个签名的其它写法：v 为 0/1、高 s，都必须得到同一把钥匙
const sigVariants = (() => {
  const v = keyVectors[0];
  const sig = hexToBytes(v.signature, 65);
  const n = secp256k1.Point.Fn.ORDER;
  const s = BigInt(hex(sig.slice(32, 64)));
  const high = cat(sig.slice(0, 32), u256(n - s), Uint8Array.of(sig[64] === 27 ? 28 : 27));
  return [
    { name: 'v as 0/1', input: 'keyDerivation[0].input', signature: hex(cat(sig.slice(0, 64), Uint8Array.of(sig[64] - 27))), publicKey: v.publicKey },
    { name: 'high s with flipped v', input: 'keyDerivation[0].input', signature: hex(high), publicKey: v.publicKey },
  ];
})();

const vectors = {
  spec: 'TAP-10',
  note: 'All hex is lowercase 0x-prefixed. Integers inside byte strings are 32-byte big-endian. Private keys here are test values only.',
  keyDerivation: keyVectors,
  sealed: {
    input: {
      to: CONTAINER_B, from: CONTAINER_A, ref: REF, hub: HUB, chainId: 56,
      recipientSecretKeys: [hex(r1), hex(r2)], ephemeralSecret: hex(e), nonce: hex(N), contentKey: hex(K),
      content: hex(content), contentText: new TextDecoder().decode(content),
    },
    ephemeralPublicKey: hex(E),
    commitment: hex(commit),
    context: hex(T),
    preamble: hex(P),
    slots,
    ciphertext: hex(C),
    payload: hex(payload),
    payloadLength: payload.length,
  },
  public: {
    content: hex(content),
    payload: hex(encodePublic(content)),
  },
  opening: openingCases,
  rejectedRecipientKeys: rejectedKeys,
  signatureVariants: sigVariants,
  messageIds: [
    { chainId: 56, hub: HUB, to: '0x' + '0'.repeat(8) + (56).toString(16).padStart(16, '0') + CONTAINER_B.slice(2).toLowerCase(), inboxIndex: 0 },
    { chainId: 8453, hub: HUB, to: '0x' + '0'.repeat(8) + (56).toString(16).padStart(16, '0') + CONTAINER_B.slice(2).toLowerCase(), inboxIndex: 257 },
  ].map((m) => ({ ...m, id: messageId(m.chainId, m.hub, m.to, m.inboxIndex) })),
  contentDecoding: [
    { name: 'valid', bytes: hex(enc.encode('{"v":1,"kind":"message","subject":"s","body":"b","ts":1}')), expect: 'message' },
    { name: 'duplicate member', bytes: hex(enc.encode('{"v":1,"kind":"message","body":"a","body":"b"}')), expect: 'damaged' },
    { name: 'duplicate member via escape', bytes: hex(enc.encode('{"v":1,"kind":"message","body":"a","\\u0062ody":"b"}')), expect: 'damaged' },
    { name: 'invalid utf-8', bytes: '0x7b22763a31ff7d', expect: 'damaged' },
    { name: 'BOM', bytes: hex(cat(Uint8Array.of(0xef, 0xbb, 0xbf), enc.encode('{"v":1,"kind":"message","body":"x"}'))), expect: 'damaged' },
    { name: 'lone surrogate', bytes: hex(enc.encode('{"v":1,"kind":"message","body":"\\ud800"}')), expect: 'damaged' },
    { name: 'missing v', bytes: hex(enc.encode('{"kind":"message","body":"x"}')), expect: 'damaged' },
    { name: 'v as string', bytes: hex(enc.encode('{"v":"1","kind":"message","body":"x"}')), expect: 'damaged' },
    { name: 'future version', bytes: hex(enc.encode('{"v":2,"kind":"message","body":"x"}')), expect: 'unsupported' },
    { name: 'other kind', bytes: hex(enc.encode('{"v":1,"kind":"poll","body":"x"}')), expect: 'unsupported' },
    { name: 'body missing', bytes: hex(enc.encode('{"v":1,"kind":"message"}')), expect: 'damaged' },
    { name: 'lone surrogate in member name', bytes: hex(enc.encode('{"v":1,"kind":"message","body":"x","\\udc00":1}')), expect: 'damaged' },
    { name: 'nesting depth 32 is allowed', bytes: hex(enc.encode('{"v":1,"kind":"message","body":"x","n":' + '['.repeat(31) + ']'.repeat(31) + '}')), expect: 'message' },
    { name: 'nesting depth 33 is damaged', bytes: hex(enc.encode('{"v":1,"kind":"message","body":"x","n":' + '['.repeat(32) + ']'.repeat(32) + '}')), expect: 'damaged' },
    { name: 'surrounding whitespace is allowed', bytes: hex(enc.encode(' \n{"v":1,"kind":"message","body":"x"}\t ')), expect: 'message' },
    { name: 'subject over 200 code points is truncated', bytes: hex(enc.encode(JSON.stringify({ v: 1, kind: 'message', subject: '字'.repeat(250), body: '' }))), expect: 'message', subjectCodePoints: 200 },
  ],
};

process.stdout.write(JSON.stringify(vectors, null, 2) + '\n');
