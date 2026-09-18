// 从 vectors.json 逐项复现 TAP-10 §13 测试向量。任何实现都应能通过同样的核对。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { x25519 } from '@noble/curves/ed25519.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import {
  TapeSendError, bytesToHex, hexToBytes, keyDerivationText, personalMessageHash, normalizedRS, deriveKeyPair, seal, openPayload,
  encodePublic, decodeContent, messageId, assertValidPublicKey,
} from '../src/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const V = JSON.parse(fs.readFileSync(path.join(here, 'vectors.json'), 'utf8'));
const hex = bytesToHex;

test('key derivation vectors', () => {
  for (const v of V.keyDerivation) {
    const p = { ...v.input, tokenId: BigInt(v.input.tokenId), cpuIndex: BigInt(v.input.processorNumber) };
    const text = keyDerivationText(p);
    assert.equal(text, v.text);
    assert.equal(hex(new TextEncoder().encode(text)), v.textBytes);
    assert.equal(hex(personalMessageHash(text)), v.personalMessageHash);
    const sk = hexToBytes(v.input.walletPrivateKey, 32);
    const rec = secp256k1.sign(personalMessageHash(text), sk, { prehash: false, format: 'recovered' });
    assert.equal(hex(new Uint8Array([...rec.slice(1), rec[0] + 27])), v.signature, 'RFC 6979 signature');
    assert.equal(hex(normalizedRS(v.signature)), v.normalizedRS);
    const kp = deriveKeyPair({ ...p, signature: v.signature });
    assert.equal(hex(kp.secretKey), v.seed);
    assert.equal(hex(kp.publicKey), v.publicKey);
  }
});

test('sealed payload vector', () => {
  const s = V.sealed;
  const queue = [s.input.ephemeralSecret, s.input.nonce, s.input.contentKey].map((h) => hexToBytes(h));
  const recipients = s.input.recipientSecretKeys.map((k) => x25519.getPublicKey(hexToBytes(k, 32)));
  const payload = seal({
    content: hexToBytes(s.input.content), recipients, to: s.input.to, from: s.input.from, hub: s.input.hub, ref: s.input.ref,
    random: () => queue.shift(),
  });
  assert.equal(hex(payload), s.payload);
  assert.equal(payload.length, s.payloadLength);
  for (const k of s.input.recipientSecretKeys) {
    const r = openPayload({ payload, secretKey: hexToBytes(k, 32), to: s.input.to, from: s.input.from, hub: s.input.hub, ref: s.input.ref });
    assert.equal(hex(r.content), s.input.content);
  }
});

test('public payload vector', () => {
  assert.equal(hex(encodePublic(hexToBytes(V.public.content))), V.public.payload);
});

test('message id vectors', () => {
  for (const m of V.messageIds) assert.equal(messageId(m.chainId, m.hub, m.to, m.inboxIndex), m.id);
});

test('content decoding vectors', () => {
  for (const c of V.contentDecoding) {
    let got;
    try {
      const r = decodeContent(hexToBytes(c.bytes));
      got = r.kind;
      if (c.subjectCodePoints !== undefined) assert.equal([...r.subject].length, c.subjectCodePoints, c.name);
    } catch (e) {
      assert.ok(e instanceof TapeSendError, `${c.name}: ${e}`);
      got = e.code;
    }
    assert.equal(got, c.expect, c.name);
  }
});

test('opening status vectors', () => {
  for (const c of V.opening) {
    let got;
    try {
      const r = openPayload({ payload: hexToBytes(c.payload), secretKey: hexToBytes(c.secretKey, 32), to: c.to, from: c.from, hub: c.hub, ref: c.ref });
      decodeContent(r.content);
      got = 'ok';
    } catch (e) {
      assert.ok(e instanceof TapeSendError, `${c.name}: ${e}`);
      got = e.code;
    }
    assert.equal(got, c.expect, c.name);
  }
});

test('rejected recipient keys', () => {
  for (const k of V.rejectedRecipientKeys) assert.throws(() => assertValidPublicKey(hexToBytes(k.key, 32)), (e) => e.code === 'bad-key', k.name);
});

test('signature variants derive the same key', () => {
  const base = V.keyDerivation[0];
  const p = { ...base.input, tokenId: BigInt(base.input.tokenId), cpuIndex: BigInt(base.input.processorNumber) };
  for (const v of V.signatureVariants) assert.equal(hex(deriveKeyPair({ ...p, signature: v.signature }).publicKey), v.publicKey, v.name);
});
