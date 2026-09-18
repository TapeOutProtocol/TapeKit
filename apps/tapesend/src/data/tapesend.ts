// TapeSend 客户端数据层：全部密码学与链上核验都来自 @tapekit/send（send/module），这里只做编排和本地状态。
import {
  TapeSendError, bytesToHex, hexToBytes, keyDerivationText, isDeterministic, deriveKeyPair, seal, encodePublic,
  openPayload, encodeContent, decodeContent, displayText, assertValidPublicKey,
} from '../../../../send/module/src/index.js';
import { encodeCall, decodeResult } from '../../../../kernel/src/abi.js';
import { keccakHex } from '../../../../kernel/src/keccak.js';
import { HUB_SEL, HUB_TOPIC, HOME_CHAIN_ID, chainById, createTapeSendChain, endpointLabel, endpointId, normalizeHeader, normalizeReceipt, parseEndpointId } from '../../../../send/module/src/chain.js';

export type Hex = `0x${string}`;

export interface Endpoint {
  label: string;
  /** 链上网站名字形式，例如 15324.30.tape */
  name?: string;
  /** 处理器（电路合约）的名字；任何人都能起同样的名字，只能作参考 */
  cpuName?: string;
  /** 链号（端点所在的链） */
  chainId: number;
  /** 端点号：uint32(0) ‖ uint64(chainId) ‖ 容器，全网唯一 */
  endpoint: Hex;
  tokenId: bigint;
  cpu: bigint;
  circuits: Hex;
  container: Hex;
  holder: Hex | null;
  opened: boolean;
  key: { suite: number; keyIndex: number; key: Hex; usable: boolean; version: number; current: Hex; chains: number[]; chainsBits: bigint };
  /** TAP-10 §3.5：工厂封印没生效时，控制工厂的人可以冒充任何端点 */
  factory: { sealed: boolean; inEffect: boolean; circuitsIntact: boolean; lostSeal?: boolean };
  /** TAP-10 §3.6：消息合约自己的封印状态。没封印时 owner 可以换掉实现，同样能冒充任何端点 */
  hub: { sealed: boolean; owner: string; implementation: string; expectedImplementation: boolean; inEffect: boolean };
  block: string;
}

export type ResolveResult = { status: 'ok' | 'not-opened'; endpoint: Endpoint } | { status: string; endpoint?: undefined };

export interface Message {
  /** 只由链上存储决定：发出链 ‖ 中枢 ‖ 收件端点号 ‖ 信箱序号 */
  id: Hex;
  /** 消息所在的链（发件人那条链） */
  chainId: number;
  /** 在收件信箱里的序号 */
  index: number;
  blockNumber: number;
  timestamp: number;
  /** 收件容器地址与端点号 */
  to: Hex;
  toEndpoint: Hex;
  /** 发件容器地址（在 chainId 那条链上）与端点号 */
  from: Hex;
  fromEndpoint: Hex;
  ref: Hex;
  /** 链上记录的内容指纹：keccak256(ref ‖ keccak256(payload)) */
  digest: Hex;
  pending: boolean;
  payload: Uint8Array;
  direction: 'in' | 'out';
  /** 同一发件人把完全相同的内容又发了几次（钱包重复弹窗时会出现），只显示一条 */
  copies?: number;
  /** 单个节点报的交易哈希，只是线索：用之前必须严格读回执核对（见 messageSender） */
  txHint?: Hex | null;
}

export interface OpenedMessage {
  status: 'ok' | 'unsupported' | 'damaged' | 'not-for-key' | 'locked';
  kind?: 'public' | 'sealed';
  /** 显示用：控制字符已换成可见形式 */
  subject?: string;
  body?: string;
  /** 回复用：原始主题 */
  rawSubject?: string;
  /** 附件（格式已校验；资产附件还要到链上核对） */
  attachments?: Attachment[];
  /** 格式不对、没有显示的附件个数 */
  badAttachments?: number;
}

export type Attachment =
  | { type: 'image'; mime: string; data: string; w: number; h: number; size?: number }
  | { type: 'native'; chainId: number; amount: string; tx: Hex }
  | { type: 'erc20'; chainId: number; token: Hex; amount: string; tx: Hex }
  | { type: 'erc721'; chainId: number; token: Hex; tokenId: string; tx: Hex };

// 合约地址：构建时可用 VITE_TAPESEND_HUB 覆盖（代理地址取决于部署时的 owner）
const chain = createTapeSendChain(import.meta.env.VITE_TAPESEND_HUB ? { hub: import.meta.env.VITE_TAPESEND_HUB } : {});
export const hubAddress = chain.hub as Hex;
const lower = (s: string) => s.toLowerCase();

// ---------------------------------------------------------------- 解析

export async function resolveEndpoint(input: string, opts: { block?: bigint } = {}): Promise<ResolveResult> {
  const r = await chain.resolveEndpoint(input.trim(), opts.block !== undefined ? { block: '0x' + opts.block.toString(16) } : {});
  if (r.status !== 'ok' && r.status !== 'not-opened') return { status: r.status };
  const endpoint = r as unknown as Endpoint;
  return { status: r.status, endpoint: { ...endpoint, factory: stickyFactory(endpoint.factory, endpoint.block) } };
}

export { endpointLabel };

/**
 * 反查显示名。传端点号（32 字节）或本链容器地址。内核按地址反查时会重新推算容器地址并比对；失败显示地址，且不缓存失败。
 * 端点在其他链上时，本客户端还不能在那条链上反查（那条链尚未启用），显示缩写地址加链名。
 */
const labelCache = new Map<string, Promise<string>>();
export function senderLabel(endpointOrContainer: string): Promise<string> {
  const parsed = /^0x[0-9a-fA-F]{64}$/.test(endpointOrContainer) ? parseEndpointId(endpointOrContainer) : { chainId: HOME_CHAIN_ID, container: lower(endpointOrContainer) };
  if (!parsed) return Promise.resolve(short(endpointOrContainer));
  const key = lower(parsed.container);
  if (parsed.chainId !== chain.chainId) {
    const c = chainById(parsed.chainId);
    return Promise.resolve(`${short(key)}.${c ? c.short : `chain${parsed.chainId}`}`);
  }
  let p = labelCache.get(key);
  if (!p) {
    p = chain.resolveEndpoint(key).then((r: { status: string; tokenId?: bigint; cpu?: bigint; container?: string }) => {
      if (r.tokenId === undefined || r.cpu === undefined || !r.container || lower(r.container) !== key) throw new Error('unresolved');
      return endpointLabel(r.tokenId, r.cpu, parsed.chainId);
    });
    labelCache.set(key, p);
    p.catch(() => labelCache.delete(key));
  }
  return p.catch(() => short(key));
}
/** 链的显示名 */
export const chainName = (id: number) => chainById(id)?.name ?? `chain ${id}`;
export const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

// ---------------------------------------------------------------- 身份（本地记住用户选过的端点）

const idsKey = (wallet: string) => `tapesend:identities:${lower(wallet)}`;
export function savedIdentities(wallet: string): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(idsKey(wallet)) ?? '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string' && /^#\d+@\d+$/.test(x)).slice(0, 20) : [];
  } catch {
    return [];
  }
}
export function rememberIdentity(wallet: string, label: string) {
  try {
    const list = [label, ...savedIdentities(wallet).filter((x) => x !== label)].slice(0, 20);
    localStorage.setItem(idsKey(wallet), JSON.stringify(list));
  } catch {
    // 存不了就算了，下次再输入
  }
}

// ---------------------------------------------------------------- 钥匙（只在内存里）

type SignFn = (text: string) => Promise<Hex>;
interface RingEntry { secretKey: Uint8Array; publicKey: Hex; keyIndex: number }
// 键里带上钱包地址：换钱包后，别的钱包派生出的钥匙绝不会被当成这个钱包的
const keyring = new Map<string, RingEntry>();
const ringKey = (wallet: string, container: string, keyIndex: number) => `${lower(wallet)}:${lower(container)}#${keyIndex}`;

/** 断开或换钱包时调用 */
export function clearKeys() {
  for (const e of keyring.values()) e.secretKey.fill(0);
  keyring.clear();
}

/** 当前钱包、这个容器下已经解锁的钥匙，按序号从高到低 */
export function unlockedKeys(wallet: string, container: string): RingEntry[] {
  const prefix = `${lower(wallet)}:${lower(container)}#`;
  return [...keyring.entries()].filter(([k]) => k.startsWith(prefix)).map(([, v]) => v).sort((a, b) => b.keyIndex - a.keyIndex);
}

/** 链上当前公钥对应的钥匙是否已解锁（公钥必须与链上一致才算） */
export function currentKeyUnlocked(wallet: string, me: Endpoint): boolean {
  if (!me.key.usable || lower(me.key.current) !== lower(wallet)) return false;
  const e = keyring.get(ringKey(wallet, me.container, me.key.keyIndex));
  return Boolean(e && e.publicKey === lower(me.key.key));
}

/**
 * 发布新钥匙时用哪个序号。钥匙文字里带着持有人地址，所以只需保证"同一持有人不重复用序号"（TAP-10 §4.5）。取以下各项的最大值：
 *   - 本钱包当前可用钥匙的序号加一；
 *   - 本机记住的、本钱包在这个容器用过的最大序号加一（不依赖任何外部来源）；
 *   - 索引器历史里本钱包用过的最大序号加一——这个值必须用多节点读回执核验过才采用，伪造的记录被忽略；
 *   - 链上记录的 version（只增不减），但只在它不超过 65535 时参考：前任持有人可以把它刷高，不能让新持有人被锁死。
 */
export async function nextKeyIndex(me: Endpoint, wallet: string): Promise<number> {
  const mine = me.key.usable && lower(me.key.current) === lower(wallet);
  let k = mine ? me.key.keyIndex + 1 : 0;
  const local = usedKeyIndex(me.container, wallet);
  if (local !== null) k = Math.max(k, local + 1);
  // version 只增不减，是"这个容器发布过几次"的上限；超过 65535（可能被前任持有人刷高）时无法保证新序号没用过，拒绝
  if (me.key.version > 65535) throw new TapeSendError('key-index', 'this container has too many key changes to choose a fresh key index');
  k = Math.max(k, me.key.version);
  if (k > 65535) throw new TapeSendError('key-index', 'no key index left for this holder');
  return k;
}

