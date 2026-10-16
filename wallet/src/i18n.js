// Hub texts in Chinese and English (SPEC §10), chosen by navigator.language. Error messages are keyed by the
// EIP-1193 / JSON-RPC code (R9) so the hub, the fallback client and the extension can share them.
// Same pattern as the gateway pages: a { key: { zh, en } } table and {var} placeholders. Plain text only:
// callers insert results with textContent.

const T = Object.freeze({
  'hub.title': { zh: 'TapeKit 钱包', en: 'TapeKit Wallet' },
  'hub.intro': { zh: '链上网站通过这里使用你的钱包。TapeKit 不保存密钥，签名始终在你的钱包里完成。', en: 'On-chain sites use your wallet through this page. TapeKit holds no keys; signing always happens in your wallet.' },

  'wallet.loading': { zh: '正在查找钱包…', en: 'Looking for wallets…' },
  'wallet.none': { zh: '没有找到受支持的钱包。请安装 OKX Wallet 或 Binance Wallet，然后重新打开这个页面。', en: 'No supported wallet found. Install OKX Wallet or Binance Wallet, then reopen this page.' },
  'wallet.store': { zh: 'Chrome 应用商店地址（复制到地址栏打开）：', en: 'Chrome Web Store address (copy it into the address bar):' },
  'wallet.pick': { zh: '找到多个钱包，请选择要使用的一个：', en: 'Several wallets found. Choose the one to use:' },
  'wallet.using': { zh: '正在使用 {wallet}', en: 'Using {wallet}' },
  'wallet.change': { zh: '换一个钱包', en: 'Change wallet' },

  'id.name': { zh: '链上名字', en: 'On-chain name' },
  'id.cpu': { zh: '处理器', en: 'Processor' },
  'id.container': { zh: '容器', en: 'Container' },
  'id.account': { zh: '账户', en: 'Account' },
  'id.site': { zh: '网址', en: 'Address' },
  'id.unknown': { zh: '（未知）', en: '(unknown)' },

  'notice.title': { zh: '已连接：这个网站现在可以看到你的钱包地址', en: 'Connected: this site can now see your wallet address' },
  'notice.revoke': { zh: '撤销', en: 'Revoke' },
  'notice.revoked': { zh: '已撤销', en: 'Revoked' },

  'site.title': { zh: '允许这个网站查看你的钱包地址吗？', en: 'Let this site see your wallet address?' },
  'site.hint': { zh: '网站只能看到地址。每次签名或交易仍会先问你。', en: 'The site only sees the address. Every signature or transaction still asks you first.' },
  'btn.allow': { zh: '允许', en: 'Allow' },
  'btn.reject': { zh: '拒绝', en: 'Reject' },
  'btn.continue': { zh: '继续', en: 'Continue' },

  'sign.personal_sign': { zh: '签名请求', en: 'Signature request' },
  'sign.eth_signTypedData_v4': { zh: '结构化数据签名请求', en: 'Typed data signature request' },
  'sign.eth_sendTransaction': { zh: '交易请求', en: 'Transaction request' },
  'sign.message': { zh: '消息', en: 'Message' },
  'sign.hex': { zh: '消息（不是文本，按十六进制显示）', en: 'Message (not text, shown as hex)' },
  'sign.siwe': { zh: '警告：这是一条登录消息，要登录的是 {domain}，不是发起请求的网站 {host}。如果你没打算登录 {domain}，请拒绝。', en: 'Warning: this sign-in message is for {domain}, not for the requesting site {host}. Reject unless you meant to sign in to {domain}.' },
  'sign.domain': { zh: '域（domain）', en: 'Domain' },
  'sign.primaryType': { zh: '类型（primaryType）', en: 'Primary type' },
  'sign.json': { zh: '完整内容', en: 'Full content' },
  'sign.chain': { zh: '链', en: 'Chain' },
  'tx.to': { zh: '收款地址', en: 'To' },
  'tx.create': { zh: '（创建新合约）', en: '(contract creation)' },
  'tx.value': { zh: '金额', en: 'Value' },
  'tx.data': { zh: '数据', en: 'Data' },
  'tx.bytes': { zh: '{n} 字节', en: '{n} bytes' },
  'tx.selector': { zh: '函数选择器 {selector}', en: 'selector {selector}' },
  'tx.badData': { zh: '格式不对', en: 'malformed' },
  'sign.walletNote': { zh: '点“继续”后钱包会弹窗，里面显示的网址是 {hub}，这是正常的。', en: 'After “Continue” your wallet opens and shows {hub} as the site. That is expected.' },

  'sites.title': { zh: '已授权的网站', en: 'Authorized sites' },
  'sites.empty': { zh: '还没有授权任何网站。', en: 'No site is authorized yet.' },
  'sites.since': { zh: '授权于 {date}', en: 'Authorized {date}' },
  'sites.revoke': { zh: '撤销', en: 'Revoke' },

  'status.moved': { zh: '{site} 的请求需要用钱包，已转到 TapeKit 标签页继续。', en: 'The request from {site} needs the wallet and continues in a TapeKit tab.' },
  'status.failed': { zh: '{site} 的请求没有完成：{reason}', en: 'The request from {site} did not complete: {reason}' },

  'err.4001': { zh: '你拒绝了这个请求。', en: 'You rejected the request.' },
  'err.4100': { zh: '这个网站还没有获得授权，或钱包里的账户已经变了。请在网站上点“连接”再试。', en: 'This site is not authorized, or the wallet account changed. Click “Connect” on the site and try again.' },
  'err.4200': { zh: 'TapeKit 不支持这个请求。', en: 'TapeKit does not support this request.' },
  'err.4900': { zh: '还没有连接钱包。请安装 OKX Wallet 或 Binance Wallet。', en: 'No wallet is connected. Install OKX Wallet or Binance Wallet.' },
  'err.4901': { zh: '请求的链和这个网站当前的链不一致。', en: 'The request is for a different chain than the one this site is on.' },
  'err.4902': { zh: '不支持这条链。TapeKit 支持 BNB Chain、X Layer 和 Base。', en: 'Unsupported chain. TapeKit supports BNB Chain, X Layer and Base.' },
  'err.-32005': { zh: '这个网站的请求太多，请稍后再试。', en: 'Too many requests from this site. Try again later.' },
  'err.-32602': { zh: '请求的参数不对。', en: 'The request parameters are invalid.' },
  'err.-32603': { zh: '出错了，请稍后再试。', en: 'Something went wrong. Try again later.' },
  'err.closed': { zh: 'TapeKit 页面被关掉了，请求已取消。', en: 'The TapeKit page was closed; the request was cancelled.' },
  'err.popup': { zh: '浏览器拦住了 TapeKit 页面。请点网站上的按钮再试。', en: 'The browser blocked the TapeKit page. Click the button on the site and try again.' },
  'err.tab': { zh: 'TapeKit 只能在浏览器标签页里使用钱包，这个小窗口做不到。请再试一次。', en: 'TapeKit can use your wallet only from a browser tab, not from this small window. Try again.' },
  'err.load': { zh: 'TapeKit 页面没有响应，已关闭。请检查网络，再点网站上的按钮重试。', en: 'The TapeKit page did not respond and was closed. Check your connection, then click the button on the site again.' },
  'err.other': { zh: '钱包返回了错误（{code}）。', en: 'The wallet returned an error ({code}).' },
});

export const LANGS = Object.freeze(['zh', 'en']);

/** navigator.language → 'zh' | 'en' */
export const pickLang = (language) => (/^zh\b/i.test(String(language || '')) ? 'zh' : 'en');

/** Text for `key` in `lang`, with {var} filled from `vars`. Unknown keys return the key itself. */
export function tr(lang, key, vars = {}) {
  const entry = Object.prototype.hasOwnProperty.call(T, key) ? T[key] : null;
  const text = entry ? entry[lang === 'zh' ? 'zh' : 'en'] : key;
  return text.replace(/\{(\w+)\}/g, (m, name) => (Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : m));
}

/** User-facing message for an error code (R9). */
export function errorText(lang, code) {
  const key = 'err.' + String(code);
  return Object.prototype.hasOwnProperty.call(T, key) ? tr(lang, key) : tr(lang, 'err.other', { code: String(code) });
}

/** For tests: every key, so each can be checked for both languages. */
export const KEYS = Object.freeze(Object.keys(T));
