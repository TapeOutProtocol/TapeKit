// 图片附件：在本机压成小图（整条消息上限 16,000 字节），以 base64 放进加密内容里。
import { IMAGE_MAX_BYTES } from '../../../../send/module/src/index.js';
import { TapeSendError } from '../../../../send/module/src/index.js';

export interface ImageAttachment { type: 'image'; mime: string; data: string; w: number; h: number; size: number }

const SIDES = [720, 600, 480, 400, 320, 256, 200];
const QUALITIES = [0.82, 0.7, 0.58, 0.46, 0.36];

function toBlob(canvas: HTMLCanvasElement, mime: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, mime, quality));
}

async function base64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/**
 * 压缩到 maxBytes 以内：先用 WebP（浏览器不支持编码 WebP 时退回 JPEG），从大尺寸、高质量开始逐步降低。
 * 只取像素重新编码，原文件里的 EXIF（拍摄位置等）不会带进消息。
 */
export async function compressImage(file: File, maxBytes = IMAGE_MAX_BYTES - 200): Promise<ImageAttachment> {
  if (!file.type.startsWith('image/')) throw new TapeSendError('bad-input', 'not an image');
  if (file.size > 30 * 1024 * 1024) throw new TapeSendError('too-large', 'image file too large');
  const bitmap = await createImageBitmap(file);
  try {
    for (const side of SIDES) {
      const scale = Math.min(1, side / Math.max(bitmap.width, bitmap.height));
      const w = Math.max(1, Math.round(bitmap.width * scale));
      const h = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new TapeSendError('bad-input', 'canvas unavailable');
      ctx.fillStyle = '#fff'; // 透明背景压成 JPEG 时不变黑
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(bitmap, 0, 0, w, h);
      for (const q of QUALITIES) {
        let blob = await toBlob(canvas, 'image/webp', q);
        if (!blob || blob.type !== 'image/webp') blob = await toBlob(canvas, 'image/jpeg', q);
        if (blob && blob.size <= maxBytes && (blob.type === 'image/webp' || blob.type === 'image/jpeg')) {
          return { type: 'image', mime: blob.type, data: await base64(blob), w, h, size: blob.size };
        }
      }
    }
  } finally {
    bitmap.close();
  }
  throw new TapeSendError('too-large', 'image cannot be compressed small enough');
}