// 本机记住用过的序号：按"持有人 + 容器"，只增不减
const usedKey = (container: string, wallet: string) => `tapesend:keyindex:${lower(wallet)}:${lower(container)}`;
function usedKeyIndex(container: string, wallet: string): number | null {
  try {
    const n = Number(localStorage.getItem(usedKey(container, wallet)));
    return localStorage.getItem(usedKey(container, wallet)) !== null && Number.isInteger(n) && n >= 0 && n <= 65535 ? n : null;
  } catch {
    return null;
  }
}
export function rememberKeyIndex(container: string, wallet: string, keyIndex: number) {
  try {
    const cur = usedKeyIndex(container, wallet);
    if (cur === null || keyIndex > cur) localStorage.setItem(usedKey(container, wallet), String(keyIndex));
    const list = usedKeyIndexes(container, wallet).filter((x) => x !== keyIndex);
    list.push(keyIndex);
    localStorage.setItem(`${usedKey(container, wallet)}:all`, JSON.stringify(list.slice(-1000)));
  } catch {
    // 忽略
  }
}
function usedKeyIndexes(container: string, wallet: string): number[] {
  try {
    const v = JSON.parse(localStorage.getItem(`${usedKey(container, wallet)}:all`) ?? '[]');
    return Array.isArray(v) ? v.filter((x) => Number.isInteger(x) && x >= 0 && x <= 65535) : [];
  } catch {
    return [];
  }
}

export type UnlockOutcome =
  | { status: 'unlocked'; needsPublish: boolean; publicKey: Hex; keyIndex: number }
  | { status: 'nondeterministic' }
  | { status: 'mismatch' };

/**
 * TAP-10 §4.2：签两次核对确定性，派生钥匙。
 * me 必须是刚从链上重新读到的端点。链上已有本钱包的可用公钥时只解锁，派生结果必须与链上一致；
 * 否则（第一次、撤销后、换过持有人、或 rotate 为真）用 nextKeyIndex 派生新钥匙，返回 needsPublish。
 */
export async function unlock(me: Endpoint, wallet: Hex, sign: SignFn, opts: { rotate?: boolean } = {}): Promise<UnlockOutcome> {
  const mine = me.key.usable && me.key.suite === 1 && lower(me.key.current) === lower(wallet);
  const needsPublish = !mine || Boolean(opts.rotate);
  const keyIndex = needsPublish ? await nextKeyIndex(me, wallet) : me.key.keyIndex;
  const p = { tokenId: me.tokenId, cpuIndex: me.cpu, container: me.container, holder: wallet, hub: hubAddress, keyIndex, chainId: me.chainId };
  const text = keyDerivationText(p);
  // 发布新钥匙之前必须签两次、核对钱包签名是确定性的（TAP-10 §4.2）。
  // 只是解锁链上已有的钥匙时签一次就够：派生结果必须等于链上的公钥，这本身就证明了确定性
  const s1 = await sign(text);
  if (needsPublish) {
    const s2 = await sign(text);
    if (!isDeterministic(s1, s2)) return { status: 'nondeterministic' };
  }
  const kp = deriveKeyPair({ ...p, signature: s1 });
  const publicKey = lower(bytesToHex(kp.publicKey)) as Hex;
  if (!needsPublish && publicKey !== lower(me.key.key)) {
    kp.secretKey.fill(0);
    return { status: 'mismatch' };
  }
  keyring.set(ringKey(wallet, me.container, keyIndex), { secretKey: kp.secretKey, publicKey, keyIndex });
  // 派生过就算用过（签名文字已经出现在钱包里），不论之后有没有发布成功
  rememberKeyIndex(me.container, wallet, keyIndex);
  return { status: 'unlocked', needsPublish, publicKey, keyIndex };
}

export function publishKeyTx(me: Endpoint, keyIndex: number, publicKey: Hex) {
  return chain.encodePublishKey({ circuits: me.circuits, tokenId: me.tokenId, keyIndex, publicKey }) as { to: Hex; data: Hex };
}

export function revokeKeyTx(me: Endpoint) {
  return chain.encodeRevokeKey({ circuits: me.circuits, tokenId: me.tokenId }) as { to: Hex; data: Hex };
}

// ---------------------------------------------------------------- 读消息

const PAGE_SIZE = 30;
const FETCH_CONCURRENCY = 6;
/**
 * 已取回、并已按链上指纹核对过的消息内容。链上内容不可变，按"消息 ID + 指纹"缓存：
 * 轮询发现新消息重新加载时，老消息不必再下载，别人刷垃圾消息也只会让客户端取新增的那几条。
 */
/** 读不到已最终确认高度时的保守回退：BNB 链快速最终性约 2 个块，这里放宽到 30 个块 */
const FINALITY_FALLBACK_BLOCKS = 30n;
const payloadCache = new Map<string, { payload: Uint8Array; ref: string; txHint?: string | null }>();
const PAYLOAD_CACHE_MAX = 600;

export interface MessagePage {
  items: Message[];
  /** 陌生发件人超出每页上限、没有取回内容的条数（防刷信箱） */
  folded?: number;
  /** 读到了但内容与链上指纹对不上、或格式不对（丢弃） */
  dropped: number;
  /** 暂时取不到内容（节点都没给出与链上指纹一致的内容），稍后重试 */
  unavailable: number;
  /** 继续取更早的消息；没有了为 null。cursor 是信箱序号 */
  more: MoreToken | null;
}
export interface MoreToken { cursor: string | null; rest: unknown[]; usedCursors?: string[] }

/**
 * 取一页消息（DeWEB 链上信箱）：
 *   - 列表来自中枢合约的存储（inbox / outbox），多节点严格一致读取：发件人、区块、时间、内容指纹都由链上决定；
 *   - 每条的内容从任意节点取回，必须与链上指纹一致（keccak256(ref ‖ keccak256(payload))），对不上就换节点；
 *   - 已静音的发件人不下载内容。
 * 目前只读本链（BNB）。其他链启用后，按收信链逐条链读取再合并。
 */
/** 每页里，每个陌生发件人（从没给他发过信）最多取回几条内容：刷信箱的人再多发，也只多花对方几次读取 */
export const STRANGER_PER_PAGE = 3;
export async function listMessages(me: Endpoint, direction: 'in' | 'out', opts: { more?: MoreToken; muted?: Set<string>; contacts?: Set<string>; showAll?: boolean } = {}): Promise<MessagePage> {
  const muted = opts.muted ?? new Set<string>();
  const before = opts.more?.cursor ?? undefined;
  const page = direction === 'in'
    ? await chain.inbox(me.endpoint, { before, limit: PAGE_SIZE })
    : await chain.outbox(me.container, { before, limit: PAGE_SIZE });
  let dropped = 0;
  let unavailable = 0;
  type Entry = { id: string; chainId: number; index: number; to: string; from: string; fromEndpoint: string; blockNumber: number; timestamp: number; digest: string };
  const wanted = (page.items as Entry[]).filter((e) => {
    // 信箱里的条目属于谁由合约存储决定；这里再核对一次，防止模块出错把别人的条目混进来
    const mine = direction === 'in' ? lower(e.to) === lower(me.endpoint) : lower(e.from) === lower(me.container);
    if (!mine) { dropped += 1; return false; }
    return !(direction === 'in' && (muted.has(lower(e.from)) || muted.has(lower(e.fromEndpoint))));
  });
  // 陌生发件人：每人每页只取最新的几条内容，其余折叠（只数条数，不取内容）
  let folded = 0;
  if (direction === 'in' && !opts.showAll) {
    const contacts = opts.contacts ?? new Set<string>();
    const seen = new Map<string, number>();
    // page.items 是从新到旧：按这个顺序计数，保留的就是每人最新的几条
    const keep: Entry[] = [];
    for (const e of wanted) {
      const from = lower(e.from);
      if (contacts.has(from) || from === lower(me.container)) { keep.push(e); continue; }
      const n = (seen.get(from) ?? 0) + 1;
      seen.set(from, n);
      if (n <= STRANGER_PER_PAGE) keep.push(e);
      else folded += 1;
    }
    wanted.splice(0, wanted.length, ...keep);
  }
  // 已最终确认的区块高度：之后的消息标"确认中"（链重组时可能消失或换序号）。
  // 读不到时退回用链上高度：钉住的区块往前 FINALITY_FALLBACK_BLOCKS 个块以内的都算确认中（不依赖本机时钟）
  const fin: bigint | null = wanted.length ? await chain.finalizedBlock().catch(() => null) : null;
  let pinned: bigint | null = null;
  try { pinned = page.block !== undefined && page.block !== null ? BigInt(page.block) : null; } catch { pinned = null; }
  const pendingFrom = fin !== null ? fin : pinned !== null ? pinned - FINALITY_FALLBACK_BLOCKS : null;
  const results: Array<Message | null> = new Array(wanted.length).fill(null);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(FETCH_CONCURRENCY, wanted.length) }, async () => {
    while (next < wanted.length) {
      const i = next++;
      const e = wanted[i];
      if (!e) continue;
      try {
        const cacheKey = `${e.id}:${lower(e.digest)}`;
        let got = payloadCache.get(cacheKey);
        if (!got) {
          got = await chain.fetchMessage(e) as { payload: Uint8Array; ref: string; txHint?: string | null };
          // 没带交易线索的不缓存：下次加载换节点重取（单个节点省略线索就能让附件一直核对不了）
          if (got.txHint) payloadCache.set(cacheKey, got);
          if (payloadCache.size > PAYLOAD_CACHE_MAX) payloadCache.delete(payloadCache.keys().next().value!);
        }
        const toParsed = parseEndpointId(e.to);
        if (!toParsed) { dropped += 1; continue; }
        results[i] = {
          id: e.id as Hex, chainId: e.chainId, index: e.index, blockNumber: e.blockNumber, timestamp: e.timestamp,
          to: lower(toParsed.container) as Hex, toEndpoint: lower(e.to) as Hex, from: lower(e.from) as Hex, fromEndpoint: lower(e.fromEndpoint) as Hex,
          ref: lower(got.ref) as Hex, digest: lower(e.digest) as Hex, payload: got.payload, direction,
          // 两样都读不到（极少见）：一律标确认中，自动重试会再读
          pending: pendingFrom !== null ? BigInt(e.blockNumber) > pendingFrom : true,
          txHint: got.txHint ? (lower(got.txHint) as Hex) : null,
        };
      } catch {
        unavailable += 1;
      }
    }
  }));
  const items = results.filter((m): m is Message => m !== null);
  items.sort((a, b) => b.timestamp - a.timestamp || b.chainId - a.chainId || b.blockNumber - a.blockNumber || b.index - a.index);
  return { items, dropped, unavailable, folded, more: page.next ? { cursor: page.next, rest: [] } : null };
}

/**
 * 两个信箱的消息总数：只用来"探测有没有新消息"，数字变了才去做完整加载（完整加载仍是多节点严格一致核对）。
 * 所以这里用普通一致规则、一包两个 eth_call，很轻，可以几秒查一次。
 */
export async function boxCounts(me: Endpoint): Promise<string> {
  const [a, b] = await chain.rpc.many([
    { method: 'eth_call', params: [{ to: chain.hub, data: encodeCall(HUB_SEL.inboxCount, ['bytes32'], [me.endpoint]) }, 'latest'] },
    { method: 'eth_call', params: [{ to: chain.hub, data: encodeCall(HUB_SEL.outboxCount, ['address'], [me.container]) }, 'latest'] },
  ]);
  if (!a?.ok || !b?.ok) return '';
  return `${BigInt(a.value)}:${BigInt(b.value)}`;
}

