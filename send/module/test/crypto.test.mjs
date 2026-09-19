import test from 'node:test';
import assert from 'node:assert/strict';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import {
  TapeSendError, bytesToHex, checksumAddress, keyDerivationText, personalMessageHash, recoverAddress, normalizedRS,
  isDeterministic, deriveKeyPair, seal, openPayload, parsePayload, encodePublic, encodeContent, decodeContent, messageId,
  MAX_PAYLOAD, MAX_SLOTS, assertValidPublicKey, displayText,
} from '../src/index.js';

const HUB = '0x28ef10badb267d7a919b5fd210122ccf07fcf178';
const A = '0x86ddaef00401e3f10418398d67d7189fc458ea95';
const B = '0x1111111111111111111111111111111111111111';

function wallet() {
  const sk = secp256k1.utils.randomSecretKey();
  const pub = secp256k1.getPublicKey(sk, false);
  const address = bytesToHex(keccak_256(pub.slice(1)).slice(12));
  const sign = (text) => {
    const rec = secp256k1.sign(personalMessageHash(text), sk, { prehash: false, format: 'recovered' });
    const out = new Uint8Array(65);
    out.set(rec.slice(1), 0);
    out[64] = rec[0] + 27;
    return out;
  };
  return { sk, address, sign };
}

function keypair() {
  const secretKey = x25519.utils.randomSecretKey();
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) };
}

const code = (c) => (e) => e instanceof TapeSendError && e.code === c;

test('checksumAddress matches EIP-55 examples', () => {
  assert.equal(checksumAddress('0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed'), '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed');
  assert.equal(checksumAddress('0xfb6916095ca1df60bb79ce92ce3ea74c37c5d359'), '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359');
});

