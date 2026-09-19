// TAP-10 链上部分：端点解析（复用 TapeKit 核心 identity.js）、读公钥、生成交易数据、核验消息。
// 所有读取都走核心的多节点一致读取（SPEC.md §4.1），任何单个节点、索引器都不被信任。
import { createRpc } from '../../../kernel/src/rpc.js';
import { createIdentity, decodeOutcome, callRequest } from '../../../kernel/src/identity.js';
import { parseInput, formatLabel } from '../../../kernel/src/name.js';
import { encodeCall, decodeResult } from '../../../kernel/src/abi.js';
import { keccakHex } from '../../../kernel/src/keccak.js';
import { BSC_MAINNET, NETWORKS, networkByArea, networkByChainId, rpcOptionsFor, IMPL_SLOT } from '../../../kernel/src/config.js';
import { TapeSendError, bytesToHex, hexToBytes } from './bytes.js';
import { messageId } from './content.js';
import { keccak_256 } from '@noble/hashes/sha3.js';

/**
 * DeWEB 跨链消息层：链表（规范的一部分）。序号 index 用于公钥里的「收信链位图」（位 index = 这条链）。
 * active = 这条链上已部署 TapeOut 电路协议和 DeWEB 中枢正式实现，可以收发消息。
 */
export const CHAINS = Object.freeze([
  Object.freeze({ index: 0, chainId: 56, short: 'bnb', name: 'BNB Smart Chain', active: true }),
  // 2026-09-19 启用：TapeOut 主协议与 DeWEB 中枢正式实现都已部署并核对
  Object.freeze({ index: 1, chainId: 8453, short: 'base', name: 'Base', active: true }),
  Object.freeze({ index: 2, chainId: 196, short: 'xlayer', name: 'X Layer', active: true }),
]);
export const HOME_CHAIN_ID = 56;
export const chainById = (id) => CHAINS.find((c) => c.chainId === Number(id)) || null;
export const chainByShort = (s) => CHAINS.find((c) => c.short === String(s).toLowerCase()) || null;
/** 收信链位图：由链号列表算出 */
export const chainsBitmap = (ids) => ids.reduce((m, id) => {
  const c = chainById(id);
  if (!c) throw new TapeSendError('bad-input', `unknown chain ${id}`);
  return m | (1n << BigInt(c.index));
}, 0n);
/** 位图 → 本客户端认识的链号列表（不认识的位忽略） */
export const chainsFromBitmap = (bits) => CHAINS.filter((c) => (BigInt(bits) >> BigInt(c.index)) & 1n).map((c) => c.chainId);
/** 默认收信链：所有已启用的链 */
export const DEFAULT_CHAINS = chainsBitmap(CHAINS.filter((c) => c.active).map((c) => c.chainId));

/** 端点号 = uint32(0) ‖ uint64(chainId) ‖ 容器地址，32 字节十六进制 */
export function endpointId(chainId, container) {
  const a = String(container).toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(a) || /^0x0{40}$/.test(a)) throw new TapeSendError('bad-input', 'bad container address');
  const c = BigInt(chainId);
  if (c <= 0n || c >= 1n << 64n) throw new TapeSendError('bad-input', 'bad chain id');
  return '0x' + '0'.repeat(8) + c.toString(16).padStart(16, '0') + a.slice(2);
}
/** 端点号 → {chainId, container}；格式不对返回 null */
export function parseEndpointId(id) {
  const s = String(id).toLowerCase();
  if (!/^0x0{8}[0-9a-f]{56}$/.test(s)) return null;
  const chainId = BigInt('0x' + s.slice(10, 26));
  const container = '0x' + s.slice(26);
  // 链号超过 2^53 时 JavaScript 数字会丢精度：这样的链不支持，当作格式不对
  if (chainId === 0n || chainId > BigInt(Number.MAX_SAFE_INTEGER) || /^0x0{40}$/.test(container)) return null;
  return { chainId: Number(chainId), container };
}

/**
 * DeWEB 中枢：每条链同一个地址（启动实现 + 同一 owner 的代理，见 send/contracts/script/Deploy.s.sol）。
 * 2026-09-18 部署于 BNB Smart Chain 主网，owner 0x571d447f4f24688ec35ccf07f1d6993655f6af15。
 */
export const HUB_MAINNET = '0xe61a9c7213a6aa616c246a2b569e555b417b25ee';
/** 各链相同的启动实现 */
export const HUB_BOOT = '0xc0d28ca8689248b0bed26cc0aa328cf16aa4401e';
/** BNB 上的正式实现：第三版，2026-09-18 区块 122623031 升级上线（封印前 owner 可以换掉它，封印后永久固定）。
 * 历史：第二版 0x7df03218910e0f37fc3a8da8792831ab7580340f（已被替换，不再认可：它允许升级到仍在启动阶段的代理） */