/**
 * 合并收件和发件两个信箱：
 *   - 同一条消息（发给自己时两个信箱里都有）按 id 只留一条；
 *   - 同一发件人发给同一收件人、内容指纹完全相同的，是同一段密文被重复发送（加密每次都带新随机数，正常写的两条不可能相同），
 *     只留最早的一条，记下重复次数。
 */
export function mergeMessages(list: Message[]): Message[] {
  const byId = new Map<string, Message>();
  for (const m of list) {
    const prev = byId.get(m.id);
    if (prev && lower(prev.digest) !== lower(m.digest)) {
      // 同一个 ID、内容指纹却不同：收件和发件两次读取之间链发生了重组。不静默丢掉：留区块更新的那条，标成"确认中"，
      // 列表会因为有确认中的消息自动重新加载，直到两边读到一致
      const keep = m.blockNumber > prev.blockNumber ? m : prev;
      byId.set(m.id, { ...keep, pending: true });
      continue;
    }
    if (!prev || (prev.direction === 'in' && m.direction === 'out')) byId.set(m.id, prev?.pending ? { ...m, pending: true } : m);
  }
  const sorted = [...byId.values()].sort((a, b) => a.timestamp - b.timestamp || a.chainId - b.chainId || a.blockNumber - b.blockNumber || a.index - b.index);
  const firstOf = new Map<string, Message>();
  const out: Message[] = [];
  for (const m of sorted) {
    const key = `${m.fromEndpoint}|${m.toEndpoint}|${m.digest}`;
    const first = firstOf.get(key);
    if (first) { first.copies = (first.copies ?? 1) + 1; continue; }
    const copy = { ...m, copies: 1 };
    firstOf.set(key, copy);
    out.push(copy);
  }
  return out;
}

export interface Conversation {
  /** 对方的端点号 */
  peer: Hex;
  /** 从旧到新 */
  messages: Message[];
  last: Message;
}

/** 按对方分组成会话，最近有消息的在前 */
export function groupConversations(list: Message[], me: Endpoint): Conversation[] {
  const groups = new Map<string, Message[]>();
  for (const m of list) {
    const peer = lower(m.fromEndpoint) === lower(me.endpoint) ? m.toEndpoint : m.fromEndpoint;
    const g = groups.get(peer) ?? [];
    g.push(m);
    groups.set(peer, g);
  }
  const out: Conversation[] = [];
  for (const [peer, messages] of groups) out.push({ peer: peer as Hex, messages, last: messages[messages.length - 1]! });
  return out.sort((a, b) => b.last.timestamp - a.last.timestamp);
}

/** 端点号里的容器地址（其他链上的也照样取出，用于静音、联系人记录） */
export function endpointContainer(endpoint: string): Hex | null {
  const p = parseEndpointId(endpoint);
  return p ? (lower(p.container) as Hex) : null;
}
/** 端点是否在本客户端已启用的链上（其他链暂时不能回复） */
export const isHomeEndpoint = (endpoint: string) => parseEndpointId(endpoint)?.chainId === chain.chainId;

export type TxOutcome = { status: 'success'; blockNumber: bigint; hash: Hex } | { status: 'reverted' | 'replaced' | 'unknown'; hash: Hex };

/** 交易结果里必须看到的 hub 日志：topic0，以及可选的 topic1（容器） */
export interface ExpectedLog { topic0: string; container: string; /** Sent 的 topic2：发件容器 */ from?: string; /** 发交易的钱包：用来核对替换交易 */ wallet?: string; /** 发出后立刻读到的 nonce */ nonce?: number; /** 本次交易的调用数据：替换交易必须和它完全相同才算送达 */ data?: string }

/**
 * 等交易结果：
 *   - 钱包里"取消"或"替换"的交易不算成功，只接受同一笔调用加价重发；
 *   - 没有被替换时，回执的哈希必须就是自己发出的那笔；
 *   - 钱包库拿到的回执只来自一个节点：最后用多节点严格一致读取核对，状态成功、并且回执里有本 hub 的对应日志，才算成功。
 *     节点暂时没看到时按退避重试约 30 秒，仍然不行就是"结果不明"。
 */
export async function confirmTx(
  wait: (args: { hash: Hex; onReplaced: (r: { reason: string; transaction: { hash: Hex } }) => void; timeout: number }) => Promise<{ status: string; transactionHash: Hex } | undefined>,
  hash: Hex,
  expected: ExpectedLog,
): Promise<TxOutcome> {
  let replaced: { reason: string; hash: Hex } | null = null;
  let receipt: { status: string; transactionHash: Hex } | undefined;
  try {
    receipt = await wait({ hash, onReplaced: (r) => { replaced = { reason: r.reason, hash: r.transaction.hash }; }, timeout: 180_000 });
  } catch {
    return { status: 'unknown', hash };
  }
  const rep = replaced as { reason: string; hash: Hex } | null;
  if (rep) {
    // "被取消/被替换/加价重发"都只是钱包库连的那一个节点说的：
    // 替换哈希就是原哈希本身，说明是伪造；先多节点看原交易是不是其实成功了；
    // 再核对替换交易确实是本钱包、同一个 nonce 发出的（nonce 用发出时记下的，被替换后节点已读不到原交易），否则一律"结果不明"
    if (lower(rep.hash) === lower(hash)) return { status: 'unknown', hash };
    const originalState = await strictReceiptState(lower(hash) as Hex);
    if (originalState !== 'none' && originalState !== 'error') return judge(originalState, lower(hash) as Hex, expected);
    const origin = expected.nonce !== undefined && expected.wallet ? { from: lower(expected.wallet), nonce: expected.nonce, input: '' } : await strictTxOrigin(hash);
    const replacementOrigin = await strictTxOrigin(rep.hash);
    const genuine = Boolean(origin && replacementOrigin && origin.from === replacementOrigin.from && origin.nonce === replacementOrigin.nonce && (!expected.wallet || origin.from === lower(expected.wallet)));
    if (!genuine) return { status: 'unknown', hash };
    // 替换交易的调用数据和本次完全相同，才是"同一条消息加速送达"；不同就是别的交易占了这个 nonce（本条没有上链）
    const sameCall = Boolean(expected.data && replacementOrigin && replacementOrigin.input === lower(expected.data));
    if (rep.reason !== 'repriced') {
      // 判"已替换"必须所有节点一致回答原交易没有回执，并且替换交易确实上链了
      const replacement = await strictReceiptLogs(lower(rep.hash) as Hex).catch(() => null);
      if (!replacement || originalState !== 'none') return { status: 'unknown', hash };
      // 替换原因也是那一个节点算出来的：替换交易里有对应的消息日志，就是加速送达了，不是"没有生效"
      const judged = judge(replacement, lower(rep.hash) as Hex, expected);
      if (judged.status === 'success' && sameCall) return judged;
      return replacement.status === 'success' ? { status: 'replaced', hash: rep.hash } : { status: 'unknown', hash };
    }
  }
  const finalHash = lower(rep ? rep.hash : hash) as Hex;
  if (rep && expected.data) {
    const again = await strictTxOrigin(finalHash).catch(() => null);
    if (!again || again.input !== lower(expected.data)) return { status: 'unknown', hash };
  }
  if (!rep && receipt && lower(receipt.transactionHash) !== lower(hash)) return { status: 'unknown', hash };
  for (let i = 0; i < 6; i++) {
    const strict = await strictReceiptLogs(finalHash).catch(() => null);
    if (strict) return judge(strict, finalHash, expected);
    if (i < 5) await new Promise((r) => setTimeout(r, 2000 * 2 ** Math.min(i, 3)));
  }
  return { status: 'unknown', hash: finalHash };
}

/** 回执里必须有本 hub 的对应日志：事件、容器（发送时还有发件容器）都对得上才算成功 */
function judge(strict: { status: 'success' | 'reverted'; blockNumber: bigint; logs: StrictLog[] }, hash: Hex, expected: ExpectedLog): TxOutcome {
  if (strict.status !== 'success') return { status: 'reverted', hash };
  const word = (a: string) => '0x' + lower(a).slice(2).padStart(64, '0');
  const hasLog = strict.logs.some((l) => lower(l.address) === hubAddress.toLowerCase() && lower(l.topics[0] ?? '') === expected.topic0
    && lower(l.topics[1] ?? '') === word(expected.container) && (!expected.from || lower(l.topics[2] ?? '') === word(expected.from)));
  return hasLog ? { status: 'success', blockNumber: strict.blockNumber, hash } : { status: 'unknown', hash };
}
export const HUB_TOPICS = HUB_TOPIC as { Sent: string; KeyPublished: string; KeyRevoked: string };

interface StrictLog { address: string; topics: string[]; data: string; logIndex: number }
type StrictReceipt = { status: 'success' | 'reverted'; blockNumber: bigint; logs: StrictLog[] };
/** 多节点严格一致读取回执（TAP-10 §8.3 第 1 步的读法），带日志。没读到一致答案（出错、分歧）返回 null */
async function strictReceiptLogs(hash: Hex): Promise<StrictReceipt | null> {
  const r = await strictReceiptState(hash);
  return r === 'none' || r === 'error' ? null : r;
}
/** 同上，但区分"所有节点一致回答没有回执"（none）和"没读到一致答案"（error）：只有 none 才能当作"没有上链" */
async function strictReceiptState(hash: Hex): Promise<StrictReceipt | 'none' | 'error'> {
  const [a] = await chain.rpc.many([{ method: 'eth_getTransactionReceipt', params: [hash], normalize: normalizeReceipt }], { all: true }).catch(() => [{ ok: false }]);
  if (!a || !a.ok) return 'error';
  if (a.raw === null) return 'none';
  if (!a.raw) return 'error';
  const logs = (Array.isArray(a.raw.logs) ? a.raw.logs : []).map((l: { address: string; topics: string[]; data: string; logIndex: string | number }) => ({
    address: l.address, topics: l.topics, data: l.data, logIndex: Number(BigInt(l.logIndex)),
  }));
  return { status: a.raw.status === '1' ? 'success' : 'reverted', blockNumber: BigInt(a.raw.blockNumber), logs };
}

/** 多节点严格一致读取一笔交易的发送方和 nonce（交易池里或已上链的都能读到）；读不到一致答案返回 null */
async function strictTxOrigin(hash: Hex): Promise<{ from: string; nonce: number; input: string } | null> {
  const [a] = await chain.rpc.many([{
    method: 'eth_getTransactionByHash', params: [lower(hash)],
    normalize: (v: { from?: string; nonce?: string; input?: string } | null) => (v && typeof v.from === 'string' && typeof v.nonce === 'string' ? { from: lower(v.from), nonce: v.nonce, input: lower(String(v.input ?? '')) } : null),
  }], { all: true }).catch(() => [{ ok: false }]);
  if (!a || !a.ok || !a.raw) return null;
  const n = Number(BigInt(a.raw.nonce));
  return Number.isSafeInteger(n) ? { from: a.raw.from, nonce: n, input: a.raw.input } : null;
}

