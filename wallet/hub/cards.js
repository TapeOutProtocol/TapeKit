// The hub's router UI (design §6, §7, §9): the connect notice, the site confirmation and the signing card.
// Every card shows the site's on-chain identity from the kernel (name, processor, container), never the page
// title (SPEC §7.4). Clickjacking defenses: the hub cannot be framed (header CSP), the affirmative button is
// enabled only after the window has been focused and visible for 600 ms (re-armed on blur or hide), and the
// default focus is on "Reject". "Reject" stays enabled so it can hold that focus; triggering it is harmless.
import { el, rows } from './dom.js';
import { tr } from '/.tape/wallet/src/i18n.js';
import { describeSign } from '/.tape/wallet/src/describe.js';

export const NOTICE_MS = 5000;
export const GATE_MS = 600;

/**
 * @param {{ doc: Document, win: Window, lang: 'zh'|'en', hubHost: string }} opts
 */
export function createCards({ doc, win, lang, hubHost }) {
  const t = (key, vars) => tr(lang, key, vars);
  const cardBox = doc.getElementById('card');
  const toastBox = doc.getElementById('toast');
  let closeCard = null;    // finish() of the open card, if any
  let closeToast = null;   // hide() of the visible notice, if any

  const hostOf = (origin) => { try { return new URL(origin).host; } catch { return String(origin); } };

  function identityRows(origin, identity, account) {
    const id = identity || {};
    return rows(doc, [
      [t('id.name'), id.name, 'mono'],
      [t('id.cpu'), id.cpuName],
      [t('id.container'), id.container, 'mono'],
      [t('id.account'), account, 'mono'],
      [t('id.site'), hostOf(origin), 'mono'],
    ], t('id.unknown'));
  }

  /** Enable `button` only after GATE_MS of the window being focused and visible. Returns a cleanup. */
  function gate(button) {
    let timer = null;
    const ready = () => doc.visibilityState === 'visible' && doc.hasFocus();
    const lock = () => { if (timer !== null) win.clearTimeout(timer); timer = null; button.disabled = true; };
    const arm = () => {
      lock();
      if (ready()) timer = win.setTimeout(() => { timer = null; if (ready()) button.disabled = false; }, GATE_MS);
    };
    win.addEventListener('focus', arm);
    win.addEventListener('blur', lock);
    doc.addEventListener('visibilitychange', arm);
    arm();
    return () => {
      lock();
      win.removeEventListener('focus', arm);
      win.removeEventListener('blur', lock);
      doc.removeEventListener('visibilitychange', arm);
    };
  }

  /** Show a card with Reject / `okKey`. Resolves 'ok' or 'reject'. One card at a time (the router queues). */
  function ask(title, body, okKey) {
    if (closeCard) closeCard('reject');   // defensive: the router never asks twice at once
    return new Promise((resolve) => {
      const reject = el(doc, 'button', { class: 'plain', type: 'button', text: t('btn.reject') });
      const ok = el(doc, 'button', { type: 'button', text: t(okKey), disabled: true });
      let ungate = () => {};
      const onKey = (e) => { if (e.key === 'Escape') finish('reject'); };
      function finish(answer) {
        if (closeCard !== finish) return;
        closeCard = null;
        ungate();
        doc.removeEventListener('keydown', onKey);
        cardBox.replaceChildren();
        cardBox.hidden = true;
        resolve(answer);
      }
      reject.addEventListener('click', () => finish('reject'));
      ok.addEventListener('click', () => { if (!ok.disabled) finish('ok'); });
      cardBox.replaceChildren(el(doc, 'h2', { text: title }), ...body, el(doc, 'div', { class: 'actions' }, reject, ok));
      cardBox.hidden = false;
      closeCard = finish;
      ungate = gate(ok);
      doc.addEventListener('keydown', onKey);
      reject.focus();
    });
  }

  /** No-click notice after a gesture grant (D-c). Resolves when it hides (5 s, replaced, or revoked). */
  function notice(info, { onRevoke } = {}) {
    if (closeToast) closeToast();
    return new Promise((resolve) => {
      let timer = null;
      function hide() {
        if (closeToast !== hide) return;
        closeToast = null;
        win.clearTimeout(timer);
        toastBox.replaceChildren();
        toastBox.hidden = true;
        resolve();
      }
      const revoke = el(doc, 'button', { class: 'small', type: 'button', text: t('notice.revoke') });
      revoke.addEventListener('click', () => {
        revoke.disabled = true;
        revoke.textContent = t('notice.revoked');
        if (typeof onRevoke === 'function') onRevoke(info.origin);
        win.clearTimeout(timer);
        timer = win.setTimeout(hide, 1200);
      });
      toastBox.replaceChildren(
        el(doc, 'p', { text: t('notice.title') }),
        identityRows(info.origin, info.identity, info.account),
        el(doc, 'div', { class: 'actions' }, revoke),
      );
      toastBox.hidden = false;
      closeToast = hide;
      timer = win.setTimeout(hide, NOTICE_MS);
    });
  }

  function confirmSite(info) {
    return ask(t('site.title'), [
      identityRows(info.origin, info.identity, info.account),
      el(doc, 'p', { class: 'hint', text: t('site.hint') }),
    ], 'btn.allow');
  }

  function requestBody(d, origin) {
    if (d.kind === 'message') {
      // No chain row: a personal message is not chain-bound and the wallet is not switched for it (describe.js).
      const warn = d.siweWarning ? el(doc, 'p', { class: 'warn', text: t('sign.siwe', { domain: d.siweDomain || '?', host: hostOf(origin) }) }) : null;
      const label = d.text !== null ? t('sign.message') : t('sign.hex');
      return [warn, el(doc, 'p', { class: 'hint', text: label }), el(doc, 'pre', { text: d.text !== null ? d.text : d.hex })];
    }
    const chainRow = [t('sign.chain'), `${d.chain.name} (${d.chain.id})`];
    if (d.kind === 'typed') {
      const dm = d.domain;
      return [
        rows(doc, [chainRow, [t('sign.domain'), [dm.name, dm.version && `v${dm.version}`].filter(Boolean).join(' ') || null],
          ['chainId', dm.chainId, 'mono'], ['verifyingContract', dm.verifyingContract, 'mono'], [t('sign.primaryType'), d.primaryType, 'mono']], t('id.unknown')),
        el(doc, 'p', { class: 'hint', text: t('sign.json') }),
        el(doc, 'pre', { text: d.json }),
      ];
    }
    const data = d.dataBytes === null ? t('tx.badData')
      : [t('tx.bytes', { n: d.dataBytes }), d.selector && t('tx.selector', { selector: d.selector })].filter(Boolean).join(' · ');
    return [rows(doc, [chainRow, [t('tx.to'), d.to || t('tx.create'), 'mono'], [t('tx.value'), d.value, 'mono'], [t('tx.data'), data]], t('id.unknown'))];
  }

  function confirmSign(card) {
    const d = describeSign(card);
    return ask(t('sign.' + card.method), [
      identityRows(card.origin, card.identity, d.account),
      ...requestBody(d, card.origin).filter(Boolean),
      el(doc, 'p', { class: 'hint', text: t('sign.walletNote', { hub: hubHost }) }),
    ], 'btn.continue');
  }

  return Object.freeze({ notice, confirmSite, confirmSign });
}