export const HUB_IMPLEMENTATION = '0x80afe7b77f2dfd08e9feab7675780bac34a7ee85';
/**
 * 客户端认可的中枢实现（都经过审计）。升级前先把新版本加进来并发布客户端，再在链上升级，
 * 用户就不会在升级那一刻被挡住。第三版（加 selfAddress 防护；公钥不可用时 keyFor 一律返回 0）已于 2026-09-18 上线。
 */
export const HUB_IMPLEMENTATIONS_BY_CHAIN = Object.freeze({
  // 正式实现的构造参数里有各链自己的 TapeOut 合约地址和链号，所以每条链的实现地址都不一样，必须分链列出。
  // 以后开通新链：部署后把那条链的实现地址（经审计、字节码核对过）加在这里，并在 send/contracts 的钉住测试里同步
  56: Object.freeze([HUB_IMPLEMENTATION]),
  // 2026-09-19：Base 与 X Layer（TapeOut 主协议已部署；中枢正式实现地址由源码确定性算出，send/contracts 钉住测试核对）
  8453: Object.freeze(['0x38a2d320b8984bbac9b0a2691b6c0fd829a23867']),
  196: Object.freeze(['0xdcc57797089ebd9f26e686379a4323f353a3f9c6']),
});
/** 某条链上客户端认可的中枢实现；没有列出的链一律不认可 */
export const hubImplementationsFor = (chainId) => HUB_IMPLEMENTATIONS_BY_CHAIN[Number(chainId)] ?? Object.freeze([]);
/** 兼容旧用法：BNB 链的名单 */
export const HUB_IMPLEMENTATIONS = HUB_IMPLEMENTATIONS_BY_CHAIN[HOME_CHAIN_ID];

export const HUB_SIG = Object.freeze({
  send: 'send(address,uint256,bytes32,bytes32,bytes)',
  publishKey: 'publishKey(address,uint256,uint8,uint16,bytes32,uint64)',
  revokeKey: 'revokeKey(address,uint256)',
  keyFor: 'keyFor(address,uint256)',
  accountOf: 'accountOf(address,uint256)',
  inboxCount: 'inboxCount(bytes32)',
  inboxPage: 'inboxPage(bytes32,uint256,uint256)',
  outboxCount: 'outboxCount(address)',
  outboxPage: 'outboxPage(address,uint256,uint256)',
  Sent: 'Sent(bytes32,address,bytes32,uint256,uint256,bytes)',
  KeyPublished: 'KeyPublished(address,address,uint8,uint16,bytes32,uint32,uint64)',
  KeyRevoked: 'KeyRevoked(address,address,uint32)',
});
const sel = (sig) => keccakHex(sig).slice(0, 10);
export const HUB_SEL = Object.freeze({
  send: sel(HUB_SIG.send), publishKey: sel(HUB_SIG.publishKey), revokeKey: sel(HUB_SIG.revokeKey),
  keyFor: sel(HUB_SIG.keyFor), accountOf: sel(HUB_SIG.accountOf),
  inboxCount: sel(HUB_SIG.inboxCount), inboxPage: sel(HUB_SIG.inboxPage), outboxCount: sel(HUB_SIG.outboxCount), outboxPage: sel(HUB_SIG.outboxPage),
});
export const HUB_TOPIC = Object.freeze({
  Sent: keccakHex(HUB_SIG.Sent), KeyPublished: keccakHex(HUB_SIG.KeyPublished), KeyRevoked: keccakHex(HUB_SIG.KeyRevoked),
});
/** 分页读取一次最多的条数（与合约 MAX_PAGE 相同） */
export const MAX_PAGE = 200;

const lower = (a) => String(a).toLowerCase();
const addrTopic = (a) => '0x' + lower(a).slice(2).padStart(64, '0');
const topicAddr = (t) => '0x' + lower(t).slice(-40);
const ZERO32 = '0x' + '0'.repeat(64);