// 结果不明的发送：按"钱包 + 容器"记在本机，写消息据此阻止重发。
// 只在多节点一致确认"已上链"时自动解除；判断出"没有上链"时只提示，由用户核对"已发送"后手动放行——
// 钱包加速替换时消息可能已经由另一笔交易送达，自动放行会让同一条消息发两次。
interface PendingSend { hash: Hex; at: number; nonce?: number; to?: string; from?: string }
const pendingKey = (container: string, wallet: string) => `tapesend:unknown-tx:${lower(wallet)}:${lower(container)}`;
export function unknownSends(container: string, wallet: string): PendingSend[] {
  try {
    const v = JSON.parse(localStorage.getItem(pendingKey(container, wallet)) ?? '[]');
    return Array.isArray(v) ? v.filter((x) => x && typeof x.hash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(x.hash)).slice(-20) : [];
  } catch {
    return [];
  }
}
/** 读-改-写都在同一个同步片段里完成：重查期间新记下的发送不会被旧列表覆盖 */
function updateSends(container: string, wallet: string, change: (list: PendingSend[]) => PendingSend[]): boolean {
  try {
    const list = change(unknownSends(container, wallet)).slice(-20);
    if (list.length) localStorage.setItem(pendingKey(container, wallet), JSON.stringify(list));
    else localStorage.removeItem(pendingKey(container, wallet));
    return true;
  } catch {
    return false;
  }
}
// "发送中 / 钱包出错"锁：调起钱包之前就写下（没有哈希），拿到哈希或用户明确拒绝后删掉；钱包出错时保留，要用户手动放行。
// 同样按"钱包 + 容器"存本机：关掉撰写框、刷新、换标签页都还在
const lockKey = (container: string, wallet: string) => `tapesend:send-lock:${lower(wallet)}:${lower(container)}`;
export function sendLock(container: string, wallet: string): { state: 'sending' | 'wallet-error'; at: number } | null {
  try {
    const v = JSON.parse(localStorage.getItem(lockKey(container, wallet)) ?? 'null');
    if (!v || (v.state !== 'sending' && v.state !== 'wallet-error') || typeof v.at !== 'number') return null;
    // 调起钱包后 10 分钟都没有结果的"发送中"，按钱包出错处理（页面可能在等待时被关掉了）
    return v.state === 'sending' && Date.now() - v.at > 10 * 60_000 ? { state: 'wallet-error', at: v.at } : v;
  } catch {
    return null;
  }
}
export function setSendLock(container: string, wallet: string, state: 'sending' | 'wallet-error' | null) {
  try {
    if (state) localStorage.setItem(lockKey(container, wallet), JSON.stringify({ state, at: Date.now() }));
    else localStorage.removeItem(lockKey(container, wallet));
  } catch {
    // 忽略
  }
}

/** 钱包一返回交易哈希就记下（这之后页面被关掉、App 被系统杀掉也不会重发） */
/** 返回是否真的写进了本机存储：写不进去时调用方必须保留发送锁，否则会出现"既无锁又无记录"的重发窗口 */
export function recordSend(container: string, wallet: string, hash: Hex, extra: { to?: string; nonce?: number } = {}): boolean {
  const ok = updateSends(container, wallet, (list) => [...list.filter((x) => lower(x.hash) !== lower(hash)), { hash, at: Date.now(), from: lower(container), ...extra }]);
  return ok && unknownSends(container, wallet).some((x) => lower(x.hash) === lower(hash));
}
/** 刚发出的交易还在交易池里，多节点一致读到它的 nonce 就记下（被替换后节点就读不到了） */
export async function noteSendNonce(container: string, wallet: string, hash: Hex, tries = 4): Promise<number | undefined> {
  // 刚广播时各节点交易池还不同步，严格读取常常读不到一致答案：退避重试几次
  for (let i = 0; i < tries; i++) {
    const origin = await strictTxOrigin(hash).catch(() => null);
    if (origin && origin.from === lower(wallet)) {
      updateSends(container, wallet, (list) => list.map((x) => (lower(x.hash) === lower(hash) ? { ...x, nonce: origin.nonce } : x)));
      return origin.nonce;
    }
    if (i < tries - 1) await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
  }
  return undefined;
}
export function forgetSend(container: string, wallet: string, hash?: Hex) {
  updateSends(container, wallet, (list) => (hash ? list.filter((x) => lower(x.hash) !== lower(hash)) : []));
}

