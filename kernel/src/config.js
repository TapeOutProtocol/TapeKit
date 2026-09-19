// 网络常量。每条链上的地址都已部署、并于写入时只读核对过（BNB 2026-09-13；Base、X Layer 2026-09-19）。
// 这里的值会被写进规范（SPEC.md §3、§5），改动任何一项都要同步改规范。
//
// 多链命名（SPEC §2）：BNB Smart Chain 不带区号（4246.0 = #4246@0），其他链用区号区分：
//   X Layer 区号 2：1.2.344 = #1@2.344（X Layer 上 344 号处理器的 #1）
//   Base    区号 3：1.3.5   = #1@3.5
// 区号一经分配永不更改、不复用；0 和 1 保留不用（BNB 本身不带区号，同一个网站只有一个名字）。

export const IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'; // ERC-1967 实现槽

export const BSC_MAINNET = Object.freeze({
  chainId: 56,
  key: 'bnb',
  name: 'BNB Smart Chain',
  currency: 'BNB',
  area: null,            // 不带区号
  nameSuffix: 'tape',
  // 读取钉在哪个区块：'latest' = 多数节点都有的最新块往回 2 块；'safe' = 节点报告的安全区块（L2 用）
  pin: 'latest',
  // TapeSend 判断消息"已确认"用的区块标签
  finality: 'finalized',
  // TapeSend 读公钥时，钉住的区块最多落后这么多秒（再旧就可能读到已换掉的公钥）
  maxBlockAgeSeconds: 300,
  // 钉住的块最多比"各运营方报的最高块"落后这么多块（约 5 分钟，BNB 约 0.75 秒一块）；再多就拒绝读取
  maxPinLagBlocks: 400,
  // TapeOut 处理器工厂：cpuAt(i) 给出第 i 号处理器（电路 NFT 合约），编号从 0 开始、只增不改
  factory: '0x68224f668083c29e9800be2a646d42d18cedf7e2',
  // 电路容器开通器：accountOf(处理器, #ID) 算出容器地址，isOpened 判断是否已开通
  opener: '0x021745de2f42a7839d96f2d3634d0294487d81f1',
  // 网站文件仓库（SiteRegistry 代理）；数组以便将来多版本并存，按序查，先命中先用
  registries: Object.freeze(['0xd006ffdd5ae313b17729621a00999cd3c71ce5e6']),
  // 付费合约（DomainBinding 代理）：链上名字 "<#ID>.<处理器编号>.tape" 的开通费也记在这里
  binding: '0x861ee183de2bbe4a6ecf9d15812c123b566a3db7',
  // 升级是 UUPS：客户端钉住审计过的实现，实现变了就拒绝服务（fail-closed），直到客户端更新这张表
  expectedImpl: Object.freeze({
    '0xd006ffdd5ae313b17729621a00999cd3c71ce5e6': Object.freeze(['0x1d279d138a4d803378a7d4557c056f1bed53c261']),
    // 2026-09-13 升级：容器级付费（isContainerLive）。旧实现保留在名单里是为了 owner 回滚时客户端不拒服，两者都经过审计。
    '0x861ee183de2bbe4a6ecf9d15812c123b566a3db7': Object.freeze(['0xaa226181a6588d3f9ac0035e5f3dbaf311039bce', '0x4e8684eaea48b524245b2191dee451eaa1c1ca94']),
  }),
  // 允许浏览器直接调用（CORS 预检通过）、支持批量请求的公共节点，**五家互不隶属的运营方**（2026-09-19 实测）：
  // NodeReal（BNB 官方 dataseed 背后就是它）、Allnodes（publicnode）、thirdweb、Alchemy（blastapi）、dRPC。
  // 不再放 defibit / ninicoin / binance.org 的 dataseed：响应头都带 NodeReal 的追踪号、版本号相同，是同一家，
  // 按域名会被误算成多家，"三家一致"实际一家就能满足。
  // 不放 bloXroute（bsc.rpc.blxrbdn.com）：它只有最近几千块的数据，更早的收据回答 null（"没有这笔"）而不是报错，
  // 严格读取会把它当成一个不同的答案——既造成分歧，也可能误导"交易没有上链"的判断。
  // 历史数据（约半小时以前的收据）：publicnode 要付费令牌（报错，严格读取会忽略它），thirdweb、dRPC 时常超时或限流，
  // 稳定能读的是 NodeReal 和 Alchemy。旧消息的附件核对因此可能读不齐三家，显示"暂时核对不了"，可以在设置里加自己的节点。
  rpcs: Object.freeze([
    'https://bsc-dataseed.bnbchain.org',
    'https://bsc-rpc.publicnode.com',
    'https://56.rpc.thirdweb.com',
    'https://bsc-mainnet.public.blastapi.io',
    'https://bsc.drpc.org',
  ]),
  // 各节点的单包上限与运营方（同一运营方的多个节点只算一票）。没列出的节点用内核默认值，节点拒绝批量时自动缩小。
  // callerKeys：节点会从网址的路径或查询串里读调用方密钥（thirdweb、Tenderly、Alchemy、dRPC 都有这种用法）。
  // 链上网站不能直接访问这种节点：否则网站能用自己的密钥让访客的浏览器把数据发到自己账户名下（审计 2026-09-19）。内核自己照常用
  rpcLimits: Object.freeze({
    'https://bsc-dataseed.bnbchain.org': Object.freeze({ maxBatch: 20, operator: 'nodereal' }),
    'https://bsc-rpc.publicnode.com': Object.freeze({ maxBatch: 20, operator: 'allnodes' }),
    // thirdweb 对未来块的报错和 dRPC 逐字相同（审计第三轮），可能走的是 dRPC：保守按 dRPC 计，不多算一家
    'https://56.rpc.thirdweb.com': Object.freeze({ maxBatch: 10, operator: 'drpc', callerKeys: true }),
    'https://bsc-mainnet.public.blastapi.io': Object.freeze({ maxBatch: 10, operator: 'alchemy', callerKeys: true }),
    'https://bsc.drpc.org': Object.freeze({ maxBatch: 3, operator: 'drpc', callerKeys: true }),
  }),
  // TapeSend 判断处理器工厂是否已封印所需的常量（TAP-10 §3.5）
  factorySeal: Object.freeze({
    implementation: '0xa68ccf4931d98ad0a4be15ee40542edc0dec6422',
    circuitBeacon: '0xf8d6d8eb894d6971c8976ad8b4971cbefe028156',
    circuitImplementation: '0x8e1d125def6d3826c278299273a0760d47626068',
  }),
});

