// TAP-10 §6：消息内容（UTF-8 JSON 对象）的编码与严格解码。
import { keccak_256 } from '@noble/hashes/sha3.js';
import { TapeSendError, ascii, bytesToHex, concat, hexToBytes, uint256 } from './bytes.js';

export const SUBJECT_MAX = 200;
/** 附件：每条最多几个；图片解码后最大字节数（整条消息上限 16,000 字节，图片要压成小图） */
export const ATTACHMENTS_MAX = 4;
export const IMAGE_MAX_BYTES = 11_000;
export const IMAGE_MIME = Object.freeze(['image/webp', 'image/jpeg', 'image/png']);

const HEX20 = /^0x[0-9a-f]{40}$/;
const HEX32 = /^0x[0-9a-f]{64}$/;
const DECIMAL = /^(0|[1-9][0-9]{0,77})$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

function base64Bytes(b64) {
  if (typeof b64 !== 'string' || b64.length % 4 !== 0 || !BASE64.test(b64)) return null;
  try {
    const bin = atob(b64);
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}
/** 图片字节开头必须与声明的格式一致（WebP / JPEG / PNG 的文件头） */
function imageMagicOk(mime, b) {
  if (mime === 'image/jpeg') return b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  if (mime === 'image/png') return b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
  if (mime === 'image/webp') return b.length > 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50;
  return false;
}

/** 图片真实尺寸上限：解码后内存 ≈ 宽×高×4，2048² 约 16 MB，已是手机可承受的上沿 */
export const IMAGE_MAX_SIDE = 2048;

/** 从文件头读出图片的真实宽高（PNG IHDR / WebP VP8·VP8L·VP8X / JPEG SOF）；读不出返回 null */
export function imageSize(mime, b) {
  const u16be = (i) => (b[i] << 8) | b[i + 1];
  const u16le = (i) => b[i] | (b[i + 1] << 8);
  const u24le = (i) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
  if (mime === 'image/png') {
    if (b.length < 24 || String.fromCharCode(b[12], b[13], b[14], b[15]) !== 'IHDR') return null;
    const w = ((b[16] << 24) | (b[17] << 16) | (b[18] << 8) | b[19]) >>> 0;
    const h = ((b[20] << 24) | (b[21] << 16) | (b[22] << 8) | b[23]) >>> 0;
    // 动图（APNG 的 acTL 块）不接受：11KB 里能塞几百帧，持续占用 CPU 和电量
    for (let i = 8; i + 8 <= b.length;) {
      const len = ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
      const type = String.fromCharCode(b[i + 4], b[i + 5], b[i + 6], b[i + 7]);
      if (type === 'acTL') return null;
      if (type === 'IDAT' || type === 'IEND') break;
      i += 12 + len;
    }
    return { w, h };
  }
  if (mime === 'image/webp') {
    if (b.length < 30) return null;
    const fourcc = String.fromCharCode(b[12], b[13], b[14], b[15]);
    if (fourcc === 'VP8 ') {
      if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
      return { w: u16le(26) & 0x3fff, h: u16le(28) & 0x3fff };
    }
    if (fourcc === 'VP8L') {
      if (b[20] !== 0x2f) return null;
      const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
      return { w: (bits & 0x3fff) + 1, h: ((bits >>> 14) & 0x3fff) + 1 };
    }
    // VP8X 标志位 0x02 = 动画：不接受
    if (fourcc === 'VP8X') return b[20] & 0x02 ? null : { w: u24le(24) + 1, h: u24le(27) + 1 };
    return null;
  }
  if (mime === 'image/jpeg') {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const m = b[i + 1];
      if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01 || m === 0xff) { i += m === 0xff ? 1 : 2; continue; }
      // 只接受基线 JPEG（SOF0/SOF1）：渐进式等可以塞几百个扫描段拖慢解码
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return m === 0xc0 || m === 0xc1 ? { h: u16be(i + 5), w: u16be(i + 7) } : null;
      i += 2 + u16be(i + 2);
    }
    return null;
  }
  return null;
}

/**
 * 校验一个附件，合法返回规范化后的对象，不合法返回 null（整条消息不因此判为损坏，只是这个附件不显示）。
 * 种类：
 *   image  { type, mime, data(base64), w, h }                         —— 图片本身在加密内容里
 *   native { type, chainId, amount(最小单位十进制), tx }             —— 随消息转给对方容器的原生币，tx 是那笔转账
 *   erc20  { type, chainId, token, amount, tx }
 *   erc721 { type, chainId, token, tokenId(十进制), tx }
 * 资产附件只是"声明"：收件方客户端必须到链上核对那笔转账确实把资产转进了自己的容器。
 */
