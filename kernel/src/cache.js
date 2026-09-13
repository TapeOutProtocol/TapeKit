// 持久缓存（可插拔）。内核只依赖这四个方法：get(key) → {meta, bytes}|undefined、set(key, meta, bytes)、delete(key)、clear()。
// 三种实现：内存（默认）、Node 文件目录、浏览器 IndexedDB。都按字节数做 LRU，超限淘汰最久没用的。
// 文件按链上 sha256 存（内容寻址），所以哈希一变自然失效；缓存里的字节在读出时不再重新校验，本地存储视为可信。

const enc = new TextEncoder();
const dec = new TextDecoder();
const size = (bytes, meta) => (bytes ? bytes.length : 0) + enc.encode(JSON.stringify(meta || null)).length + 64;
let tick = 0;
const now = () => Date.now() * 1000 + (tick = (tick + 1) % 1000);   // 同一毫秒内也单调递增，LRU 才分得出先后

export function createMemoryCache({ maxBytes = 64 * 1024 * 1024 } = {}) {
  const map = new Map(); let total = 0;
  return {
    kind: 'memory',
    async get(key) { const v = map.get(key); if (!v) return undefined; map.delete(key); map.set(key, v); return { meta: v.meta, bytes: v.bytes }; },
    async set(key, meta, bytes) {
      const n = size(bytes, meta); if (n > maxBytes / 2) return;
      const old = map.get(key); if (old) { total -= old.n; map.delete(key); }
      map.set(key, { meta, bytes, n }); total += n;
      while (total > maxBytes && map.size) { const [k, v] = map.entries().next().value; map.delete(k); total -= v.n; }
    },
    async delete(key) { const v = map.get(key); if (v) { total -= v.n; map.delete(key); } },
    async clear() { map.clear(); total = 0; },
  };
}

/** Node：目录里每个条目两个文件 <hash>.bin / <hash>.json，加一个 index.json 记 LRU。 */
export async function createFsCache(dir, { maxBytes = 512 * 1024 * 1024 } = {}) {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const { createHash } = await import('node:crypto');
  await fs.mkdir(dir, { recursive: true });
  const indexPath = path.join(dir, 'index.json');
  let index = { entries: {} };   // key → { n, at }
  try { index = JSON.parse(await fs.readFile(indexPath, 'utf8')); } catch { /* 新目录 */ }
  const fname = (key) => createHash('sha256').update(key).digest('hex').slice(0, 40);
  let saving = null;
  const save = () => { saving = (saving || Promise.resolve()).then(() => fs.writeFile(indexPath, JSON.stringify(index))).catch(() => {}); return saving; };
  const total = () => Object.values(index.entries).reduce((s, e) => s + e.n, 0);
  async function evict() {
    while (total() > maxBytes) {
      const oldest = Object.entries(index.entries).sort((a, b) => a[1].at - b[1].at)[0];
      if (!oldest) break;
      await remove(oldest[0]);
    }
  }
  async function remove(key) {
    delete index.entries[key];
    const f = fname(key);
    await Promise.allSettled([fs.unlink(path.join(dir, f + '.bin')), fs.unlink(path.join(dir, f + '.json'))]);
  }
  return {
    kind: 'fs', dir,
    async get(key) {
      const e = index.entries[key]; if (!e) return undefined;
      const f = fname(key);
      try {
        const [meta, bytes] = await Promise.all([fs.readFile(path.join(dir, f + '.json'), 'utf8').then(JSON.parse), fs.readFile(path.join(dir, f + '.bin'))]);
        e.at = now(); save();
        return { meta, bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) };
      } catch { await remove(key); await save(); return undefined; }
    },
    async set(key, meta, bytes) {
      const n = size(bytes, meta); if (n > maxBytes / 2) return;
      const f = fname(key);
      await fs.writeFile(path.join(dir, f + '.bin'), bytes || new Uint8Array());
      await fs.writeFile(path.join(dir, f + '.json'), JSON.stringify(meta ?? null));
      index.entries[key] = { n, at: now() };
      await evict(); await save();
    },
    async delete(key) { await remove(key); await save(); },
    async clear() { for (const k of Object.keys(index.entries)) await remove(k); await save(); },
  };
}

/** 浏览器：IndexedDB，一个对象仓库 entries：{ key, meta, bytes, n, at }。 */
export async function createIdbCache(name = 'hashport-kernel', { maxBytes = 256 * 1024 * 1024 } = {}) {
  const db = await new Promise((res, rej) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => { const s = req.result.createObjectStore('entries', { keyPath: 'key' }); s.createIndex('at', 'at'); };
    req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error);
  });
  const tx = (mode, fn) => new Promise((res, rej) => { const t = db.transaction('entries', mode); const out = fn(t.objectStore('entries')); t.oncomplete = () => res(out && 'result' in out ? out.result : out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });
  const req = (mode, fn) => new Promise((res, rej) => { const t = db.transaction('entries', mode); const r = fn(t.objectStore('entries')); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  async function totalBytes() { let s = 0; const all = await req('readonly', (st) => st.getAll()); for (const e of all) s += e.n; return s; }
  async function evict() {
    if ((await totalBytes()) <= maxBytes) return;
    const all = (await req('readonly', (st) => st.getAll())).sort((a, b) => a.at - b.at);
    let t = all.reduce((s, e) => s + e.n, 0);
    for (const e of all) { if (t <= maxBytes) break; await req('readwrite', (st) => st.delete(e.key)); t -= e.n; }
  }
  return {
    kind: 'idb', name,
    async get(key) { const e = await req('readonly', (st) => st.get(key)); if (!e) return undefined; req('readwrite', (st) => st.put({ ...e, at: now() })).catch(() => {}); return { meta: e.meta, bytes: e.bytes }; },
    async set(key, meta, bytes) { const n = size(bytes, meta); if (n > maxBytes / 2) return; await req('readwrite', (st) => st.put({ key, meta: meta ?? null, bytes: bytes || new Uint8Array(), n, at: now() })); await evict(); },
    async delete(key) { await req('readwrite', (st) => st.delete(key)); },
    async clear() { await tx('readwrite', (st) => st.clear()); },
  };
}

/** 小工具：把 JSON 放进缓存（meta 里），bytes 为空。 */
export const jsonKey = (cache) => ({
  async get(key) { const v = await cache.get(key); return v ? v.meta : undefined; },
  set: (key, value) => cache.set(key, value, new Uint8Array()),
});

export const textBytes = (s) => enc.encode(s);
export const bytesText = (b) => dec.decode(b);
