// Raw-CDP harness for wallet/test/e2e.mjs (same approach as sw-gateway/test/e2e.mjs, no dependencies).
// Starts headless Chrome with a fresh profile, auto-attaches to every new page (tabs and the hub popups a page
// opens) before it runs, and prepares each page the same way: scripts injected at document start, a binding
// the fake wallet reports through, and focus emulation (headless windows are never focused, and the hub only
// enables its confirm buttons in a focused window).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll `fn` until it returns a truthy value (returned) or `ms` passes (null). Errors count as "not yet". */
export async function until(fn, ms = 20_000, step = 100) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const v = await fn(); if (v) return v; } catch { /* page not ready yet */ }
    await sleep(step);
  }
  return null;
}

/**
 * @param {{ pageScripts: string[], binding: string }} opts
 *   pageScripts  sources added with Page.addScriptToEvaluateOnNewDocument to every page (they self-select)
 *   binding      name of the Runtime binding; its calls land in `bindingCalls`
 */
export async function startBrowser({ pageScripts, binding }) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tapekit-wallet-e2e-'));
  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run',
    '--no-default-browser-check', '--disable-extensions', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const wsUrl = await new Promise((res, rej) => {
    let buf = '';
    chrome.stderr.on('data', (d) => { buf += d; const m = buf.match(/DevTools listening on (ws:\/\/\S+)/); if (m) res(m[1]); });
    chrome.on('exit', (c) => rej(new Error('chrome exited ' + c)));
    setTimeout(() => rej(new Error('chrome did not start: ' + buf)), 15_000);
  });
  const ws = new WebSocket(wsUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));

  let seq = 0;
  const waiting = new Map();
  const pages = new Map();       // targetId → { targetId, sessionId, openerId, url, closed, ready }
  const frames = [];             // { sessionId, url } of out-of-process iframes
  const bindingCalls = [];       // { sessionId, payload }
  const errors = [];             // { sessionId, text }: uncaught exceptions, console.error, error log entries
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
    const id = ++seq;
    waiting.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });

  async function preparePage(info, s) {
    const page = { targetId: info.targetId, sessionId: s, openerId: info.openerId || null, url: info.url, closed: false, ready: false };
    pages.set(info.targetId, page);
    try {
      for (const domain of ['Page', 'Runtime', 'Log']) await send(`${domain}.enable`, {}, s);
      await send('Runtime.addBinding', { name: binding }, s);
      for (const source of pageScripts) await send('Page.addScriptToEvaluateOnNewDocument', { source }, s);
      await send('Emulation.setFocusEmulationEnabled', { enabled: true }, s);
      await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, s);
    } finally {
      await send('Runtime.runIfWaitingForDebugger', {}, s).catch(() => {});
      page.ready = true;
    }
  }

  async function onAttached({ sessionId: s, targetInfo: info }) {
    if (info.type === 'page') return preparePage(info, s).catch(() => {});
    // Workers, service workers and out-of-process frames: just let them run (Runtime.enable on a paused
    // service worker never answers, which would leave the gateway's worker stuck before it starts).
    if (info.type === 'iframe') frames.push({ sessionId: s, url: info.url });
    await send('Runtime.runIfWaitingForDebugger', {}, s).catch(() => {});
  }

  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && waiting.has(m.id)) {
      const w = waiting.get(m.id);
      waiting.delete(m.id);
      return m.error ? w.rej(new Error(m.error.message)) : w.res(m.result);
    }
    const p = m.params || {};
    if (m.method === 'Target.attachedToTarget') onAttached(p);
    else if (m.method === 'Target.targetInfoChanged' && pages.has(p.targetInfo.targetId)) pages.get(p.targetInfo.targetId).url = p.targetInfo.url;
    else if (m.method === 'Target.targetDestroyed' && pages.has(p.targetId)) pages.get(p.targetId).closed = true;
    else if (m.method === 'Runtime.bindingCalled' && p.name === binding) bindingCalls.push({ sessionId: m.sessionId, payload: p.payload });
    else if (m.method === 'Runtime.exceptionThrown') errors.push({ sessionId: m.sessionId, text: p.exceptionDetails.exception?.description || p.exceptionDetails.text });
    else if (m.method === 'Runtime.consoleAPICalled' && p.type === 'error') errors.push({ sessionId: m.sessionId, text: p.args.map((a) => a.value ?? a.description).join(' ') });
    else if (m.method === 'Log.entryAdded' && p.entry.level === 'error' && p.entry.source !== 'network') errors.push({ sessionId: m.sessionId, text: p.entry.text });
  });
  await send('Target.setDiscoverTargets', { discover: true });
  await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });

  /** Evaluate in a page; the value comes back as JSON text so arrays and objects survive intact. */
  async function evaluate(sessionId, expr) {
    const r = await send('Runtime.evaluate', { expression: `(async () => JSON.stringify(await (${expr})) ?? 'null')()`, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return typeof r.result.value === 'string' ? JSON.parse(r.result.value) : r.result.value;
  }

  /** A real click (trusted input, so it carries user activation) at the centre of `selector`. */
  async function click(sessionId, selector) {
    const at = await evaluate(sessionId, `(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null;
      const b = e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
    if (!at) throw new Error('no element ' + selector);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y, button: 'none' }, sessionId);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'left', buttons: 1, clickCount: 1 }, sessionId);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button: 'left', buttons: 0, clickCount: 1 }, sessionId);
  }

  /** New tab, prepared before its first document. */
  async function newTab() {
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const page = await until(() => pages.get(targetId)?.ready && pages.get(targetId));
    if (!page) throw new Error('tab was not attached');
    return page;
  }

  async function navigate(page, url) {
    await send('Page.navigate', { url }, page.sessionId);
    await sleep(300);
  }

  async function close() {
    try { ws.close(); } catch { /* already closed */ }
    chrome.kill('SIGKILL');
    await new Promise((done) => { if (chrome.exitCode !== null) return done(); chrome.once('exit', done); setTimeout(done, 5000); });
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* left for the OS */ }
  }

  return { send, pages, frames, bindingCalls, errors, evaluate, click, newTab, navigate, close };
}