// Base 与 X Layer：TapeOut 主协议、电路容器、网站合约与 BNB 同一份源码（只有 4 个费用常量不同），
// 由同一部署者按同一顺序部署，所以两条链上的合约地址相同。2026-09-19 主网只读核对：代码存在、实现槽与下表一致。
const L2_CONTRACTS = Object.freeze({
  factory: '0x1f09daefa827f02cbb40967cc91b259763760761',
  opener: '0x536add8f30f03b69f6fbf29d425a816a0dc50106',
  registries: Object.freeze(['0xd6efb7adcc9c83dc4924ad56f6a8e4e969b9adb6']),
  binding: '0x68809fd2fb343aa57d0aeb7f33defe477c9666f9',
  expectedImpl: Object.freeze({
    '0xd6efb7adcc9c83dc4924ad56f6a8e4e969b9adb6': Object.freeze(['0xa85c4143d1d4a77f54b8e4ecc9e6d1418afea45f']),
    '0x68809fd2fb343aa57d0aeb7f33defe477c9666f9': Object.freeze(['0x5ebf29b80789e548907c707530c3c7607c4347df']),
  }),
  factorySeal: Object.freeze({
    implementation: '0x74956236ab64ed143933040b4137e8a352e4d17b',
    circuitBeacon: '0xf70d1ed4f62cf3780157b0b421b7e2f45bd0991c',
    circuitImplementation: '0x977f217887e085d298cb3819cdad5a0ee35f29b2',
  }),
  nameSuffix: 'tape',
  // 读取和 BNB 一样钉在最新块往回 2 块：消息、网站几秒内就能看到。
  // "已确认"以安全区块为准（用户定案）：L2 的最新块由排序器单方面给出、还没提交到以太坊，可能被改写。
  // TapeSend 界面上 L2 消息不显示"确认中"（只是查看消息，用户定案），但内部仍按安全区块判断：
  // 资产附件的核对、首次引用记录都要等安全区块；读不到安全区块高度时一律当未确认。
  // 不把读取钉在安全区块：2026-09-19 实测 X Layer 的安全区块落后 3–4 分钟、而且隔几分钟跳一大段，用户要干等。
  pin: 'latest',
  finality: 'safe',
  maxBlockAgeSeconds: 300,
});