// 多节点核对时只比较这些字段：不同节点对区块 size 等无关字段的计算不一样（实测 publicnode 与其他三家 size 差 1）。
// 核心 rpc 在带 normalize 时只把规范化后的对象交给调用方，所以下面用到的每个字段都经过了所有节点核对。
const HEX = /^0x[0-9a-f]*$/;
const q = (v) => {
  const n = BigInt(v);
  if (n < 0n) throw new Error('negative quantity');
  return n.toString();
};
const hexField = (v, bytes) => {
  const s = lower(v);
  if (!HEX.test(s) || (bytes !== undefined && s.length !== 2 + bytes * 2)) throw new Error('bad hex field');
  return s;
};
const normalizeLog = (l) => ({
  address: hexField(l.address, 20), topics: (l.topics || []).map((t) => hexField(t, 32)), data: hexField(l.data),
  logIndex: q(l.logIndex), blockNumber: q(l.blockNumber), blockHash: hexField(l.blockHash, 32), transactionHash: hexField(l.transactionHash, 32),
});
export const normalizeReceipt = (r) => ({
  status: q(r.status), blockHash: hexField(r.blockHash, 32), blockNumber: q(r.blockNumber), transactionHash: hexField(r.transactionHash, 32),
  logs: (r.logs || []).map(normalizeLog),
});
export const normalizeHeader = (b) => ({ hash: hexField(b.hash, 32), number: q(b.number), parentHash: hexField(b.parentHash, 32), timestamp: q(b.timestamp) });

/** TAP-10 §3.5：判断工厂封印所需的常量（BNB；各链的在 kernel/src/config.js 的 factorySeal 里） */
export const FACTORY_SEAL = Object.freeze({ ...BSC_MAINNET.factorySeal, implSlot: IMPL_SLOT });
/** 某条链的工厂封印常量 */
export const factorySealFor = (chainId) => {
  const n = networkByChainId(chainId);
  return n ? Object.freeze({ ...n.factorySeal, implSlot: IMPL_SLOT }) : null;
};


/** 钉住的区块离现在太久就拒绝读公钥（防一个节点把钉住的区块压到过去，读到已经换掉的旧公钥）。
 *  BNB 的值；各链用自己配置里的 maxBlockAgeSeconds */
export const MAX_BLOCK_AGE_SECONDS = BSC_MAINNET.maxBlockAgeSeconds;
/** 区块时间比本机时钟快这么多，说明本机时钟不准，不能用来判断新鲜度 */
export const MAX_CLOCK_AHEAD_SECONDS = 60;
/** 一次最多核验的条数 */
export const MAX_VERIFY_BATCH = 200;

/** 显示用端点名：BNB #ID@编号，其他链带区号 #ID@区号.编号（X Layer = 2，Base = 3）。本客户端不认识的链：#ID@编号.chain<链号> */
export const endpointLabel = (tokenId, cpu, chainId = HOME_CHAIN_ID) => {
  const n = networkByChainId(chainId);
  if (n) return formatLabel(tokenId, cpu, n.area);
  return `#${BigInt(tokenId)}@${BigInt(cpu)}.chain${Number(chainId)}`;
};
/** 输入（名字、#ID@区号.编号、32 字节端点号）属于哪条链；认不出链时返回 null。容器地址等不带链信息的写法返回 BNB */
export function chainIdOfInput(input) {
  const s = String(input ?? '').trim();
  if (/^0x0{8}[0-9a-fA-F]{56}$/.test(s)) { const p = parseEndpointId(s); return p ? p.chainId : null; }
  let parsed;
  try { parsed = parseInput(s); } catch { return null; }
  if (parsed.kind !== 'name') return HOME_CHAIN_ID;
  const n = networkByArea(parsed.area);
  return n ? n.chainId : null;
}

const word = (hex, i) => BigInt('0x' + hex.slice(2 + i * 64, 2 + (i + 1) * 64));
const wordHex = (hex, i) => '0x' + hex.slice(2 + i * 64, 2 + (i + 1) * 64);
/** 按合约里的字段宽度解码：超宽说明节点返回的数据不对 */
const wordUint = (hex, i, bits) => {
  const w = word(hex, i);
  if (w >> BigInt(bits)) throw new TapeSendError('hub-read', `field wider than uint${bits}`);
  return w;
};
const wordAddr = (hex, i) => {
  const w = word(hex, i);
  if (w >> 160n) throw new TapeSendError('hub-read', 'dirty address');
  return '0x' + w.toString(16).padStart(40, '0');
};
/** 解码 inboxPage / outboxPage 返回的「静态结构体数组」：offset(=0x20) ‖ length ‖ length × width 个字 */
function decodeStructArray(hex, width) {
  const s = String(hex).toLowerCase();
  if (!/^0x([0-9a-f]{64})*$/.test(s) || s.length < 2 + 128) throw new Error('bad array data');
  if (word(s, 0) !== 32n) throw new Error('bad array offset');
  const n = word(s, 1);
  if (n > BigInt(MAX_PAGE)) throw new Error('array too long');
  const len = Number(n);
  if ((s.length - 2) / 64 !== 2 + len * width) throw new Error('bad array length');
  return Array.from({ length: len }, (_, k) => 2 + k * width);
}

