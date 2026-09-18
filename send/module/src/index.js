// @tapekit/send —— TAP-10 参考实现。
// 这个模块处理密钥与加密，刻意和 TapeKit 的网页模块分开：私钥逻辑绝不和"运行陌生人的网页"放在同一个包里。
export { TapeSendError, bytesToHex, hexToBytes, checksumAddress } from './bytes.js';
export {
  CHAIN_ID, KEY_DOMAIN, KEY_ISSUED_AT, keyDerivationText, personalMessageHash, recoverAddress, normalizedRS, isDeterministic, deriveKeyPair, fingerprint,
} from './keys.js';
export {
  MAGIC, FORMAT_VERSION, KIND_PUBLIC, KIND_SEALED, MAX_PAYLOAD, MAX_SLOTS, encodePublic, seal, parsePayload, openPayload, assertValidPublicKey,
} from './payload.js';
export { SUBJECT_MAX, ATTACHMENTS_MAX, IMAGE_MAX_BYTES, IMAGE_MIME, checkAttachment, encodeContent, decodeContent, displayText, messageId } from './content.js';