/** 多节点一致读取账户已确认的交易数（nonce） */
async function confirmedNonce(wallet: string): Promise<number | null> {
  const [a] = await chain.rpc.many([{ method: 'eth_getTransactionCount', params: [lower(wallet), 'latest'] }], { all: true }).catch(() => [{ ok: false }]);
  if (!a || !a.ok || typeof a.value !== 'string') return null;
  const n = Number(BigInt(a.value));
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * 重新看一遍结果不明的发送：
 *   - landed：多节点一致读到回执，移出（成功的提示"已发出"，回滚的提示"执行失败"）；
 *   - gone：所有节点一致回答没有回执、交易本身的 nonce（多节点一致读到、确属本钱包）已被账户确认越过——这笔永远不会上链。
 *     只提示，不移出：可能是被加速替换、消息已经送达，要用户去"已发送"核对后手动放行；
 *   - 其余保持不变。
 */
export async function recheckUnknownSends(container: string, wallet: string): Promise<{ left: PendingSend[]; landed: Hex[]; landedTo: string[]; reverted: Hex[]; gone: Hex[] }> {
  const landed: Hex[] = [];
  const landedTo: string[] = [];
  const reverted: Hex[] = [];
  const gone: Hex[] = [];
  const list = unknownSends(container, wallet);
  let count: number | null | undefined;
  for (const x of list) {
    // 先读 nonce、再读回执：避免"读回执时还没上链、读计数时刚上链"被误判为永远不会上链。nonce 优先用发出时记下的
    const read = x.nonce === undefined ? await strictTxOrigin(x.hash).catch(() => null) : null;
    const nonce = x.nonce ?? (read && read.from === lower(wallet) ? read.nonce : undefined);
    if (nonce !== undefined && count === undefined) count = await confirmedNonce(wallet).catch(() => null);
    const state = await strictReceiptState(lower(x.hash) as Hex);
    if (state !== 'none' && state !== 'error') {
      // 回执成功还要有对应的 Sent 日志才算"已发出"
      // x.to 是收件端点号；旧版记录存的是容器地址，按本链端点号换算
      const toEp = x.to ? (/^0x[0-9a-f]{40}$/i.test(x.to) ? endpointId(HOME_CHAIN_ID, x.to) : lower(x.to)) : undefined;
      const ok = toEp ? judge(state, lower(x.hash) as Hex, { topic0: HUB_TOPIC.Sent, container: toEp, from: x.from }).status === 'success' : state.status === 'success';
      (ok ? landed : reverted).push(x.hash);
      const peer = ok && toEp ? parseEndpointId(toEp) : null;
      if (peer) landedTo.push(lower(peer.container));
      continue;
    }
    if (state === 'none' && nonce !== undefined && typeof count === 'number' && count > nonce) gone.push(x.hash);
  }
  const decided = new Set([...landed, ...reverted].map(lower));
  updateSends(container, wallet, (cur) => cur.filter((x) => !decided.has(lower(x.hash))));
  return { left: unknownSends(container, wallet), landed, landedTo, reverted, gone };
}

/** 打开一条消息：公开的直接解；加密的把本钱包在这个容器下解锁过的钥匙全部试一遍（TAP-10 §5.3：任一钥匙解出即为 ok） */
export function openMessage(m: Message, wallet: string, myContainer: string): OpenedMessage {
  const keys = unlockedKeys(wallet, myContainer);
  const attempts: Array<Uint8Array | undefined> = keys.length ? keys.map((k) => k.secretKey) : [undefined];
  let sawDamaged = false;
  let sawNotForKey = false;
  for (const secretKey of attempts) {
    try {
      const r = openPayload({ payload: m.payload, secretKey, to: m.toEndpoint, from: m.fromEndpoint, hub: hubAddress, ref: m.ref });
      const c = decodeContent(r.content);
      if (c.kind !== 'message') return { status: 'unsupported', kind: r.kind };
      return {
        status: 'ok', kind: r.kind, subject: displayText(c.subject ?? ''), body: displayText(c.body), rawSubject: c.subject ?? '',
        attachments: (c.attachments ?? []) as Attachment[], badAttachments: c.badAttachments ?? 0,
      };
    } catch (e) {
      if (e instanceof TapeSendError && e.code === 'not-for-key') sawNotForKey = true;
      else if (e instanceof TapeSendError && e.code === 'unsupported') return { status: 'unsupported' };
      else sawDamaged = true;
    }
  }
  if (sawDamaged) return { status: 'damaged' };
  if (sawNotForKey) return { status: keys.length ? 'not-for-key' : 'locked', kind: 'sealed' };
  return { status: 'damaged' };
}

// ---------------------------------------------------------------- 联系人记录（TAP-10 §9 第 3 步、§8.4）

const tofuKey = (me: string, peer: string) => `tapesend:peer:${lower(me)}:${lower(peer)}`;
interface PeerRecord { key: string; keyIndex: number; holder: string }

/** 和上次往来时相比：持有人变了，或原来有公钥、现在换了一把 */
export function peerChanged(me: string, peer: Endpoint): boolean {
  try {
    const raw = localStorage.getItem(tofuKey(me, peer.container));
    if (!raw) return false;
    const r = JSON.parse(raw) as PeerRecord;
    const holder = lower(peer.holder ?? '');
    if (r.holder && r.holder !== holder) return true;
    const key = peer.key.usable ? lower(peer.key.key) : '';
    return Boolean(r.key && key && (r.key !== key || r.keyIndex !== peer.key.keyIndex));
  } catch {
    return false;
  }
}
export function knownPeer(me: string, peer: string): boolean {
  try {
    return localStorage.getItem(tofuKey(me, peer)) !== null;
  } catch {
    return false;
  }
}
/** 本机记住的对方持有人钱包（上次往来或第一次收到核实过的消息时记下的） */
export function peerHolder(me: string, peer: string): string | null {
  try {
    const raw = localStorage.getItem(tofuKey(me, peer));
    return raw ? (lower((JSON.parse(raw) as PeerRecord).holder ?? '') || null) : null;
  } catch {
    return null;
  }
}
/** 第一次收到对方核实过发件钱包的消息时就记下（不等到自己回复）；已有记录不覆盖：换主要靠它发现 */
export function notePeerSender(me: string, peer: string, wallet: string) {
  try {
    if (localStorage.getItem(tofuKey(me, peer)) !== null) return;
    const r: PeerRecord = { key: '', keyIndex: 0, holder: lower(wallet) };
    localStorage.setItem(tofuKey(me, peer), JSON.stringify(r));
  } catch {
    // 忽略
  }
}
/** 联系人：自己给他发过信的容器（本机记录）。收信时陌生发件人的内容按页限量取回 */
const contactsKey = (me: string) => `tapesend:contacts:${lower(me)}`;
export function contacts(me: string): Set<string> {
  try {
    const v = JSON.parse(localStorage.getItem(contactsKey(me)) ?? '[]');
    return new Set(Array.isArray(v) ? v.filter((x) => typeof x === 'string' && /^0x[0-9a-f]{40}$/.test(x)) : []);
  } catch {
    return new Set();
  }
}
export function addContacts(me: string, peers: string[]) {
  try {
    const cur = contacts(me);
    const before = cur.size;
    for (const p of peers) if (/^0x[0-9a-fA-F]{40}$/.test(p)) cur.add(lower(p));
    if (cur.size !== before) localStorage.setItem(contactsKey(me), JSON.stringify([...cur].slice(-2000)));
  } catch {
    // 忽略：只影响陌生人限量
  }
}
/** 任何一次成功往来之后记录（密封或公开都记），用来发现之后的换主和换钥匙 */
export function rememberPeer(me: string, peer: Endpoint) {
  addContacts(me, [peer.container]);
  try {
    const r: PeerRecord = { key: peer.key.usable ? lower(peer.key.key) : '', keyIndex: peer.key.usable ? peer.key.keyIndex : 0, holder: lower(peer.holder ?? '') };
    localStorage.setItem(tofuKey(me, peer.container), JSON.stringify(r));
  } catch {
    // 忽略
  }
}

// 本地静音（TAP-10 §8.4）：只存在这台设备
const muteKey = (me: string) => `tapesend:muted:${lower(me)}`;
export function mutedSenders(me: string): Set<string> {
  try {
    const v = JSON.parse(localStorage.getItem(muteKey(me)) ?? '[]');
    return new Set(Array.isArray(v) ? v.filter((x) => typeof x === 'string').map(lower) : []);
  } catch {
    return new Set();
  }
}
export function setMuted(me: string, sender: string, muted: boolean) {
  try {
    const s = mutedSenders(me);
    s.delete(lower(sender));
    if (muted) s.add(lower(sender));
    // 超过 1000 个时丢掉最早的，新静音的一定生效
    localStorage.setItem(muteKey(me), JSON.stringify([...s].slice(-1000)));
  } catch {
    // 忽略
  }
}

// ---------------------------------------------------------------- 发消息

/** 能不能给这个端点发密封消息：套件是 1、可用、公钥本身合法 */
export function canSeal(ep: Endpoint): boolean {
  if (!ep.key.usable || ep.key.suite !== 1) return false;
  try {
    assertValidPublicKey(hexToBytes(ep.key.key, 32));
    return true;
  } catch {
    return false;
  }
}

export type PreparedSend = { tx: { to: Hex; data: Hex }; sealed: boolean; recipientVersion: number };

/** me 和 to 都必须是发送前刚从链上重新读到的（TAP-10 §9 第 2、5 步） */
/** 对方的收信链位图是否包含某条链（按原始位图；客户端不认识的链号一律视为不包含） */
export function readsChain(to: Endpoint, chainId: number): boolean {
  const c = chainById(chainId);
  if (!c) return false;
  return ((BigInt(to.key.chainsBits ?? 0n) >> BigInt(c.index)) & 1n) === 1n;
}

export function prepareSend(p: { me: Endpoint; wallet: string; to: Endpoint; subject: string; body: string; publicOk: boolean; ref?: Hex; attachments?: Attachment[] }): PreparedSend {
  const content = encodeContent({ subject: p.subject, body: p.body, ts: Date.now(), attachments: p.attachments ?? [] });
  const ref = p.ref ?? (('0x' + '0'.repeat(64)) as Hex);
  let payload: Uint8Array;
  let sealed = false;
  // 对方公钥可用、但收信链位图里没有本链那一位：发出去对方不会读，直接拒绝（按原始位图判断，不认识的链不会让检查被跳过）
  if (p.to.key.usable && !readsChain(p.to, p.me.chainId)) throw new TapeSendError('wrong-chain', 'recipient does not read this chain');
  if (canSeal(p.to)) {
    const recipient = hexToBytes(p.to.key.key, 32);
    const recipients = [recipient];
    // 自己的副本只加密给"链上当前、属于本钱包、合法"的公钥：撤销或轮换过的旧钥匙不再收到副本
    if (canSeal(p.me) && lower(p.me.key.current) === lower(p.wallet)) {
      const mine = hexToBytes(p.me.key.key, 32);
      if (bytesToHex(mine) !== bytesToHex(recipient)) recipients.push(mine);
    }
    payload = seal({ content, recipients, to: p.to.endpoint, from: p.me.endpoint, hub: hubAddress, ref });
    sealed = true;
  } else {
    if (!p.publicOk) throw new TapeSendError('no-key', 'recipient has no usable key');
    payload = encodePublic(content);
  }
  const tx = chain.encodeSend({ circuits: p.me.circuits, tokenId: p.me.tokenId, to: p.to.endpoint, ref, payload }) as { to: Hex; data: Hex };
  return { tx, sealed, recipientVersion: p.to.key.version };
}

/** 回复主题：用原始主题，加 Re: 后按字符截到 200 */
export function replySubject(raw: string): string {
  const s = raw && !/^re:/i.test(raw) ? `Re: ${raw}` : raw;
  return [...s].slice(0, 200).join('');
}

/**
 * 粘滞的安全状态（TAP-10 §3.5、§8.7）：电路合约一旦被发现更换就一直停用；
 * 工厂封印曾经生效、之后在不低于那次的区块上又读到不生效，就一直警告（临时替换再换回来，本机记住的状态不会恢复）。
 * 用区块号比较，避免节点故障时先读到新块、后读到旧块造成误报。
 */
// 各链中枢地址相同：按"链号 + 中枢"区分，多链启用后各链的封印状态不会互相覆盖
const stickyKey = () => `tapesend:sticky:${chain.chainId}:${hubAddress.toLowerCase()}`;
export function stickyFactory(f: Endpoint['factory'], block: string): Endpoint['factory'] {
  let st = { circuitsChanged: false, inEffectAt: '', lostSeal: false };
  try {
    st = { ...st, ...JSON.parse(localStorage.getItem(stickyKey()) ?? '{}') };
  } catch {
    // 读不到就从头记
  }
  let at: bigint;
  try {
    at = BigInt(block);
  } catch {
    return { ...f, lostSeal: st.lostSeal };
  }
  const firstInEffect = st.inEffectAt ? BigInt(st.inEffectAt) : null;
  const next = {
    circuitsChanged: st.circuitsChanged || !f.circuitsIntact,
    inEffectAt: f.inEffect && (firstInEffect === null || at < firstInEffect) ? at.toString() : st.inEffectAt,
    lostSeal: st.lostSeal || (firstInEffect !== null && !f.inEffect && at >= firstInEffect),
  };
  try {
    localStorage.setItem(stickyKey(), JSON.stringify(next));
  } catch {
    // 忽略
  }
  return { sealed: f.sealed, inEffect: f.inEffect && !next.lostSeal, circuitsIntact: f.circuitsIntact && !next.circuitsChanged, lostSeal: next.lostSeal };
}

export const payloadLimit = 16_000;
export { TapeSendError };

// ---------------------------------------------------------------- 附件：代币、NFT、原生币（随消息转进对方的电路容器）

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
/** BNB 链上常见代币：同名但合约地址不同的，界面上标为可能是仿冒 */
export const KNOWN_TOKENS: Record<string, string> = {
  USDT: '0x55d398326f99059ff775485246999027b3197955',
  USDC: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d',
  BUSD: '0xe9e7cea3dedca5984780bafc599bd69add087d56',
  FDUSD: '0xc5f0f7b66764f6ec8c8dff7ba683102295e16409',
  WBNB: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',
  BTCB: '0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c',
  ETH: '0x2170ed0880ac9a755fd29b2688956bd959f933f8',
  BEM: '0x5ce033b2bfca3af30b3e8c8457deaf776a8b695a',
};
/** 原生币等保留符号：任何代币合约自称这些都是仿冒 */
const RESERVED_SYMBOLS = new Set(['BNB', 'ETH', 'OKB']);
// 常见的形近字（西里尔、希腊字母等）→ 拉丁字母
const CONFUSABLE: Record<string, string> = {
  'А': 'A', 'В': 'B', 'С': 'C', 'Е': 'E', 'Н': 'H', 'І': 'I', 'Ј': 'J', 'К': 'K', 'М': 'M', 'О': 'O', 'Р': 'P', 'Ѕ': 'S', 'Т': 'T', 'Х': 'X', 'У': 'Y',
  'а': 'A', 'в': 'B', 'с': 'C', 'е': 'E', 'н': 'H', 'і': 'I', 'ј': 'J', 'к': 'K', 'м': 'M', 'о': 'O', 'р': 'P', 'ѕ': 'S', 'т': 'T', 'х': 'X', 'у': 'Y',
  'Α': 'A', 'Β': 'B', 'Ε': 'E', 'Η': 'H', 'Ι': 'I', 'Κ': 'K', 'Μ': 'M', 'Ν': 'N', 'Ο': 'O', 'Ρ': 'P', 'Τ': 'T', 'Χ': 'X', 'Υ': 'Y', 'Ζ': 'Z',
  '₮': 'T', '＄': '$',
};
/** 代币符号的"骨架"：兼容分解、去掉所有不可见和格式字符、形近字换成拉丁字母、转大写 */
export function symbolSkeleton(symbol: string): string {
  return [...symbol.normalize('NFKC')]
    .filter((c) => !/[\p{Cf}\p{Cc}\p{Z}\p{M}]/u.test(c))
    .map((c) => CONFUSABLE[c] ?? c)
    .join('')
    .toUpperCase();
}
export const isKnownToken = (token: string) => Object.values(KNOWN_TOKENS).includes(lower(token));
/** 看起来像某个常见代币（或原生币），但合约地址不是它：可能是仿冒 */
export function lookalikeToken(symbol: string, token: string): boolean {
  // 名单里的合约本身不是仿冒（例如真的 Binance-Peg ETH）
  if (isKnownToken(token)) return false;
  // 符号里有任何非 ASCII 字符：一律当作可疑（形近字名单永远列不全，例如利索字母、切罗基字母、小型大写字母）。
  // 显示前被换成 \u{…} 可见形式的不可见字符也算
  if (/[^\x20-\x7e]/.test(symbol) || /\\u\{[0-9a-f]+\}/i.test(symbol)) return true;
  const sk = symbolSkeleton(symbol);
  if (RESERVED_SYMBOLS.has(sk)) return true;
  if (KNOWN_TOKENS[sk]) return true;
  // 纯英文变体：常见币名加几个字符（USDT0、USDT.E、USDT(BSC)、XUSDC……）。ETH、WBNB 不在这里（ETHFI、STETH 这类正常代币太多）
  const letters = sk.replace(/[^A-Z0-9]/g, '');
  return VARIANT_BASES.some((k) => letters.includes(k) && letters.length - k.length <= 5);
}
const VARIANT_BASES = ['USDT', 'USDC', 'BUSD', 'FDUSD', 'BTCB', 'BEM'];

const sel = (hex: string) => hex as `0x${string}`;
async function viewCall(to: string, data: string, types: string[], strict = false): Promise<unknown[] | null> {
  const [oc] = await chain.rpc.many([{ method: 'eth_call', params: [{ to, data }, 'latest'] }], strict ? { all: true } : undefined).catch(() => [{ ok: false }]);
  if (!oc || !oc.ok || typeof oc.value !== 'string' || oc.value === '0x') return null;
  try { return decodeResult(types, oc.value); } catch { return null; }
}

export interface TokenInfo { symbol: string; name: string; decimals: number }
/** 读代币 / NFT 合约的名字、符号、小数位（只用于显示；读不到时返回空） */
/** 常见代币的小数位写死（BNB 链主网）：不靠节点报，两个串通的节点也改不了显示金额 */
const KNOWN_DECIMALS: Record<string, number> = { USDT: 18, USDC: 18, BUSD: 18, FDUSD: 18, WBNB: 18, BTCB: 18, ETH: 18, BEM: 8 };
export async function tokenInfo(kind: 'erc20' | 'erc721', token: string): Promise<TokenInfo | null> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(token)) return null;
  if (kind === 'erc20') {
    const known = Object.entries(KNOWN_TOKENS).find(([, a]) => a === lower(token));
    if (known && KNOWN_DECIMALS[known[0]] !== undefined) return { symbol: known[0], name: known[0], decimals: KNOWN_DECIMALS[known[0]]! };
  }
  const [sym, name, dec] = await Promise.all([
    viewCall(token, sel('0x95d89b41'), ['string']),
    viewCall(token, sel('0x06fdde03'), ['string']),
    kind === 'erc20' ? viewCall(token, sel('0x313ce567'), ['uint']) : Promise.resolve([0n]),
  ]);
  if (!sym && !name) return null;
  const decimals = dec ? Number(dec[0] as bigint) : NaN;
  if (kind === 'erc20' && (!Number.isInteger(decimals) || decimals < 0 || decimals > 36)) return null;
  return { symbol: displayText(String(sym?.[0] ?? '')).slice(0, 24), name: displayText(String(name?.[0] ?? '')).slice(0, 64), decimals: kind === 'erc20' ? decimals : 0 };
}
export async function erc20Balance(token: string, owner: string): Promise<bigint | null> {
  const r = await viewCall(token, encodeCall('0x70a08231', ['address'], [lower(owner)]), ['uint']);
  return r ? (r[0] as bigint) : null;
}
export async function nativeBalance(owner: string): Promise<bigint | null> {
  const [oc] = await chain.rpc.many([{ method: 'eth_getBalance', params: [lower(owner), 'latest'] }]).catch(() => [{ ok: false }]);
  return oc && oc.ok && typeof oc.value === 'string' ? BigInt(oc.value) : null;
}
export async function nftOwner(token: string, tokenId: string): Promise<string | null> {
  const r = await viewCall(token, encodeCall('0x6352211e', ['uint256'], [BigInt(tokenId)]), ['address']);
  return r ? lower(r[0] as string) : null;
}

