// Popup section「钱包路由」(wallet router design §10.1, R3): turn wallet routing on or off for the configured
// gateway, and list the sites the hub has authorized (from the hub's snapshot), each with a revoke button.
// Enabling has to start inside the click: chrome.permissions.request needs the user gesture. So the gateway is
// read when the popup renders and kept here, and the click handler calls enableRouting() right away.
// All text goes in with textContent.
import { routingState, enableRouting, disableRouting, ROUTING_KEY } from '../wallet/extension/routing.js';
import { SNAPSHOT_KEY, snapshotFor, grantedSites } from '../wallet/extension/snapshot.js';
import { REVOKE_MESSAGE } from '../wallet/src/ext-protocol.js';

const T = {
  noGateway: '先在上面填网关域名，再启用钱包路由。',
  badGateway: '这个网关地址用不了钱包路由：需要域名形式（如 tapekit.org、localhost:8096），不能是 IP 地址。',
  off: (g) => `启用后，${g} 下的链上网站会自动看到 TapeKit 钱包（EIP-6963），钱包只需在 TapeKit 里连一次。Chrome 会请你允许扩展访问这个网关。`,
  on: (g) => `已启用：${g} 下的链上网站会看到 TapeKit 钱包。`,
  enable: '启用钱包路由',
  disable: '停用钱包路由',
  denied: '没有得到访问这个网关的权限，钱包路由没有启用。',
  failed: '操作没有完成，请稍后再试。',
  sites: '已授权的网站',
  empty: '还没有授权任何网站。',
  container: '容器',
  account: '账户',
  unknown: '（未知）',
  revoke: '撤销',
  revoking: '正在撤销…',
};

/** @param {{ doc: Document, chrome: object, getGateway: () => Promise<string> }} opts */
export function mountWalletSection({ doc, chrome, getGateway }) {
  const $ = (id) => doc.getElementById(id);
  const node = (tag, cls, text) => {
    const n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  let gateway = '';
  let enabled = false;

  function showError(text) {
    $('wallet-error').textContent = text;
    $('wallet-error').hidden = !text;
  }

  function revokeButton(origin) {
    const btn = node('button', 'small', T.revoke);
    btn.type = 'button';
    btn.dataset.origin = origin;
    btn.addEventListener('click', () => {
      btn.disabled = true;
      btn.textContent = T.revoking;
      const undo = () => { btn.disabled = false; btn.textContent = T.revoke; showError(T.failed); };
      chrome.runtime.sendMessage({ type: REVOKE_MESSAGE, origin }).then((r) => { if (!r || !r.ok) undo(); }, undo);
    });
    return btn;
  }

  function showSites(list) {
    const box = $('wallet-sites');
    if (!enabled) { box.replaceChildren(); return; }
    const items = list.map((s) => {
      const what = node('div', 'what');
      what.append(
        node('strong', 'mono', s.name),
        node('span', 'mono hint', `${T.container} ${s.container || T.unknown}`),
        node('span', 'mono hint', `${T.account} ${s.accounts.join(', ')}`),
      );
      const li = node('li');
      li.append(what, revokeButton(s.origin));
      return li;
    });
    const list2 = node('ul', 'sites');
    list2.append(...items);
    box.replaceChildren(node('h3', '', T.sites), items.length ? list2 : node('p', 'hint', T.empty));
  }

  async function render() {
    gateway = await getGateway();
    const { info, enabled: on } = await routingState(chrome, gateway);
    enabled = on;
    const toggle = $('wallet-toggle');
    if (!info) {
      $('wallet-state').textContent = gateway ? T.badGateway : T.noGateway;
      toggle.hidden = true;
      showSites([]);
      return;
    }
    toggle.hidden = false;
    toggle.textContent = on ? T.disable : T.enable;
    $('wallet-state').textContent = on ? T.on(info.gateway) : T.off(info.gateway);
    const got = on ? await chrome.storage.local.get(SNAPSHOT_KEY) : {};
    showSites(on ? grantedSites(snapshotFor(got[SNAPSHOT_KEY], info.hubUrl), info.hubUrl) : []);
  }

  $('wallet-toggle').addEventListener('click', () => {
    showError('');
    // enableRouting's first await is chrome.permissions.request, so it still runs inside this click.
    const work = enabled ? disableRouting(chrome).then(() => ({ ok: true })) : enableRouting(chrome, gateway);
    work
      .then((r) => { if (!r.ok) showError(r.reason === 'denied' ? T.denied : T.badGateway); }, () => showError(T.failed))
      .finally(() => render().catch(() => showError(T.failed)));
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    const local = area === 'local' && (changes[ROUTING_KEY] || changes[SNAPSHOT_KEY]);
    if (local || (area === 'sync' && changes.gateway)) render().catch(() => showError(T.failed));
  });
  render().catch(() => showError(T.failed));
}
