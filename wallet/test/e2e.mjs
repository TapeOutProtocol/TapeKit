// End-to-end test of the wallet router's fallback channel (prd.md acceptance criteria, client script; the
// extension channel is e2e-extension.mjs). Real headless Chrome, the local gateway with the hub
// (sw-gateway/dev-server.mjs), mainnet read-only (site identities, read calls), a fake wallet in the hub, and
// wallet/client.js injected into site pages as if the owner had bundled it. User gestures are real CDP mouse
// input; element.click() is not one.
// The fake wallet is loaded as an extension (e2e-pages.mjs) because it applies OKX Wallet 4.19.0's focus rule
// with chrome.tabs/chrome.windows: connect, transaction and chain-switch calls from anything but the active tab
// of the focused normal window are refused without a prompt, while a plain personal_sign and typed data pass
// (research/manual-test.md). The TapeKit extension is not loaded. The fake's background also lists tabs, for the
// checks that the hub opens as a tab next to the site, or as a small popup window for a message signature (D-i).
// Run: npm run test:wallet:e2e   (needs Google Chrome and network; no keys, no transactions)
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import server from '../../sw-gateway/dev-server.mjs';
import { createKernel } from '../../kernel/src/index.js';
import { readNodes } from '../src/chains.js';
import { startBrowser, until, sleep } from './e2e-cdp.mjs';
import { writeFakeWalletExtension, tabsState, hubWindow, typedData, siweFor, permitData, cardOnScreen, CARD_LAYOUT, hiddenCallTx, MARKER, PAGE_HELPER, BINDING, FAKE_ACCOUNT, FAKE_SIGNATURE, FAKE_TX_HASH } from './e2e-pages.mjs';

// Mainnet sites, all checked with the kernel on 2026-10-08 (research/live-sites.md). Swap them here if one lapses.
const SITE_A = { name: '433.0.tape', label: '433-0' };
const SITE_B = { name: '11636.0.tape', label: '11636-0' };
const NOT_OPENED = { name: '1.0.tape', label: '1-0' };
const OTHER_ACCOUNT = '0x' + '11'.repeat(20);
// Block 0 hashes never change; read 2026-10-08 from bsc-dataseed.bnbchain.org and mainnet.base.org (eth_getBlockByNumber).
const GENESIS = { '0x38': '0x0d21840abff46b96c84b2ac9e10e4f5cdaeb5693cb665db62a2f3b02d2d57b5b', '0x2105': '0xf712aa9241cc24369b143cf6dce85f0902a9731e70d66818a3a5845b296c73dd' };
const CLIENT = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const OK_BTN = '#card .actions button:nth-child(2)';
const REJECT_BTN = '#card .actions button:nth-child(1)';
const J = JSON.stringify;
// A sandboxed frame (opaque origin, like the preview viewer) that runs the client itself, then reports.
const SANDBOXED_DOC = `<script>window.__e2eInjected = true;\n${CLIENT.replaceAll('</', '<\\/')}</script>`
  + '<script>parent.postMessage({ probe: 1, injected: window.__e2eInjected === true, tapekit: typeof window.tapekit }, "*");</script>';

const results = [];
const check = (name, ok, detail = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`); };
const has = (text, ...parts) => typeof text === 'string' && parts.every((p) => text.toLowerCase().includes(String(p).toLowerCase()));


await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const HUB_HOST = `localhost:${PORT}`;
const HUB = `http://${HUB_HOST}/.tape/wallet/`;
const siteUrl = (site) => `http://${site.label}.localhost:${PORT}/`;
// A page with a site-shaped name on another gateway (another port): the hub must ignore it.
const lookAlike = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end('<!doctype html><title>look-alike</title><p>look-alike'); });
await new Promise((r) => lookAlike.listen(0, '127.0.0.1', r));

const walletDir = writeFakeWalletExtension(fs.mkdtempSync(path.join(os.tmpdir(), 'tapekit-fake-wallet-')), HUB_HOST);
const b = await startBrowser({ pageScripts: [MARKER, CLIENT], binding: BINDING, extensionPath: walletDir });
const ev = (page, expr) => b.evaluate(page.sessionId, expr);
const walletCalls = () => b.bindingCalls.map((c) => JSON.parse(c.payload));
const connects = () => walletCalls().filter((c) => c.method === 'eth_requestAccounts').length;
const signs = () => walletCalls().filter((c) => c.method === 'personal_sign');
const refusedCalls = () => walletCalls().filter((c) => c.refused);
const tabsNow = () => tabsState(b, b.extensionId);
const tabAt = (tabs, prefix) => tabs.find((t) => t.url.startsWith(prefix)) || null;
const windowOf = (hub, site) => hubWindow(b, b.extensionId, hub, site);
const popupsOf = (opener) => [...b.pages.values()].filter((p) => p.openerId === opener.targetId);
const openHubOf = (opener) => popupsOf(opener).filter((p) => !p.closed && p.url.startsWith(HUB)).at(-1);
const HUB_STATE = `(() => { const c = document.getElementById('card'), t = document.getElementById('toast');
  return { card: c.hidden ? null : c.textContent, buttons: [...c.querySelectorAll('.actions button')].map((x) => ({ text: x.textContent, disabled: x.disabled })),
    focus: document.activeElement && document.activeElement.textContent, toast: t.hidden ? null : t.textContent,
    sites: document.getElementById('sites').textContent, log: window.__hubLog }; })()`;

