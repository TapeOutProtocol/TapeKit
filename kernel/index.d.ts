// Type definitions for @tapekit/kernel — the tape:// on-chain website kernel (SPEC.md).
// Hand-written; kept in sync with src/*.js. Checked by `npm run test:types`.

export type Locale = 'zh' | 'en';
export type SiteStatus = 'ok' | 'unpaid' | 'not-opened' | 'no-such-cpu' | 'no-such-token' | 'not-tapeout' | 'blocked' | 'store-changed';
export type FileStatus = 'ok' | 'no-hash' | 'incomplete' | 'too-large';
export type Hex = `0x${string}`;
export type Address = `0x${string}`;

// ---------------------------------------------------------------- errors & i18n

/** Base class of every kernel error: stable `code`, `message` in the current locale, both languages in `messages`. */
export class KernelError extends Error {
  code: string;
  messages: { zh: string; en: string };
  detail?: unknown;
  constructor(code: string, key: string, vars?: Record<string, unknown>, detail?: unknown);
}
/** Address-bar input that cannot be parsed (code `input`). */
export class InputError extends KernelError {}
/** Node problems (code `rpc`): `rpc.conflict` nodes disagree, `rpc.short` not enough nodes, `rpc.heads` not enough heads, `rpc.none` no nodes configured. */
export class RpcError extends KernelError {}
/** Site read problems (codes `chain`, `too-many-files`, `too-large`). */
export class SiteError extends KernelError {}

export function setLocale(locale?: string): Locale;
export function getLocale(): Locale;
export function detectLocale(): Locale;
/** Message in the current locale. */
export function t(key: string, vars?: Record<string, unknown>): string;
/** Message in both languages. */
export function tt(key: string, vars?: Record<string, unknown>): { zh: string; en: string };
/** "中文 / English" on one line. */
export function both(key: string, vars?: Record<string, unknown>): string;
export const messages: Readonly<Record<string, { zh: string; en: string }>>;
export function statusText(status: SiteStatus | string): string;
export function statusText(status: SiteStatus | string, mode: 'both'): { zh: string; en: string };
/** @deprecated use statusText(); a live view of the current-locale texts */
export const STATUS_TEXT: Readonly<Record<SiteStatus, string>>;

// ---------------------------------------------------------------- names, paths, scanning

export interface ParsedName { kind: 'name'; tokenId: bigint; cpu: bigint; path: string }
export interface ParsedContainer { kind: 'container'; container: Address; path: string }
export interface ParsedCircuit { kind: 'circuit'; circuits: Address; tokenId: bigint; path: string }
export type ParsedInput = ParsedName | ParsedContainer | ParsedCircuit;
/** Accepts every form of SPEC §2.4 (`4246.0.tape`, `4246.0`, `tape://…`, `web+tape://…`, `#4246@0`, `0x<container>`, `0x<processor>#4246`). Throws InputError otherwise. */
export function parseInput(raw: string): ParsedInput;
export function formatName(tokenId: bigint | number | string, cpu: bigint | number | string, suffix?: string): string;
export function formatUrl(tokenId: bigint | number | string, cpu: bigint | number | string, path?: string, suffix?: string): string;

/** SPEC §6 steps 1–3. Returns null for an invalid path. */
export function normalizePath(raw: string): string | null;
/** SPEC §6 step 4: exact → `<path>/index.html` → fallback → null (404). */
export function resolvePath(requested: string, pathSet: Set<string>, fallbackPath: string): string | null;
export function safeContentType(ct: string): string;

export interface ExternalRef { url: string; where: 'html' | 'inline-css' | 'css' | 'meta-refresh' }
export function isExternal(url: string): boolean;
export function scanHtml(text: string): ExternalRef[];
export function scanCss(text: string): ExternalRef[];
export function scanSite(files: Map<string, { bytes: Uint8Array; contentType?: string }>): { pure: boolean; external: Array<ExternalRef & { path: string }> };
/** In-site references (relative or root-relative) found in HTML/CSS, resolved to site-root paths, deduplicated. */
export function collectReferences(text: string, kind: 'html' | 'css', fromDir?: string): string[];