export const XLAYER_MAINNET = Object.freeze({
  chainId: 196,
  maxPinLagBlocks: 300,   // 约 1 秒一块，约 5 分钟
  key: 'xlayer',
  name: 'X Layer',
  currency: 'OKB',
  area: 2,
  ...L2_CONTRACTS,
  // 2026-09-19 实测：都允许浏览器跨域调用，都能读 safe 区块、事件和整块收据。
  // 独立运营方实际只有两家：OKX（两个域名；它也是 X Layer 的排序器）和 dRPC。
  // thirdweb 的 X Layer 节点对未知方法、超范围区块的报错和 OKX 逐字相同（它在 Base、BNB 上的报错格式不同），
  // 应是直接转发 OKX，按 OKX 计。所以严格读取要求 OKX 和 dRPC 两家一致；任一家挂了就读不到，可以在设置里加自己的节点。
  rpcs: Object.freeze([
    'https://rpc.xlayer.tech',
    'https://xlayerrpc.okx.com',
    'https://xlayer.drpc.org',
    'https://196.rpc.thirdweb.com',
  ]),
  rpcLimits: Object.freeze({
    'https://rpc.xlayer.tech': Object.freeze({ maxBatch: 10, operator: 'okx' }),
    'https://xlayerrpc.okx.com': Object.freeze({ maxBatch: 10, operator: 'okx' }),
    'https://xlayer.drpc.org': Object.freeze({ maxBatch: 3, operator: 'drpc', callerKeys: true }),
    'https://196.rpc.thirdweb.com': Object.freeze({ maxBatch: 10, operator: 'okx', callerKeys: true }),
  }),
});

export const BASE_MAINNET = Object.freeze({
  chainId: 8453,
  maxPinLagBlocks: 150,   // 2 秒一块，约 5 分钟
  key: 'base',
  name: 'Base',
  currency: 'ETH',
  area: 3,
  ...L2_CONTRACTS,
  // 2026-09-19 实测：五家不同运营方，都允许跨域、能读 safe 区块和事件。
  // 1rpc.io、blastapi、llamarpc 限流严重或不可用，不作默认。
  rpcs: Object.freeze([
    'https://mainnet.base.org',
    'https://base-rpc.publicnode.com',
    'https://base.drpc.org',
    'https://8453.rpc.thirdweb.com',
    'https://base.gateway.tenderly.co',
  ]),
  rpcLimits: Object.freeze({
    'https://mainnet.base.org': Object.freeze({ maxBatch: 10, operator: 'coinbase' }),
    'https://base-rpc.publicnode.com': Object.freeze({ maxBatch: 20, operator: 'publicnode' }),
    'https://base.drpc.org': Object.freeze({ maxBatch: 3, operator: 'drpc', callerKeys: true }),
    'https://8453.rpc.thirdweb.com': Object.freeze({ maxBatch: 10, operator: 'drpc', callerKeys: true }),
    'https://base.gateway.tenderly.co': Object.freeze({ maxBatch: 10, operator: 'tenderly', callerKeys: true }),
  }),
});

/** 所有已开通的网络，BNB 在最前（没有区号的名字、容器地址探测都先看它） */
export const NETWORKS = Object.freeze([BSC_MAINNET, XLAYER_MAINNET, BASE_MAINNET]);
export const HOME_NETWORK = BSC_MAINNET;
/** 区号 → 网络（null/undefined = BNB） */
export function networkByArea(area) {
  if (area === null || area === undefined) return BSC_MAINNET;
  return NETWORKS.find((n) => n.area !== null && n.area === Number(area)) || null;
}
export const networkByChainId = (chainId) => NETWORKS.find((n) => n.chainId === Number(chainId)) || null;
export const networkByKey = (key) => NETWORKS.find((n) => n.key === String(key).toLowerCase()) || null;

/** 链上网站可以直接访问的节点（网关放行、沙盒 CSP 用）：排除会从路径或查询串读调用方密钥的节点 */
export const siteNodes = (net) => net.rpcs.filter((u) => !(net.rpcLimits && net.rpcLimits[u] && net.rpcLimits[u].callerKeys));

/**
 * 给 createRpc 的参数：节点列表、每个节点的单包上限、运营方。
 * urls 传入时（用户自己的节点）用它；自定义节点没有登记上限，由 rpc 在节点拒绝批量时自动缩小。
 */
export function rpcOptionsFor(net, urls) {
  const list = urls && urls.length ? [...urls] : [...net.rpcs];
  const limits = net.rpcLimits || {};
  const maxBatchByUrl = {}, operators = {};
  for (const u of list) {
    const l = limits[u];
    if (!l) continue;
    if (l.maxBatch) maxBatchByUrl[u] = l.maxBatch;
    if (l.operator) operators[u] = l.operator;
  }
  return { urls: list, maxBatchByUrl, operators, pin: net.pin };
}

export const LIMITS = Object.freeze({
  rangeBytes: 96 * 1024,          // 大文件按 96 KB 分段 readRange（与网关一致，单段约 2M gas 以内）
  maxFileBytes: 350 * 24_000,     // SiteRegistry 单文件上限：350 块 × 24,000 字节
  maxManifestPaths: 5_000,        // 一个站点最多列这么多路径
  maxTokenId: 10n ** 18n,         // 输入里的 #ID 上限（防超长数字）
  maxCpuIndex: 10n ** 9n,
});
