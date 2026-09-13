// 内核调用的全部函数选择器（keccak256(签名) 前 4 字节）。写死是为了零依赖；
// test/unit.test.mjs 会用内置 keccak 逐个重算核对，改签名必须同步改这里。

export const SIG = Object.freeze({
  cpuCount: 'cpuCount()',
  cpuAt: 'cpuAt(uint256)',
  isCPU: 'isCPU(address)',
  accountOf: 'accountOf(address,uint256)',
  isOpened: 'isOpened(address,uint256)',
  token: 'token()',
  ownerOf: 'ownerOf(uint256)',
  name: 'name()',
  fileInfo: 'fileInfo(address,string)',
  read: 'read(address,string)',
  readRange: 'readRange(address,string,uint256,uint256)',
  pathCount: 'pathCount(address)',
  pathsRange: 'pathsRange(address,uint256,uint256)',
  fallbackPath: 'fallbackPath(address)',
  isLive: 'isLive(string,address)',
  paidUntil: 'paidUntil(bytes32,address)',
  monthlyFee: 'monthlyFee()',
  containerPaidUntil: 'containerPaidUntil(address)',
  isContainerLive: 'isContainerLive(address)',
});

export const SEL = Object.freeze({
  cpuCount: '0xa94da8a7',
  cpuAt: '0x4bc7cbbd',
  isCPU: '0x5f5a364f',
  accountOf: '0x0c1905e5',
  isOpened: '0x8b508494',
  token: '0xfc0c546a',
  ownerOf: '0x6352211e',
  name: '0x06fdde03',
  fileInfo: '0x6c609107',
  read: '0xccaa7afb',
  readRange: '0x15a4cae2',
  pathCount: '0xb554782b',
  pathsRange: '0xb056072c',
  fallbackPath: '0xa76c7713',
  isLive: '0xd6b062cd',
  paidUntil: '0x2110540f',
  monthlyFee: '0x8cfd3e40',
  containerPaidUntil: '0x9ebfd859',
  isContainerLive: '0xdcca979e',
});

/** SiteRegistry 事件主题（keccak256 of signature），watch() 用来发现站点更新 */
export const EVENT_SIG = Object.freeze({
  FileSet: 'FileSet(address,string,uint32,bytes32,string)',
  FileRemoved: 'FileRemoved(address,string)',
  FallbackSet: 'FallbackSet(address,string)',
});
export const TOPIC = Object.freeze({
  FileSet: '0x13b9b0f05b22c496a9d9a29e7041c56c04670dc98ab327448870f18eb07b6773',
  FileRemoved: '0x8598a19145ba7b62366f9f3e3ceca438df1e575ffa3bef982ed120041131d786',
  FallbackSet: '0x47296cb5a49fb9ae062bb59d2c8932790144b5997d4a4f76f76207bb527f1be0',
});