/**
 * @param {{ hub?: string, rpc?: any, rpcUrls?: string[], quorum?: number, network?: object, fetchImpl?: typeof fetch }} [o]
 */
export function createTapeSendChain(o = {}) {
  const net = { ...BSC_MAINNET, ...(o.network || {}) };
  const hub = lower(o.hub || HUB_MAINNET);
  const rpc = o.rpc || createRpc({ ...rpcOptionsFor(net, o.rpcUrls), quorum: o.quorum, fetchImpl: o.fetchImpl });
  const seal = Object.freeze({ ...net.factorySeal, implSlot: IMPL_SLOT });
  const maxBlockAge = net.maxBlockAgeSeconds ?? MAX_BLOCK_AGE_SECONDS;
  const fetchImpl = o.fetchImpl || globalThis.fetch.bind(globalThis);
  // 身份读取必须用严格模式，并且用自己的缓存：不和网页内核共用处理器编号表，
  // 否则一次默认模式下被串通节点带偏的结果会被写进共享缓存（TAP-10 §8.3）
  const identity = createIdentity({ rpc, network: net, strict: true });

  // 这条链的链号只取自写死的配置，并要求所有节点一致确认（发件端点号的链号就是它，绝不取自任何数据）
  let chainChecked = null;
  function assertChain() {
    if (!chainChecked) {
      chainChecked = rpc.many([{ method: 'eth_chainId', params: [] }], { all: true }).then(([oc]) => {
        if (!oc.ok || BigInt(oc.value) !== BigInt(net.chainId)) throw new TapeSendError('wrong-chain', `nodes are not on chain ${net.chainId}`);
      });
      chainChecked.catch(() => { chainChecked = null; });
    }
    return chainChecked;
  }

  /** hub.keyFor，在 block 上读；问所有节点，任何分歧都拒绝 */
  async function keyFor(circuits, tokenId, block) {
    const item = {
      to: hub, sel: HUB_SEL.keyFor, types: ['address', 'uint256'], values: [circuits, tokenId],
      out: ['address', 'bytes32', 'bool', 'address', 'uint', 'uint', 'bytes32', 'bool', 'uint', 'uint'],
    };
    let r;
    try {
      const [oc] = await rpc.many([callRequest(item, block)], { all: true });
      r = decodeOutcome(item.out, oc);
    } catch (e) {
      if (e && e.code === 'rpc') throw e;
      throw new TapeSendError('hub-read', 'keyFor returned malformed data');
    }
    if (r.revert) throw new TapeSendError(r.empty ? 'hub-missing' : 'hub-read', r.empty ? 'DeWEB hub is not deployed at the configured address' : 'keyFor reverted');
    const [container, endpoint, opened, current, suite, keyIndex, key, usable, version, chains] = r;
    if (suite > 255n || keyIndex > 65535n || version > 4294967295n || chains >= 1n << 64n) throw new TapeSendError('hub-read', 'keyFor returned out-of-range values');
    if (lower(endpoint) !== endpointId(net.chainId, container)) throw new TapeSendError('hub-mismatch', 'hub returned an endpoint for another chain');
    return {
      container: lower(container), endpoint: lower(endpoint), opened, current: lower(current), suite: Number(suite), keyIndex: Number(keyIndex),
      key: lower(key), usable, version: Number(version), chains: chainsFromBitmap(chains), chainsBits: chains,
    };
  }

  /**
   * TAP-10 §3.5：工厂封印状态，以及电路实现是否仍是钉住的那一份。
   * @returns {Promise<{sealed: boolean, factoryImplementation: string, beaconOwner: string, circuitsIntact: boolean, inEffect: boolean}>}
   */
  async function factoryStatus(block) {
    const items = [
      { to: net.factory, sel: keccakHex('isSealed()').slice(0, 10), out: ['bool'] },
      { to: seal.circuitBeacon, sel: keccakHex('owner()').slice(0, 10), out: ['address'] },
      { to: seal.circuitBeacon, sel: keccakHex('implementation()').slice(0, 10), out: ['address'] },
    ];
    const answers = await rpc.many([
      ...items.map((it) => callRequest(it, block)),
      { method: 'eth_getStorageAt', params: [net.factory, seal.implSlot, block] },
    ], { all: true });
    const [sealedR, ownerR, implR] = items.map((it, i) => decodeOutcome(it.out, answers[i]));
    const slot = answers[3];
    // 实现槽是一个 32 字节的字：高 12 字节必须为 0，否则不当作地址
    const slotHex = slot.ok ? String(slot.value).toLowerCase() : '';
    const factoryImplementation = /^0x0{24}[0-9a-f]{40}$/.test(slotHex) ? '0x' + slotHex.slice(-40) : '';
    const sealed = !sealedR.revert && sealedR[0] === true;
    const beaconOwner = ownerR.revert ? '' : lower(ownerR[0]);
    const circuitsIntact = !implR.revert && lower(implR[0]) === seal.circuitImplementation;
    return {
      sealed, factoryImplementation, beaconOwner, circuitsIntact,
      inEffect: sealed && factoryImplementation === seal.implementation && beaconOwner === lower(net.factory) && circuitsIntact,
    };
  }

  /**
   * TAP-10 §3.6：hub 自身的封印状态。封印之前 owner 可以更换实现，从而改写身份核对逻辑——
   * 与工厂未封印同级别的风险，客户端必须一直显示警告。
   * @returns {Promise<{sealed: boolean, owner: string, implementation: string, expectedImplementation: boolean, inEffect: boolean}>}
   */
  async function hubStatus(block) {
    const items = [
      { to: hub, sel: keccakHex('isSealed()').slice(0, 10), out: ['bool'] },
      { to: hub, sel: keccakHex('owner()').slice(0, 10), out: ['address'] },
    ];
    const answers = await rpc.many([
      ...items.map((it) => callRequest(it, block)),
      { method: 'eth_getStorageAt', params: [hub, seal.implSlot, block] },
    ], { all: true });
    const [sealedR, ownerR] = items.map((it, i) => decodeOutcome(it.out, answers[i]));
    const slot = answers[2];
    const slotHex = slot.ok ? String(slot.value).toLowerCase() : '';
    const implementation = /^0x0{24}[0-9a-f]{40}$/.test(slotHex) ? '0x' + slotHex.slice(-40) : '';
    const sealed = !sealedR.revert && sealedR[0] === true;
    const owner = ownerR.revert ? '' : lower(ownerR[0]);
    const expectedImplementation = hubImplementationsFor(net.chainId).includes(implementation);
    return { sealed, owner, implementation, expectedImplementation, inEffect: sealed && expectedImplementation && owner === '0x' + '0'.repeat(40) };
  }

  /** 钉住的区块必须是最近的（所有节点一致的区块头时间戳） */
  async function assertFreshBlock(block) {
    const [h] = await rpc.many([{ method: 'eth_getBlockByNumber', params: [block, false], normalize: normalizeHeader }], { all: true });
    if (!h.ok || !h.raw) throw new TapeSendError('stale-block', 'cannot read the pinned block header');
    const age = Math.floor(Date.now() / 1000) - Number(h.raw.timestamp);
    if (age < -MAX_CLOCK_AHEAD_SECONDS) throw new TapeSendError('clock-skew', `pinned block is ${-age}s ahead of this device's clock`);
    if (age > maxBlockAge) throw new TapeSendError('stale-block', `pinned block is ${age}s old`);
  }

  /**
   * TAP-10 §2.3：解析端点，并在同一个区块读它的公钥记录。
   * @returns {Promise<{status: string, block: string, label?: string, tokenId?: bigint, cpu?: bigint, circuits?: string,
   *   container?: string, holder?: string|null, opened?: boolean, key?: Awaited<ReturnType<typeof keyFor>>}>}
   *   status：ok / no-such-cpu / no-such-token / not-tapeout / not-opened
   */
  async function resolveEndpoint(input, opts = {}) {
    const parsed = typeof input === 'string' ? parseInput(input) : input;
    // 带区号的名字只属于那条链：先拒绝，不去读链（拿 #1@2.344 到 BNB 上查会查到另一枚电路）
    if (parsed.kind === 'name' && (parsed.area ?? null) !== (net.area ?? null)) {
      throw new TapeSendError('wrong-chain', `${formatLabel(parsed.tokenId, parsed.cpu, parsed.area)} is not on ${net.name || 'chain ' + net.chainId}`);
    }
    await assertChain();
    const block = opts.block || (await rpc.pinBlock());
    // 钉住的块不能比各运营方报的最高块落后太多（防一家把钉块压到过去、读到已经换掉的旧公钥）。
    // 按块数比，不看本机时钟：电脑时间不准时不会一直报错
    if (!opts.block && !opts.skipFreshness) {
      const lag = typeof rpc.pinLag === 'function' ? rpc.pinLag() : 0n;
      if (net.maxPinLagBlocks && lag > BigInt(net.maxPinLagBlocks)) throw new TapeSendError('stale-block', `pinned block is ${lag} blocks behind the highest head`);
    }
    const { identity: id } = await identity.resolveIdentity(parsed, block);
    if (id.status !== 'ok') return { ...id, block };
    const [key, factory, hubSeal] = await Promise.all([keyFor(id.circuits, id.tokenId, block), factoryStatus(block), hubStatus(block)]);
    // 核心算出的容器必须等于 hub 算出的容器：两边用的注册表参数一旦不一致，宁可报错也不发错地址
    if (key.container !== lower(id.container)) throw new TapeSendError('hub-mismatch', 'hub and resolver disagree on the container address');
    return {
      status: id.opened ? 'ok' : 'not-opened', block, label: endpointLabel(id.tokenId, id.cpu, net.chainId), name: id.name, cpuName: id.cpuName || '',
      chainId: net.chainId, endpoint: endpointId(net.chainId, id.container),
      tokenId: id.tokenId, cpu: id.cpu, circuits: lower(id.circuits), container: lower(id.container),
      holder: id.holder ? lower(id.holder) : null, opened: id.opened, key, factory, hub: hubSeal,
    };
  }

  /** 发消息的交易数据（由持有人钱包签名发送）。to 是收件端点号（可以是其他链上的端点） */
  function encodeSend({ circuits, tokenId, to, ref = ZERO32, payload }) {
    if (!parseEndpointId(to)) throw new TapeSendError('bad-input', 'to must be an endpoint id');
    const hex = typeof payload === 'string' ? payload : bytesToHex(payload);
    return { to: hub, data: encodeCall(HUB_SEL.send, ['address', 'uint256', 'bytes32', 'bytes32', 'bytes'], [circuits, tokenId, lower(to), ref, hex]) };
  }
  function encodePublishKey({ circuits, tokenId, keyIndex = 0, publicKey, chains = DEFAULT_CHAINS }) {
    const hex = typeof publicKey === 'string' ? publicKey : bytesToHex(publicKey);
    const bits = BigInt(chains);
    if (bits <= 0n || bits >= 1n << 64n) throw new TapeSendError('bad-input', 'chains bitmap must be a non-zero uint64');
    if (!Number.isInteger(Number(keyIndex)) || Number(keyIndex) < 0 || Number(keyIndex) > 65535) throw new TapeSendError('bad-input', 'keyIndex must fit in uint16');
    return { to: hub, data: encodeCall(HUB_SEL.publishKey, ['address', 'uint256', 'uint256', 'uint256', 'bytes32', 'uint256'], [circuits, tokenId, 1, keyIndex, hex, bits]) };
  }
  function encodeRevokeKey({ circuits, tokenId }) {
    return { to: hub, data: encodeCall(HUB_SEL.revokeKey, ['address', 'uint256'], [circuits, tokenId]) };
  }

  /** 一次 eth_call，问所有节点，任何分歧都拒绝；返回原始返回数据 */
  async function strictCall(data, block) {
    const [oc] = await rpc.many([{ method: 'eth_call', params: [{ to: hub, data }, block] }], { all: true });
    if (!oc.ok) throw new TapeSendError('hub-read', 'hub call reverted');
    const v = String(oc.value).toLowerCase();
    if (v === '0x') throw new TapeSendError('hub-missing', 'DeWEB hub is not deployed at the configured address');
    return v;
  }
  const readCount = async (selector, type, arg, block) => {
    const hex = await strictCall(encodeCall(selector, [type], [arg]), block);
    if (!/^0x[0-9a-f]{64}$/.test(hex)) throw new TapeSendError('hub-read', 'bad count');
    return BigInt(hex);
  };
  const pageBounds = (count, before, limit) => {
    const end = before === undefined || before === null ? count : BigInt(before) < count ? BigInt(before) : count;
    const n = BigInt(Math.max(1, Math.min(MAX_PAGE, Number(limit) || 50)));
    const start = end > n ? end - n : 0n;
    return { start, end };
  };

  /**
   * 收件信箱：本链中枢里发给 endpoint 的消息，最新的在前。
   * 所有字段来自合约存储、经多节点严格一致读出；载荷另用 fetchMessage 取回并按 digest 核对。
   * @param {string} endpoint
   * @param {{ before?: string|number|bigint, limit?: number, block?: string }} [opts]
   * @returns {Promise<{chainId: number, count: number, items: any[], next: string|null, block: string}>}
   */
  async function inbox(endpoint, { before, limit = 50, block } = {}) {
    const to = lower(endpoint);
    if (!parseEndpointId(to)) throw new TapeSendError('bad-input', 'bad endpoint id');
    await assertChain();
    const b = block || (await rpc.pinBlock());
    const count = await readCount(HUB_SEL.inboxCount, 'bytes32', to, b);
    const { start, end } = pageBounds(count, before, limit);
    let items = [];
    if (end > start) {
      const hex = await strictCall(encodeCall(HUB_SEL.inboxPage, ['bytes32', 'uint256', 'uint256'], [to, start, end - start]), b);
      let offs;
      try { offs = decodeStructArray(hex, 4); } catch { throw new TapeSendError('hub-read', 'bad inbox page'); }
      if (offs.length !== Number(end - start)) throw new TapeSendError('hub-read', 'inbox page length mismatch');
      items = offs.map((w, k) => {
        const index = start + BigInt(k);
        const from = wordAddr(hex, w);
        return {
          id: messageId(net.chainId, hub, to, index), chainId: net.chainId, direction: 'in', to, index: Number(index),
          from, fromEndpoint: endpointId(net.chainId, from), blockNumber: Number(wordUint(hex, w + 1, 56)), timestamp: Number(wordUint(hex, w + 2, 40)), digest: wordHex(hex, w + 3),
        };
      }).reverse();
    }
    return { chainId: net.chainId, count: Number(count), items, next: start > 0n ? start.toString() : null, block: b };
  }

  /**
   * 发件目录：本链上 container 发出的消息，最新的在前
   * @param {string} container
   * @param {{ before?: string|number|bigint, limit?: number, block?: string }} [opts]
   */
  async function outbox(container, { before, limit = 50, block } = {}) {
    const from = lower(container);
    if (!/^0x[0-9a-f]{40}$/.test(from)) throw new TapeSendError('bad-input', 'bad container');
    await assertChain();
    const b = block || (await rpc.pinBlock());
    const count = await readCount(HUB_SEL.outboxCount, 'address', from, b);
    const { start, end } = pageBounds(count, before, limit);
    let items = [];
    if (end > start) {
      const hex = await strictCall(encodeCall(HUB_SEL.outboxPage, ['address', 'uint256', 'uint256'], [from, start, end - start]), b);
      let offs;
      try { offs = decodeStructArray(hex, 5); } catch { throw new TapeSendError('hub-read', 'bad outbox page'); }
      if (offs.length !== Number(end - start)) throw new TapeSendError('hub-read', 'outbox page length mismatch');
      items = offs.map((w) => {
        const to = wordHex(hex, w);
        if (!parseEndpointId(to)) throw new TapeSendError('hub-read', 'bad endpoint in outbox');
        const index = wordUint(hex, w + 1, 32);
        return {
          id: messageId(net.chainId, hub, to, index), chainId: net.chainId, direction: 'out', to, index: Number(index),
          from, fromEndpoint: endpointId(net.chainId, from), blockNumber: Number(wordUint(hex, w + 2, 56)), timestamp: Number(wordUint(hex, w + 3, 40)), digest: wordHex(hex, w + 4),
        };
      }).reverse();
    }
    return { chainId: net.chainId, count: Number(count), items, next: start > 0n ? start.toString() : null, block: b };
  }

  /** 把一条原始日志解码成 Sent；不是本 hub 的 Sent 事件返回 null */
  function decodeSentLog(log) {
    if (!log || lower(log.address) !== hub || !Array.isArray(log.topics) || log.topics.length !== 4 || lower(log.topics[0]) !== HUB_TOPIC.Sent) return null;
    const topic2 = lower(log.topics[2]);
    if (!/^0x0{24}[0-9a-f]{40}$/.test(topic2)) return null;
    const [inboxIndex, outboxIndex, payload] = decodeResult(['uint', 'uint', 'bytes'], log.data);
    if (payload.length === 0 || payload.length > 16_000) return null;
    return {
      to: lower(log.topics[1]), from: '0x' + topic2.slice(-40), ref: lower(log.topics[3]), inboxIndex, outboxIndex, payload,
      txHash: lower(log.transactionHash || ''), logIndex: log.logIndex,
    };
  }

  async function postOne(url, method, params) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 12_000);
    try {
      const r = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: ctl.signal });
      if (!r.ok) return null;
      const j = await r.json();
      return j && !j.error ? j.result : null;
    } catch {
      return null;
    } finally {
      clearTimeout(t);
    }
  }

  /**
   * 取回一条消息的载荷。只需要任意一个诚实节点：从该区块的日志（或整块收据）里找到对应的 Sent，
   * 用链上存储里的 digest = keccak256(ref ‖ keccak256(payload)) 核对，对不上就换下一个节点。
   * @param {{to: string, index: number, from: string, blockNumber: number, digest: string}} m  inbox/outbox 返回的一项
   * @returns {Promise<{payload: Uint8Array, ref: string}>}
   */
  async function fetchMessage(m) {
    const n = '0x' + BigInt(m.blockNumber).toString(16);
    const urls = [...rpc.urls].sort(() => Math.random() - 0.5);
    for (const url of urls) {
      let logs = await postOne(url, 'eth_getLogs', [{ fromBlock: n, toBlock: n, address: hub, topics: [HUB_TOPIC.Sent, lower(m.to)] }]);
      if (!Array.isArray(logs)) {
        const receipts = await postOne(url, 'eth_getBlockReceipts', [n]);
        if (!Array.isArray(receipts)) continue;
        logs = receipts.flatMap((r) => (r && Array.isArray(r.logs) ? r.logs : []));
      }
      for (const log of logs) {
        let d;
        try { d = decodeSentLog(log); } catch { d = null; }
        if (!d || d.to !== lower(m.to) || d.inboxIndex !== BigInt(m.index) || d.from !== lower(m.from)) continue;
        const digest = bytesToHex(keccak_256(new Uint8Array([...hexToBytes(d.ref), ...keccak_256(d.payload)])));
        // 单个节点给的数据只信 ref 和载荷（都已被 digest 认证）。交易哈希只是线索（txHint）：
        // 要用它（例如核对附件付款人）必须再多节点严格读回执，确认里面有这条 Sent
        if (digest === lower(m.digest)) return { payload: d.payload, ref: d.ref, txHint: /^0x[0-9a-f]{64}$/.test(d.txHash) ? d.txHash : null };
      }
    }
    throw new TapeSendError('unavailable', 'no node returned a payload matching the on-chain digest');
  }

  /**
   * 已确认的区块高度 F：逐个节点读确认标签（BNB 'finalized'；L2 'safe'，见各链配置），至少 3 个不同运营方答上来才算数
   * （配置不足 3 家时要全部答上来），取其中最小的。
   * 节点把 F 报低只会让更多消息显示"确认中"（安全方向）；报高会被最小值压住。读不到返回 null。
   */
  const finalityTag = net.finality === 'safe' ? 'safe' : 'finalized';
  async function finalizedBlock() {
    const got = await Promise.all(rpc.urls.map((url) => postOne(url, 'eth_getBlockByNumber', [finalityTag, false]).then((b) => ({ url, b }))));
    const ok = got.filter(({ b }) => b && typeof b.number === 'string' && /^0x[0-9a-f]+$/i.test(b.number));
    const ops = new Set(ok.map(({ url }) => rpc.operatorOf(url)));
    if (ops.size < Math.min(3, rpc.operatorCount)) return null;
    return ok.map(({ b }) => BigInt(b.number)).reduce((m, n) => (n < m ? n : m));
  }

  return {
    finalizedBlock, finalityTag, factorySeal: seal,
    hub, rpc, identity, network: net, chainId: net.chainId, assertChain, keyFor, factoryStatus, hubStatus, assertFreshBlock, resolveEndpoint,
    encodeSend, encodePublishKey, encodeRevokeKey, decodeSentLog, inbox, outbox, fetchMessage,
  };
}

/**
 * 每条已启用的链一个实例（各自的节点、工厂、封印常量、确认标签），中枢地址各链相同。
 * @param {{ hub?: string, rpcUrls?: Record<string, string[]>, fetchImpl?: typeof fetch, quorum?: number }} [o]
 *   rpcUrls：按链号或链名（bnb / xlayer / base）替换节点
 * @returns {Map<number, ReturnType<typeof createTapeSendChain>>}
 */
export function createTapeSendChains(o = {}) {
  const out = new Map();
  for (const c of CHAINS) {
    if (!c.active) continue;
    const net = networkByChainId(c.chainId);
    if (!net) continue;
    const urls = o.rpcUrls && (o.rpcUrls[net.chainId] || o.rpcUrls[String(net.chainId)] || o.rpcUrls[net.key]);
    out.set(net.chainId, createTapeSendChain({ network: net, hub: o.hub, rpcUrls: urls && urls.length ? urls : undefined, fetchImpl: o.fetchImpl, quorum: o.quorum }));
  }
  return out;
}

export { hexToBytes, NETWORKS };
