// Compile-only check that index.d.ts describes the public API usefully.
import { createKernel, createMemoryCache, parseInput, type Resolution, type SiteFile } from '../../index.js';
const k = createKernel({ cache: createMemoryCache({ maxBytes: 1 << 20 }), quorum: 2, locale: 'en' });
async function main(): Promise<void> {
  const res: Resolution = await k.resolve('4246.0.tape');
  if (res.status !== 'ok') return;
  const site = await k.openSite(res);
  const f = await site.get('index.html');
  if (f && f.status !== 'too-large') { const sf: SiteFile = f; console.log(sf.sha256, sf.verified, res.name, res.paidVia); }
  const stop = k.watch(site, (c) => console.log(c.changed));
  stop();
  const p = parseInput('web+tape://4246.0.tape/a');
  if (p.kind === 'name') console.log(p.tokenId + p.cpu);
}
main();