// ---------------------------------------------------------------- hashing & constants

export function keccak256(input: Uint8Array | string): Uint8Array;
export function keccakHex(input: Uint8Array | string): Hex;
export function toChecksumAddress(addr: string): Address;
export function sha256Hex(bytes: Uint8Array): Promise<Hex>;

export interface Network {
  chainId: number;
  nameSuffix: string;
  factory: Address;
  opener: Address;
  registries: readonly Address[];
  binding: Address;
  /** proxy address → audited implementation addresses (lowercase) */
  expectedImpl: Readonly<Record<string, readonly string[]>>;
  rpcs: readonly string[];
}
export const BSC_MAINNET: Readonly<Network>;
export const LIMITS: Readonly<{ rangeBytes: number; maxFileBytes: number; maxManifestPaths: number; maxTokenId: bigint; maxCpuIndex: bigint }>;
export const IMPL_SLOT: Hex;
export const SEL: Readonly<Record<string, Hex>>;
export const SIG: Readonly<Record<string, string>>;
export const TOPIC: Readonly<Record<'FileSet' | 'FileRemoved' | 'FallbackSet', Hex>>;
export const EVENT_SIG: Readonly<Record<'FileSet' | 'FileRemoved' | 'FallbackSet', string>>;

// ---------------------------------------------------------------- cache

