// 网络常量。全部是 BNB Smart Chain 主网上已部署、已核对过的地址（2026-09-13 只读核实）。
// 这里的值会被写进规范（SPEC.md §3、§5），改动任何一项都要同步改规范。

export const IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'; // ERC-1967 实现槽

export const BSC_MAINNET = Object.freeze({
  chainId: 56,
  nameSuffix: 'tape',
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
  // 允许浏览器直接调用（CORS 预检通过）且支持批量请求的公共节点，**每个来自不同的运营方**
  // （BNB Chain、Allnodes/publicnode、Defibit、Ninicoin），默认要求至少 2 个结果一致。
  // 不要同时放 bnbchain.org 与 binance.org 的 dataseed：同一运营方，两票等于一票。
  // bsc.meowrpc.com 预检可用但浏览器里很快 429，不作默认。
  rpcs: Object.freeze([
    'https://bsc-dataseed.bnbchain.org',
    'https://bsc-rpc.publicnode.com',
    'https://bsc-dataseed1.defibit.io',
    'https://bsc-dataseed1.ninicoin.io',
  ]),
});

export const LIMITS = Object.freeze({
  rangeBytes: 96 * 1024,          // 大文件按 96 KB 分段 readRange（与网关一致，单段约 2M gas 以内）
  maxFileBytes: 350 * 24_000,     // SiteRegistry 单文件上限：350 块 × 24,000 字节
  maxManifestPaths: 5_000,        // 一个站点最多列这么多路径
  maxTokenId: 10n ** 18n,         // 输入里的 #ID 上限（防超长数字）
  maxCpuIndex: 10n ** 9n,
});