async function openSite(page, site) {
  await b.navigate(page, siteUrl(site));
  const loaded = await until(() => ev(page, `!!(navigator.serviceWorker && navigator.serviceWorker.controller && document.body && !document.getElementById('msg'))`), 90_000);
  return loaded ? until(() => ev(page, PAGE_HELPER)) : null;
}
const call = (page, key, method, params) => ev(page, `(__e2e.call(${J(key)}, ${J(method)}, ${J(params)}), 1)`);
async function clickCall(page, key, method, params) {
  await ev(page, `(__e2e.next = () => __e2e.call(${J(key)}, ${J(method)}, ${J(params)}), 1)`);
  await b.click(page.sessionId, '#__e2e_btn');
}
const result = (page, key, ms = 60_000) => until(() => ev(page, `__e2e.results[${J(key)}] || null`), ms);
const events = (page) => ev(page, '__e2e.events');
async function hubOf(opener) {
  const hub = await until(() => openHubOf(opener));
  if (hub) await until(() => ev(hub, `document.readyState === 'complete' && !!window.__hubLog`));
  return hub;
}
const hubState = (hub) => ev(hub, HUB_STATE);
const waitCard = (hub) => until(async () => { const s = await hubState(hub); return s.card ? s : null; }, 60_000);
const waitHubClosed = (opener) => until(() => !openHubOf(opener), 20_000);
async function pressContinue(hub) {
  await until(async () => (await ev(hub, `document.querySelector(${J(OK_BTN)}).disabled`)) === false, 5000);
  await b.click(hub.sessionId, OK_BTN);
}

