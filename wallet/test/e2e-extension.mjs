// End-to-end test of the wallet router's extension channel (prd.md acceptance criteria, extension parts; design
// §10.1). Real headless Chrome with the TapeKit extension's test build loaded over CDP (Extensions.loadUnpacked),
// the local gateway with the hub (sw-gateway/dev-server.mjs), mainnet read-only (site identities, read calls)
// and a fake wallet in the hub (e2e-pages.mjs, as in e2e.mjs, loaded as a second extension the way real wallets
// inject). User gestures are real CDP mouse input. The fake applies OKX Wallet 4.19.0's focus rule (connect,
// transaction and chain-switch calls only from the active tab of the focused normal window, while a plain
// personal_sign and typed data pass; research/manual-test.md), so the hub must open as a tab next to the site
// for those; message signatures use the small window with focus (D-i), the no-click notice the same window
// without focus.
// The test build (build-extension.mjs --test) has host access to http://*.localhost and the content scripts
// declared statically, because a test cannot click Chrome's permission dialog; routing is switched on by
// writing the same storage the popup's "enable" button writes. The button itself and the dynamic registration
// real users get are checked afterwards on the normal build (e2e-extension-enable.mjs).
// Run: npm run test:wallet:e2e:extension   (needs Google Chrome and network; no keys, no transactions)
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import server from '../../sw-gateway/dev-server.mjs';
import { createKernel } from '../../kernel/src/index.js';
import { ROUTING_KEY } from '../extension/routing.js';
import { SNAPSHOT_KEY } from '../extension/snapshot.js';
import { startBrowser, until, sleep } from './e2e-cdp.mjs';
import { runEnableChecks } from './e2e-extension-enable.mjs';
import { writeFakeWalletExtension, tabsState, hubWindow, typedData, siweFor, permitData, cardOnScreen, CARD_LAYOUT, hiddenCallTx, MARKER, PAGE_HELPER, BINDING, FAKE_ACCOUNT, FAKE_SIGNATURE, FAKE_TX_HASH } from './e2e-pages.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SITE_A = { name: '433.0.tape', label: '433-0' };
const SITE_B = { name: '11636.0.tape', label: '11636-0' };
const NOT_OPENED = { name: '1.0.tape', label: '1-0' };
const GENESIS_BSC = '0x0d21840abff46b96c84b2ac9e10e4f5cdaeb5693cb665db62a2f3b02d2d57b5b';
const CLIENT = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const OK_BTN = '#card .actions button:nth-child(2)';
const REJECT_BTN = '#card .actions button:nth-child(1)';
const J = JSON.stringify;

const results = [];
const check = (name, ok, detail = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`); };
const has = (text, ...parts) => typeof text === 'string' && parts.every((p) => text.toLowerCase().includes(String(p).toLowerCase()));

execFileSync(process.execPath, [path.join(ROOT, 'build-extension.mjs'), '--test'], { stdio: 'ignore' });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const HUB_HOST = `localhost:${PORT}`;
const HUB = `http://${HUB_HOST}/.tape/wallet/`;
const siteUrl = (site, port = PORT) => `http://${site.label}.localhost:${port}/`;
const originOf = (site) => `http://${site.label}.localhost:${PORT}`;
const lookAlike = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end('<!doctype html><title>look-alike</title><p>look-alike'); });
await new Promise((r) => lookAlike.listen(0, '127.0.0.1', r));

const walletDir = writeFakeWalletExtension(fs.mkdtempSync(path.join(os.tmpdir(), 'tapekit-fake-wallet-')), HUB_HOST);
const b = await startBrowser({ pageScripts: [MARKER], binding: BINDING, extensionPath: [path.join(ROOT, 'dist', 'extension-test'), walletDir] });
const EXT = `chrome-extension://${b.extensionId}/`;
const ev = (page, expr) => b.evaluate(page.sessionId, expr);
const calls = () => b.bindingCalls.map((c) => JSON.parse(c.payload));
const connects = () => calls().filter((c) => c.method === 'eth_requestAccounts').length;
const walletCalls = (method) => calls().filter((c) => c.method === method && !c.refused).length;
const refusedCalls = () => calls().filter((c) => c.refused);
const windowOf = (hub, site) => hubWindow(b, b.extensionIds[1], hub, site);