export function checkAttachment(a) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) return null;
  if (a.type === 'image') {
    if (!IMAGE_MIME.includes(a.mime)) return null;
    const bytes = base64Bytes(a.data);
    if (!bytes || bytes.length === 0 || bytes.length > IMAGE_MAX_BYTES || !imageMagicOk(a.mime, bytes)) return null;
    // 声明的宽高必须等于文件头里的真实宽高，并且不超过上限：几百字节的图片可以声明巨大的真实尺寸，解码时把内存撑爆（解压炸弹）
    const real = imageSize(a.mime, bytes);
    if (!real || real.w < 1 || real.h < 1 || real.w > IMAGE_MAX_SIDE || real.h > IMAGE_MAX_SIDE) return null;
    if (a.w !== real.w || a.h !== real.h) return null;
    return { type: 'image', mime: a.mime, data: a.data, w: a.w, h: a.h, size: bytes.length };
  }
  if (a.type !== 'native' && a.type !== 'erc20' && a.type !== 'erc721') return null;
  if (!Number.isSafeInteger(a.chainId) || a.chainId <= 0) return null;
  const tx = typeof a.tx === 'string' ? a.tx.toLowerCase() : '';
  if (!HEX32.test(tx)) return null;
  if (a.type === 'native') {
    if (typeof a.amount !== 'string' || !DECIMAL.test(a.amount) || a.amount === '0') return null;
    return { type: 'native', chainId: a.chainId, amount: a.amount, tx };
  }
  const token = typeof a.token === 'string' ? a.token.toLowerCase() : '';
  if (!HEX20.test(token)) return null;
  if (a.type === 'erc20') {
    if (typeof a.amount !== 'string' || !DECIMAL.test(a.amount) || a.amount === '0') return null;
    return { type: 'erc20', chainId: a.chainId, token, amount: a.amount, tx };
  }
  if (typeof a.tokenId !== 'string' || !DECIMAL.test(a.tokenId)) return null;
  return { type: 'erc721', chainId: a.chainId, token, tokenId: a.tokenId, tx };
}

// 高代理后面没跟低代理，或低代理前面没有高代理
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
// 双向文字控制字符（含阿拉伯字母标记 U+061C）、零宽和看不见的填充字符（不含 U+200D 零宽连接符，表情序列要用它）、
// 行 / 段分隔符，以及除换行、制表符以外的 C0 / C1 控制字符
const BIDI = /[\u061c\u115f\u180e\u200b\u200e\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\u3164\ufeff\uffa0]/g;
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/** TAP-10 §6 显示规则：双向控制字符和控制字符换成可见的 \u{..}，结果只能当纯文本显示 */
export function displayText(s) {
  const visible = (c) => `\\u{${c.codePointAt(0).toString(16)}}`;
  return String(s).replace(BIDI, visible).replace(CONTROL, visible);
}

/** @param {{subject?: string, body: string, ts?: number, attachments?: object[]}} m */
export function encodeContent(m) {
  if (typeof m.body !== 'string') throw new TapeSendError('bad-input', 'body must be a string');
  const obj = { v: 1, kind: 'message' };
  if (m.subject !== undefined && m.subject !== '') {
    if (typeof m.subject !== 'string') throw new TapeSendError('bad-input', 'subject must be a string');
    if ([...m.subject].length > SUBJECT_MAX) throw new TapeSendError('bad-input', `subject longer than ${SUBJECT_MAX} characters`);
    obj.subject = m.subject;
  }
  obj.body = m.body;
  if (m.attachments !== undefined && m.attachments.length) {
    if (!Array.isArray(m.attachments) || m.attachments.length > ATTACHMENTS_MAX) throw new TapeSendError('bad-input', `at most ${ATTACHMENTS_MAX} attachments`);
    obj.attachments = m.attachments.map((a) => {
      const c = checkAttachment(a);
      if (!c) throw new TapeSendError('bad-input', 'invalid attachment');
      const { size: _size, ...wire } = c;
      return wire;
    });
  }
  if (m.ts !== undefined) {
    if (!Number.isSafeInteger(m.ts) || m.ts < 0) throw new TapeSendError('bad-input', 'ts must be a non-negative integer');
    obj.ts = m.ts;
  }
  return new TextEncoder().encode(JSON.stringify(obj));
}

/**
 * 严格解码（TAP-10 §6）：非法 UTF-8、开头是 BOM、不是对象、任意层级出现重复成员名、字符串里有孤立代理项，都判为 damaged。
 * @returns {{kind: 'message', subject: string, body: string, ts: number|null, attachments: object[], badAttachments: number} | {kind: 'unsupported', value: object}}
 */
