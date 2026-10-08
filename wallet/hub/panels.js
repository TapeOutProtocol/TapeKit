// Hub panels: which wallet is in use (or install guidance, or a picker when several are installed), the
// authorized-sites list with revoke (R3), and a status line for failed requests (R9).
import { el } from './dom.js';
import { tr } from '/.tape/wallet/src/i18n.js';

/**
 * @param {{ doc: Document, lang: 'zh'|'en' }} opts
 */
export function createPanels({ doc, lang }) {
  const t = (key, vars) => tr(lang, key, vars);
  const walletBox = doc.getElementById('wallet');
  const sitesBox = doc.getElementById('sites');
  const statusBox = doc.getElementById('status');
  const dateText = (ms) => (Number.isFinite(ms) ? new Date(ms).toLocaleString(lang === 'zh' ? 'zh-CN' : 'en') : '');

  function walletLoading() {
    walletBox.replaceChildren(el(doc, 'p', { class: 'hint', text: t('wallet.loading') }));
  }

  /** Install guidance. Store addresses are plain text (no links): the hub never navigates anywhere. */
  function walletNone(adapters) {
    const item = (a) => el(doc, 'li', {}, el(doc, 'span', { class: 'what' },
      el(doc, 'strong', { text: a.label }),
      el(doc, 'span', { class: 'mono store', text: a.storeUrl })));
    walletBox.replaceChildren(
      el(doc, 'p', { text: t('wallet.none') }),
      el(doc, 'p', { class: 'hint', text: t('wallet.store') }),
      el(doc, 'ul', { class: 'list' }, adapters.map(item)),
    );
  }

  /** Several wallets: resolves with the adapter id the user clicks. */
  function walletPick(found) {
    return new Promise((resolve) => {
      const buttons = found.map((x) => el(doc, 'button', { type: 'button', class: 'plain', text: x.adapter.label, onclick: () => resolve(x.adapter.id) }));
      walletBox.replaceChildren(el(doc, 'p', { text: t('wallet.pick') }), el(doc, 'div', { class: 'picks' }, buttons));
      if (buttons[0]) buttons[0].focus();
    });
  }

  /** @param {string} label @param {(() => void)|null} onChange  shown only when there is something to change to */
  function walletUsing(label, onChange) {
    const change = onChange ? el(doc, 'button', { type: 'button', class: 'plain small', text: t('wallet.change'), onclick: onChange }) : null;
    walletBox.replaceChildren(el(doc, 'p', { class: 'hint' }, t('wallet.using', { wallet: label }), change ? ' ' : '', change));
  }

  /**
   * @param {Array<{ origin: string, name: string, container: string|null, accounts: string[], grantedAt: number|null }>} entries
   * @param {(origin: string) => void} onRevoke
   */
  function showSites(entries, onRevoke) {
    const items = entries.map((e) => {
      const revoke = el(doc, 'button', { type: 'button', class: 'plain small', text: t('sites.revoke') });
      revoke.addEventListener('click', () => { revoke.disabled = true; onRevoke(e.origin); });
      return el(doc, 'li', {},
        el(doc, 'span', { class: 'what' },
          el(doc, 'strong', { class: 'mono', text: e.name }),
          el(doc, 'span', { class: 'mono hint', text: `${t('id.container')} ${e.container || t('id.unknown')}` }),
          el(doc, 'span', { class: 'mono hint', text: `${t('id.account')} ${e.accounts.join(', ')}` }),
          e.grantedAt ? el(doc, 'span', { class: 'hint', text: t('sites.since', { date: dateText(e.grantedAt) }) }) : null),
        revoke);
    });
    sitesBox.replaceChildren(
      el(doc, 'h2', { text: t('sites.title') }),
      items.length ? el(doc, 'ul', { class: 'list' }, items) : el(doc, 'p', { class: 'hint', text: t('sites.empty') }),
    );
  }

  function showStatus(text) {
    statusBox.textContent = text;
    statusBox.hidden = !text;
  }

  return Object.freeze({ walletLoading, walletNone, walletPick, walletUsing, showSites, showStatus });
}