/** Evaluate in the TapeKit extension's service worker. */
const sw = (expr) => b.inWorker(EXT + 'background.js', expr);
/** Every tab with its window's type, from the fake wallet's background (the second extension). */
const tabsNow = () => tabsState(b, b.extensionIds[1]);
const tabAt = (tabs, prefix) => tabs.find((t) => t.url.startsWith(prefix)) || null;
/** The open hub's tab: a tab of a normal window, active, right after the site's tab, opened from it. */
async function hubTabNextTo(site) {
  const tabs = await tabsNow();
  const [hub, page] = [tabAt(tabs, HUB), tabAt(tabs, siteUrl(site))];
  const ok = !!hub && !!page && hub.windowType === 'normal' && hub.windowId === page.windowId && hub.active && hub.index === page.index + 1 && hub.openerTabId === page.id;
  return { ok, hub, page };
}
/** After the hub tab closed: the site's tab is the active one again. */
const backOn = (site) => until(async () => { const t = tabAt(await tabsNow(), siteUrl(site)); return t && t.active ? t : null; }, 10_000);
const hubPages = () => [...b.pages.values()].filter((p) => !p.closed && p.url.startsWith(HUB));
const popupWindows = () => sw(`chrome.windows.getAll({ windowTypes: ['popup'] }).then((ws) => ws.map((w) => ({ id: w.id, focused: w.focused })))`);
async function hubOf() {
  const hub = await until(() => hubPages().at(-1), 30_000);
  if (hub) await until(() => ev(hub, `document.readyState === 'complete' && !!window.__hubLog`));
  return hub;
}
const HUB_STATE = `(() => { const c = document.getElementById('card'), t = document.getElementById('toast');
  return { card: c.hidden ? null : c.textContent, buttons: [...c.querySelectorAll('.actions button')].map((x) => ({ text: x.textContent, disabled: x.disabled })),
    toast: t.hidden ? null : t.textContent, log: window.__hubLog }; })()`;
const hubState = (hub) => ev(hub, HUB_STATE);
const waitCard = (hub) => until(async () => { const s = await hubState(hub); return s.card ? s : null; }, 60_000);
const waitToast = (hub) => until(async () => { const s = await hubState(hub); return s.toast ? s : null; }, 60_000);
const waitNoHub = () => until(() => hubPages().length === 0, 20_000);
async function pressContinue(hub) {
  await until(async () => (await ev(hub, `document.querySelector(${J(OK_BTN)}).disabled`)) === false, 5000);
  await b.click(hub.sessionId, OK_BTN);
}
async function openSite(page, site, port = PORT) {
  await b.navigate(page, siteUrl(site, port));
  if (port === PORT) await until(() => ev(page, `!!(navigator.serviceWorker && navigator.serviceWorker.controller && document.body && !document.getElementById('msg'))`), 90_000);
  else await until(() => ev(page, `document.readyState === 'complete'`));
  return until(() => ev(page, PAGE_HELPER));
}
const call = (page, key, method, params) => ev(page, `(__e2e.call(${J(key)}, ${J(method)}, ${J(params)}), 1)`);
async function clickCall(page, key, method, params) {
  await ev(page, `(__e2e.next = () => __e2e.call(${J(key)}, ${J(method)}, ${J(params)}), 1)`);
  await b.click(page.sessionId, '#__e2e_btn');
}
const result = (page, key, ms = 60_000) => until(() => ev(page, `__e2e.results[${J(key)}] || null`), ms);
const events = (page) => ev(page, '__e2e.events');
const noWallet = async (page) => (await ev(page, `typeof window.tapekit === 'undefined' && !(window.__e2e && window.__e2e.announced.some((i) => i.rdns === 'org.tapekit'))`)) === true;
/** The window type of every hub tab, sampled while `work()` runs. */
async function hubKindsDuring(work) {
  const seen = new Map();   // hub tab id → type of its window
  let watching = true;
  const watch = (async () => {
    while (watching) {
      for (const t of await tabsNow().catch(() => [])) if (t.url.startsWith(HUB)) seen.set(t.id, t.windowType);
      await sleep(100);
    }
  })();
  try {
    return { value: await work(), kinds: [...seen.values()] };
  } finally {
    watching = false;
    await watch;
  }
}
/** The hub page that shows a card now. */
const cardHub = () => until(async () => {
  for (const p of hubPages()) if ((await hubState(p).catch(() => ({}))).card) return p;
  return null;
}, 60_000);
/** Reject the site dialog in the hub and return the request's result. */
async function rejectDialog(page, key) {
  const hub = await hubOf();
  const dlg = await waitCard(hub);
  await b.click(hub.sessionId, REJECT_BTN);
  return { dlg, res: await result(page, key) };
}

