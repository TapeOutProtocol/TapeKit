// @tapekit/kernel —— TapeOut 纯链上网站的读取内核（开源，MIT）。规范见 ../../SPEC.md（英文正本）与 ../../SPEC.zh.md（中文）。
export { createKernel, createChainKernel, STATUS_TEXT, statusText, SiteError } from './kernel.js';
export { createRpc, RpcError } from './rpc.js';
export { createIdentity } from './identity.js';
export { parseInput, formatName, formatUrl, formatShort, formatLabel, formatHostLabel, parseHostLabel, InputError } from './name.js';
export { normalizePath, resolvePath, safeContentType } from './path.js';
export { scanSite, scanHtml, scanCss, isExternal, collectReferences } from './purity.js';
export { keccak256, keccakHex, toChecksumAddress } from './keccak.js';
export { sha256Hex } from './sha.js';
export { BSC_MAINNET, XLAYER_MAINNET, BASE_MAINNET, NETWORKS, HOME_NETWORK, networkByArea, networkByChainId, networkByKey, rpcOptionsFor, siteNodes, LIMITS, IMPL_SLOT } from './config.js';
export { SEL, SIG, TOPIC, EVENT_SIG } from './selectors.js';
export { createMemoryCache, createFsCache, createIdbCache } from './cache.js';
export { setLocale, getLocale, detectLocale, t, tt, both, messages, KernelError } from './i18n.js';
