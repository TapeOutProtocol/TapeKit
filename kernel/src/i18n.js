// 双语文案（中文 / English）。内核抛出的错误和状态说明都从这里取；外壳可以用 setLocale() 切换，也可以直接拿 messages 自己渲染。
// Bilingual messages (zh / en). Every kernel error and status text comes from here; shells call setLocale() or read `messages` directly.

const MESSAGES = {
  // 状态 / statuses
  'status.ok': { zh: '已开通', en: 'Live' },
  'status.unpaid': { zh: '这个链上名字还没开通（未付费），官方客户端不显示', en: 'This on-chain name is not activated (unpaid); official clients do not display it' },
  'status.not-opened': { zh: '这枚电路还没有开通容器', en: 'This circuit has not opened its container yet' },
  'status.no-such-cpu': { zh: '没有这个处理器编号', en: 'No processor with this number' },
  'status.no-such-token': { zh: '这个处理器下没有这枚电路（#ID 不存在）', en: 'This processor has no such circuit (#ID does not exist)' },
  'status.not-tapeout': { zh: '这不是 TapeOut 电路容器', en: 'Not a TapeOut circuit container' },
  'status.blocked': { zh: '此客户端已屏蔽这个网站', en: 'This client has blocked this site' },
  'status.store-changed': { zh: '网站仓库合约的实现与客户端钉住的版本不一致，已拒绝读取（等待客户端更新）', en: 'The site store contract implementation does not match the version pinned by this client; refusing to read (client update required)' },
  // 输入 / input
  'input.empty': { zh: '请输入链上名字、#ID@处理器编号，或容器地址', en: 'Enter an on-chain name, #ID@processor, or a container address' },
  'input.decimal': { zh: '{what}必须是不带前导 0 的十进制数字：{value}', en: '{what} must be a decimal number without leading zeros: {value}' },
  'input.range': { zh: '{what}超出范围：{value}', en: '{what} out of range: {value}' },
  'input.unknown': { zh: '看不懂这个地址。例子：4246.0.tape、#4246@0、0x…（容器地址）', en: 'Unrecognised address. Examples: 4246.0.tape, #4246@0, 0x… (container address)' },
  'what.tokenId': { zh: '#ID', en: '#ID' },
  'what.cpu': { zh: '处理器编号', en: 'processor number' },
  // RPC
  'rpc.none': { zh: '没有配置 RPC 节点', en: 'No RPC nodes configured' },
  'rpc.conflict': { zh: '节点返回的结果不一致，已拒绝（可能有节点作假或不同步）', en: 'Nodes returned different results; rejected (a node may be lying or out of sync)' },
  'rpc.short': { zh: '可用节点不足：需要 {quorum} 个节点给出相同结果', en: 'Not enough nodes: {quorum} nodes must agree' },
  'rpc.heads': { zh: '可用节点不足：只有 {n} 个节点响应', en: 'Not enough nodes: only {n} responded' },
  // 站点 / site
  'site.chain-call': { zh: '链上调用失败：{what}', en: 'On-chain call failed: {what}' },
  'site.too-many-files': { zh: '站点文件太多（{n} 个，上限 {max}）', en: 'Too many files in this site ({n}, limit {max})' },
  'site.too-large': { zh: '站点太大（{mb} MB，上限 {max} MB）', en: 'Site too large ({mb} MB, limit {max} MB)' },
  'file.ok': { zh: '与链上一致', en: 'matches chain' },
  'file.no-hash': { zh: '未声明哈希，未校验', en: 'no declared hash, unverified' },
  'file.incomplete': { zh: '与链上记录不符（上传中或已损坏）', en: 'does not match the on-chain record (uploading or corrupted)' },
  'file.too-large': { zh: '文件超过上限', en: 'file exceeds the size limit' },
  'paid.container': { zh: '容器已付费', en: 'container paid' },
  'paid.name': { zh: '名字已付费', en: 'name paid' },
};

let current = 'zh';

/** 'zh' | 'en'；传其它值按 en 处理。不传则按运行环境的语言猜。 */
export function setLocale(locale) {
  current = String(locale || '').toLowerCase().startsWith('zh') ? 'zh' : 'en';
  return current;
}
export const getLocale = () => current;

export function detectLocale() {
  const langs = typeof navigator !== 'undefined' && navigator.languages ? navigator.languages : [typeof navigator !== 'undefined' ? navigator.language : (process?.env?.LANG || 'zh')];
  return String(langs[0] || 'zh').toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

const fill = (s, vars) => String(s).replace(/\{(\w+)\}/g, (m, k) => (vars && k in vars ? String(vars[k]) : m));

/** 当前语言的文案 */
export function t(key, vars) {
  const m = MESSAGES[key];
  if (!m) return key;
  return fill(m[current] || m.en, vars);
}
/** 两种语言都要（错误对象上带着，外壳按需显示） */
export function tt(key, vars) {
  const m = MESSAGES[key];
  return m ? { zh: fill(m.zh, vars), en: fill(m.en, vars) } : { zh: key, en: key };
}
/** 中英文并排的一句（外壳没做语言切换时可以直接用） */
export const both = (key, vars) => { const b = tt(key, vars); return b.zh === b.en ? b.zh : `${b.zh} / ${b.en}`; };

export const messages = Object.freeze(MESSAGES);

/** 内核所有错误的基类：code 稳定，message 跟随当前语言，messages 两种语言都有。 */
export class KernelError extends Error {
  constructor(code, key, vars, detail) {
    const m = tt(key, vars);
    super(current === 'zh' ? m.zh : m.en);
    this.name = 'KernelError';
    this.code = code;
    this.messages = m;
    if (detail !== undefined) this.detail = detail;
  }
}