/** 金额：界面输入的十进制（如 "1.5"）↔ 最小单位 */
export function parseUnits(input: string, decimals: number): bigint | null {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(input.trim());
  if (!m) return null;
  const frac = (m[2] ?? '');
  if (frac.length > decimals) return null;
  return BigInt(m[1]!) * 10n ** BigInt(decimals) + BigInt((frac + '0'.repeat(decimals)).slice(0, decimals) || '0');
}
export function formatUnits(v: string | bigint, decimals: number): string {
  const n = BigInt(v);
  const base = 10n ** BigInt(decimals);
  const whole = n / base;
  const frac = (n % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole.toString();
}

export type AssetDraft =
  | { type: 'native'; amount: string }
  | { type: 'erc20'; token: Hex; amount: string }
  | { type: 'erc721'; token: Hex; tokenId: string };

/** 把资产转进对方电路容器的交易（由本钱包直接发出；消息合约不经手任何资产） */
export function transferTx(a: AssetDraft, wallet: string, toContainer: string): { to: Hex; data?: Hex; value?: bigint } {
  if (a.type === 'native') return { to: lower(toContainer) as Hex, value: BigInt(a.amount) };
  if (a.type === 'erc20') return { to: a.token, data: encodeCall('0xa9059cbb', ['address', 'uint256'], [lower(toContainer), BigInt(a.amount)]) as Hex };
  // transferFrom（不用 safeTransferFrom）：容器是账户合约，不需要回调确认
  return { to: a.token, data: encodeCall('0x23b872dd', ['address', 'address', 'uint256'], [lower(wallet), lower(toContainer), BigInt(a.tokenId)]) as Hex };
}

async function strictTx(hash: Hex): Promise<{ from: string; to: string; value: bigint } | null | 'none'> {
  const [a] = await chain.rpc.many([{
    method: 'eth_getTransactionByHash', params: [lower(hash)],
    normalize: (v: { from?: string; to?: string | null; value?: string } | null) => (v && typeof v.from === 'string' && typeof v.value === 'string' ? { from: lower(v.from), to: lower(String(v.to ?? '')), value: v.value } : null),
  }], { all: true }).catch(() => [{ ok: false }]);
  if (!a || !a.ok) return null;
  if (a.raw === null) return 'none';
  if (!a.raw) return null;
  try { return { from: a.raw.from, to: a.raw.to, value: BigInt(a.raw.value) }; } catch { return null; }
}

/**
 * 资产附件核对结果：
 *   ok           链上确实转进了收件容器；付款钱包就是发出这条消息的钱包；转账不晚于消息、早得不超过 1 小时
 *   third-party  转账是真的，但付款钱包不是发这条消息的钱包：不能证明是对方付的
 *   late         转账发生在消息之后：不能证明是为这条消息付的
 *   stale        转账比消息早了 1 小时以上：可能是以前为别的事付的
 *   mismatch     链上没有对应的转账（或交易根本不存在）
 * known：代币在常见代币名单里（原生币为真）。
 */
export type AttachmentCheck =
  | { status: 'ok' | 'third-party' | 'late' | 'stale' | 'not-first' | 'crowded'; from: string; known: boolean }
  | { status: 'mismatch' | 'unavailable' | 'other-chain' | 'pending' | 'indirect' | 'unverifiable' };
const checkCache = new Map<string, Promise<AttachmentCheck>>();
/** 转账早于消息的最长间隔（秒） */
export const TRANSFER_WINDOW_SECONDS = 3600;

/**
 * 发出这条消息的钱包：用消息的交易线索（txHint），多节点严格读回执，确认回执成功、区块就是信箱记录的区块、
 * 里面有这条 Sent（收件端点、发件容器、信箱序号、ref、载荷全都一致），再严格读交易发起者。
 * 合约只允许电路的持有人发消息，所以对普通钱包来说，这就是发消息那一刻的持有人。
 */
const INDIRECT = 'indirect';
const senderCache = new Map<string, Promise<string | null>>();
/** 返回发件钱包地址；'indirect' = 消息不是钱包直接发给中枢的，认定不了；null = 暂时读不到 */
export function messageSender(m: Message): Promise<string | null> {
  const key = `${m.id}:${m.digest}`;
  let p = senderCache.get(key);
  if (!p) {
    p = (async () => {
      if (!m.txHint) return null;
      const rc = await strictReceiptState(m.txHint);
      if (rc === 'none' || rc === 'error' || rc.status !== 'success' || rc.blockNumber !== BigInt(m.blockNumber)) return null;
      const payload = bytesToHex(m.payload);
      const found = rc.logs.some((l) => {
        let d: { to: string; from: string; ref: string; inboxIndex: bigint; payload: Uint8Array } | null = null;
        try { d = chain.decodeSentLog({ address: l.address, topics: l.topics, data: l.data }); } catch { d = null; }
        return Boolean(d && d.to === lower(m.toEndpoint) && d.from === lower(m.from) && d.inboxIndex === BigInt(m.index)
          && d.ref === lower(m.ref) && bytesToHex(d.payload) === payload);
      });
      if (!found) return null;
      // 同一笔交易里还转移了 NFT（ERC-721 Transfer）：典型的"被授权合约借走电路、冒充持有人发消息、再还回去"，
      // 认定不了真正的发件人（合约没有禁止合约持有人发消息，只能在这里识别）
      if (rc.logs.some((l) => l.topics.length === 4 && lower(l.topics[0] ?? '') === TRANSFER_TOPIC)) return INDIRECT;
      const tx = await strictTx(m.txHint);
      if (!tx || tx === 'none') return null;
      // 只认"钱包直接调用中枢"的交易：经别的合约转手时，交易发起者不一定是电路持有人（持有人可能是那个合约），
      // 发起者反而可能是被诱导去调用那个合约的付款人——这种一律认定不了发件钱包
      // 例外：EIP-7702 委托的普通账户自己调用自己（批量），中枢看到的调用者就是这个账户本身
      return tx.to === lower(hubAddress) || tx.to === tx.from ? tx.from : INDIRECT;
    })().catch(() => null);
    senderCache.set(key, p);
    // 读不到不缓存：下次再试。线索可能来自一个说谎的节点，连同内容缓存一起丢掉，重新加载时换节点取
    p.then((r) => { if (r === null) { senderCache.delete(key); payloadCache.delete(key); } });
  }
  return p;
}

/** 区块时间（多节点严格一致） */
async function strictBlockTime(block: bigint): Promise<number | null> {
  const [a] = await chain.rpc.many([{ method: 'eth_getBlockByNumber', params: ['0x' + block.toString(16), false], normalize: normalizeHeader }], { all: true }).catch(() => [{ ok: false }]);
  if (!a || !a.ok || !a.raw) return null;
  const n = Number(BigInt(a.raw.timestamp));
  return Number.isSafeInteger(n) ? n : null;
}

type TransferFound = { status: 'found'; payer: string; txFrom: string; block: bigint; known: boolean };
/**
 * 只核对"这笔转账确实按声明把资产转进了 toContainer"，不管是谁付的、为什么付。
 * 代币的付款方以 Transfer 事件的转出方为准；原生币要求交易直接转给容器。回执、交易都用多节点严格一致读取。
 */
async function checkTransfer(a: Exclude<Attachment, { type: 'image' }>, toContainer: string): Promise<TransferFound | { status: 'mismatch' | 'unavailable' | 'unverifiable' }> {
  const [rc, tx] = await Promise.all([strictReceiptState(a.tx), strictTx(a.tx)]);
  // 所有节点一致说既没有回执也没有这笔交易：编造的交易编号
  if (rc === 'none' && tx === 'none') return { status: 'mismatch' };
  if (rc === 'error' || rc === 'none' || tx === null || tx === 'none') return { status: 'unavailable' };
  if (rc.status !== 'success') return { status: 'mismatch' };
  if (a.type === 'native') {
    // 交易成功、但不是直接转给容器（合约钱包、4337、7702 批量里的内部转账）：看不到内部转账，只能说核实不了，不标红
    if (tx.to !== lower(toContainer)) return { status: 'unverifiable' };
    if (tx.value !== BigInt(a.amount)) return { status: 'mismatch' };
    return { status: 'found', payer: tx.from, txFrom: tx.from, block: rc.blockNumber, known: true };
  }
  const to = '0x' + lower(toContainer).slice(2).padStart(64, '0');
  const word = (n: bigint) => '0x' + n.toString(16).padStart(64, '0');
  const log = rc.logs.find((l) => lower(l.address) === a.token && lower(l.topics[0] ?? '') === TRANSFER_TOPIC && lower(l.topics[2] ?? '') === to && (
    a.type === 'erc20'
      ? l.topics.length === 3 && lower(l.data) === word(BigInt(a.amount))
      : l.topics.length === 4 && lower(l.topics[3] ?? '') === word(BigInt(a.tokenId))
  ));
  if (!log) return { status: 'mismatch' };
  return { status: 'found', payer: '0x' + lower(log.topics[1] ?? '').slice(-40), txFrom: tx.from, block: rc.blockNumber, known: a.type === 'erc20' && isKnownToken(a.token) };
}

/**
 * 到链上核对消息 m 里的资产附件：
 *   1. 那笔转账确实把声明的资产转进了收件容器（checkTransfer）；
 *   2. 付款钱包 = 发出这条消息的钱包（messageSender，按消息交易本身认定，不看"现在"的持有人，
 *      发件人事后把电路转给别人也改变不了结论）。发件容器自己转出、且由同一个钱包发起的也算；
 *   3. 转账不晚于消息，并且早得不超过 1 小时。
 * 通过的记进本机"首次引用"记录（见 claimTransfer），同一笔转账被后来的消息再引用时标成重复。
 */
export function verifyAttachment(a: Attachment, m: Message): Promise<AttachmentCheck> {
  if (a.type === 'image') return Promise.resolve({ status: 'ok', from: '', known: true });
  // 还没最终确认的消息：链重组时它的序号和 ID 可能变，先不核对、不写首次引用记录
  if (m.pending) return Promise.resolve({ status: 'pending' });
  if (a.chainId !== chain.chainId || m.chainId !== chain.chainId) return Promise.resolve({ status: 'other-chain' });
  const key = `${m.id}:${m.digest}:${a.type}:${a.tx}:${'token' in a ? a.token : ''}:${'amount' in a ? a.amount : ''}:${'tokenId' in a ? a.tokenId : ''}`;
  let p = checkCache.get(key);
  if (!p) {
    p = (async (): Promise<AttachmentCheck> => {
      const [t, sender] = await Promise.all([checkTransfer(a, m.to), messageSender(m)]);
      if (t.status !== 'found') return t;
      const from = t.payer;
      if (t.block > BigInt(m.blockNumber)) return { status: 'late', from, known: t.known };
      if (!sender) return { status: 'unavailable' };
      if (sender === INDIRECT) return { status: 'indirect' };
      const bound = from === sender || (from === lower(m.from) && t.txFrom === sender);
      if (!bound) return { status: 'third-party', from, known: t.known };
      const ts = await strictBlockTime(t.block);
      if (ts === null) return { status: 'unavailable' };
      if (m.timestamp - ts > TRANSFER_WINDOW_SECONDS) return { status: 'stale', from, known: t.known };
      // 只有"转账之后，这个钱包发给这个收件端点的第一条消息"能引用这笔转账：只看链上信箱，任何客户端算出的结论都一样，
      // 不依赖本机记录、是否展开、翻到第几页
      const first = await firstAfterTransfer(m, t.block, sender);
      if (first === 'unknown') return { status: 'unavailable' };
      if (first === 'crowded') return { status: 'crowded', from, known: t.known };
      if (first === 'no') return { status: 'not-first', from, known: t.known };
      claimTransfer(a.tx, m.to, { id: m.id, block: m.blockNumber, index: m.index });
      return { status: 'ok', from, known: t.known };
    })();
    checkCache.set(key, p);
    p.then((r) => { if (r.status === 'unavailable') checkCache.delete(key); }, () => checkCache.delete(key));
  }
  return p;
}

/** 转账之后、这条消息之前最多往回看这么多条收件记录；更多（被刷屏）时不给绿框 */
const FIRST_SCAN_MAX = 60;
/**
 * m 是不是"转账区块之后，发件钱包 sender 发给 m.toEndpoint 的第一条消息"：
 * 往回扫收件信箱（多节点严格读），区块不早于转账的条目里，同一发件容器的直接算"不是第一条"；
 * 别的容器的，取回它的交易线索、核对出发件钱包，等于 sender 也算"不是第一条"。
 */
async function firstAfterTransfer(m: Message, transferBlock: bigint, sender: string): Promise<'yes' | 'no' | 'unknown' | 'crowded'> {
  let before: number | undefined = m.index;
  let scanned = 0;
  const others: Array<{ id: string; chainId: number; index: number; to: string; from: string; fromEndpoint: string; blockNumber: number; timestamp: number; digest: string }> = [];
  try {
    while (before !== undefined && before > 0) {
      const page = await chain.inbox(m.toEndpoint, { before, limit: 50 });
      let done = false;
      for (const e of page.items as typeof others) {
        if (BigInt(e.blockNumber) < transferBlock) { done = true; break; }
        if (++scanned > FIRST_SCAN_MAX) return 'crowded';
        if (lower(e.from) === lower(m.from)) return 'no';
        others.push(e);
      }
      if (done || !page.next) break;
      before = Number(page.next);
    }
    for (const e of others) {
      const cacheKey = `${e.id}:${lower(e.digest)}`;
      let got = payloadCache.get(cacheKey);
      if (!got) {
        got = await chain.fetchMessage(e) as { payload: Uint8Array; ref: string; txHint?: string | null };
        if (got.txHint) payloadCache.set(cacheKey, got);
      }
      const toParsed = parseEndpointId(e.to);
      if (!toParsed) continue;
      const w = await messageSender({
        id: e.id as Hex, chainId: e.chainId, index: e.index, blockNumber: e.blockNumber, timestamp: e.timestamp,
        to: lower(toParsed.container) as Hex, toEndpoint: lower(e.to) as Hex, from: lower(e.from) as Hex, fromEndpoint: lower(e.fromEndpoint) as Hex,
        ref: lower(got.ref) as Hex, digest: lower(e.digest) as Hex, pending: false, payload: got.payload, direction: 'in', txHint: got.txHint ? (lower(got.txHint) as Hex) : null,
      });
      if (w === null) return 'unknown';
      if (w === sender) return 'no';
    }
    return 'yes';
  } catch {
    return 'unknown';
  }
}

// 转账的"首次引用"记录：核对通过的附件按交易哈希记下最早引用它的那条消息，持久保存在本机、只会变得更早。
// 只有核对通过（付款钱包就是发消息的钱包）的才记，别人抢先引用你的付款抢不到这个位置。
export interface TransferClaim { id: string; block: number; index: number }
const CLAIMS_KEY = `tapesend:claims:v2:${HOME_CHAIN_ID}`;
const CLAIMS_MAX = 3000;
let claims: Map<string, TransferClaim> | null = null;
const claimListeners = new Set<() => void>();
function loadClaims(): Map<string, TransferClaim> {
  if (claims) return claims;
  claims = new Map();
  try {
    const v = JSON.parse(localStorage.getItem(CLAIMS_KEY) ?? '[]');
    if (Array.isArray(v)) {
      for (const x of v) {
        if (Array.isArray(x) && typeof x[0] === 'string' && x[1] && typeof x[1].id === 'string' && Number.isSafeInteger(x[1].block) && Number.isSafeInteger(x[1].index)) {
          claims.set(x[0], { id: x[1].id, block: x[1].block, index: x[1].index });
        }
      }
    }
  } catch {
    // 忽略：没有记录时只按已加载的消息判断
  }
  return claims;
}
const earlier = (a: TransferClaim, b: TransferClaim) => a.block < b.block || (a.block === b.block && (a.index < b.index || (a.index === b.index && a.id < b.id)));
// 键 = 交易哈希 + 收件容器：一笔交易同时转给两个容器（批量转账）时互不干扰
const claimKey = (tx: string, toContainer: string) => `${lower(tx)}:${lower(toContainer)}`;
export function claimTransfer(tx: string, toContainer: string, c: TransferClaim) {
  const map = loadClaims();
  const k = claimKey(tx, toContainer);
  const cur = map.get(k);
  if (cur && (cur.id === c.id || earlier(cur, c))) return;
  map.delete(k);
  map.set(k, c);
  while (map.size > CLAIMS_MAX) map.delete(map.keys().next().value!);
  try { localStorage.setItem(CLAIMS_KEY, JSON.stringify([...map])); } catch { /* 存不下时只在本次运行里生效 */ }
  for (const f of claimListeners) f();
}
export function firstClaim(tx: string, toContainer: string): TransferClaim | null {
  return loadClaims().get(claimKey(tx, toContainer)) ?? null;
}
export function onClaims(f: () => void): () => void {
  claimListeners.add(f);
  return () => { claimListeners.delete(f); };
}

/**
 * 发出转账之后等它上链并核对（多节点严格一致）：
 *   ok        成功，并且链上确实按声明转进了对方容器
 *   reverted  交易失败，资产没有转出，可以重新转
 *   mismatch  交易成功（资产已经转出），但链上记录和声明对不上，例如转账时会扣手续费的代币
 *   unknown   暂时确认不了
 * 只有 reverted 才允许再转一次；其余情况这笔转账都要当成"已转出"记住。
 */
export async function waitTransfer(hash: Hex, a: AssetDraft, toContainer: string): Promise<'ok' | 'reverted' | 'mismatch' | 'unknown'> {
  const att = { ...a, chainId: chain.chainId, tx: lower(hash) as Hex } as Exclude<Attachment, { type: 'image' }>;
  for (let i = 0; i < 60; i++) {
    const rc = await strictReceiptState(lower(hash) as Hex);
    if (rc !== 'none' && rc !== 'error') {
      if (rc.status !== 'success') return 'reverted';
      const v = await checkTransfer(att, toContainer);
      return v.status === 'found' ? 'ok' : v.status === 'unavailable' ? 'unknown' : 'mismatch';
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  return 'unknown';
}

/**
 * 钱包是什么账户：普通钱包（eoa）、EIP-7702 委托过的普通钱包（7702）、合约钱包（contract，例如 Safe、4337 智能账户）。
 * 合约钱包付款时，交易发起者、转出方和发消息的钱包对不上，收件方核实不了。读不到返回 null
 */
export async function walletKind(wallet: string): Promise<'eoa' | '7702' | 'contract' | null> {
  const [a] = await chain.rpc.many([{ method: 'eth_getCode', params: [lower(wallet), 'latest'] }], { all: true }).catch(() => [{ ok: false }]);
  if (!a || !a.ok || typeof a.value !== 'string') return null;
  const code = lower(a.value);
  if (code === '0x') return 'eoa';
  // 7702 委托标记：0xef0100 ‖ 20 字节地址
  if (/^0xef0100[0-9a-f]{40}$/.test(code)) return '7702';
  return 'contract';
}

/** 刚发出的转账：多节点一致读到它的 nonce（在交易池里时才读得到，退避重试几次） */
export async function txNonce(hash: Hex, wallet: string): Promise<number | undefined> {
  for (let i = 0; i < 4; i++) {
    const o = await strictTxOrigin(hash).catch(() => null);
    if (o && o.from === lower(wallet)) return o.nonce;
    if (i < 3) await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
  }
  return undefined;
}

/**
 * 钱包里"加速"或"取消"了一笔转账（钱包连接库报告被 replacement 替换）：多节点严格核对后判断——
 *   same       替换交易是同一钱包、同一 nonce、调用完全相同（加速）：以替换交易为准
 *   cancelled  原交易所有节点一致说没有回执，同 nonce 的替换交易已上链但调用不同（取消）：资产没有转出
 *   unknown    判断不了：继续当作"已转出"
 */
export async function transferReplacement(original: Hex, replacement: Hex, expected: { wallet: string; nonce?: number; to: string; data?: string; value?: bigint }): Promise<'same' | 'cancelled' | 'unknown'> {
  if (expected.nonce === undefined) return 'unknown';
  const [orig, rep, o, t] = await Promise.all([strictReceiptState(lower(original) as Hex), strictReceiptState(lower(replacement) as Hex), strictTxOrigin(lower(replacement) as Hex), strictTx(lower(replacement) as Hex)]);
  if (orig !== 'none' || rep === 'none' || rep === 'error' || !o || !t || t === 'none') return 'unknown';
  if (o.from !== lower(expected.wallet) || o.nonce !== expected.nonce) return 'unknown';
  const same = t.to === lower(expected.to) && o.input === lower(expected.data ?? '0x') && t.value === (expected.value ?? 0n);
  return same ? 'same' : 'cancelled';
}

/** 这个地址是不是 TapeOut 登记过的电路合约（处理器）：电路 NFT 不能当附件发 */
export async function isCircuitContract(token: string): Promise<boolean> {
  // 多节点严格一致：两个串通的节点回答"不是"也放不过去
  const r = await viewCall(chain.network.factory, encodeCall('0x' + keccakHex('isCPU(address)').slice(2, 10), ['address'], [lower(token)]), ['bool'], true);
  // 读不到时按"是"处理：宁可拦下，也不能让用户把身份电路转出去
  return r ? Boolean(r[0]) : true;
}

/** 已经转出、但消息还没发出去的资产：记在本机，消息发送失败后重发时直接复用，不会重复转账 */
const transferKey = (me: string, toContainer: string) => `tapesend:transfers:${lower(me)}:${lower(toContainer)}`;
export function savedTransfers(me: string, toContainer: string): Attachment[] {
  try {
    const v = JSON.parse(localStorage.getItem(transferKey(me, toContainer)) ?? '[]');
    return Array.isArray(v) ? v.filter((x) => x && typeof x.tx === 'string') : [];
  } catch {
    return [];
  }
}
/** 每笔已转出资产是什么时候转的（本机时间，毫秒）：随消息发出太晚，对方会核实不了（超过 1 小时） */
const TRANSFER_AT_KEY = 'tapesend:transfer-at';
export function noteTransferTime(tx: string) {
  try {
    const v = JSON.parse(localStorage.getItem(TRANSFER_AT_KEY) ?? '{}') as Record<string, number>;
    const k = lower(tx);
    if (!v[k]) v[k] = Date.now();
    const keys = Object.keys(v);
    for (const old of keys.slice(0, Math.max(0, keys.length - 200))) delete v[old];
    localStorage.setItem(TRANSFER_AT_KEY, JSON.stringify(v));
  } catch {
    // 忽略：只影响提醒
  }
}
export function transferTime(tx: string): number | null {
  try {
    const v = JSON.parse(localStorage.getItem(TRANSFER_AT_KEY) ?? '{}') as Record<string, number>;
    const t = v[lower(tx)];
    return typeof t === 'number' && Number.isFinite(t) ? t : null;
  } catch {
    return null;
  }
}

/** 返回是否真的写进了本机存储（隐私模式、存储满时写不进去） */
export function saveTransfers(me: string, toContainer: string, list: Attachment[]): boolean {
  try {
    if (list.length) localStorage.setItem(transferKey(me, toContainer), JSON.stringify(list));
    else localStorage.removeItem(transferKey(me, toContainer));
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- 电路容器资产：查看与取出（容器的 execute，需要持有人签名）

/** 容器每次 execute 收的协议手续费（TapeOutCircuitAccount.EXEC_FEE，读不到时用这个值） */
export const CONTAINER_EXEC_FEE_DEFAULT = 200_000_000_000_000n; // 0.0002 BNB
export async function containerExecFee(container: string): Promise<bigint> {
  // 多节点严格读取：单个节点报高了会让用户多付
  const r = await viewCall(container, sel('0x' + keccakHex('EXEC_FEE()').slice(2, 10)), ['uint'], true);
  // 只接受合理范围：读到离谱的值时用已知值，免得多付
  return r && (r[0] as bigint) > 0n && (r[0] as bigint) <= 10n ** 16n ? (r[0] as bigint) : CONTAINER_EXEC_FEE_DEFAULT;
}

export interface ContainerToken { token: Hex; info: TokenInfo | null; balance: bigint | null }
export interface ContainerNft { token: Hex; tokenId: string; info: TokenInfo | null; owned: boolean | null }

/** 本机记住的、用户想在资产页里看的代币和 NFT（按容器） */
const watchKey = (container: string) => `tapesend:watch:${lower(container)}`;
export function watchedAssets(container: string): { tokens: Hex[]; nfts: Array<{ token: Hex; tokenId: string }> } {
  try {
    const v = JSON.parse(localStorage.getItem(watchKey(container)) ?? '{}');
    return {
      tokens: Array.isArray(v.tokens) ? v.tokens.filter((x: unknown) => typeof x === 'string' && /^0x[0-9a-f]{40}$/.test(x)) : [],
      nfts: Array.isArray(v.nfts) ? v.nfts.filter((x: { token?: string; tokenId?: string }) => x && /^0x[0-9a-f]{40}$/.test(String(x.token)) && /^\d{1,78}$/.test(String(x.tokenId))) : [],
    };
  } catch {
    return { tokens: [], nfts: [] };
  }
}
export function watchAsset(container: string, a: { token: Hex } | { token: Hex; tokenId: string }) {
  const cur = watchedAssets(container);
  const token = lower(a.token) as Hex;
  if ('tokenId' in a) {
    if (!cur.nfts.some((x) => x.token === token && x.tokenId === a.tokenId)) cur.nfts.push({ token, tokenId: a.tokenId });
  } else if (!cur.tokens.includes(token)) cur.tokens.push(token);
  try { localStorage.setItem(watchKey(container), JSON.stringify({ tokens: cur.tokens.slice(-100), nfts: cur.nfts.slice(-200) })); } catch { /* 忽略 */ }
}

/**
 * 读容器资产：BNB、常见代币 + 收到过的附件 + 用户添加的代币的余额，NFT 看 ownerOf 是否仍是容器。
 * 只用于显示（默认一致规则）；取出以链上执行结果为准。
 */
export async function containerAssets(container: string, extra: { tokens: string[]; nfts: Array<{ token: string; tokenId: string }> }): Promise<{ bnb: bigint | null; tokens: ContainerToken[]; nfts: ContainerNft[] }> {
  const w = watchedAssets(container);
  const tokens = [...new Set([...Object.values(KNOWN_TOKENS), ...extra.tokens, ...w.tokens].map(lower))] as Hex[];
  const nftKeys = new Map<string, { token: Hex; tokenId: string }>();
  for (const n of [...extra.nfts, ...w.nfts]) nftKeys.set(`${lower(n.token)}:${n.tokenId}`, { token: lower(n.token) as Hex, tokenId: n.tokenId });
  const [bnb, tokenRows, nftRows] = await Promise.all([
    nativeBalance(container),
    Promise.all(tokens.map(async (token) => {
      const [info, balance] = await Promise.all([tokenInfo('erc20', token), erc20Balance(token, container)]);
      return { token, info, balance };
    })),
    Promise.all([...nftKeys.values()].map(async (n) => {
      const [info, owner] = await Promise.all([tokenInfo('erc721', n.token), nftOwner(n.token, n.tokenId)]);
      return { ...n, info, owned: owner === null ? null : owner === lower(container) };
    })),
  ]);
  // 常见代币余额为 0 的不列出来；收到过或手动添加的都列（让用户知道查过了）
  // BEM 永远列出（即使余额为 0），并排在第一位
  const explicit = new Set([...extra.tokens, ...w.tokens, KNOWN_TOKENS.BEM!].map(lower));
  const shown = tokenRows.filter((r) => explicit.has(r.token) || (r.balance !== null && r.balance > 0n));
  shown.sort((x, y) => Number(y.token === KNOWN_TOKENS.BEM) - Number(x.token === KNOWN_TOKENS.BEM));
  return { bnb, tokens: shown, nfts: nftRows };
}

/** 从容器取出资产：调用容器的 execute(to, value, data, 0)，附带协议手续费。只有电路当前持有人能调 */
export function withdrawTx(container: string, asset: { type: 'native'; amount: bigint } | { type: 'erc20'; token: string; amount: bigint } | { type: 'erc721'; token: string; tokenId: string }, dest: string, fee: bigint): { to: Hex; data: Hex; value: bigint } {
  let target: string;
  let value = 0n;
  let inner: string;
  if (asset.type === 'native') { target = lower(dest); value = asset.amount; inner = '0x'; }
  else if (asset.type === 'erc20') { target = lower(asset.token); inner = encodeCall('0xa9059cbb', ['address', 'uint256'], [lower(dest), asset.amount]); }
  else { target = lower(asset.token); inner = encodeCall('0x23b872dd', ['address', 'address', 'uint256'], [lower(container), lower(dest), BigInt(asset.tokenId)]); }
  // execute(address,uint256,bytes,uint8) = 0x51945447
  const data = encodeCall('0x51945447', ['address', 'uint256', 'bytes', 'uint256'], [target, value, inner, 0n]) as Hex;
  return { to: lower(container) as Hex, data, value: fee };
}

/** 容器 execute 回滚时的错误名（用来给出能看懂的提示） */
export const CONTAINER_ERRORS: Record<string, string> = Object.fromEntries(
  ['NotOwner()', 'NotPaid()', 'ListedForSale()', 'OnlyCall()', 'CallToCodeless()', 'ProtocolFeeTooLow(uint256,uint256)'].map((e) => [keccakHex(e).slice(0, 10), e.replace(/\(.*$/, '')]),
);