/** Pluggable persistent cache. Files are content-addressed by on-chain sha256; entries are LRU-evicted by bytes. */
export interface Cache {
  kind: string;
  get(key: string): Promise<{ meta: any; bytes: Uint8Array } | undefined>;
  set(key: string, meta: any, bytes: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
}
export function createMemoryCache(options?: { maxBytes?: number }): Cache;
/** Node: one directory, `<hash>.bin` + `<hash>.json` per entry plus `index.json` for LRU. */
export function createFsCache(dir: string, options?: { maxBytes?: number }): Promise<Cache & { dir: string }>;
/** Browsers and Service Workers: IndexedDB. */
export function createIdbCache(name?: string, options?: { maxBytes?: number }): Promise<Cache & { name: string }>;

// ---------------------------------------------------------------- rpc

export type RpcOutcome = { ok: true; value: string; raw?: unknown; logs?: unknown[] } | { revert: true; data?: string; empty?: boolean };
export interface NodeStats { ok: number; fail: number; rateLimited: number; lastMs: number | null; lastError: string | null; cooldownUntil: number }
export interface RpcRequest {
  method: string;
  params: unknown[];
  /** Pick the fields that must agree across nodes; the picked object is what the caller receives as `raw`. */
  normalize?: (result: any) => unknown;
}
export interface ManyOptions {
  /** Strict agreement: ask every node, reject on any disagreement, require `strictQuorum` agreeing answers. */
  all?: boolean;
}
export interface Rpc {
  urls: string[];
  quorum: number;
  /** Agreeing operators required in strict mode: 3, or 2 when only 2 operators are configured; never fewer than 2 unless set explicitly. */
  strictQuorum: number;
  /** Distinct operators among `urls`. */
  operatorCount: number;
  /** Operator label of a node URL: the `operators` entry, else the IP address, else the last two host labels. */
  operatorOf(url: string): string;
  /** Runs a batch of JSON-RPC requests; every request needs `quorum` identical answers from different nodes. Rejects with RpcError on disagreement. */
  many(reqs: RpcRequest[], opts?: ManyOptions): Promise<RpcOutcome[]>;
  calls(items: Array<{ to: Address; data: Hex }>, block: Hex | 'latest'): Promise<RpcOutcome[]>;
  storageAt(addr: Address, slot: Hex, block: Hex | 'latest'): Promise<RpcOutcome>;
  /** A block height that at least `quorum` nodes already have (the `quorum`-th highest head minus 2), waiting `headGraceMs` for the other nodes. */
  pinBlock(): Promise<Hex>;
  getLogs(filter: object, opts?: ManyOptions): Promise<unknown[]>;
  stats(): Record<string, NodeStats>;
}
export interface RpcOptions {
  urls: string[];
  /** default 2 */ quorum?: number;
  /** agreeing operators required in strict mode; default max(2, min(3, operators)) */ strictQuorum?: number;
  /** explicit operator label per URL; nodes of one operator count once */ operators?: Record<string, string>;
  /** default 10000 */ timeoutMs?: number;
  /** ask another node if no agreement within this time; default 1500 */ hedgeMs?: number;
  /** default 40 */ maxBatch?: number;
  fetchImpl?: typeof fetch;
  shuffle?: boolean;
  /** retries on 429 / 5xx / network errors; default 2 */ retries?: number;
  /** default 400 (doubles each retry, with jitter) */ backoffMs?: number;
  /** rate-limited nodes are ordered last for this long; default 20000 */ cooldownMs?: number;
  /** how long pinBlock waits for the remaining nodes after `quorum` heads arrived; default 1500 */ headGraceMs?: number;
  /** overall time limit of a strict-mode many(); default 1.5 × timeoutMs */ strictDeadlineMs?: number;
}
export function createRpc(options: RpcOptions): Rpc;
export function canonicalJson(value: unknown): string;

// ---------------------------------------------------------------- identity (TapeKit core, shared with TapeSend)

export type IdentityStatus = 'ok' | 'no-such-cpu' | 'no-such-token' | 'not-tapeout';
export interface ResolvedIdentity {
  status: IdentityStatus;
  name?: string;
  tokenId?: bigint;
  cpu?: bigint;
  cpuName?: string;
  circuits?: Address;
  container?: Address | null;
  holder?: Address | null;
  opened?: boolean;
}
/** Identity resolution of SPEC §3.2 steps 1–4 and §3.3 steps 1–4, without store pinning, blocking or activation. */
export interface Identity {
  network: Network;
  batch(items: Array<{ to: string; sel: string; types?: string[]; values?: unknown[]; out: string[] }>, block: Hex): Promise<any[]>;
  one(item: { to: string; sel: string; types?: string[]; values?: unknown[]; out: string[] }, block: Hex): Promise<any>;
  cpuAt(cpu: bigint | number, block: Hex): Promise<Address | null>;
  cpuIndexOf(circuits: string, block: Hex): Promise<bigint | null>;
  resolveIdentity(
    parsed: ParsedInput,
    block: Hex,
    opts?: { prepend?: Array<{ method: string; params: unknown[] }>; afterFirst?: (outcomes: unknown[]) => boolean },
  ): Promise<{ prepended: unknown[]; identity: ResolvedIdentity | null }>;
}
export function createIdentity(options: { rpc: Rpc; network?: Partial<Network>; cache?: Cache; fail?: (what: string) => never; strict?: boolean }): Identity;

// ---------------------------------------------------------------- kernel

export interface StoreCheck { ok: boolean; stores: Array<{ address: string; impl: string | null; expected: readonly string[]; ok: boolean }> }

/** Result of resolve(). Fields after `stores` are present once the name has been derived. */
export interface Resolution {
  input: string;
  path: string;
  block: Hex;
  chainId: number;
  stores: StoreCheck;
  status: SiteStatus;
  name?: string;
  url?: string;
  cpu?: bigint;
  cpuName?: string;
  circuits?: Address;
  tokenId?: bigint;
  container?: Address;
  holder?: Address | null;
  opened?: boolean;
  paid?: boolean;
  paidUntil?: bigint;
  paidVia?: 'name' | 'container' | null;
}

export interface Manifest { registry: Address; paths: string[]; pathSet: Set<string>; fallback: string; truncated: boolean; block: Hex }
export interface FileInfo { size: number; contentType: string; sha: Hex; updatedAt: number; chunkCount: number }

export interface SiteFile {
  path: string;
  bytes: Uint8Array;
  size: number;
  contentType: string;
  declaredSha: Hex;
  sha256: Hex;
  updatedAt: number;
  /** true only when status === 'ok' */
  verified: boolean;
  status: 'ok' | 'no-hash' | 'incomplete';
  fromCache: boolean;
}
export interface TooLargeFile { path: string; status: 'too-large'; size: number; verified: false }
export type GetFileResult = SiteFile | TooLargeFile | null;

export interface Progress { done: number; total: number; files: number; count?: number }

/** On-demand site handle from openSite(): manifest first, files as they are requested. */
export interface Site {
  res: Resolution;
  manifest: Manifest;
  /** real path → file, for everything read so far */
  files: Map<string, SiteFile>;
  /** Resolve a requested path (SPEC §6) and read it; null = 404. Concurrent calls for one path share a single read. */
  get(requestedPath: string): Promise<GetFileResult>;
  /** Batch prefetch (requests are merged). */
  prefetch(paths: string[], onProgress?: (p: Progress) => void): Promise<{ loaded: Map<string, SiteFile>; problems: Array<{ path: string; status: string }> }>;
  info(realPath: string): Promise<FileInfo>;
}

export interface WatchChange { changed: string[]; removed: string[]; added: boolean; fallbackChanged: boolean; count: number; block: Hex }

export interface KernelOptions {
  /** override any field of BSC_MAINNET */ network?: Partial<Network>;
  rpcUrls?: string[];
  quorum?: number;
  rpc?: Rpc;
  fetchImpl?: typeof fetch;
  /** SPEC §9 blocklist hook */ isBlocked?: (x: { container: Address; name: string }) => boolean | Promise<boolean>;
  cache?: Cache;
  /** for the default memory cache; default 64 MiB */ cacheBytes?: number;
  /** resolution cache; default 60000 */ resolveTtlMs?: number;
  /** tests only: skip the ERC-1967 implementation check */ skipImplCheck?: boolean;
  locale?: string;
}

export interface Kernel {
  config: Network;
  rpc: Rpc;
  cache: Cache;
  parseInput: typeof parseInput;
  /** Resolve any SPEC §2.4 input. All reads pinned to one block. Cached for resolveTtlMs unless `fresh`. */
  resolve(input: string | ParsedInput, opts?: { fresh?: boolean; block?: Hex }): Promise<Resolution>;
  manifest(res: Resolution, opts?: { block?: Hex }): Promise<Manifest>;
  /** Read one file directly (no handle). */
  getFile(res: Resolution, man: Manifest, requestedPath: string): Promise<GetFileResult>;
  openSite(res: Resolution, opts?: { block?: Hex }): Promise<Site>;
  /** Whole-site read for small sites; throws SiteError above the limits. */
  loadSite(res: Resolution, opts?: { maxBytes?: number; maxFiles?: number; onProgress?: (p: Progress) => void; block?: Hex }): Promise<{ manifest: Manifest; files: Map<string, SiteFile>; problems: Array<{ path: string; status: string }>; totalBytes: number; site: Site }>;
  checkStores(block: Hex | 'latest'): Promise<StoreCheck>;
  cpuIndexOf(circuits: Address, block: Hex | 'latest'): Promise<bigint | null>;
  cpuAt(cpu: bigint | number, block: Hex | 'latest'): Promise<Address | null>;
  /** DomainBinding.isLive(domain, container) — for verifying ordinary https pages. */
  domainLive(domain: string, container: Address, opts?: { block?: Hex }): Promise<boolean>;
  /** Poll known files for on-chain changes (public nodes rarely serve eth_getLogs). Returns stop(). */
  watch(site: Site, onChange: (c: WatchChange) => void | Promise<void>, opts?: { intervalMs?: number; maxPaths?: number; firstDelayMs?: number; onError?: (e: unknown) => void }): () => void;
  normalizePath: typeof normalizePath;
  resolvePath: typeof resolvePath;
  setLocale: typeof setLocale;
  getLocale: typeof getLocale;
  statusText: typeof statusText;
}

export function createKernel(options?: KernelOptions): Kernel;
