// SHA-256：浏览器与 Node（≥18）都用 Web Crypto，不依赖第三方库。

async function subtle() {
  if (globalThis.crypto?.subtle) return globalThis.crypto.subtle;
  const { webcrypto } = await import('node:crypto');
  return webcrypto.subtle;
}

/** @param {Uint8Array} bytes @returns {Promise<string>} 0x 开头的 64 位小写十六进制 */
export async function sha256Hex(bytes) {
  const d = new Uint8Array(await (await subtle()).digest('SHA-256', bytes));
  return '0x' + Array.from(d, (x) => x.toString(16).padStart(2, '0')).join('');
}