try {
  const kernel = createKernel();
  const ref = {};
  for (const s of [SITE_A, SITE_B, NOT_OPENED]) ref[s.name] = await kernel.resolve(s.name, { fresh: true });
  const A = ref[SITE_A.name], B = ref[SITE_B.name];
  check('reference: A and B are ok, 1.0.tape is not-opened (Node kernel, mainnet)', A.status === 'ok' && B.status === 'ok' && ref[NOT_OPENED.name].status === 'not-opened',
    `${A.status}/${B.status}/${ref[NOT_OPENED.name].status} at BNB block ${Number(A.block)}`);
  check('the extension test build loads over CDP (Extensions.loadUnpacked)', !!b.extensionId, b.extensionId);
  await sw(`chrome.storage.sync.set({ gateway: ${J(HUB_HOST)} }).then(() => chrome.storage.local.set({ ${J(ROUTING_KEY)}: { gateway: ${J(HUB_HOST)} } })).then(() => 1)`);

  // ---- 1. Where the wallet appears, and where it does not (R6, AC8)
  const misc = await b.newTab();
  await b.navigate(misc, `http://${HUB_HOST}/`);
  await until(() => ev(misc, `document.readyState === 'complete'`));
  await ev(misc, PAGE_HELPER);
  check('AC8 the gateway root gets no TapeKit wallet', await noWallet(misc));
  const a = await b.newTab();
  check('site A loads through the gateway', (await openSite(a, SITE_A)) === 'ok');
  const annA = await ev(a, '__e2e.announced');
  check('R2 A: EIP-6963 announces "TapeKit" (org.tapekit) injected by the extension; window.ethereum untouched', annA.filter((i) => i.rdns === 'org.tapekit' && i.name === 'TapeKit').length === 1
    && await ev(a, `window.ethereum === undefined && window.tapekit.wallet.isTapeKit === true && window.__e2eInjected === true`), J(annA.map((i) => i.rdns)));
  for (const [k, m, p] of [['cid', 'eth_chainId'], ['acc0', 'eth_accounts'], ['ethsign', 'eth_sign', [FAKE_ACCOUNT, '0x00']], ['g0', 'eth_getBlockByNumber', ['0x0', false]]]) await call(a, k, m, p);
  const [cid, acc0, ethsign, g0] = [await result(a, 'cid'), await result(a, 'acc0'), await result(a, 'ethsign'), await result(a, 'g0')];
  check('A: eth_chainId 0x38 and eth_accounts [] answered by the extension; eth_sign 4200; reads reach a BNB node; no window opened',
    cid.result === '0x38' && J(acc0.result) === '[]' && ethsign.error && ethsign.error.code === 4200 && g0.result && g0.result.hash === GENESIS_BSC && hubPages().length === 0, J([cid, acc0, ethsign.error]));
  const frame = await ev(a, `new Promise((done) => { const f = document.createElement('iframe'); f.src = '/'; f.onload = () => setTimeout(() => done({ tapekit: typeof f.contentWindow.tapekit, href: f.contentWindow.location.href }), 800); document.body.append(f); })`);
  check('AC8 a frame inside site A gets no TapeKit wallet (top frame only)', frame.tapekit === 'undefined', J(frame));
  await b.navigate(misc, siteUrl(SITE_A) + '.tape/status');
  await until(() => ev(misc, `document.readyState === 'complete'`));
  await ev(misc, PAGE_HELPER);
  check('AC8 /.tape/status on site A gets no TapeKit wallet', await noWallet(misc) && (await ev(misc, 'location.pathname')) === '/.tape/status');
  await b.navigate(misc, `http://127.0.0.1:${PORT}/`);
  await until(() => ev(misc, `document.readyState === 'complete'`));
  await ev(misc, PAGE_HELPER);
  check('AC8 a non-gateway host (127.0.0.1) gets no TapeKit wallet', await noWallet(misc));
  check('a site-shaped page on another port gets the script (match patterns ignore ports)', (await openSite(misc, SITE_A, lookAlike.address().port)) === 'ok');
  await call(misc, 'other', 'eth_chainId');
  const other = await result(misc, 'other');
  check('…but the background refuses it: the exact origin, port included, is not the gateway (4100)', other.error && other.error.code === 4100 && hubPages().length === 0, J(other));

  // ---- 2. AC1/AC2: A connects inside a real click; the hub has no wallet yet, so it opens as a tab (the one-time
  // wallet connection needs the wallet's own prompt, which OKX shows only for the active tab of a normal window)
  await clickCall(a, 'conn1', 'eth_requestAccounts', []);
  const hub1 = await hubOf();
  const first = await hubTabNextTo(SITE_A);
  const shown = await waitToast(hub1);
  const conn1 = await result(a, 'conn1');
  check('AC2 A (real click) gets the address with no dialog; the notice shows name, processor, container', J(conn1 && conn1.result) === J([FAKE_ACCOUNT]) && shown && shown.log.cardShows === 0
    && has(shown.toast, SITE_A.name, A.cpuName, A.container, FAKE_ACCOUNT), J(conn1));
  check('the first connect opens the hub as the active tab of A\'s normal window, right after A (the one-time wallet connection)', first.ok, J(first));
  check('the hub tab closes by itself after the notice', !!(await waitNoHub()));
  check('…and the browser is back on A\'s tab', !!(await backOn(SITE_A)));
  await call(a, 'acc1', 'eth_accounts');
  check('A: accountsChanged event, and eth_accounts from the snapshot with no window', J((await result(a, 'acc1')).result) === J([FAKE_ACCOUNT])
    && (await events(a)).some(([e, d]) => e === 'accountsChanged' && J(d) === J([FAKE_ACCOUNT])) && hubPages().length === 0, J(await events(a)));
  await call(a, 'conn2', 'eth_requestAccounts', []);
  const conn2 = await result(a, 'conn2');
  check('A, already connected, asks again without a click: the address from the snapshot, no window at all', J(conn2 && conn2.result) === J([FAKE_ACCOUNT])
    && hubPages().length === 0 && (await popupWindows()).length === 0 && connects() === 1, J(conn2));

  // ---- 3. AC5 / D-d: signing on A shows the card first; a message signature uses the small window (D-i)
  const text = `TapeKit e2e (extension): sign in to ${SITE_A.name}`;
  const msgHex = '0x' + Buffer.from(text).toString('hex');
  await clickCall(a, 'sign1', 'personal_sign', [msgHex, FAKE_ACCOUNT]);
  const hub2 = await hubOf();
  const card = await waitCard(hub2);
  const win2 = await windowOf(hub2, a);
  const signWindows = await popupWindows();
  check('AC5 the card shows A\'s identity and the message before the wallet sees anything', card && has(card.card, SITE_A.name, A.cpuName, A.container, text) && walletCalls('personal_sign') === 0, card && card.card.slice(0, 160));
  check('D-i the message card has no chain row (a personal message is not chain-bound; typed data keeps it, step 3c)', card && !has(card.card, 'BNB Smart Chain')
    && !card.card.includes('(0x38)'), card && card.card.slice(0, 300));
  check('D-i personal_sign opens the hub in the small window, focused (chrome.windows type popup, its own CDP window of about 400 px), not a tab',
    win2.type === 'popup' && win2.ownWindow && win2.width <= 500 && signWindows.length === 1 && signWindows[0].focused === true, J({ win2, signWindows }));
  await pressContinue(hub2);
  const sign1 = await result(a, 'sign1');
  const fwd = calls().filter((c) => c.method === 'personal_sign');
  check('AC5 after Continue the wallet signs and A gets the result unchanged', sign1.result === FAKE_SIGNATURE && walletCalls('personal_sign') === 1, J(sign1));
  check('D-i in that window the fake, like OKX, lets the plain personal_sign through although its focus check fails there; no chain switch',
    fwd.length === 1 && fwd[0].focused === false && fwd[0].refused === false && refusedCalls().length === 0 && walletCalls('wallet_switchEthereumChain') === 0, J(fwd[0]));
  await waitNoHub();
  check('the window closes after signing and the browser is back on A\'s tab', !!(await backOn(SITE_A)) && (await popupWindows()).length === 0);

  // ---- 3a. The card keeps the requesting site on screen (audit 2026-10-18 issue 1): a sign-in message for another
  // site at 400×580 and a token Permit at 1280×650, both in the small window. Rejected, so nothing is signed.
  async function cardLayout(key, method, params, size) {
    b.nextPageSize(size);
    await clickCall(a, key, method, params);
    const hub = await cardHub();
    const layout = await ev(hub, CARD_LAYOUT);
    await b.click(hub.sessionId, REJECT_BTN);
    const res = await result(a, key);
    await waitNoHub();
    await backOn(SITE_A);
    return { layout, rejected: !!res.error && res.error.code === 4001 };
  }
  const siweCard = await cardLayout('siwe', 'personal_sign', ['0x' + Buffer.from(siweFor('app.uniswap.org')).toString('hex'), FAKE_ACCOUNT], { width: 400, height: 580 });
  check('issue 1: a 10-line sign-in message for another site at 400×580: title, identity rows and the warning on screen; no header, no site list',
    cardOnScreen(siweCard.layout, [400, 580], true) && siweCard.rejected, J(siweCard));
  const permitCard = await cardLayout('permit', 'eth_signTypedData_v4', [FAKE_ACCOUNT, permitData(56)], { width: 1280, height: 650 });
  check('issue 1: a Permit card at 1280×650: title and identity rows on screen; no header, no site list',
    cardOnScreen(permitCard.layout, [1280, 650], false) && permitCard.rejected && walletCalls('personal_sign') === 1 && walletCalls('eth_signTypedData_v4') === 0, J(permitCard));

  // ---- 3b. A transaction (audit 2026-10-18 issues 2 and 7): the card shows the call hidden in `input`, and the
  // wallet gets exactly the rebuilt transaction the card showed, from a hub tab (OKX gates transactions).
  const txCase = hiddenCallTx('0x38');
  await clickCall(a, 'tx1', 'eth_sendTransaction', [txCase.sent]);
  const hubTx = await hubOf();
  const txCard = await waitCard(hubTx);
  const txWin = await windowOf(hubTx, a);
  await pressContinue(hubTx);
  const tx1 = await result(a, 'tx1');
  const sentTx = calls().filter((c) => c.method === 'eth_sendTransaction');
  check('issue 2: the transaction card shows the call hidden in input (68 bytes, selector, recipient) in a hub tab, not a popup window',
    txCard && has(txCard.card, txCase.token, txCase.selector, String(txCase.bytes), 'BNB Smart Chain (0x38)') && txWin.type === 'normal', J({ card: txCard && txCard.card.slice(0, 400), txWin }));
  check('issue 2: after Continue the wallet gets exactly the rebuilt transaction the card showed (data, the site\'s chainId; no input, gas, type or nonce), from a focused tab; the site gets the hash',
    tx1.result === FAKE_TX_HASH && sentTx.length === 1 && J(sentTx[0].params) === J([txCase.expected]) && sentTx[0].focused === true && sentTx[0].refused === false, J({ tx1, sentTx }));
  await waitNoHub();
  await backOn(SITE_A);

  // ---- 3b. AC7: a chain switch goes through the hub (no focus); chainChanged reaches A; the snapshot has the chain
  await call(a, 'sw1', 'wallet_switchEthereumChain', [{ chainId: '0xc4' }]);
  const sw1 = await result(a, 'sw1');
  const swWindows = await popupWindows();
  await call(a, 'cid2', 'eth_chainId');
  const cid2 = await result(a, 'cid2');
  check('AC7 A switches to X Layer through the extension: null, chainChanged 0xc4, eth_chainId 0xc4 right after, window without focus',
    sw1.result === null && cid2.result === '0xc4' && (await events(a)).some(([e, d]) => e === 'chainChanged' && d === '0xc4')
    && swWindows.every((w) => w.focused === false), J([sw1, cid2, swWindows]));
  await waitNoHub();

  // ---- 3c. D-i: typed data for X Layer while the wallet is on BNB Chain. It goes to the small window, whose
  // hub would need a chain switch there (OKX answers it null without switching): it answers needs-tab before any
  // card, and the request moves to a hub tab next to A, where the wallet adds X Layer, switches and signs.
  const markT = calls().length;
  const moved = await hubKindsDuring(async () => {
    await clickCall(a, 'typed1', 'eth_signTypedData_v4', [FAKE_ACCOUNT, typedData(196)]);
    const hubT = await cardHub();
    const state = await hubState(hubT);
    const placed = { tab: await hubTabNextTo(SITE_A), win: await windowOf(hubT, a), cards: state.log.cardShows, card: state.card };
    await pressContinue(hubT);
    return { ...placed, res: await result(a, 'typed1') };
  });
  const seqT = calls().slice(markT).filter((c) => c.method.startsWith('wallet_') || c.method.startsWith('eth_sign'));
  check('D-i typed data on another chain: the small window first, then a hub tab next to A with the one card; nothing sent from the window',
    moved.kinds.includes('popup') && moved.kinds.includes('normal') && moved.value.tab.ok && moved.value.win.type === 'normal' && moved.value.cards === 1
    && refusedCalls().length === 0, J({ kinds: moved.kinds, tab: moved.value.tab, win: moved.value.win, cards: moved.value.cards, refused: refusedCalls() }));
  check('…its card keeps the chain row (typed data is chain-bound): X Layer (0xc4)', has(moved.value.card, 'X Layer (0xc4)'), moved.value.card && moved.value.card.slice(0, 300));
  check('…where the wallet adds X Layer with TapeKit\'s params, switches and signs; A gets the signature', moved.value.res.result === FAKE_SIGNATURE
    && J(seqT.map((c) => c.method)) === J(['wallet_switchEthereumChain', 'wallet_addEthereumChain', 'wallet_switchEthereumChain', 'eth_signTypedData_v4'])
    && seqT.every((c) => c.focused === true), J(seqT.map((c) => [c.method, c.focused])));
  await waitNoHub();

  // ---- 4. AC3: site B without a gesture gets the dialog (the extension can open windows without a click)
  const bt = await b.newTab();
  check('site B loads through the gateway', (await openSite(bt, SITE_B)) === 'ok');
  await call(bt, 'b-load', 'eth_requestAccounts', []);
  await hubOf();
  const dialogTab = await hubTabNextTo(SITE_B);
  const r1 = await rejectDialog(bt, 'b-load');
  check('AC3 B on load (no click): the site dialog with B\'s identity, Allow disabled; Reject gives 4001', r1.dlg && has(r1.dlg.card, SITE_B.name, B.container) && r1.dlg.buttons[1].disabled === true
    && r1.res.error && r1.res.error.code === 4001, J(r1.res));
  check('the dialog (it may lead to the wallet\'s connect) is in a hub tab next to B', dialogTab.ok, J(dialogTab));
  await ev(bt, `(__e2e.next = () => __e2e.call('b-sim', 'eth_requestAccounts', []), document.getElementById('__e2e_btn').click(), 1)`);
  const r2 = await rejectDialog(bt, 'b-sim');
  check('a simulated element.click() is not a gesture: dialog, Reject gives 4001', r2.dlg && r2.res.error && r2.res.error.code === 4001, J(r2.res));
  await ev(bt, `(Object.defineProperty(Navigator.prototype, 'userActivation', { configurable: true, get: () => ({ isActive: true, hasBeenActive: true }) }),
    __e2e.next = () => __e2e.call('b-forged', 'eth_requestAccounts', []), document.getElementById('__e2e_btn').click(), navigator.userActivation.isActive)`);
  const r3 = await rejectDialog(bt, 'b-forged');
  check('a page that forges navigator.userActivation in its own world gets the dialog, not a grant', r3.dlg && r3.res.error && r3.res.error.code === 4001, J(r3.res));
  await call(bt, 'b-acc', 'eth_accounts');
  await clickCall(bt, 'b-sign', 'personal_sign', [msgHex, FAKE_ACCOUNT]);
  const bSign = await result(bt, 'b-sign');
  check('AC4 A\'s grant does not work for B: eth_accounts [], signing with A\'s account 4100', J((await result(bt, 'b-acc')).result) === '[]' && bSign.error && bSign.error.code === 4100
    && walletCalls('personal_sign') === 1, J(bSign));
  await waitNoHub();

  // ---- 5. A gesture connect once the wallet is connected: unfocused notice window, no dialog
  await ev(bt, `(__e2e.next = () => __e2e.call('b-conn', 'eth_requestAccounts', []).then(() => __e2e.call('b-after', 'eth_accounts')), 1)`);
  await b.click(bt.sessionId, '#__e2e_btn');
  const hub3 = await hubOf();
  const windows3 = await popupWindows();
  const shownB = await waitToast(hub3);
  const shownAt = Date.now();
  const bConn = await result(bt, 'b-conn');
  check('B (real click) is granted with no dialog; the notice shows B', J(bConn.result) === J([FAKE_ACCOUNT]) && shownB.log.cardShows === 0 && has(shownB.toast, SITE_B.name, B.container), J(bConn));
  const bAfter = await result(bt, 'b-after');
  check('B asks eth_accounts the moment the connect resolves: the new grant, no accountsChanged([]) flap (the snapshot goes out before the answer)',
    J(bAfter.result) === J([FAKE_ACCOUNT]) && !(await events(bt)).some(([e, d]) => e === 'accountsChanged' && J(d) === '[]'), J([bAfter, await events(bt)]));
  const closedB = await waitNoHub();
  const closeMs = Date.now() - shownAt;
  check('…in a hub window opened without focus, which closes about 5 s after the notice (no 15 s hold)', windows3.length === 1 && windows3[0].focused === false
    && closedB && closeMs < 10_000, `${J(windows3)} closed ${closeMs} ms after the notice`);

  // ---- 6. Revoke A from the extension popup; events reach only A
  const pop = await b.newTab();
  await b.navigate(pop, EXT + 'popup/popup.html');
  const revokeA = `button[data-origin="${originOf(SITE_A)}"]`;
  const listed = await until(() => ev(pop, `(() => { const t = document.getElementById('wallet-sites').textContent; return document.querySelector(${J(revokeA)}) && t.includes(${J(SITE_B.name)}) ? t : null; })()`));
  check('R3 the extension popup lists A and B (from the hub snapshot)', has(listed, SITE_A.name, SITE_B.name, A.container));
  const eventsB = (await events(bt)).length;
  await b.click(pop.sessionId, revokeA);
  const gotA = await until(async () => (await events(a)).some(([e, d]) => e === 'accountsChanged' && J(d) === '[]'), 30_000);
  await call(a, 'acc2', 'eth_accounts');
  const acc2 = await result(a, 'acc2');
  const gone = await until(() => ev(pop, `!document.querySelector(${J(revokeA)}) && document.getElementById('wallet-sites').textContent.includes(${J(SITE_B.name)})`), 20_000);
  check('R3 a revoke from the extension popup: A gets accountsChanged([]), eth_accounts [], the list drops A', gotA && J(acc2.result) === '[]' && gone, J(acc2));
  check('events go only to the matching origin: B got nothing from A\'s revoke', (await events(bt)).length === eventsB, J(await events(bt)));
  // Granted origins only: the revoke keeps A's own chain (X Layer since 3b), with no accounts.
  const snap = await sw(`chrome.storage.local.get(${J(SNAPSHOT_KEY)}).then((r) => Object.entries(r[${J(SNAPSHOT_KEY)}].perms).filter(([, e]) => e.accounts.length).map(([o]) => o))`);
  check('the snapshot no longer grants A', !snap.includes(originOf(SITE_A)) && snap.includes(originOf(SITE_B)), J(snap));
  await waitNoHub();
  await call(a, 'a-again', 'eth_requestAccounts', []);
  const again = await rejectDialog(a, 'a-again');
  check('AC4 after the revoke, A asks again without a click: the site dialog, not the old grant; Reject gives 4001', again.dlg && has(again.dlg.card, SITE_A.name)
    && again.res.error && again.res.error.code === 4001, J(again.res));
  await waitNoHub();

  // ---- 7. Closing the hub window rejects with 4001
  await clickCall(bt, 'b-sign2', 'personal_sign', [msgHex, FAKE_ACCOUNT]);
  const hub4 = await hubOf();
  await waitCard(hub4);
  await b.send('Target.closeTarget', { targetId: hub4.targetId });
  const bSign2 = await result(bt, 'b-sign2', 15_000);
  check('R9 closing the signing window rejects the pending request with 4001 (zh + en text)', bSign2 && bSign2.error && bSign2.error.code === 4001 && bSign2.error.data.reason === 'closed'
    && has(bSign2.error.data.messages.zh, 'TapeKit') && walletCalls('personal_sign') === 1, J(bSign2));

  // ---- 8. Not-opened site; one provider per page with client.js; AC1
  const nt = await b.newTab();
  check('1.0.tape page loads (the gateway notice page)', (await openSite(nt, NOT_OPENED)) === 'ok');
  await clickCall(nt, 'n-conn', 'eth_requestAccounts', []);
  const nConn = await result(nt, 'n-conn');
  check('AC6 1.0.tape (not opened) is refused: 4100, status not-opened', nConn.error && nConn.error.code === 4100 && nConn.error.data && nConn.error.data.status === 'not-opened', J(nConn));
  const both = await b.newTab();
  await b.send('Page.addScriptToEvaluateOnNewDocument', { source: `document.addEventListener('DOMContentLoaded', () => { window.__clientRan = true; ${CLIENT} });` }, both.sessionId);
  check('site B with the bundled client.js too', (await openSite(both, SITE_B)) === 'ok');
  await call(both, 'acc3', 'eth_accounts');
  const annBoth = await ev(both, '__e2e.announced.filter((i) => i.rdns === "org.tapekit").length');
  check('with client.js on the page too, there is one TapeKit wallet and it is the extension\'s (B\'s account at once, no popup)', annBoth === 1 && await ev(both, 'window.__clientRan === true')
    && J((await result(both, 'acc3')).result) === J([FAKE_ACCOUNT]), `announced ${annBoth}`);
  check('AC1 the wallet "connect" was called exactly once in the whole run', connects() === 1, String(connects()));
  check('OKX focus rule: the fake wallet refused nothing (every connect and switch came from the active tab of a normal window; message signatures passed as in OKX)',
    refusedCalls().length === 0, J(refusedCalls()));

  // ---- 9. Safety net: the wallet dropped the hub, but the extension's copy still has its account. A's connect
  // with a click goes to the notice window (no prompt expected), whose hub must not call the wallet's connect
  // there (OKX would refuse it in silence): it answers 'needs-tab' and the request moves to a hub tab.
  await b.navigate(misc, `http://${HUB_HOST}/`);
  await until(() => ev(misc, `document.readyState === 'complete'`));
  await ev(misc, `(localStorage.setItem('tapekit-e2e-fake-wallet', JSON.stringify({ ...JSON.parse(localStorage.getItem('tapekit-e2e-fake-wallet')), connected: false })), 1)`);
  await waitNoHub();
  const net = await hubKindsDuring(async () => {
    await clickCall(a, 'net', 'eth_requestAccounts', []);
    return result(a, 'net');
  });
  check('safety net: with a stale copy the connect goes to the notice window, whose hub refuses to call the wallet there; it moves to a hub tab, where the wallet connects',
    J(net.value && net.value.result) === J([FAKE_ACCOUNT]) && connects() === 2 && refusedCalls().length === 0 && net.kinds.includes('popup') && net.kinds.includes('normal'), J({ net: net.value, kinds: net.kinds, connects: connects(), refused: refusedCalls() }));

  const hubSessions = new Set([...b.pages.values()].filter((p) => p.url.startsWith(HUB)).map((p) => p.sessionId));
  const hubErrors = b.errors.filter((e) => hubSessions.has(e.sessionId));
  check('no uncaught errors, console errors or CSP violations in any hub page', hubErrors.length === 0, J(hubErrors.slice(0, 5)));
} catch (e) {
  check('test script error', false, String((e && e.stack) || e));
} finally {
  await b.close();
  server.close();
  lookAlike.close();
  fs.rmSync(walletDir, { recursive: true, force: true });
}
await runEnableChecks({ root: ROOT, check });
const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