test('key text is exact EIP-4361', () => {
  const t = keyDerivationText({ tokenId: 4246n, cpuIndex: 0, container: A, holder: B, hub: HUB });
  const lines = t.split('\n');
  assert.equal(lines.length, 14);
  assert.equal(lines[0], 'www.tapesend.com wants you to sign in with your Ethereum account:');
  assert.equal(lines[1], '0x1111111111111111111111111111111111111111');
  assert.equal(lines[2], '');
  assert.match(lines[3], /^Create the TapeSend encryption key for #4246@0\. /);
  assert.equal(lines[5], 'URI: https://www.tapesend.com');
  assert.equal(lines[7], 'Chain ID: 56');
  assert.equal(lines[8], 'Nonce: tapesendkey0');
  assert.equal(lines[11], '- tapesend:container:0x86DDaEF00401E3F10418398D67D7189fc458eA95');
  assert.equal(lines[13], '- tapesend:key-index:0');
  assert.ok(!t.endsWith('\n'));
  assert.ok(/^[\x0a\x20-\x7e]*$/.test(t), 'ASCII only');
  assert.throws(() => keyDerivationText({ tokenId: 0, cpuIndex: 0, container: A, holder: B, hub: HUB }), code('bad-input'));
  assert.throws(() => keyDerivationText({ tokenId: 1, cpuIndex: 0, container: A, holder: B, hub: HUB, keyIndex: 65536 }), code('bad-input'));
});

test('derive: same wallet same container => same key; recovers holder; deterministic check', () => {
  const w = wallet();
  const p = { tokenId: 4246, cpuIndex: 0, container: A, holder: w.address, hub: HUB };
  const text = keyDerivationText(p);
  const s1 = w.sign(text);
  const s2 = w.sign(text);
  assert.ok(isDeterministic(s1, s2));
  assert.equal(recoverAddress(personalMessageHash(text), s1), w.address);
  const k1 = deriveKeyPair({ ...p, signature: s1 });
  const k2 = deriveKeyPair({ ...p, signature: bytesToHex(s2) });
  assert.deepEqual(k1.publicKey, k2.publicKey);
  assert.deepEqual(k1.publicKey, x25519.getPublicKey(k1.secretKey));

  const other = deriveKeyPair({ tokenId: 4246, cpuIndex: 0, container: B, holder: w.address, hub: HUB, signature: w.sign(keyDerivationText({ tokenId: 4246, cpuIndex: 0, container: B, holder: w.address, hub: HUB })) });
  const rotated = deriveKeyPair({ ...p, keyIndex: 1, signature: w.sign(keyDerivationText({ ...p, keyIndex: 1 })) });
  assert.notDeepEqual(rotated.publicKey, k1.publicKey, 'different key index => different key');
  assert.notDeepEqual(other.publicKey, k1.publicKey, 'different container => different key');
});

test('derive: rejects a signature by someone else', () => {
  const w = wallet();
  const mallory = wallet();
  const p = { tokenId: 1, cpuIndex: 7, container: A, holder: w.address, hub: HUB };
  assert.throws(() => deriveKeyPair({ ...p, signature: mallory.sign(keyDerivationText(p)) }), code('signer-mismatch'));
});

test('derive: high-s malleated signature yields the same key', () => {
  const w = wallet();
  const p = { tokenId: 9, cpuIndex: 3, container: A, holder: w.address, hub: HUB };
  const sig = w.sign(keyDerivationText(p));
  const n = secp256k1.Point.Fn.ORDER;
  const s = BigInt(bytesToHex(sig.slice(32, 64)));
  const flipped = new Uint8Array(sig);
  const hs = (n - s).toString(16).padStart(64, '0');
  for (let i = 0; i < 32; i++) flipped[32 + i] = parseInt(hs.slice(i * 2, i * 2 + 2), 16);
  flipped[64] = sig[64] === 27 ? 28 : 27;
  assert.equal(recoverAddress(personalMessageHash(keyDerivationText(p)), flipped), w.address);
  assert.deepEqual(normalizedRS(flipped), normalizedRS(sig));
  assert.deepEqual(deriveKeyPair({ ...p, signature: flipped }).publicKey, deriveKeyPair({ ...p, signature: sig }).publicKey);
});

test('seal/open roundtrip for recipient and sender copy', () => {
  const bob = keypair();
  const me = keypair();
  const content = encodeContent({ subject: '你好', body: 'hello 👋', ts: 1_726_000_000_000 });
  const payload = seal({ content, recipients: [bob.publicKey, me.publicKey], to: B, from: A, hub: HUB });
  for (const k of [bob, me]) {
    const { kind, content: got } = openPayload({ payload, secretKey: k.secretKey, to: B, from: A, hub: HUB });
    assert.equal(kind, 'sealed');
    assert.deepEqual(decodeContent(got), { kind: 'message', subject: '你好', body: 'hello 👋', ts: 1_726_000_000_000, attachments: [], badAttachments: 0 });
  }
  assert.throws(() => openPayload({ payload, secretKey: keypair().secretKey, to: B, from: A, hub: HUB }), code('not-for-key'));
});

test('context binding: wrong to / from / hub / chain does not open', () => {
  const bob = keypair();
  const payload = seal({ content: encodeContent({ body: 'x' }), recipients: [bob.publicKey], to: B, from: A, hub: HUB });
  const base = { payload, secretKey: bob.secretKey, to: B, from: A, hub: HUB };
  // 指纹对上了但解不开：被搬运或伪造的载荷，判为损坏（TAP-10 §5.3 打开第 3 步）
  assert.throws(() => openPayload({ ...base, to: A }), code('damaged'));
  assert.throws(() => openPayload({ ...base, from: B }), code('damaged'));
  assert.throws(() => openPayload({ ...base, hub: A }), code('damaged'));
  assert.throws(() => openPayload({ ...base, chainId: 97 }), code('damaged'));
});

test('any single-byte change is detected', () => {
  const bob = keypair();
  const payload = seal({ content: encodeContent({ body: 'tamper me' }), recipients: [bob.publicKey], to: B, from: A, hub: HUB });
  for (let i = 0; i < payload.length; i++) {
    const t = new Uint8Array(payload);
    t[i] ^= 0x01;
    if (i === 3) {
      // 类型字节 0x01 → 0x00 变成"公开消息"：解析成功，但剩下的密文不是合法内容，必须判为损坏
      const r = openPayload({ payload: t, secretKey: bob.secretKey, to: B, from: A, hub: HUB });
      assert.equal(r.kind, 'public');
      assert.throws(() => decodeContent(r.content), code('damaged'));
      continue;
    }
    assert.throws(() => openPayload({ payload: t, secretKey: bob.secretKey, to: B, from: A, hub: HUB }), `byte ${i}`);
  }
});

test('slot stripping, reordering and injection', () => {
  const bob = keypair();
  const me = keypair();
  const payload = seal({ content: encodeContent({ body: 'x' }), recipients: [bob.publicKey, me.publicKey], to: B, from: A, hub: HUB });
  const p = parsePayload(payload);
  // 交换两个槽位的顺序
  const swapped = new Uint8Array(payload);
  swapped.set(payload.slice(93 + 56, 93 + 112), 93);
  swapped.set(payload.slice(93, 93 + 56), 93 + 56);
  assert.throws(() => openPayload({ payload: swapped, secretKey: bob.secretKey, to: B, from: A, hub: HUB }));
  // 去掉一个槽位（改 n 并删掉字节）
  const stripped = new Uint8Array(payload.length - 56);
  stripped.set(payload.slice(0, 93));
  stripped[92] = 1;
  stripped.set(payload.slice(93, 93 + 56), 93);
  stripped.set(p.C, 93 + 56);
  assert.throws(() => openPayload({ payload: stripped, secretKey: bob.secretKey, to: B, from: A, hub: HUB }));
});

test('limits and malformed payloads', () => {
  const k = keypair();
  assert.throws(() => seal({ content: new Uint8Array(1), recipients: [], to: B, from: A, hub: HUB }), code('bad-input'));
  const many = Array.from({ length: MAX_SLOTS + 1 }, () => keypair().publicKey);
  assert.throws(() => seal({ content: new Uint8Array(1), recipients: many, to: B, from: A, hub: HUB }), code('bad-input'));
  assert.throws(() => seal({ content: new Uint8Array(1), recipients: [k.publicKey, k.publicKey], to: B, from: A, hub: HUB }), code('bad-input'));
  assert.throws(() => seal({ content: new Uint8Array(MAX_PAYLOAD), recipients: [k.publicKey], to: B, from: A, hub: HUB }), code('too-large'));
  assert.equal(seal({ content: new Uint8Array(MAX_PAYLOAD - 93 - 56 - 16), recipients: [k.publicKey], to: B, from: A, hub: HUB }).length, MAX_PAYLOAD);
  assert.throws(() => seal({ content: new Uint8Array(1), recipients: [new Uint8Array(32)], to: B, from: A, hub: HUB }), code('bad-key'));
  assert.throws(() => parsePayload(Uint8Array.of(0x54, 0x53, 0x03, 0x00)), code('unsupported'));
  assert.throws(() => parsePayload(Uint8Array.of(0x54, 0x53, 0x01, 0x00)), code('unsupported'), 'v1 (single-chain) payloads are no longer read');
  assert.throws(() => parsePayload(Uint8Array.of(0x54, 0x53, 0x02, 0x05)), code('unsupported'));
  const bad = new Uint8Array(93 + 16);
  bad.set([0x54, 0x53, 0x02, 0x01]);
  bad[92] = 0;
  assert.throws(() => parsePayload(bad), code('damaged'));
});

test('public payload', () => {
  const content = encodeContent({ body: 'everyone can read this' });
  const payload = encodePublic(content);
  const r = openPayload({ payload, to: B, from: A, hub: HUB });
  assert.equal(r.kind, 'public');
  assert.equal(decodeContent(r.content).body, 'everyone can read this');
});

test('content decoding is strict', () => {
  const enc = (s) => new TextEncoder().encode(s);
  assert.throws(() => decodeContent(Uint8Array.of(0xff, 0xfe)), code('damaged'));
  assert.throws(() => decodeContent(enc('[1,2]')), code('damaged'));
  assert.throws(() => decodeContent(enc('{"v":1,"kind":"message","body":"a","body":"b"}')), code('damaged'));
  assert.throws(() => decodeContent(enc('{"v":1,"kind":"message","body":"a","x":{"k":1,"\\u006b":2}}')), code('damaged'));
  assert.deepEqual(decodeContent(enc('{"v":1,"kind":"message","body":"a","x":{"k":1},"y":{"k":2}}')).body, 'a');
  assert.equal(decodeContent(enc('{"v":2,"kind":"message","body":"a"}')).kind, 'unsupported');
  assert.equal(decodeContent(enc('{"v":1,"kind":"message","body":"a","extra":[{"a":1},{"a":1}]}')).body, 'a');
});

test('message id', () => {
  const to = '0x' + '0'.repeat(8) + '0000000000000038' + 'ab'.repeat(20);
  const id = messageId(56, HUB, to, 7);
  assert.match(id, /^0x[0-9a-f]{64}$/);
  assert.notEqual(id, messageId(56, HUB, to, 8));
  assert.notEqual(id, messageId(8453, HUB, to, 7), 'same inbox index on another chain is another message');
});

test('ref is bound: a different ref does not open', () => {
  const bob = keypair();
  const ref = '0x' + 'cd'.repeat(32);
  const payload = seal({ content: encodeContent({ body: 'reply' }), recipients: [bob.publicKey], to: B, from: A, hub: HUB, ref });
  assert.equal(decodeContent(openPayload({ payload, secretKey: bob.secretKey, to: B, from: A, hub: HUB, ref }).content).body, 'reply');
  assert.throws(() => openPayload({ payload, secretKey: bob.secretKey, to: B, from: A, hub: HUB }), code('damaged'));
  assert.throws(() => openPayload({ payload, secretKey: bob.secretKey, to: B, from: A, hub: HUB, ref: '0x' + 'ce'.repeat(32) }), code('damaged'));
});

test('commitment field is authenticated', () => {
  const bob = keypair();
  const payload = seal({ content: encodeContent({ body: 'x' }), recipients: [bob.publicKey], to: B, from: A, hub: HUB });
  for (const at of [60, 75, 91]) {
    const t = new Uint8Array(payload);
    t[at] ^= 0x80;
    assert.throws(() => openPayload({ payload: t, secretKey: bob.secretKey, to: B, from: A, hub: HUB }));
  }
});

test('public key validation', () => {
  const good = keypair().publicKey;
  assertValidPublicKey(good);
  const top = new Uint8Array(good); top[31] |= 0x80;
  assert.throws(() => assertValidPublicKey(top), code('bad-key'));
  const nonCanonical = new Uint8Array(32).fill(0xff); nonCanonical[31] = 0x7f; nonCanonical[0] = 0xed;
  assert.throws(() => assertValidPublicKey(nonCanonical), code('bad-key'));
  const one = new Uint8Array(32); one[0] = 1;
  assert.throws(() => assertValidPublicKey(one), code('bad-key'));
  assert.throws(() => assertValidPublicKey(new Uint8Array(32)), code('bad-key'));
});

test('content decoding: BOM, lone surrogates, v and kind', () => {
  const enc = (s) => new TextEncoder().encode(s);
  assert.throws(() => decodeContent(Uint8Array.of(0xef, 0xbb, 0xbf, ...enc('{"v":1,"kind":"message","body":"x"}'))), code('damaged'));
  assert.throws(() => decodeContent(enc('{"v":1,"kind":"message","body":"\\ud800"}')), code('damaged'));
  assert.equal(decodeContent(enc('{"v":1,"kind":"message","body":"\\ud83d\\ude00"}')).body.length, 2);
  assert.throws(() => decodeContent(enc('{"kind":"message","body":"x"}')), code('damaged'));
  assert.throws(() => decodeContent(enc('{"v":"1","kind":"message","body":"x"}')), code('damaged'));
  assert.equal(decodeContent(enc('{"v":3,"body":"x"}')).kind, 'unsupported');
  assert.equal(decodeContent(enc('{"v":1,"kind":"poll","body":"x"}')).kind, 'unsupported');
});

test('displayText makes bidi and control characters visible', () => {
  const rlo = String.fromCodePoint(0x202e);
  const bell = String.fromCodePoint(7);
  assert.equal(displayText(`a${rlo}b${bell}c\nd\te`), 'a\\u{202e}b\\u{7}c\nd\te');
});

test('content: nesting limit and lone surrogates in member names', () => {
  const enc = (x) => new TextEncoder().encode(x);
  const nested = (d) => '{"v":1,"kind":"message","body":"x","n":' + '['.repeat(d) + ']'.repeat(d) + '}';
  assert.equal(decodeContent(enc(nested(31))).kind, 'message');
  assert.throws(() => decodeContent(enc(nested(32))), code('damaged'));
  assert.throws(() => decodeContent(enc(nested(8000))), code('damaged'));
  assert.throws(() => decodeContent(enc('{"v":1,"kind":"message","body":"x","\\ud800":1}')), code('damaged'));
  assert.throws(() => decodeContent(enc('{"v":1,"kind":"message","body":"x","o":{"\\udc00":1}}')), code('damaged'));
});

test('opening: invalid ephemeral key is damaged for everyone', () => {
  const bob = keypair();
  const payload = seal({ content: encodeContent({ body: 'x' }), recipients: [bob.publicKey], to: B, from: A, hub: HUB });
  for (const bad of [new Uint8Array(32), (() => { const e = payload.slice(4, 36); e[31] |= 0x80; return e; })()]) {
    const t = new Uint8Array(payload);
    t.set(bad, 4);
    assert.throws(() => openPayload({ payload: t, secretKey: bob.secretKey, to: B, from: A, hub: HUB }), code('damaged'));
    assert.throws(() => openPayload({ payload: t, secretKey: keypair().secretKey, to: B, from: A, hub: HUB }), code('damaged'));
  }
});

test('attachments: valid ones round-trip, bad ones are dropped without damaging the message', () => {
  // 最小的 PNG 头：签名 + IHDR（宽 10、高 20）
  const png = (w, h) => btoa(String.fromCharCode(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, (w >>> 24) & 255, (w >>> 16) & 255, (w >>> 8) & 255, w & 255, (h >>> 24) & 255, (h >>> 16) & 255, (h >>> 8) & 255, h & 255, 8, 2, 0, 0, 0));
  const webp = png(10, 20);
  const tx = '0x' + 'ab'.repeat(32);
  const token = '0x' + '55'.repeat(20);
  const good = [
    { type: 'image', mime: 'image/png', data: webp, w: 10, h: 20 },
    { type: 'erc20', chainId: 56, token, amount: '1000000', tx },
    { type: 'erc721', chainId: 56, token, tokenId: '15324', tx },
    { type: 'native', chainId: 56, amount: '1', tx },
  ];
  const c = decodeContent(encodeContent({ body: 'x', attachments: good }));
  assert.equal(c.attachments.length, 4);
  assert.equal(c.badAttachments, 0);
  assert.equal(c.attachments[1].amount, '1000000');
  // 头部与声明格式不符的图片、零金额、非法地址、坏 tx、多余的附件：都丢弃
  const raw = JSON.stringify({ v: 1, kind: 'message', body: 'y', attachments: [
    { type: 'image', mime: 'image/png', data: png(16383, 16383), w: 16383, h: 16383 },
    { type: 'erc20', chainId: 56, token, amount: '0', tx },
    { type: 'erc20', chainId: 56, token: '0x12', amount: '1', tx },
    { type: 'native', chainId: 56, amount: '1', tx: '0x12' },
    { type: 'script', src: 'x' },
  ] });
  const d = decodeContent(new TextEncoder().encode(raw));
  assert.equal(d.body, 'y');
  assert.equal(d.attachments.length, 0);
  assert.equal(d.badAttachments, 5, 'items beyond the limit count as not shown too');
  assert.throws(() => encodeContent({ body: 'x', attachments: [{ type: 'erc20', chainId: 56, token, amount: '-1', tx }] }), code('bad-input'));
  // 声明尺寸与真实尺寸不符
  assert.throws(() => encodeContent({ body: 'x', attachments: [{ type: 'image', mime: 'image/png', data: png(10, 20), w: 20, h: 10 }] }), code('bad-input'));
  assert.throws(() => encodeContent({ body: 'x', attachments: [...good, good[0]] }), code('bad-input'));
});

test('imageSize: PNG / WebP (VP8, VP8L, VP8X) / JPEG header parsing; animated and progressive images are rejected', async () => {
  const { imageSize } = await import('../src/content.js');
  const u32be = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const chunk = (type, data) => [...u32be(data.length), ...[...type].map((c) => c.charCodeAt(0)), ...data, 0, 0, 0, 0];
  const pngSig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const ihdr = (w, h) => chunk('IHDR', [...u32be(w), ...u32be(h), 8, 2, 0, 0, 0]);
  const png = new Uint8Array([...pngSig, ...ihdr(300, 200), ...chunk('IDAT', [1, 2, 3]), ...chunk('IEND', [])]);
  assert.deepEqual(imageSize('image/png', png), { w: 300, h: 200 });
  const apng = new Uint8Array([...pngSig, ...ihdr(300, 200), ...chunk('acTL', [...u32be(200), ...u32be(0)]), ...chunk('IDAT', [1]), ...chunk('IEND', [])]);
  assert.equal(imageSize('image/png', apng), null);

  const riff = (fourcc, body) => new Uint8Array([...'RIFF'].map((c) => c.charCodeAt(0)).concat([0, 0, 0, 0], [...'WEBP'].map((c) => c.charCodeAt(0)), [...fourcc].map((c) => c.charCodeAt(0)), body));
  // VP8：帧头在 20 起，23..25 是起始码 9d 01 2a，26/28 是宽高（14 位小端）
  const vp8 = riff('VP8 ', [0, 0, 0, 0, 0, 0, 0, 0x9d, 0x01, 0x2a, 500 & 255, 500 >> 8, 300 & 255, 300 >> 8, 0, 0]);
  assert.deepEqual(imageSize('image/webp', vp8), { w: 500, h: 300 });
  // VP8L：20 是签名 0x2f，21..24 是 (宽-1) | (高-1)<<14
  const bits = (500 - 1) | ((300 - 1) << 14);
  const vp8l = riff('VP8L', [0, 0, 0, 0, 0x2f, bits & 255, (bits >>> 8) & 255, (bits >>> 16) & 255, (bits >>> 24) & 255, 0, 0, 0, 0, 0]);
  assert.deepEqual(imageSize('image/webp', vp8l), { w: 500, h: 300 });
  // VP8X：20 是标志位，24..26 / 27..29 是 宽-1 / 高-1（24 位小端）
  const vp8x = (flags) => riff('VP8X', [0, 0, 0, 0, flags, 0, 0, 0, (500 - 1) & 255, (500 - 1) >> 8, 0, (300 - 1) & 255, (300 - 1) >> 8, 0]);
  assert.deepEqual(imageSize('image/webp', vp8x(0x10)), { w: 500, h: 300 });
  assert.equal(imageSize('image/webp', vp8x(0x02)), null);

  const jpeg = (sof) => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, sof, 0, 11, 8, 300 >> 8, 300 & 255, 500 >> 8, 500 & 255, 3, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(imageSize('image/jpeg', jpeg(0xc0)), { w: 500, h: 300 });
  assert.equal(imageSize('image/jpeg', jpeg(0xc2)), null);
});

test('endpoint bytes: zero chain id or zero container is refused on both input paths; hub allow-list is per chain', async () => {
  const { endpointBytes } = await import('../src/payload.js');
  const { hubImplementationsFor, HUB_IMPLEMENTATIONS } = await import('../src/chain.js');
  const A20 = '0x' + '12'.repeat(20);
  assert.throws(() => endpointBytes(A20, 0), code('bad-input'));
  assert.throws(() => endpointBytes(A20, 1n << 64n), code('bad-input'));
  assert.throws(() => endpointBytes('0x' + '0'.repeat(24) + '12'.repeat(20)), code('bad-input')); // 链号为 0
  assert.throws(() => endpointBytes('0x' + '0'.repeat(8) + '0'.repeat(14) + '38' + '0'.repeat(40)), code('bad-input')); // 容器为 0
  assert.equal(endpointBytes('0x' + '0'.repeat(8) + '0'.repeat(14) + '38' + '12'.repeat(20)).length, 32);
  assert.ok(hubImplementationsFor(56).length >= 1);
  assert.deepEqual([...hubImplementationsFor(8453)], ['0x38a2d320b8984bbac9b0a2691b6c0fd829a23867']);
  assert.deepEqual([...hubImplementationsFor(196)], ['0xdcc57797089ebd9f26e686379a4323f353a3f9c6']);
  assert.deepEqual([...hubImplementationsFor(42161)], []);
  assert.deepEqual(HUB_IMPLEMENTATIONS, hubImplementationsFor(56));
});

test('multi-chain: labels with area codes, input → chain, chain instances use their own network', async () => {
  const { endpointLabel, chainIdOfInput, createTapeSendChains, factorySealFor, FACTORY_SEAL, DEFAULT_CHAINS, CHAINS, endpointId } = await import('../src/chain.js');
  assert.equal(endpointLabel(4246n, 0n), '#4246@0');
  assert.equal(endpointLabel(4246n, 0n, 56), '#4246@0');
  assert.equal(endpointLabel(1n, 344n, 196), '#1@2.344');
  assert.equal(endpointLabel(1n, 5n, 8453), '#1@3.5');
  assert.equal(endpointLabel(1n, 5n, 42161), '#1@5.chain42161');
  assert.equal(chainIdOfInput('#4246@0'), 56);
  assert.equal(chainIdOfInput('4246.0'), 56);
  assert.equal(chainIdOfInput('#1@2.344'), 196);
  assert.equal(chainIdOfInput('1.3.5'), 8453);
  assert.equal(chainIdOfInput(A), 56, 'container address without chain info → BNB');
  assert.equal(chainIdOfInput(endpointId(196, A)), 196);
  assert.equal(chainIdOfInput('1.9.5'), null);
  assert.equal(chainIdOfInput('nonsense'), null);
  // 三条链都启用，默认收信位图 = 7
  assert.deepEqual(CHAINS.filter((c) => c.active).map((c) => c.chainId), [56, 8453, 196]);
  assert.equal(DEFAULT_CHAINS, 7n);
  const chains = createTapeSendChains({ fetchImpl: async () => { throw new Error('offline'); } });
  assert.deepEqual([...chains.keys()], [56, 8453, 196]);
  const bnb = chains.get(56), base = chains.get(8453), x = chains.get(196);
  assert.equal(bnb.finalityTag, 'finalized');
  assert.equal(base.finalityTag, 'safe');
  assert.equal(x.finalityTag, 'safe');
  assert.equal(base.rpc.pin, 'latest');
  assert.equal(bnb.rpc.pin, 'latest');
  assert.equal(bnb.factorySeal.implementation, FACTORY_SEAL.implementation);
  assert.equal(base.factorySeal.implementation, '0x74956236ab64ed143933040b4137e8a352e4d17b');
  assert.equal(x.factorySeal.circuitBeacon, '0xf70d1ed4f62cf3780157b0b421b7e2f45bd0991c');
  assert.equal(factorySealFor(196).circuitImplementation, '0x977f217887e085d298cb3819cdad5a0ee35f29b2');
  assert.equal(factorySealFor(42161), null);
  for (const c of chains.values()) assert.equal(c.hub, '0xe61a9c7213a6aa616c246a2b569e555b417b25ee');
  assert.equal(x.network.factory, '0x1f09daefa827f02cbb40967cc91b259763760761');
  assert.ok(x.rpc.urls.every((u) => !/bsc|bnbchain/.test(u)));
  // 带区号的名字不能拿到别的链上解析
  await assert.rejects(bnb.resolveEndpoint('#1@2.344'), (e) => /X Layer|BNB/.test(String(e.message)));
});