try {
  // ---- References read in Node with the same kernel (mainnet, read-only)
  const kernel = createKernel();
  const ref = {};
  for (const s of [SITE_A, SITE_B, NOT_OPENED]) ref[s.name] = await kernel.resolve(s.name, { fresh: true });
  const A = ref[SITE_A.name], B = ref[SITE_B.name];
  check('reference: A and B are ok, 1.0.tape is not-opened (Node kernel, mainnet)', A.status === 'ok' && B.status === 'ok' && ref[NOT_OPENED.name].status === 'not-opened',
    `${A.status}/${B.status}/${ref[NOT_OPENED.name].status} at BNB block ${Number(A.block)}`);

  // ---- 0. Pages that must not get the wallet: the gateway root
  const misc = await b.newTab();
  await b.navigate(misc, `http://${HUB_HOST}/`);
  await until(() => ev(misc, `document.readyState === 'complete'`));
  const rootHelper = await ev(misc, PAGE_HELPER);
  const rootAnn = await ev(misc, '__e2e.announced.map((i) => i.rdns)');
  check('AC8 the gateway root gets no TapeKit wallet although the client script runs there', rootHelper === 'no-wallet' && !rootAnn.includes('org.tapekit') && await ev(misc, 'window.__e2eInjected === true'), J(rootAnn));

  // ---- 1. Site A: local answers, no window
  const a = await b.newTab();
  check('site A loads through the gateway with the client', (await openSite(a, SITE_A)) === 'ok');
  const annA = await ev(a, '__e2e.announced');
  check('R2 A: EIP-6963 announces "TapeKit" (org.tapekit); window.ethereum untouched', annA.some((i) => i.rdns === 'org.tapekit' && i.name === 'TapeKit')
    && await ev(a, `window.ethereum === undefined && window.tapekit.wallet.isTapeKit === true`), J(annA.map((i) => i.rdns)));
  for (const [k, m, p] of [['cid', 'eth_chainId'], ['acc0', 'eth_accounts'], ['ethsign', 'eth_sign', [FAKE_ACCOUNT, '0x00']], ['g0', 'eth_getBlockByNumber', ['0x0', false]]]) await call(a, k, m, p);
  const [cid, acc0, ethsign, g0] = [await result(a, 'cid'), await result(a, 'acc0'), await result(a, 'ethsign'), await result(a, 'g0')];
  check('A before the hub: eth_chainId 0x38 from the host label, eth_accounts []', cid.result === '0x38' && J(acc0.result) === '[]', J([cid, acc0]));
  check('AC6 A: eth_sign (not in the list) is refused with 4200', ethsign.error && ethsign.error.code === 4200, J(ethsign));
  check('A: read calls go straight to a BNB Chain node (block 0 hash)', g0.result && g0.result.hash === GENESIS['0x38'], g0.result && g0.result.hash);
  check('A: none of that opened a window', popupsOf(a).length === 0);

  // ---- 2. AC1 + AC2: A connects inside a real click. The hub cannot see that click (pop-ups may be allowed, or the
  // click banked), so a site's first connect in script mode always gets the Allow / Reject dialog (audit
  // 2026-10-18 issue 3, option B); after Allow there is no separate notice.
  await clickCall(a, 'conn1', 'eth_requestAccounts', []);
  const hub1 = await hubOf(a);
  const tabs1 = await tabsNow();
  const [hubTab, aTab] = [tabAt(tabs1, HUB), tabAt(tabs1, siteUrl(SITE_A))];
  check('a real click opens the hub as the active tab of a normal window, right after site A\'s tab (not a popup window)', !!hub1 && hubTab && aTab
    && hubTab.windowType === 'normal' && hubTab.windowId === aTab.windowId && hubTab.active && hubTab.index === aTab.index + 1, J({ hubTab, aTab }));
  const dlg1 = await waitCard(hub1);
  check('issue 3 (option B): A\'s first connect, even inside a real click, gets the Allow / Reject dialog with A\'s name, processor and container; Allow starts disabled, focus on Reject; the wallet is not asked yet',
    dlg1 && has(dlg1.card, SITE_A.name, A.cpuName, A.container) && dlg1.buttons[1].disabled === true && dlg1.focus === dlg1.buttons[0].text && connects() === 0, dlg1 && dlg1.card.slice(0, 200));
  check('no Service Worker on the gateway root (checked from the hub)', (await ev(hub1, 'navigator.serviceWorker.getRegistrations().then((r) => r.length)')) === 0);
  await pressContinue(hub1);   // the dialog's second button: Allow
  const conn1 = await result(a, 'conn1');
  const shown = await hubState(hub1).catch(() => null);
  check('AC2 after Allow, A gets the address; then the one-time wallet connection; no 5-second notice in script mode', J(conn1 && conn1.result) === J([FAKE_ACCOUNT])
    && connects() === 1 && !!shown && shown.log.toastShows === 0, J({ conn1, log: shown && shown.log }));
  check('R3 the hub lists A under authorized sites', shown && has(shown.sites, SITE_A.name, A.container), shown && shown.sites);
  check('the hub tab then closes by itself', !!(await waitHubClosed(a)));
  const backA = await until(async () => { const t = tabAt(await tabsNow(), siteUrl(SITE_A)); return t && t.active ? t : null; }, 5000);
  check('…and the browser is back on site A\'s tab', !!backA, J(backA));
  await call(a, 'acc1', 'eth_accounts');
  const acc1 = await result(a, 'acc1');
  check('A: accountsChanged event and eth_accounts now give the address, still answered locally', J(acc1.result) === J([FAKE_ACCOUNT])
    && (await events(a)).some(([e, d]) => e === 'accountsChanged' && J(d) === J([FAKE_ACCOUNT])) && !openHubOf(a), J(await events(a)));

  // ---- 3. AC5: signing on A goes card → Continue → wallet; forged replies are ignored. A message signature
  // opens the hub in a small popup window, not a tab (D-i, design §10.3 2026-10-17).
  const text = `TapeKit e2e: sign in to ${SITE_A.name}`;
  const msgHex = '0x' + Buffer.from(text).toString('hex');
  await clickCall(a, 'sign1', 'personal_sign', [msgHex, FAKE_ACCOUNT]);
  const hub2 = await hubOf(a);
  const card = await waitCard(hub2);
  const win2 = await windowOf(hub2, a);
  check('D-i personal_sign opens the hub in a small popup window: chrome.windows type popup, its own CDP window of about 400 px, not a tab',
    win2.type === 'popup' && win2.ownWindow && win2.width <= 500, J(win2));
  const wasDisabled = await ev(hub2, `document.querySelector(${J(OK_BTN)}).disabled`);
  check('AC5 the card shows A\'s identity and the message before the wallet sees anything', card && has(card.card, SITE_A.name, A.cpuName, A.container, text)
    && !walletCalls().some((c) => c.method === 'personal_sign'), card && card.card.slice(0, 200));
  check('D-i the message card has no chain row (a personal message is not chain-bound; typed data keeps it, step 4)', card && !has(card.card, 'BNB Smart Chain')
    && !card.card.includes('(0x38)'), card && card.card.slice(0, 300));
  check('clickjacking: Continue starts disabled, focus on Reject', wasDisabled === true && card.focus === card.buttons[0].text, J(card && card.buttons) + ' focus=' + (card && card.focus));
  await b.click(hub2.sessionId, OK_BTN);   // too early: inside the 600 ms gate
  await ev(a, `(() => { const forged = (id) => ({ channel: 'tapekit-wallet/1', type: 'response', id, result: '0xforged' });
    for (let id = 1; id < 60; id++) window.postMessage(forged(id), '*');
    window.postMessage({ channel: 'tapekit-wallet/1', type: 'event', event: 'accountsChanged', data: ['${OTHER_ACCOUNT}'] }, '*');
    const f = document.createElement('iframe'); f.sandbox = 'allow-scripts';
    f.srcdoc = '<script>for (let id = 1; id < 60; id++) parent.postMessage({ channel: "tapekit-wallet/1", type: "response", id, result: "0xframe" }, "*");<\\/script>';
    document.documentElement.append(f); return 1; })()`);
  await sleep(500);
  const early = await ev(a, `__e2e.results.sign1 || null`);
  check('clickjacking: a click on Continue inside the 600 ms gate does nothing', wasDisabled === true && early === null && !walletCalls().some((c) => c.method === 'personal_sign'), J(early));
  await pressContinue(hub2);
  const sign1 = await result(a, 'sign1');
  const fwd = signs();
  check('AC5 after Continue the wallet signs and A gets its result unchanged', sign1.result === FAKE_SIGNATURE && fwd.length === 1 && J(fwd[0].params) === J([msgHex, FAKE_ACCOUNT]), J(sign1));
  check('D-i in that popup window the fake, like OKX, lets the plain personal_sign through although its focus check fails there; no chain switch',
    fwd.length === 1 && fwd[0].focused === false && fwd[0].refused === false && refusedCalls().length === 0 && !walletCalls().some((c) => c.method === 'wallet_switchEthereumChain'), J(fwd[0]));
  check('forged replies from the page itself and from an opaque-origin frame are ignored', sign1.result === FAKE_SIGNATURE
    && !(await events(a)).some(([, d]) => J(d).includes(OTHER_ACCOUNT)));
  check('D-i the popup window closes by itself when done', !!(await waitHubClosed(a)));

  // ---- 3a. The card keeps the requesting site on screen (audit 2026-10-18 issue 1): a sign-in message for another
  // site in the small window (400×580) and a token Permit in a tab (1280×650). Rejected, so nothing is signed.
  async function cardLayout(key, method, params, size) {
    b.nextPageSize(size);
    await clickCall(a, key, method, params);
    const hub = await hubOf(a);
    await waitCard(hub);
    const layout = await ev(hub, CARD_LAYOUT);
    await b.click(hub.sessionId, REJECT_BTN);
    const res = await result(a, key);
    await waitHubClosed(a);
    return { layout, rejected: !!res.error && res.error.code === 4001 };
  }
  const siweCard = await cardLayout('siwe', 'personal_sign', ['0x' + Buffer.from(siweFor('app.uniswap.org')).toString('hex'), FAKE_ACCOUNT], { width: 400, height: 580 });
  check('issue 1: a 10-line sign-in message for another site at 400×580: title, identity rows and the warning on screen; no header, no site list',
    cardOnScreen(siweCard.layout, [400, 580], true) && siweCard.rejected, J(siweCard));
  const permitCard = await cardLayout('permit', 'eth_signTypedData_v4', [FAKE_ACCOUNT, permitData(56)], { width: 1280, height: 650 });
  check('issue 1: a Permit card at 1280×650: title and identity rows on screen; no header, no site list',
    cardOnScreen(permitCard.layout, [1280, 650], false) && permitCard.rejected && signs().length === 1, J(permitCard));

  // ---- 3b. A transaction (audit 2026-10-18 issues 2 and 7): the card shows the call hidden in `input`, and the
  // wallet gets exactly the rebuilt transaction the card showed, from a hub tab (OKX gates transactions).
  const txCase = hiddenCallTx('0x38');
  await clickCall(a, 'tx1', 'eth_sendTransaction', [txCase.sent]);
  const hubTx = await hubOf(a);
  const txCard = await waitCard(hubTx);
  const txWin = await windowOf(hubTx, a);
  await pressContinue(hubTx);
  const tx1 = await result(a, 'tx1');
  const sentTx = walletCalls().filter((c) => c.method === 'eth_sendTransaction');
  check('issue 2: the transaction card shows the call hidden in input (68 bytes, selector, recipient) in a hub tab, not a popup window',
    txCard && has(txCard.card, txCase.token, txCase.selector, String(txCase.bytes), 'BNB Smart Chain (0x38)') && txWin.type === 'normal', J({ card: txCard && txCard.card.slice(0, 400), txWin }));
  check('issue 2: after Continue the wallet gets exactly the rebuilt transaction the card showed (data, the site\'s chainId; no input, gas, type or nonce), from a focused tab; the site gets the hash',
    tx1.result === FAKE_TX_HASH && sentTx.length === 1 && J(sentTx[0].params) === J([txCase.expected]) && sentTx[0].focused === true && sentTx[0].refused === false, J({ tx1, sentTx }));
  await waitHubClosed(a);

  // ---- 4. AC6 wrong signer, AC7 chains
  await clickCall(a, 'sign2', 'personal_sign', [msgHex, OTHER_ACCOUNT]);
  const sign2 = await result(a, 'sign2');
  check('AC6 signing with an address A was not given is refused with 4100', sign2.error && sign2.error.code === 4100 && signs().length === 1, J(sign2));
  await waitHubClosed(a);
  await clickCall(a, 'sw196', 'wallet_switchEthereumChain', [{ chainId: '0xc4' }]);
  const sw196 = await result(a, 'sw196');
  const answeredAt = Date.now();
  await call(a, 'cid196', 'eth_chainId');
  check('AC7 A switches to X Layer: null, chainChanged, eth_chainId 0xc4', sw196.result === null && (await result(a, 'cid196')).result === '0xc4'
    && (await events(a)).some(([e, d]) => e === 'chainChanged' && d === '0xc4'), J(sw196));
  const idleClosed = await waitHubClosed(a);
  const idleMs = Date.now() - answeredAt;
  check('the hub tab closes about 3 s after its last answer (the 15 s first-request hold ends with the first request)', !!idleClosed && idleMs < 6000, `${idleMs} ms`);
  // Typed data is chain-bound: the wallet (on BNB Chain) must move to X Layer. With the script it opens a tab,
  // since a page has no second click to move it to a tab later.
  const mark = walletCalls().length;
  await clickCall(a, 'typed3', 'eth_signTypedData_v4', [FAKE_ACCOUNT, typedData(196)]);
  const hub3 = await hubOf(a);
  const card3 = await waitCard(hub3);
  const tabs3 = await tabsNow();
  const [t3, a3] = [tabAt(tabs3, HUB), tabAt(tabs3, siteUrl(SITE_A))];
  check('typed data (it may need a chain switch) opens the hub as a tab next to A, not a popup window', t3 && a3 && t3.windowType === 'normal'
    && t3.windowId === a3.windowId && t3.active && t3.index === a3.index + 1, J({ t3, a3 }));
  await pressContinue(hub3);
  const typed3 = await result(a, 'typed3');
  const seq = walletCalls().slice(mark).filter((c) => c.method.startsWith('wallet_') || c.method.startsWith('eth_sign') || c.method === 'personal_sign');
  const add = seq.find((c) => c.method === 'wallet_addEthereumChain');
  check('AC7 typed data on X Layer: the wallet lacks 0xc4, TapeKit adds it with its own params, switches, then signs', typed3.result === FAKE_SIGNATURE
    && J(seq.map((c) => c.method)) === J(['wallet_switchEthereumChain', 'wallet_addEthereumChain', 'wallet_switchEthereumChain', 'eth_signTypedData_v4'])
    && add.params[0].chainId === '0xc4' && J(add.params[0].rpcUrls) === J(readNodes('0xc4')) && has(card3.card, 'X Layer (0xc4)'), J(seq.map((c) => c.method)));
  // The user goes back to A's tab while that hub tab is still open: a message signature goes to it (one hub at
  // a time, no popup window next to it) and brings it to the front (the user has to see the card).
  const openHub = openHubOf(a);
  await b.send('Target.activateTarget', { targetId: a.targetId });
  const onA = await until(async () => { const t = tabAt(await tabsNow(), siteUrl(SITE_A)); return t && t.active ? t : null; }, 5000);
  await clickCall(a, 'sign3', 'personal_sign', [msgHex, FAKE_ACCOUNT]);
  const hub3b = await hubOf(a);
  await waitCard(hub3b);
  const front = tabAt(await tabsNow(), HUB);
  check('a message signature sent while a hub tab is open goes to that tab and brings it to the front (no second hub)', !!openHub && !!onA && hub3b.targetId === openHub.targetId
    && front && front.active && front.windowType === 'normal', J({ reused: !!openHub && hub3b.targetId === openHub.targetId, onA: !!onA, front }));
  await pressContinue(hub3b);
  const sign3 = await result(a, 'sign3');
  check('…and is signed there', sign3.result === FAKE_SIGNATURE && signs().length === 2, J(sign3));
  await clickCall(a, 'sw8453', 'wallet_switchEthereumChain', [{ chainId: '0x2105' }]);
  await result(a, 'sw8453');
  await call(a, 'cid8453', 'eth_chainId');
  await call(a, 'g8453', 'eth_getBlockByNumber', ['0x0', false]);
  const g8453 = await result(a, 'g8453');
  check('AC7 A switches to Base: eth_chainId 0x2105 and reads go to a Base node', (await result(a, 'cid8453')).result === '0x2105' && g8453.result && g8453.result.hash === GENESIS['0x2105'], g8453.result && g8453.result.hash);
  // D-i: A is on Base and the wallet on X Layer. A message signature is not chain-bound: a popup window, no
  // switch. While its card is open, typed data for Base (it would need a switch) reaches that popup window's hub
  // without a click: the hub refuses it with needs-tab instead of sending the switch OKX would fake there.
  await waitHubClosed(a);
  const markP = walletCalls().length;
  await clickCall(a, 'pmsg', 'personal_sign', [msgHex, FAKE_ACCOUNT]);
  const hubP = await hubOf(a);
  await waitCard(hubP);
  const winP = await windowOf(hubP, a);
  await call(a, 'ptyped', 'eth_signTypedData_v4', [FAKE_ACCOUNT, typedData(8453)]);
  await pressContinue(hubP);
  const [pmsg, ptyped] = [await result(a, 'pmsg'), await result(a, 'ptyped')];
  const afterP = walletCalls().slice(markP);
  check('D-i personal_sign with A on Base and the wallet on X Layer: a popup window, signed with no chain switch', winP.type === 'popup' && pmsg.result === FAKE_SIGNATURE
    && afterP.some((c) => c.method === 'personal_sign') && !afterP.some((c) => c.method.startsWith('wallet_')), J({ winP, pmsg, calls: afterP.map((c) => c.method) }));
  check('D-i the popup window\'s hub refuses typed data that needs a chain switch: 4900 needs-tab (zh + en), no switch sent, nothing signed',
    ptyped.error && ptyped.error.code === 4900 && ptyped.error.data.reason === 'needs-tab' && has(ptyped.error.data.messages.zh, '标签页') && has(ptyped.error.data.messages.en, 'tab')
    && !afterP.some((c) => c.method === 'wallet_switchEthereumChain' || c.method === 'eth_signTypedData_v4'), J(ptyped));
  await clickCall(a, 'sw1', 'wallet_switchEthereumChain', [{ chainId: '0x1' }]);
  const sw1 = await result(a, 'sw1');
  await clickCall(a, 'sw56', 'wallet_switchEthereumChain', [{ chainId: '0x38' }]);
  await result(a, 'sw56');
  await call(a, 'cid56', 'eth_chainId');
  check('AC7 an unsupported chain gives 4902; back to BNB Chain gives 0x38', sw1.error && sw1.error.code === 4902 && (await result(a, 'cid56')).result === '0x38', J(sw1));

  // ---- 5. Closing the hub while a card is open rejects with 4001
  await clickCall(a, 'sign4', 'personal_sign', [msgHex, FAKE_ACCOUNT]);
  const hub4 = await hubOf(a);
  await waitCard(hub4);
  await b.send('Target.closeTarget', { targetId: hub4.targetId });
  const sign4 = await result(a, 'sign4', 10_000);
  check('R9 closing the hub rejects the pending request with 4001 (zh + en text)', sign4 && sign4.error.code === 4001 && has(sign4.error.data.messages.zh, 'TapeKit')
    && signs().length === 3, J(sign4));

  // ---- 6. Site B: no gesture, the site dialog, and A's grant is not B's
  const bt = await b.newTab();
  check('site B loads through the gateway with the client', (await openSite(bt, SITE_B)) === 'ok');
  await call(bt, 'b-load', 'eth_requestAccounts', []);
  const bLoad = await result(bt, 'b-load');
  check('AC3 B on load (no click): no popup, 4100 asking for a click (zh + en)', bLoad.error && bLoad.error.code === 4100 && has(bLoad.error.data.messages.zh, '请点网站上的按钮再试')
    && has(bLoad.error.data.messages.en, 'click') && popupsOf(bt).length === 0, J(bLoad.error));
  await ev(bt, `(__e2e.next = () => __e2e.call('b-sim', 'eth_requestAccounts', []), document.getElementById('__e2e_btn').click(), 1)`);
  const bSim = await result(bt, 'b-sim');
  check('a simulated element.click() is not a gesture: 4100, no popup', bSim.error && bSim.error.code === 4100 && popupsOf(bt).length === 0, J(bSim));
  await clickCall(bt, 'b-open', 'wallet_switchEthereumChain', [{ chainId: '0x38' }]);
  await result(bt, 'b-open');
  await call(bt, 'b-conn', 'eth_requestAccounts', []);   // hub already open, no click
  const hubB = await hubOf(bt);
  const dlg = await waitCard(hubB);
  check('AC3 with the hub open, B (no click) gets the site dialog: B identity, focus on Reject, Allow disabled', dlg && has(dlg.card, SITE_B.name, B.container)
    && dlg.focus === dlg.buttons[0].text && dlg.buttons[1].disabled === true, dlg && J(dlg.buttons));
  await b.click(hubB.sessionId, REJECT_BTN);
  const bConn = await result(bt, 'b-conn');
  await call(bt, 'b-acc', 'eth_accounts');
  check('AC3 Reject gives 4001 and B has no address', bConn.error && bConn.error.code === 4001 && J((await result(bt, 'b-acc')).result) === '[]', J(bConn));
  await clickCall(bt, 'b-sign', 'personal_sign', [msgHex, FAKE_ACCOUNT]);
  const bSign = await result(bt, 'b-sign');
  check('AC4 A\'s grant does not work for B: signing with A\'s account gives 4100', bSign.error && bSign.error.code === 4100 && signs().length === 3, J(bSign));
  // Audit 2026-10-18 issue 3, option B: a banked click, no extension. B opens a blank window during an unrelated
  // click and, once that click's activation is gone (5 s), sends it to the hub and asks for the address. Before,
  // that first request counted as the click and B got the address with only the notice.
  await waitHubClosed(bt);
  await ev(bt, `(__e2e.next = () => { window.__bank = window.open('about:blank', 'banked', 'popup,width=400,height=640'); }, 1)`);
  await b.click(bt.sessionId, '#__e2e_btn');
  await sleep(6000);
  await ev(bt, `(() => { const hubOrigin = ${J(`http://${HUB_HOST}`)}; window.__banked = [];
    addEventListener('message', (e) => {
      if (e.source !== __bank || e.origin !== hubOrigin || !e.data) return;
      if (e.data.type === 'ready') __bank.postMessage({ channel: 'tapekit-wallet/1', type: 'request', id: 1, method: 'eth_requestAccounts', params: [] }, hubOrigin);
      if (e.data.type === 'response') __banked.push(e.data);
    });
    __bank.location = ${J(HUB)} + '#origin=' + encodeURIComponent(location.origin); return 1; })()`);
  const bankHub = await hubOf(bt);
  const bankedAt = await until(async () => {
    const reply = await ev(bt, `__banked[0] || null`);
    if (reply) return { reply };
    const st = await hubState(bankHub).catch(() => ({}));
    return st.card ? { card: st.card } : null;
  }, 60_000);
  if (bankedAt && bankedAt.card) await b.click(bankHub.sessionId, REJECT_BTN);
  const banked = bankedAt && bankedAt.reply ? bankedAt.reply : await until(() => ev(bt, `__banked[0] || null`), 30_000);
  await call(bt, 'b-acc2', 'eth_accounts');
  check('issue 3 (option B): a banked click through the script channel gets the Allow / Reject dialog, not the address; Reject gives 4001, B still has no address',
    !!bankedAt && !!bankedAt.card && has(bankedAt.card, SITE_B.name) && !!banked && !!banked.error && banked.error.code === 4001 && J((await result(bt, 'b-acc2')).result) === '[]',
    J({ card: bankedAt && bankedAt.card && bankedAt.card.slice(0, 120), banked }));
  await waitHubClosed(bt);

  // ---- 7. AC4: revoke A, then A is handled from scratch
  await waitHubClosed(a);
  await clickCall(a, 'rev', 'wallet_revokePermissions', [{ eth_accounts: {} }]);
  const rev = await result(a, 'rev');
  await call(a, 'acc2', 'eth_accounts');
  check('AC4 A revokes: null, accountsChanged([]), eth_accounts []', rev.result === null && J((await result(a, 'acc2')).result) === '[]'
    && (await events(a)).some(([e, d]) => e === 'accountsChanged' && J(d) === '[]'), J(rev));
  await call(a, 'conn2', 'eth_requestAccounts', []);   // hub still open, no click
  const hub5 = await hubOf(a);
  const dlgA = await waitCard(hub5);
  await b.click(hub5.sessionId, REJECT_BTN);
  const conn2 = await result(a, 'conn2');
  check('AC4 after the revoke, A without a click is asked again; Reject gives 4001', dlgA && has(dlgA.card, SITE_A.name) && conn2.error && conn2.error.code === 4001, J(conn2));
  await waitHubClosed(a);
  await clickCall(a, 'conn3', 'eth_requestAccounts', []);
  const hub6 = await hubOf(a);
  const again = await waitCard(hub6);
  await pressContinue(hub6);
  const conn3 = await result(a, 'conn3');
  check('AC4 after the revoke, A with a real click gets the Allow / Reject dialog again (the script channel never counts a click); Allow grants it, the wallet is not asked again',
    J(conn3.result) === J([FAKE_ACCOUNT]) && again && has(again.card, SITE_A.name) && connects() === 1, J(conn3));

  // ---- 8. AC6: a site that is not opened is refused
  const nt = await b.newTab();
  check('1.0.tape page loads (the gateway notice page, client injected)', (await openSite(nt, NOT_OPENED)) === 'ok');
  await clickCall(nt, 'n-conn', 'eth_requestAccounts', []);
  const nConn = await result(nt, 'n-conn');
  check('AC6 1.0.tape (not opened) is refused: 4100, status not-opened', nConn.error && nConn.error.code === 4100 && nConn.error.data && nConn.error.data.status === 'not-opened', J(nConn));
  check('AC1 the wallet "connect" was called exactly once in the whole run', connects() === 1, String(connects()));
  check('OKX focus rule: the fake wallet refused nothing (every connect and switch came from the active tab of a normal window; message signatures passed as in OKX)',
    refusedCalls().length === 0, J(refusedCalls()));

  // ---- 9. AC8: frames, framing the hub, other origins
  const frames = await ev(a, `new Promise((done) => {
    const out = {};
    addEventListener('message', (e) => { if (e.data && e.data.probe) out.sandboxed = e.data; });
    const same = document.createElement('iframe'); same.src = '/';
    same.onload = () => setTimeout(() => { out.same = { injected: same.contentWindow.__e2eInjected === true, tapekit: typeof same.contentWindow.tapekit }; }, 500);
    const box = document.createElement('iframe'); box.sandbox = 'allow-scripts';
    box.srcdoc = ${J(SANDBOXED_DOC)};
    document.documentElement.append(same, box);
    setTimeout(() => done(out), 8000);
  })`);
  check('AC8 frames inside a site get no TapeKit wallet although the client runs in them (same-origin frame, sandboxed frame)', frames.same && frames.same.injected
    && frames.same.tapekit === 'undefined' && frames.sandboxed && frames.sandboxed.injected && frames.sandboxed.tapekit === 'undefined', J(frames));
  // Audit 2026-10-18 issue 6: on a site host the hub's path is the gateway's. With A's Service Worker installed,
  // /.tape/wallet/ there is a script-free notice naming the real hub, never the site's own file or a hub.
  await b.navigate(misc, siteUrl(SITE_A) + '.tape/wallet/');
  await until(() => ev(misc, `document.readyState === 'complete' && !!navigator.serviceWorker.controller`));
  const reserved = await ev(misc, `({ text: document.body.innerText, scripts: document.scripts.length, hub: !!window.__hubLog })`);
  check('issue 6: /.tape/wallet/ on a site host (through its Service Worker) is the gateway\'s notice naming the real hub, not a site file or a hub',
    has(reserved.text, HUB) && (has(reserved.text, 'TapeKit 钱包不在这个地址') || has(reserved.text, 'The TapeKit wallet is not at this address')) && reserved.scripts === 0 && !reserved.hub, J(reserved));
  // The look-alike page sends no CSP, so only the hub's own frame-ancestors can stop it framing the hub
  // (a site page's frame-src would already refuse an http hub). The gateway root frame is the control.
  await b.navigate(misc, `http://${SITE_A.label}.localhost:${lookAlike.address().port}/`);
  await until(() => ev(misc, `document.readyState === 'complete'`));
  const framesBefore = b.frames.length;
  await ev(misc, `(() => { for (const src of [${J(`http://${HUB_HOST}/`)}, ${J(HUB)}]) { const f = document.createElement('iframe'); f.src = src; document.body.append(f); } return 1; })()`);
  await sleep(2500);
  const tree = await b.send('Page.getFrameTree', {}, misc.sessionId);
  const kids = (tree.frameTree.childFrames || []).map((c) => ({ url: c.frame.url, unreachable: c.frame.unreachableUrl || null }));
  const docs = [];
  for (const f of b.frames.slice(framesBefore)) docs.push(await b.evaluate(f.sessionId, 'location.href').catch((e) => 'eval failed: ' + e.message));
  const control = docs.includes(`http://${HUB_HOST}/`) || kids.some((k) => k.url === `http://${HUB_HOST}/`);
  const hubLoaded = docs.some((u) => u.startsWith(HUB)) || kids.some((k) => k.url.startsWith(HUB) && !k.unreachable);
  const refused = docs.some((u) => u.startsWith('chrome-error:')) || kids.some((k) => (k.unreachable || '').startsWith(HUB));
  check('AC8 the hub refuses to be framed (frame-ancestors none); the gateway root frame loads as a control', control && refused && !hubLoaded, J({ kids, docs }));
  await ev(misc, `(delete window.__e2e, ${PAGE_HELPER})`);
  await ev(misc, `(__e2e.next = () => { window.__evil = { got: [] }; const w = window.open(${J(HUB)} + '#origin=' + encodeURIComponent(location.origin), 'look-alike', 'popup,width=400,height=640');
    __evil.w = w; addEventListener('message', (e) => { if (e.source === w) __evil.got.push(e.data); }); }, 1)`);
  await b.click(misc.sessionId, '#__e2e_btn');
  const evilHub = await hubOf(misc);
  await until(() => ev(evilHub, `document.getElementById('wallet').textContent.includes('OKX')`));
  await ev(misc, `(__evil.w.postMessage({ channel: 'tapekit-wallet/1', type: 'request', id: 1, method: 'eth_requestAccounts', params: [] }, ${J(`http://${HUB_HOST}`)}),
    __evil.w.postMessage({ channel: 'tapekit-wallet/1', type: 'request', id: 2, method: 'eth_chainId', params: [] }, ${J(`http://${HUB_HOST}`)}), 1)`);
  await sleep(3000);
  const evil = await ev(misc, '__evil.got');
  const evilLog = await ev(evilHub, 'window.__hubLog');
  check('AC8 the hub ignores a site-shaped page from another gateway: no ready, no answer, no card', J(evil) === '[]' && evilLog.cardShows === 0 && evilLog.toastShows === 0 && connects() === 1, J({ evil, evilLog }));
  await b.send('Target.closeTarget', { targetId: evilHub.targetId }).catch(() => {});

  // ---- 10. Control: the fake's OKX rule is live in this run. A hub opened the old way, as a popup window and
  // without the '&window=popup' hint (a site that does not say so only hurts itself): the hub thinks it is in a
  // tab. Typed data needs a switch (the wallet is on X Layer from step 4, A on BNB Chain); the fake answers it
  // null and does not switch, as OKX does in a popup window, and TapeKit stops with 4901: nothing is signed.
  // A message signature from the same popup window goes through, as OKX lets a plain personal_sign through. It
  // carries a third param asking for a silent signature, which TapeKit drops: had it reached the wallet, the
  // fake (like OKX) would have refused it there.
  await ev(a, `(__e2e.next = () => { const hubOrigin = ${J(`http://${HUB_HOST}`)}; window.__old = { got: [] };
    const w = window.open(${J(HUB)} + '#origin=' + encodeURIComponent(location.origin), 'old-client', 'popup,width=400,height=640');
    const send = (id, method, params) => w.postMessage({ channel: 'tapekit-wallet/1', type: 'request', id, method, params }, hubOrigin);
    addEventListener('message', (e) => {
      if (e.source !== w || e.origin !== hubOrigin || !e.data) return;
      if (e.data.type === 'ready') send(1, 'eth_signTypedData_v4', [${J(FAKE_ACCOUNT)}, ${J(typedData(56))}]);
      if (e.data.type !== 'response') return;
      __old.got.push(e.data);
      if (e.data.id === 1) send(2, 'personal_sign', [${J(msgHex)}, ${J(FAKE_ACCOUNT)}, { isSilentSign: true }]);
    }); }, 1)`);
  await b.click(a.sessionId, '#__e2e_btn');
  const oldHub = await until(() => [...b.pages.values()].filter((p) => !p.closed && p.url.startsWith(HUB) && p.openerId === a.targetId).at(-1));
  await until(() => ev(oldHub, `document.readyState === 'complete' && !!window.__hubLog`));
  const oldWin = await windowOf(oldHub, a);
  const oldReply = (id) => until(() => ev(a, `__old.got.find((m) => m.id === ${id}) || null`), 30_000);
  const typedBefore = walletCalls().filter((c) => c.method === 'eth_signTypedData_v4').length;
  await waitCard(oldHub);
  await pressContinue(oldHub);
  const r1 = await oldReply(1);
  check('control: a popup window without the hint asks for the switch; the fake answers null and does not switch; TapeKit stops with 4901, nothing is signed',
    oldWin.type === 'popup' && r1 && r1.error && r1.error.code === 4901 && J(refusedCalls().map((c) => c.method)) === J(['wallet_switchEthereumChain'])
    && walletCalls().filter((c) => c.method === 'eth_signTypedData_v4').length === typedBefore, J({ oldWin, r1, refused: refusedCalls() }));
  await until(async () => (await ev(oldHub, `window.__hubLog.cardShows`)) >= 2, 30_000);
  await pressContinue(oldHub);
  const r2 = await oldReply(2);
  const last = signs().at(-1);
  check('control: …a message signature from that popup window passes (its focus check fails, like OKX\'s); the silent-sign param never reaches the wallet',
    r2 && r2.result === FAKE_SIGNATURE && last.focused === false && last.refused === false && J(last.params) === J([msgHex, FAKE_ACCOUNT])
    && refusedCalls().length === 1, J({ r2, last }));
  await b.send('Target.closeTarget', { targetId: oldHub.targetId }).catch(() => {});

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
const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
