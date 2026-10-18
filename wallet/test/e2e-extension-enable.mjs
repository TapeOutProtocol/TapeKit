// Second part of e2e-extension.mjs: the popup's "enable" button and dynamic registration, i.e. the path real
// users take (the main part uses the --test build with static content scripts). It loads a copy of the normal
// build (dist/extension) whose only change is install-time access to http://*.localhost, so that
// chrome.permissions.request resolves without Chrome's dialog (it does when the access is already granted).
// Then the extension is reloaded the way an update or chrome://extensions "reload" does (Extensions.loadUnpacked
// on the same path), which drops dynamically registered scripts: routing must come back on its own.
// Offline: a plain local page server stands in for the gateway; no chain reads.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startBrowser, until } from './e2e-cdp.mjs';
import { PAGE_HELPER, BINDING } from './e2e-pages.mjs';

/** @param {{ root: string, check: (name: string, ok: unknown, detail?: string) => void }} opts */
export async function runEnableChecks({ root, check }) {
  execFileSync(process.execPath, [path.join(root, 'build-extension.mjs')], { stdio: 'ignore' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapekit-ext-enable-'));
  fs.cpSync(path.join(root, 'dist', 'extension'), dir, { recursive: true });
  const manifestFile = path.join(dir, 'manifest.json');
  fs.writeFileSync(manifestFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(manifestFile, 'utf8')), host_permissions: ['http://*.localhost/*'] }));
  const pages = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end('<!doctype html><title>page</title><p>page'); });
  await new Promise((r) => pages.listen(0, '127.0.0.1', r));
  const gateway = `localhost:${pages.address().port}`;
  const b = await startBrowser({ pageScripts: [], binding: BINDING, extensionPath: dir });
  const EXT = `chrome-extension://${b.extensionId}/`;
  const ev = (page, expr) => b.evaluate(page.sessionId, expr);
  async function sw(expr) {
    const w = await until(async () => {
      const x = b.workers.filter((y) => !y.closed && y.url === EXT + 'background.js').at(-1);
      if (!x) return null;
      await b.send('Runtime.runIfWaitingForDebugger', {}, x.sessionId).catch(() => {});
      return (await b.evaluate(x.sessionId, `typeof chrome === 'object' && !!chrome.storage`).catch(() => false)) ? x : null;
    });
    return b.evaluate(w.sessionId, expr);
  }
  async function walletOn(url) {
    const t = await b.newTab();
    await b.navigate(t, url);
    await until(() => ev(t, `document.readyState === 'complete'`));
    await ev(t, PAGE_HELPER);
    const out = await ev(t, `({ tapekit: !!(window.tapekit && window.tapekit.wallet), announced: __e2e.announced.map((i) => i.rdns) })`);
    await b.send('Target.closeTarget', { targetId: t.targetId });
    return out.tapekit && out.announced.includes('org.tapekit');
  }
  const registered = () => sw(`chrome.scripting.getRegisteredContentScripts().then((l) => l.map((s) => s.id + ':' + s.world))`);
  try {
    const pop = await b.newTab();
    await b.navigate(pop, EXT + 'popup/popup.html');
    await sw(`chrome.storage.sync.set({ gateway: ${JSON.stringify(gateway)} }).then(() => 1)`);
    const label = await until(() => ev(pop, `(() => { const t = document.getElementById('wallet-toggle'); return !t.hidden && t.textContent === '启用钱包路由' ? t.textContent : null; })()`));
    check('enable: before enabling, nothing is registered and sites get no wallet', label && J0(await registered()) && !(await walletOn(`http://433-0.${gateway}/`)));
    await b.click(pop.sessionId, '#wallet-toggle');
    const list = await until(async () => { const l = await registered(); return l.length === 3 ? l : null; });
    check('enable: a real click on "启用钱包路由" registers the provider (MAIN) and both relays (ISOLATED)',
      JSON.stringify(list) === JSON.stringify(['tapekit-wallet-inpage:MAIN', 'tapekit-wallet-relay:ISOLATED', 'tapekit-wallet-hub-relay:ISOLATED']), JSON.stringify(list));
    check('enable: the gateway\'s sites now get the TapeKit wallet; the root and /.tape/* do not',
      await walletOn(`http://433-0.${gateway}/`) && !(await walletOn(`http://${gateway}/`)) && !(await walletOn(`http://433-0.${gateway}/.tape/status`)));
    // An update or reload drops the registrations; onInstalled → syncRouting registers them again (audit
    // 2026-10-18 issue 5: before, routing stayed "on" with no scripts and no site got the wallet).
    const reloaded = await b.send('Extensions.loadUnpacked', { path: dir });
    const back = await until(async () => { const l = await registered(); return l.length === 3 ? l : null; }, 20_000);
    check('reload/update: the extension registers its three scripts again by itself, and sites get the wallet again (no click)',
      reloaded.id === b.extensionId && !!back && await walletOn(`http://433-0.${gateway}/`), JSON.stringify(back));
    const pop2 = await b.newTab();   // the old popup tab closed with the old extension instance
    await b.navigate(pop2, EXT + 'popup/popup.html');
    await until(() => ev(pop2, `document.getElementById('wallet-toggle').textContent === '停用钱包路由'`));
    await b.click(pop2.sessionId, '#wallet-toggle');
    await until(async () => (await registered()).length === 0);
    check('disable: the scripts are unregistered and sites get no wallet again', J0(await registered()) && !(await walletOn(`http://433-0.${gateway}/`)));
  } catch (e) {
    check('enable checks: script error', false, String((e && e.stack) || e));
  } finally {
    await b.close();
    pages.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const J0 = (list) => Array.isArray(list) && list.length === 0;