export function decodeContent(bytes) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new TapeSendError('damaged', 'content is not valid UTF-8');
  }
  if (text.charCodeAt(0) === 0xfeff) throw new TapeSendError('damaged', 'content starts with a BOM');
  assertNoDuplicateKeys(text);
  let value;
  try {
    value = JSON.parse(text, (_k, v) => {
      if (typeof v === 'string' && LONE_SURROGATE.test(v)) throw new TapeSendError('damaged', 'lone surrogate in string');
      return v;
    });
  } catch (e) {
    if (e instanceof TapeSendError) throw e;
    throw new TapeSendError('damaged', 'content is not JSON');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TapeSendError('damaged', 'content is not a JSON object');
  if (value.v !== 1 || value.kind !== 'message') {
    // 认得出是"别的版本 / 别的类型"才算不支持；字段缺失或类型不对是损坏
    if ((typeof value.v === 'number' && value.v !== 1) || (typeof value.kind === 'string' && value.kind !== 'message')) return { kind: 'unsupported', value };
    throw new TapeSendError('damaged', 'v or kind missing or of the wrong type');
  }
  if (typeof value.body !== 'string') throw new TapeSendError('damaged', 'body missing');
  if (value.subject !== undefined && typeof value.subject !== 'string') throw new TapeSendError('damaged', 'subject is not a string');
  const subject = value.subject === undefined ? '' : [...value.subject].slice(0, SUBJECT_MAX).join('');
  const ts = Number.isSafeInteger(value.ts) && value.ts >= 0 ? value.ts : null;
  // 附件是可选的：格式不对的附件只是不显示，并计数告诉用户，不让整条消息变成"已损坏"
  const raw = Array.isArray(value.attachments) ? value.attachments.slice(0, ATTACHMENTS_MAX) : [];
  const attachments = raw.map(checkAttachment).filter(Boolean);
  const badAttachments = (Array.isArray(value.attachments) ? value.attachments.length : value.attachments === undefined ? 0 : 1) - attachments.length;
  return { kind: 'message', subject, body: value.body, ts, attachments, badAttachments };
}

export const MAX_DEPTH = 32;

/**
 * 扫描 JSON 文本（在 JSON.parse 之前）：
 *   - 任意对象里重复的成员名（反转义后比较）→ damaged。JSON.parse 会静默保留最后一个，所以要单独查；
 *   - 成员名里的孤立代理项 → damaged（JSON.parse 的 reviver 只看得到值，看不到键）；
 *   - 嵌套超过 MAX_DEPTH → damaged。否则结果取决于 JS 引擎的栈深度，不同客户端会给出不同结论。
 */
function assertNoDuplicateKeys(text) {
  const stack = []; // 每层：对象 => Set，数组 => null
  let i = 0;
  let expectKey = false;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      let raw = '';
      while (j < text.length && text[j] !== '"') {
        if (text[j] === '\\') {
          raw += text[j] + (text[j + 1] ?? '');
          j += 2;
        } else {
          raw += text[j];
          j += 1;
        }
      }
      if (j >= text.length) throw new TapeSendError('damaged', 'unterminated string');
      const top = stack[stack.length - 1];
      if (expectKey && top instanceof Set) {
        let key;
        try {
          key = JSON.parse(`"${raw}"`);
        } catch {
          throw new TapeSendError('damaged', 'bad string escape');
        }
        if (LONE_SURROGATE.test(key)) throw new TapeSendError('damaged', 'lone surrogate in member name');
        if (top.has(key)) throw new TapeSendError('damaged', 'duplicate member name');
        top.add(key);
        expectKey = false;
      }
      i = j + 1;
      continue;
    }
    if (ch === '{' || ch === '[') {
      if (stack.length >= MAX_DEPTH) throw new TapeSendError('damaged', `nesting deeper than ${MAX_DEPTH}`);
    }
    if (ch === '{') {
      stack.push(new Set());
      expectKey = true;
    } else if (ch === '[') {
      stack.push(null);
      expectKey = false;
    } else if (ch === '}' || ch === ']') {
      stack.pop();
      expectKey = false;
    } else if (ch === ',') {
      expectKey = stack[stack.length - 1] instanceof Set;
    }
    i += 1;
  }
}

/** §7 消息 ID */
export function messageId(chainId, hub, to, inboxIndex) {
  // 只由链上存储里、经多节点严格一致读出的值决定：标签 ‖ 发出链 ‖ 中枢 ‖ 收件端点号 ‖ 它在收件信箱里的序号。全网唯一。
  return bytesToHex(keccak_256(concat(ascii('TAP-10/msg/v2'), uint256(chainId), hexToBytes(hub, 20), hexToBytes(to, 32), uint256(inboxIndex))));
}
