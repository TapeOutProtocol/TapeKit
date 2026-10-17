# Tapekit

**The open-source browser kernel for the TapeOut protocol.** Websites are stored byte-for-byte on BNB Chain; Tapekit reads them straight from the chain, verifies every byte, and opens them in the browser. No domain name, no DNS, no server.

**Try it now / 现在就试**: open **https://4246-0.tapekit.org/** in any browser. That page is `4246.0.tape`, read straight from BNB Chain by a Service Worker in your browser and verified byte by byte; its status page is at **https://4246-0.tapekit.org/.tape/status**. The gateway home is https://tapekit.org/ .

[中文](#中文) · [English](#english) · [한국어](#한국어) · [Documentation index / 文档索引](#documentation-index--文档索引)

---

## Contents / 目录

- [中文](#中文) — 正文（含展望）
- [English](#english) — the same text in English
- [한국어](#한국어) — 한국어 번역
- [Documentation index / 文档索引](#documentation-index--文档索引)
  - [Specification / 规范](#specification--规范)
  - [Repository map / 仓库结构](#repository-map--仓库结构)
  - [Quick start / 快速开始](#quick-start--快速开始)
  - [Ways to open an on-chain site / 打开链上网站的几种方式](#ways-to-open-an-on-chain-site--打开链上网站的几种方式)
  - [Mainnet constants / 主网常量](#mainnet-constants--主网常量)
  - [Status and roadmap / 状态与路线](#status-and-roadmap--状态与路线)
  - [Naming / 命名](#naming--命名)
  - [License / 许可](#license--许可)
- [Site owner handbook / 站长手册](#site-owner-handbook--站长手册)
  - [1. What a site is on chain / 网站在链上是什么](#1-what-a-site-is-on-chain--网站在链上是什么)
  - [2. Prepare the folder / 准备文件夹](#2-prepare-the-folder--准备文件夹)
  - [3. Publish / 发布](#3-publish--发布)
  - [4. Fallback path for single-page apps / 单页应用的回退路径](#4-fallback-path-for-single-page-apps--单页应用的回退路径)
  - [5. Content types / 内容类型](#5-content-types--内容类型)
  - [6. Limits / 上限](#6-limits--上限)
  - [7. Being 100% on-chain / 做到 100% 链上](#7-being-100-on-chain--做到-100-链上)
  - [8. Activate the name / 开通名字](#8-activate-the-name--开通名字)
  - [9. Test before you pay / 付费前自测](#9-test-before-you-pay--付费前自测)
  - [10. Verify your own site / 核对自己的站](#10-verify-your-own-site--核对自己的站)
  - [11. Update, transfer, take down / 更新、转让、下线](#11-update-transfer-take-down--更新转让下线)
  - [12. TapeKit wallet for site owners / 给站长的 TapeKit 钱包](#12-tapekit-wallet-for-site-owners--给站长的-tapekit-钱包)
- [Kernel API reference / 内核 API 参考](#kernel-api-reference--内核-api-参考)
  - [Install and import / 安装与引入](#install-and-import--安装与引入)
  - [createKernel(options)](#createkerneloptions)
  - [kernel.resolve(input, opts)](#kernelresolveinput-opts)
  - [kernel.openSite(res) → site](#kernelopensiteres--site)
  - [site.get(path) / site.prefetch(paths) / site.info(path)](#sitegetpath--siteprefetchpaths--siteinfopath)
  - [kernel.loadSite(res, opts)](#kernelloadsiteres-opts)
  - [kernel.watch(site, onChange, opts)](#kernelwatchsite-onchange-opts)
  - [Caches / 缓存](#caches--缓存)
  - [RPC client / 节点客户端](#rpc-client--节点客户端)
  - [Errors and bilingual messages / 错误码与双语文案](#errors-and-bilingual-messages--错误码与双语文案)
  - [Helpers / 工具函数](#helpers--工具函数)
  - [Types / 类型](#types--类型)

---

## 中文

Tapekit 是 TapeOut 协议的开源浏览器内核：网站的每一个字节都存在 BNB 链上，内核直接读链、逐字节校验、在浏览器里打开。不经过域名，不经过 DNS，不经过任何服务器。

### 正文

在 TapeOut 里，一枚电路 NFT 绑定一个链上容器，容器名下存着一整个网站：HTML、脚本、样式、图片，每个文件都带着链上记录的 SHA-256。Tapekit 做的事只有一件：把这些字节原样取回来，验明正身，交给浏览器。

打开一个网站有三种写法，指向的是同一个东西：

* 链上名字：`4246.0.tape`（0 号处理器的第 4246 枚电路）；
* 电路本身：处理器合约地址加 #ID；
* 容器合约地址：`0x86DD…eA95`。

内核从名字算出容器，从容器读出文件清单，再把每个文件读回来，和链上记录的长度、哈希逐一核对。核对不过的字节不显示。读取不信任任何单个节点：至少两家互不相关的节点运营方给出完全相同的结果才采用，任何一处不一致就拒绝。

这意味着几件以前做不到的事：

* **没有服务器可以下线。** 网站不在任何一台机器上，它在链上。没有主机可以关停，没有域名可以过期，没有证书可以被吊销。
* **没有人能篡改你看到的东西。** 每个字节都对得上链上哈希，中间人换不掉一个字符。
* **没有人能挡在你和网站之间。** 只要你能连上任意一个 BNB 链节点，或者自己跑一个，你就能用这份开源内核把网站读出来。这不是我们承诺的，是链本身保证的：数据在链上就是公开的，谁都读得到，谁都删不掉。
* **区块链在，网站就在。** 站长可以更新它，可以转让它，但不能让它消失；任何人都不能。

### 展望

今天 Tapekit 已经能做到：Service Worker 网关让普通 Chrome、Edge、Firefox、Safari 不装任何东西就打开链上网站，每个网站有独立来源，能保存数据，能直接用你已有的钱包扩展；浏览器扩展在地址栏输入名字就能打开；桌面版将向系统注册 `tape://` 协议，让 `tape://4246.0.tape` 成为一个真正的网址。

往下走的方向只有一个：把一切放到链上。前端在链上，逻辑在链上（TapeOut 的电路本身就是链上运行的程序），状态在链上。到那一步，一个应用从界面到后端没有任何一环落在链外，也就没有任何一环可以被关掉、被改掉、被拦下。

规范以 CC0 放弃权利，代码以 MIT 开源。任何人都可以架自己的网关、写自己的内核实现、做自己的浏览器。我们写的这一份只是参考。

---

## English

Tapekit is the open-source browser kernel for the TapeOut protocol: every byte of a website lives on BNB Chain, and the kernel reads it straight from the chain, verifies it byte by byte, and opens it in the browser. No domain name, no DNS, no server of any kind.

### What it does

In TapeOut, a circuit NFT is bound to an on-chain container, and under that container's name lives an entire website: HTML, scripts, stylesheets, images, each file carrying the SHA-256 recorded on chain. Tapekit does exactly one thing: fetch those bytes as they are, verify their identity, and hand them to the browser.

There are three ways to open a website, and they all point to the same thing:

* The on-chain name: `4246.0.tape` (circuit #4246 on processor 0);
* The circuit itself: the processor contract address plus the #ID;
* The container contract address: `0x86DD…eA95`.

From the name, the kernel derives the container; from the container, it reads the file list; then it fetches each file and checks it, one by one, against the length and hash recorded on chain. Bytes that fail the check are never displayed. Reads trust no single node: at least two unrelated node operators must return exactly the same result before it is accepted, and any disagreement anywhere means rejection.

This makes possible several things that could not be done before:

* **No server can go offline.** The website is not on any machine; it is on the chain. There is no host to shut down, no domain to expire, no certificate to revoke.
* **No one can tamper with what you see.** Every byte matches its on-chain hash; a man in the middle cannot swap a single character.
* **No one can stand between you and the website.** As long as you can reach any BNB Chain node, or run one yourself, you can read the website with this open-source kernel. This is not something we promise; it is something the chain itself guarantees: data on chain is public, anyone can read it, and no one can delete it.
* **As long as the blockchain exists, the website exists.** The owner can update it and can transfer it, but cannot make it disappear; nor can anyone else.

### Looking ahead

Today Tapekit can already do this: the Service Worker gateway lets ordinary Chrome, Edge, Firefox, and Safari open on-chain websites without installing anything, each website in its own origin, able to store data and use the wallet extension you already have; the browser extension opens a site when you type its name in the address bar; the desktop version will register the `tape://` protocol with the operating system, making `tape://4246.0.tape` a real URL.

There is only one direction from here: put everything on chain. Front end on chain, logic on chain (TapeOut circuits are themselves programs that run on chain), state on chain. At that point, an application from its interface to its back end has not a single link off chain, and therefore not a single link that can be shut down, altered, or intercepted.

The specification is released under CC0; the code is open source under MIT. Anyone can run their own gateway, write their own kernel implementation, build their own browser. The one we wrote is only a reference.

---

## 한국어

Tapekit은 TapeOut 프로토콜의 오픈소스 브라우저 커널입니다: 웹사이트의 모든 바이트가 BNB 체인에 저장되어 있고, 커널은 체인을 직접 읽어 바이트 단위로 검증한 뒤 브라우저에서 엽니다. 도메인을 거치지 않고, DNS를 거치지 않고, 어떤 서버도 거치지 않습니다.

### 본문

TapeOut에서는 회로 NFT 하나가 온체인 컨테이너 하나에 묶이고, 그 컨테이너 이름 아래에 웹사이트 전체가 저장됩니다: HTML, 스크립트, 스타일, 이미지, 그리고 각 파일마다 체인에 기록된 SHA-256이 함께 있습니다. Tapekit이 하는 일은 단 하나입니다: 이 바이트들을 원본 그대로 가져와서, 신원을 확인하고, 브라우저에 넘기는 것.

웹사이트를 여는 방법은 세 가지이며, 모두 같은 것을 가리킵니다:

* 온체인 이름: `4246.0.tape` (0번 프로세서의 4246번째 회로);
* 회로 자체: 프로세서 컨트랙트 주소와 #ID;
* 컨테이너 컨트랙트 주소: `0x86DD…eA95`.

커널은 이름에서 컨테이너를 계산하고, 컨테이너에서 파일 목록을 읽은 뒤, 각 파일을 다시 읽어와 체인에 기록된 길이와 해시를 하나하나 대조합니다. 대조에 실패한 바이트는 표시하지 않습니다. 읽기는 어떤 단일 노드도 신뢰하지 않습니다: 서로 무관한 노드 운영자 최소 두 곳이 완전히 동일한 결과를 내놓아야 채택하며, 어느 한 곳이라도 불일치하면 거부합니다.

이는 예전에는 할 수 없었던 몇 가지를 의미합니다:

* **어떤 서버도 다운될 수 없습니다.** 웹사이트는 어느 기계에도 있지 않습니다. 체인 위에 있습니다. 끌 수 있는 호스트도, 만료될 수 있는 도메인도, 취소될 수 있는 인증서도 없습니다.
* **누구도 당신이 보는 것을 변조할 수 없습니다.** 모든 바이트가 온체인 해시와 일치하며, 중간자는 한 글자도 바꿀 수 없습니다.
* **누구도 당신과 웹사이트 사이를 가로막을 수 없습니다.** 아무 BNB 체인 노드에 연결할 수 있거나 직접 하나를 운영할 수 있다면, 이 오픈소스 커널로 웹사이트를 읽어낼 수 있습니다. 이것은 우리가 약속하는 것이 아니라 체인 자체가 보장하는 것입니다: 체인 위의 데이터는 공개되어 있고, 누구나 읽을 수 있으며, 누구도 삭제할 수 없습니다.
* **블록체인이 존재하는 한, 웹사이트도 존재합니다.** 사이트 소유자는 그것을 업데이트할 수 있고 양도할 수 있지만, 사라지게 할 수는 없습니다. 그 누구도 할 수 없습니다.

### 전망

오늘 Tapekit은 이미 다음을 할 수 있습니다: Service Worker 게이트웨이는 일반 Chrome, Edge, Firefox, Safari가 아무것도 설치하지 않고 온체인 웹사이트를 열게 하며, 각 웹사이트는 독립된 출처(origin)를 가지고, 데이터를 저장할 수 있고, 이미 가지고 있는 지갑 확장 프로그램을 바로 사용할 수 있습니다; 브라우저 확장 프로그램은 주소창에 이름을 입력하면 열립니다; 데스크톱 버전은 시스템에 `tape://` 프로토콜을 등록하여 `tape://4246.0.tape`를 진짜 URL로 만들 것입니다.

앞으로 나아갈 방향은 하나뿐입니다: 모든 것을 체인 위에 올리는 것. 프런트엔드도 체인에, 로직도 체인에 (TapeOut의 회로 자체가 체인 위에서 실행되는 프로그램입니다), 상태도 체인에. 그 단계에 이르면, 하나의 애플리케이션은 화면에서 백엔드까지 어느 한 고리도 체인 밖에 있지 않으며, 따라서 어느 한 고리도 꺼지거나, 바뀌거나, 가로막힐 수 없습니다.

명세는 CC0로 권리를 포기하고, 코드는 MIT로 오픈소스입니다. 누구나 자신의 게이트웨이를 세우고, 자신의 커널 구현을 쓰고, 자신의 브라우저를 만들 수 있습니다. 우리가 쓴 이 구현은 참고용일 뿐입니다.


---

## Documentation index / 文档索引

### Specification / 规范

| Document | Language | What it is |
|---|---|---|
| [SPEC.md](SPEC.md) | English (normative / 正本) | tape:// On-Chain Website Specification v0.2: URL format, resolution, verification, node agreement, site isolation, Service Worker gateway requirements, blocking, caching, security, test vectors, **change rules (§15)**, shell compliance checklist (Appendix A), **contract interfaces (Appendix B)** |
| [SPEC.zh.md](SPEC.zh.md) | 中文 | 同一份规范的中文版，逐节对应；有出入以英文版为准 |

Section guide / 章节导读:

| § | Topic / 主题 |
|---|---|
| 1 | Terms: processor, processor number, #ID, container, site store, kernel, shell / 名词 |
| 2 | On-chain names `<#ID>.<processor>.tape`, URLs `tape://…`, the `web+tape://` alias, accepted input forms / 名字、网址、别名、输入写法 |
| 3 | Resolution: name → container, container → name, activation (payment) check, status codes / 解析与状态码 |
| 4 | Nodes: multi-operator agreement, pinned block, pinned store implementations / 节点、钉块、钉实现 |
| 5–6 | Reading, SHA-256 verification, path rules / 读取、校验、路径 |
| 7 | Site isolation: real origin, opaque origin, Service Worker gateway (§7.8), wallets, network, navigation, identity / 隔离要求 |
| 8–10 | "100% on-chain" badge, blocklist and reporting, caching and updates / 纯链上标记、屏蔽、缓存 |
| 11–12 | Security considerations, relationship to `web3://` and the BEP draft / 安全、与其他规范的关系 |
| 13–14 | Reference implementations, test vectors / 参考实现、测试向量 |
| 15 | Change rules: what never changes, what changes and how, versioning, who maintains / 变更规则 |
| A | Shell compliance checklist / 外壳合规清单 |
| B | Contract interfaces: factory, opener, processor, container, SiteRegistry, DomainBinding, pinned implementation list / 合约接口 |

### Repository map / 仓库结构

| Path | Component | Notes |
|---|---|---|
| [`kernel/`](kernel/) | **Kernel** `@tapekit/kernel` | Zero-dependency ES module for browsers and Node ≥ 18. Name resolution, multi-node agreement, pinned block, pinned implementations, per-file SHA-256 verification, persistent cache (memory / directory / IndexedDB), on-demand reads, update watching, bilingual messages. Tests: `kernel/test/unit.test.mjs` (offline), `kernel/test/mainnet.test.mjs` (mainnet read-only) |
| [`sw-gateway/`](sw-gateway/) | **Service Worker gateway** | Lets ordinary Chrome / Edge / Firefox / Safari open on-chain sites with nothing installed, one real origin per site. Bootstrap page, Service Worker, script-free status pages, operator config, deployment rules, end-to-end test in real headless Chrome. See [sw-gateway/README.md](sw-gateway/README.md) |
| [`extension/`](extension/) | **Browser extension** (Chrome MV3) | Address-bar keyword `tape`; verifies that the current https page matches the on-chain bytes; optional gateway domain setting; optional wallet routing (the TapeKit wallet on every gateway site, section 12 of the handbook; code in `wallet/extension/`). Build with `node build-extension.mjs` → `dist/extension/` |
| [`viewer/`](viewer/) | **Web viewer** (preview mode) | Sandboxed-iframe shell with an opaque origin and strict CSP; the fallback when there is no extension and no gateway |
| [`wallet/`](wallet/) | **Wallet router** | One wallet page on the gateway root (`/.tape/wallet/`) that every site's wallet requests go through, so OKX Wallet or Binance Wallet is connected once. `wallet/client.js` is the script site owners bundle (section 12 of the handbook); `wallet/extension/` is the extension's side. Tests: `wallet/test/*.test.mjs` (offline), `wallet/test/e2e.mjs` and `e2e-extension.mjs` (headless Chrome, mainnet read-only) |
| [`kernel/src/identity.js`](kernel/src/identity.js) | **Identity core** | Name → container resolution shared by the page kernel and TapeSend, so one name always means one container |
| [`send/`](send/) | **TapeSend · DeWEB messaging layer** | Messages between containers, recorded in an on-chain inbox on the sender's chain. See [send/README.md](send/README.md) |
| [`send/contracts/`](send/contracts/) | DeWEB hub | `DeWebHub` (UUPS proxy, same address on every chain). Foundry project: unit, fuzz, invariant and BSC fork tests, pinned-address test, deterministic deployment page (signed in a browser wallet) |
| [`send/module/`](send/module/) | `@tapekit/send` | Keys, sealing, content and attachments, endpoint IDs, strict chain reads (inbox/outbox, keys, finality); test vectors in `test/vectors.json` |
| [`apps/tapesend/`](apps/tapesend/) | TapeSend client | Web, desktop (Electron, with the `tape://` browser) and iOS/Android (Capacitor) |
| [`GUIDE.md`](GUIDE.md) | 技术说明 (Chinese) | How to run, test, build and deploy each component; known limitations; next steps |
| [`test/`](test/) | Render fixture | Headless-Chrome regression fixture for the preview renderer |
| `dev-server.mjs` | Viewer dev server | `http://127.0.0.1:8095/viewer/` |
| `build-extension.mjs` | Extension build | Assembles `dist/extension/` (bundling the wallet content scripts) and checks that no import leaves the package; `--test` builds `dist/extension-test/` for the extension end-to-end test only |
| [`LICENSE`](LICENSE) / [`LICENSE-SPEC`](LICENSE-SPEC) | Licenses | MIT for code; CC0 for the specification text |

### Quick start / 快速开始

```bash
npm install            # only dev dependencies (ethers, used by the unit tests as a second implementation)
npm test               # kernel unit tests, offline
npm run test:mainnet   # kernel mainnet read-only tests (no keys, no transactions)
npm run dev:gateway    # Service Worker gateway on http://localhost:8096  → try http://4246-0.localhost:8096/
npm run test:e2e       # gateway end-to-end test in real headless Chrome (needs Google Chrome installed)
npm run test:wallet:e2e   # wallet router end-to-end test (headless Chrome, mainnet read-only, fake wallet)
npm run dev:viewer     # preview-mode viewer on http://127.0.0.1:8095/viewer/
npm run build:extension
```

Using the kernel from your own code / 在自己的代码里用内核:

```js
import { createKernel } from './kernel/src/index.js';
const kernel = createKernel();                       // defaults: 4 public nodes, 2 must agree
const res = await kernel.resolve('4246.0.tape');     // res.status === 'ok' | 'unpaid' | …
const site = await kernel.openSite(res);             // manifest only
const file = await site.get('index.html');           // bytes verified against the on-chain SHA-256
```

### Ways to open an on-chain site / 打开链上网站的几种方式

| Where | What to type | Requires |
|---|---|---|
| Any browser, via a gateway | `https://4246-0.tapekit.org/` (official gateway) or `https://4246-0.<your gateway>/` | nothing installed; the gateway serves only a bootstrap page |
| Chrome address bar, site-search shortcut | `tape` ⇥ `4246.0.tape` (shortcut URL `https://<gateway domain>/?open=%s`) | one-time setting in `chrome://settings/searchEngines` |
| Chrome address bar, extension | `tape` ␣ `4246.0.tape` | the extension |
| Links on web pages | `web+tape://4246.0.tape/` | one-time "allow this site to handle web+tape links" on the gateway home page |
| Desktop app (planned) | `tape://4246.0.tape/` | the app registers the scheme with the OS |

### Mainnet constants / 主网常量

Tapekit supports three chains. On chains other than BNB Smart Chain, a name carries the chain's area code between the #ID and the processor number.

| Chain | chainId | Name format | Example name |
|---|---|---|---|
| BNB Smart Chain | 56 | `<#ID>.<processor>` (no area code) | `4246.0` |
| X Layer | 196 | `<#ID>.2.<processor>` (area code 2) | `1.2.0` |
| Base | 8453 | `<#ID>.3.<processor>` (area code 3) | `1.3.1` |

The on-chain name adds `.tape` (`4246.0.tape`, `1.2.0.tape`); `#4246@0` and `#1@2.0` are accepted as input too. The X Layer and Base examples show the format; they are not sample sites.

X Layer and Base use the same contract addresses: the same account deployed them in the same order on both chains.

| Contract | BNB Smart Chain | X Layer and Base |
|---|---|---|
| Processor factory | `0x68224F668083c29e9800Be2a646d42d18cedF7e2` | `0x1f09DAeFA827f02CBb40967cc91b259763760761` |
| Container opener | `0x021745DE2f42A7839d96f2d3634d0294487D81F1` | `0x536adD8F30f03b69f6fbF29d425A816A0dC50106` |
| SiteRegistry (proxy) | `0xd006ffdd5Ae313B17729621A00999cD3C71CE5e6` | `0xd6EFb7adCc9c83dC4924Ad56f6a8E4e969b9ADB6` |
| DomainBinding (proxy) | `0x861EE183de2BBE4a6ecf9D15812C123b566a3DB7` | `0x68809Fd2fb343aA57D0aeB7f33Defe477c9666f9` |
| Sample site | `4246.0.tape` = container `0x86DDaEF00401E3F10418398D67D7189fc458eA95` | — |

Full list and pinned implementations for BNB Smart Chain: [SPEC.md §3.1 and §4.3](SPEC.md#31-mainnet-constants). SPEC v0.2 describes BNB Smart Chain only; the pinned implementations for X Layer and Base are `L2_CONTRACTS.expectedImpl` in [kernel/src/config.js](kernel/src/config.js).

### Status and roadmap / 状态与路线

- 2026-09-13: specification v0.2; kernel, viewer, extension and Service Worker gateway reference implementations; unit 22/22, mainnet read-only 9/9, gateway end-to-end 25/25. Official gateway live at **tapekit.org** (Cloudflare Workers static assets, wildcard route). **Not yet independently audited.**
- 2026-09-17: **TAP-10 TapeSend** draft v0.5: hub contract, `@tapekit/send` module, indexer and notification service, after four rounds of internal review (contract security, cryptography, clean-room reimplementation from the spec, node agreement and verification, red team, services). Kernel: shared identity core (`kernel/src/identity.js`) and strict all-node agreement mode in the RPC client. The hub is **not deployed yet**; sealing the processor factory first is recommended (see [send/README.md](send/README.md)). **Not independently audited.**
- 2026-09-18: **TapeSend becomes the DeWEB messaging layer.** The indexer is replaced by an on-chain inbox and outbox in the hub (the indexer and the indexer-based notification service are removed); endpoints carry the chain ID (`uint32(0) ‖ uint64(chainId) ‖ container`) so one address works across chains; payload format `0x02`; asset and image attachments. The DeWEB hub is **live on BNB Smart Chain** at `0xe61A9C7213a6Aa616C246a2B569e555B417b25ee` (implementation v3 `0x80aFE7B77F2dFD08e9feab7675780baC34a7EE85`), **upgradeable until sealed** (the processor factory must be sealed first). Client: web, desktop and mobile. Several rounds of internal review (contracts in five roles, client, desktop, protocol consistency, red team). **Not independently audited.** The specification is being rewritten as the DeWEB standard and will be published separately.
- Next: independent audit of the kernel and gateway; gateway domain and Public Suffix List; `@tapekit/kernel` on npm; site-owner handbook (publishing, activation, "100% on-chain" rules); kernel API reference and `.d.ts` types; open-source contract sources and the publishing CLI; desktop app registering `tape://`; `web3://` (ERC-4804 / ERC-6860) read-only adapter.

### Naming / 命名

| Layer | Name | Scope |
|---|---|---|
| Protocol | TapeOut | transistors, processors, circuit containers: the on-chain layer |
| URL and specification | `tape://` | what users type in the address bar; the specification is "the tape:// specification" |
| Open-source tools | Tapekit | everything that reads `tape://`: kernel, gateway, extension, CLI, the future desktop app |
| Commercial service | HashPort | the hosted console, domain binding and fees run by the HashPort team |

### License / 许可

Code: [MIT](LICENSE). Specification text: [CC0](LICENSE-SPEC). Anyone may run their own gateway, write their own kernel, build their own browser.


---

## Site owner handbook / 站长手册

For people who want to put a website on chain. English first; 中文摘要在每节末尾。

### 1. What a site is on chain / 网站在链上是什么

A site belongs to a **container**: the ERC-6551 account of one TapeOut circuit NFT. Whoever holds the NFT controls the site. The files live in the `SiteRegistry` contract under (container, path); every file records its size, content type, and the SHA-256 you declare. Readers verify every byte against that hash, so what you publish is exactly what everyone sees.

You need, in this order: a TapeOut circuit (an NFT on some processor), its container **opened** (through the container opener; the HashPort console does this for you), and then files written under it.

> 中文：网站挂在一枚 TapeOut 电路 NFT 的容器名下，谁持有 NFT 谁控制网站。文件存在 SiteRegistry 合约里，每个文件带大小、内容类型和你声明的 SHA-256。前提：有电路、容器已开通。

### 2. Prepare the folder / 准备文件夹

- Build your site as a plain static folder: `index.html` at the root, assets in subfolders. No server-side code.
- **Use relative paths** (`./app.js`, `assets/logo.png`, `../style.css`) or root-relative paths (`/app.js`). Never absolute `https://` URLs to your own files.
- **File names must be Unicode NFC.** macOS stores names as NFD; browsers request NFC. Check with `python3 -c "import unicodedata,sys;print(unicodedata.is_normalized('NFC',sys.argv[1]))" 文件名`, or simply use ASCII names.
- Path rules (SPEC §6): no `.` or `..` segments, no control characters, `/` separators. `index.html` is the directory index: `docs/` lands on `docs/index.html`.
- Compute the SHA-256 of every file as it is on disk; that is the hash you declare.

```bash
find dist -type f -exec shasum -a 256 {} \;
```

> 中文：纯静态文件夹，根目录放 `index.html`；引用一律相对路径；文件名必须是 NFC（macOS 默认 NFD，最稳妥是只用英文名）；路径不能含 `.`/`..` 段；每个文件先算好 SHA-256。

### 3. Publish / 发布

Two ways. The hosted console does everything below for you; the contract calls are what any tool ultimately does.

**A. HashPort console** (hosted, wallet-signed): open the console, pick the circuit, upload the folder, sign the transactions. It computes hashes, splits chunks, sets the fallback path.

**B. Direct contract calls** (SPEC Appendix B.5) — any wallet or script, signed by the holder or an operator authorised with `setOperator`:

1. For each file, `putFile(container, path, contentType, sha256Hash, firstChunk)` with the first ≤ 24,000 bytes. If the file already exists, this **replaces** it.
2. For the rest of a larger file, `appendChunk(container, path, expectIndex, chunk)` per 24,000-byte chunk, `expectIndex` = 1, 2, 3 … (the contract rejects a wrong index, so a retried transaction cannot append twice).
3. Optionally `setFallback(container, path)` (section 4).
4. Remove a file with `removeFile(container, path)`.

Each chunk is deployed as a small contract, so the cost is roughly proportional to bytes (the EVM charges 200 gas per byte of deployed code plus overhead). Minify and compress images before publishing; do not publish source maps or `node_modules`.

An open-source publishing CLI is on the roadmap; until then use the console or your own script against Appendix B.

> 中文：两条路：HashPort 控制台（选电路、传文件夹、签名，哈希和分块它自动做）；或直接调合约：`putFile` 写第一块（≤ 24,000 字节，已存在则整体替换），`appendChunk` 逐块追加（`expectIndex` 防重复），`setFallback` 设回退，`removeFile` 删除。每块是一个小合约，费用按字节算，发布前先压缩。

### 4. Fallback path for single-page apps / 单页应用的回退路径

If your app uses client-side routing (`/dashboard`, `/user/42`), set `fallbackPath` to `index.html`. A request for a path that does not exist **and has no file extension** then lands on `index.html` (SPEC §6 step 4.3). Requests with an extension (`/missing.png`) still 404, so broken assets stay visible.

Client-side routing works under a **real origin** (Service Worker gateway, desktop app). In the **preview viewer** (sandboxed iframe) only the home page is rendered; routes that the script builds with the History API cannot be followed there.

> 中文：前端路由把 `fallbackPath` 设成 `index.html`：无扩展名的未知路径落回首页，带扩展名的仍然 404。前端路由在网关和桌面版可用，在预览查看器里只能显示首页。

### 5. Content types / 内容类型

Declare the real MIME type per file: `text/html; charset=utf-8`, `text/css`, `text/javascript`, `application/json`, `image/png`, `image/svg+xml`, `font/woff2`, `application/wasm` … Only letters, digits, `. + / ; = -` and spaces are accepted; anything else is served as `application/octet-stream` (SPEC §5.6), which browsers will not execute or render. Always include a type for HTML, CSS and JavaScript: without it the browser cannot run your site.

> 中文：每个文件填真实 MIME 类型；只放行常规字符，不合规一律当二进制。HTML、CSS、JS 一定要填对，否则浏览器不执行。

### 6. Limits / 上限

| Limit | Value | Where |
|---|---|---|
| Chunk size | 24,000 bytes | contract constant `CHUNK_MAX` |
| Single file | 350 chunks = 8,400,000 bytes | SPEC §5.2; larger files are never read |
| Paths listed by a client | first 5,000 | kernel `LIMITS.maxManifestPaths` |
| Whole-site preread (viewer only) | 32 MB, 2,000 files | `loadSite` defaults; the gateway reads on demand and has no such limit |
| Read in one call | 96 KB; larger files in 96 KB segments | SPEC §5.3 |

> 中文：一块 24,000 字节；单文件 8.4 MB；客户端最多列 5,000 个路径；预览查看器整站预读 32 MB / 2,000 文件（网关按需读，没有这条限制）。

### 7. Being 100% on-chain / 做到 100% 链上

A shell shows the "100% on-chain" badge only when both the static scan and the runtime check are clean (SPEC §8). To pass:

- **No off-chain references** anywhere in HTML or CSS: no `https://…` or `//host` in `src`, `href`, `action`, `poster`, `srcset`, CSS `url()`, `@import`, or `<meta http-equiv="refresh">`. Self-host fonts, icons, and every script; drop analytics, CDN copies of libraries, embedded videos from third parties.
- **No runtime fetches off chain**: `fetch`, `XMLHttpRequest`, dynamic `<script>` and `<img>` to external hosts are blocked and listed by the gateway and the viewer. If your app needs external data, users must allow it per site, and the badge is lost.
- Relative paths only (section 2). Under the gateway, `location.origin` is `https://<id>-<cpu>.<gateway>`; under a desktop app it is `tape://<id>.<cpu>.tape`. Never hard-code either.
- Chain data itself is fine: reading BNB Chain through the wallet's provider (`window.ethereum`) or through the configured public nodes is allowed and does not count as off-chain.
- Client-side routing: see section 4. Do not rely on `location.href` assignments to navigate inside the preview viewer; use `<a href>` links, which every shell intercepts correctly.

> 中文：HTML/CSS 里不能有任何链外地址（字体、图标、脚本、统计、CDN 都要自托管）；运行时不能有链外 fetch；只用相对路径；不要写死来源；读链本身不算链外。

### 8. Activate the name / 开通名字

Clients that follow the specification display a site only when its name is **activated** (SPEC §3.4). Activation is a payment recorded in `DomainBinding`:

- Price: `monthlyFee` = 0.08 BNB per 30 days; 1–120 months in one transaction (up to 10 years); non-refundable.
- Call `DomainBinding.bind("4246.0.tape", container, months)` with `msg.value = months × monthlyFee`, from the holder's wallet. The console offers a button for this.
- **One payment per container.** If your container has already paid for a domain (for example `example.com` through HashPort), the on-chain name `4246.0.tape` is activated too, with the same expiry: `isContainerLive(container)` is true. Payments made before 2026-09-13 are copied over by calling `syncContainer(domain, container)` once (anyone may call it).
- The record follows the container: if you sell the circuit, the buyer keeps the remaining time.
- Nobody can activate your name for their own container; clients only accept the container derived from the name.

> 中文：客户端只显示已开通的名字。开通 = 在 DomainBinding 付费：每 30 天 0.08 BNB，一次 1–120 个月，不退款；调用 `bind("4246.0.tape", 容器, 月数)`。**容器付过一次就够**：为域名付过费的容器，链上名字自动算开通；2026-09-13 之前的付费调一次 `syncContainer` 同步。转让电路，剩余时间跟着走。别人无法用自己的容器给你的名字付费。

### 9. Test before you pay / 付费前自测

- **Viewer**: run `npm run dev:viewer`, open `http://127.0.0.1:8095/viewer/?dev#/4246.0.tape`. The `?dev` flag (localhost only) previews names that are not activated yet.
- **Gateway**: run `npm run dev:gateway`, open `http://4246-0.localhost:8096/.tape/status`, tick **Dev preview** and save. Then open `http://4246-0.localhost:8096/`. The status page lists every file read, whether it verified, every off-chain reference found, and every request blocked at runtime: that is your "100% on-chain" checklist.
- Both previews read the real chain, so publish first, then test, then pay.

> 中文：查看器加 `?dev`（只在本机生效）或网关状态页打开「开发预览」，就能看还没开通的名字。状态页列出每个文件的校验结果、链外引用和被拦截的请求，就是「100% 链上」的自查单。先发布，再自测，再付费。

### 10. Verify your own site / 核对自己的站

- Gateway status page `/.tape/status`: each file shows "verified against chain" or not, with the on-chain hash in the `x-tape-sha256` response header.
- Command line, mainnet read-only:

```bash
node -e "import('./kernel/src/index.js').then(async ({createKernel}) => { const k = createKernel(); const r = await k.resolve('4246.0.tape'); const s = await k.openSite(r); for (const p of s.manifest.paths) { const f = await s.get(p); console.log(f.status, f.sha256, p); } })"
```

- Compare with your local files: `shasum -a 256 dist/index.html`. A `status` of `incomplete` means the upload is unfinished or a chunk is wrong; `no-hash` means you declared an all-zero hash (the site is shown but marked unverified).
- Browser extension: on an https site served through HashPort, the popup re-downloads the page and its scripts and compares them with the chain.

> 中文：状态页看每个文件是否「已与链上核对」；命令行用内核逐个读取并打印状态和哈希，与本地 `shasum -a 256` 比对；`incomplete` = 上传没完成或某块错了，`no-hash` = 没声明哈希。

### 11. Update, transfer, take down / 更新、转让、下线

- **Update**: `putFile` again with the new hash (replaces the whole file), then `appendChunk` as needed. Readers pin every site open to one block, so they never see a half-updated site; clients that watch the site show "the site has been updated, reload".
- **Transfer**: sell or send the circuit NFT. The site, the container, and the remaining activation time go with it. While the circuit is listed on the market you cannot edit the site.
- **Take down**: `removeFile` every path. There is no other way: the chain keeps history, and clients read current state only. `unbind` stops a domain but does not lower the container's activation, so the on-chain name stays live until it expires.

> 中文：更新 = 重新 `putFile`（整体替换）；读者钉住区块，看不到半新半旧。转让 NFT，网站、容器、剩余开通时间一起走；挂单期间不能改。下线只能 `removeFile` 删文件；`unbind` 只停域名，不影响链上名字的开通期。

### 12. TapeKit wallet for site owners / 给站长的 TapeKit 钱包

**What it is.** Wallet extensions remember permissions per origin, and every on-chain site is its own origin, so today users connect their wallet again on every site. With the TapeKit wallet, the user connects OKX Wallet or Binance Wallet once, on the TapeKit wallet page at the gateway root (`https://<gateway>/.tape/wallet/`). Your site then sees one standard wallet named **TapeKit**: an EIP-1193 provider, announced with EIP-6963 (`rdns` `org.tapekit`) and also at `window.tapekit.wallet`. It never touches `window.ethereum`. TapeKit holds no keys: it routes requests, keeps per-site permissions, and shows your site's on-chain identity (name, processor, container), never the page title.

**Two ways your site gets it.**
- **The TapeKit extension**: adds the wallet to every gateway site automatically; nothing to change on your site. It needs no site access when installed. The user turns it on once: in the extension popup, set the gateway domain (for example `tapekit.org`, or `localhost:8096` for local development), click **启用钱包路由 / Enable wallet routing**, and allow Chrome's prompt for that gateway. The extension then injects the provider into the top page of every site on that gateway (not the gateway root, not `/.tape/*` pages, not frames), and the same button turns it off again. The popup also lists the sites the user has authorized, each with a Revoke button.
- **The bundled client script** (available now): copy [`wallet/client.js`](wallet/client.js) into your site as `tapekit-wallet.js` and load it with `<script src="tapekit-wallet.js"></script>`. One file, about 22 KB, no dependencies. When it needs TapeKit, it opens the TapeKit page and closes it when it is done, so the browser returns to your site. A message signature (`personal_sign`) opens it in a small window; everything else (connect, typed data, transactions, chain switches) opens it in a new tab next to your site. The tab is needed because OKX Wallet silently refuses connect, transaction and chain-switch requests that come from a popup window. It lets a plain message signature through, and a message signature never needs a chain switch. Typed data stays in a tab with the script: it may need a chain switch, and the page gets no second click to move it to a tab. Browsers only let a page open a tab or window from a click, so connect, sign and chain-switch requests must come from a button the user clicks. Wallet libraries that support EIP-6963 list "TapeKit" without code changes.

**With the extension, three things differ from the script.** It reads the user's click where the page cannot fake it, and it can open TapeKit without a click. So a connect request without a click gets the Allow / Reject dialog instead of 4100. A connect with a click, once the user's wallet is connected to TapeKit, only shows the 5-second notice, in a small TapeKit window that does not take focus. Message signatures (`personal_sign`, `eth_signTypedData_v4`) open the same small window with focus, for the TapeKit card and then the wallet. Transactions, the Allow / Reject dialog and the one-time wallet connection open the TapeKit tab next to your site, which closes itself and returns to your site when it is done. So does typed data when the wallet must first switch chains: it starts in the small window and moves to the tab by itself. `eth_chainId`, `eth_accounts`, and a connect request from a site the user already connected are answered from the extension's copy of the user's grants, so a connected site gets its address with no window, even before any click. If your site also bundles `wallet/client.js`, the extension's wallet is installed first and the script steps aside: there is one TapeKit wallet per page.

**What opens where / 在哪里打开.** TapeKit reuses an open TapeKit page where it can: an open TapeKit tab takes the next requests too (with the extension, a chain switch or a notice only while that tab is in front), and an open small window takes chain switches, revokes and message signatures. With the script, a request that needs a tab while the small window is open opens a tab in the same click and the window closes. If the window is still busy (its card is open), or there was no click, the request goes to that window instead: TapeKit does it there when it can (a connect gets the Allow / Reject dialog; typed data is signed when the wallet is already on your site's chain), else it fails 4900 `needs-tab`, so ask the user to try again. / TapeKit 尽量复用已经开着的页面：标签页开着时，后面的请求都交给它（用扩展时，切链和提示只在这个标签页在前台时才交给它）；小窗口开着时，切链、撤销和消息签名交给它。用小脚本时，小窗口开着又来了需要标签页的请求，会在同一次点击里开标签页并关掉小窗口。小窗口还在忙（卡片开着），或者这次没有点击时，请求改交给小窗口：能在那里做的就在那里做（连接请求弹确认框；钱包已经在网站的链上时，结构化数据直接签），做不了的返回 4900 `needs-tab`，请让用户再试一次。

| Request / 请求 | Script / 小脚本 | Extension / 扩展 |
|---|---|---|
| `personal_sign` (message signature / 消息签名) | small window / 小窗口 | small window, focused / 小窗口（获得焦点） |
| `eth_signTypedData_v4` | tab / 标签页 | small window, focused; moves to a tab when the wallet must switch chains / 小窗口（获得焦点）；钱包需要切链时自动转到标签页 |
| `eth_sendTransaction` | tab / 标签页 | tab / 标签页 |
| One-time wallet connection / 第一次连钱包 | tab / 标签页 | tab / 标签页 |
| Connect without a click / 没有点击的连接 | nothing, 4100 / 不打开，返回 4100 | tab (Allow / Reject dialog) / 标签页（确认框） |
| Connect with a click, wallet already connected / 钱包已连过、带点击的连接 | tab (5-second notice) / 标签页（5 秒提示） | small window, no focus (5-second notice) / 不抢焦点的小窗口（5 秒提示） |
| Chain switch, revoke / 切链、撤销 | tab / 标签页 | small window, no focus / 不抢焦点的小窗口 |
| `eth_chainId`, `eth_accounts`, read calls; a connect from a site already connected (extension) / 只读请求；已授权网站的连接（扩展） | nothing / 不打开 | nothing / 不打开 |

**What the user confirms.**
- Connect (with the script; the extension differs as described above): when the user's click on your connect button opens the TapeKit tab, the site gets the address at once, and TapeKit shows a notice for 5 seconds with your site's identity and a Revoke button. A connect request without a click fails with 4100. While a TapeKit page (tab or small window) is already open, only the request that opened it counts as a click, so a new connect request gets an Allow / Reject dialog instead. A site the user already connected gets its address with no prompt. Users can revoke any site on the TapeKit page.
- Every signature or transaction: a TapeKit card first shows your site's identity and the request; the wallet opens only after the user clicks Continue.
- Chains: BNB Chain (`0x38`), X Layer (`0xc4`) and Base (`0x2105`). `wallet_switchEthereumChain` changes only your site's chain; the wallet is switched (or the chain added) when typed data or a transaction is signed. A message signature (`personal_sign`) does not depend on the chain: it never switches the wallet, and its TapeKit card shows no chain. After each switch TapeKit reads the wallet's chain back and stops with 4901 if the switch did not happen (OKX answers a refused switch with success). Read calls (`eth_call`, `eth_getBalance`, …) go straight to a public node of your site's current chain, without opening anything. `eth_chainId` and `eth_accounts` never open anything. With the script, `eth_accounts` is `[]` until a TapeKit page has answered once in this page session, so show a Connect button.

**Error codes your site may see** (`code` on the rejected error). When the browser blocks the TapeKit page (4100), the TapeKit tab or window is closed (4001), does not load within 20 seconds (4900) or cannot reach the wallet from a small window (4900), the error also has `data.reason` and `data.messages`, the text in Chinese and English for you to show:

| Code | When |
|---|---|
| 4001 | The user rejected (TapeKit card or dialog, or in the wallet), or closed the TapeKit tab or window (`data.reason: 'closed'`) |
| 4100 | No click, so the browser blocked the TapeKit tab or window (`data.reason: 'popup'`); the site is not connected; the address is not the one granted; the wallet account changed; the site's on-chain status is not `ok` (`data.status`) |
| 4200 | Method not supported (`eth_sign`, `eth_signTypedData` v1, `eth_signTransaction`, `wallet_sendCalls`, …) |
| 4900 | No supported wallet installed; or the TapeKit tab did not load within 20 seconds (`data.reason: 'load'`; the script closes it); or the request reached TapeKit in a small window, where OKX refuses connect, transaction and chain-switch requests (`data.reason: 'needs-tab'`): the extension then retries in a tab by itself, and with the script a site sees it only for a request that needs a tab while the small signing window is open and still busy, or made without a click (ask the user to try again); with the extension, also when the extension was updated or turned off while the page was open (reload the page) |
| 4901 | The request names another chain than your site's current one, or the wallet did not really switch to it |
| 4902 | Chain not supported |
| -32602 / -32005 / -32603 | Invalid or oversized (over 256 KB) params / more than 4 pending requests / internal error, or the public node did not answer (a node's own error, such as `3` execution reverted, is passed through) |

> 中文：钱包插件按来源记授权，每个链上网站都是独立来源，所以现在每个网站都要再连一次钱包。有了 TapeKit 钱包，用户只在网关根域名的 TapeKit 钱包页（`/.tape/wallet/`）连一次 OKX 或币安钱包；网站看到的是一个叫 **TapeKit** 的标准钱包（EIP-1193，用 EIP-6963 登记，`rdns` 为 `org.tapekit`，也挂在 `window.tapekit.wallet`），不碰 `window.ethereum`。TapeKit 不保存密钥，只负责转发、按网站记授权、显示网站的链上身份。网站有两种方式拿到它。一是 TapeKit 扩展，网站不用改：扩展安装时不要任何网站权限，用户在扩展弹窗里填好网关域名（如 `tapekit.org`，本地开发填 `localhost:8096`），点“启用钱包路由”，在 Chrome 的提示里允许访问这个网关；之后这个网关下每个网站的顶层页面都会有 TapeKit 钱包（根域名、`/.tape/*` 页面和网站里的框架都没有），同一个按钮可以停用，弹窗里还列出已授权的网站，每个都能撤销。用扩展时有三点不同：点击由扩展在网页碰不到的地方判断，扩展打开 TapeKit 也不需要点击，所以没有点击的连接请求会弹确认框，而不是返回 4100；钱包已经连过 TapeKit 时，带点击的连接只在一个不抢焦点的小窗口里显示 5 秒提示；消息签名（`personal_sign`、`eth_signTypedData_v4`）也用这个小窗口，但窗口会获得焦点，先出 TapeKit 卡片、再到钱包；发交易、确认框、第一次连钱包，都在网站旁边新开的 TapeKit 标签页里完成，完成后标签页自动关闭并回到网站；结构化数据签名需要钱包先切链时，会自动从小窗口转到标签页；`eth_chainId`、`eth_accounts`，以及已授权网站的连接请求，都由扩展保存的授权副本直接回答，已授权的网站不点击、不开窗口也能拿到地址。网站同时放了 `wallet/client.js` 时，扩展先装好钱包，小脚本自动让开，一个页面只有一个 TapeKit 钱包。二是把 `wallet/client.js` 复制进网站文件，命名为 `tapekit-wallet.js` 并用 `<script>` 引入（一个文件，约 22 KB，无依赖）。它需要时会打开 TapeKit 页面，用完自动关闭并回到网站：消息签名（`personal_sign`）开一个小窗口，其他请求（连接、结构化数据签名、发交易、切链）开在网站旁边的新标签页。要用标签页，是因为 OKX 钱包会直接拒绝小窗口里发出的连接、发交易和切链请求；普通的消息签名它会放行，而且消息签名不需要切链。结构化数据签名可能要切链，小脚本又没有第二次点击可以把它转到标签页，所以仍开标签页。各种请求在哪里打开，见上面的表。浏览器只允许点击时打开新标签页或小窗口，所以连接、签名、切链都要由用户点按钮发起。用户亲手点“连接”即授权，同时弹出 5 秒自动关闭、可撤销的身份提示；没有点击的连接请求返回 4100；TapeKit 页面（标签页或小窗口）已经开着时，只有打开它的那个请求算点击，新的连接请求改为弹确认框；已授权的网站直接拿到地址。每次签名或交易先出 TapeKit 卡片，点“继续”后才到钱包。支持 BNB Chain、X Layer、Base；结构化数据签名和交易会先把钱包切到网站当前的链，消息签名与链无关，不切链，卡片上也不显示链；每次切链后 TapeKit 都会读回钱包当前的链，切链没有真的发生就返回 4901（OKX 拒绝切链时会假装成功）；只读请求直接发到网站当前链的公共节点；本页还没打开过 TapeKit 页面时 `eth_accounts` 为空，请显示“连接”按钮。可能收到的错误码见上表：4001 用户拒绝（卡片、确认框或钱包里）或关掉 TapeKit 标签页或窗口；4100 没点击、浏览器拦下了 TapeKit 标签页或小窗口，未授权、地址不对、账户已变、网站状态不是 `ok`；4200 不支持的方法；4900 没装受支持的钱包，或 TapeKit 标签页 20 秒内没加载出来（小脚本会关掉它），或请求到了小窗口里，而 OKX 不接受那里的连接、发交易和切链请求（`needs-tab`：扩展会自动改在标签页里重试；用小脚本时，只有签名小窗口开着、又发来需要标签页的请求，而小窗口还在忙或这次没有点击时才会遇到，请让用户再试一次），用扩展时还包括页面开着期间扩展被更新或停用（请刷新页面）；4901 链不一致，或钱包实际没有切过去；4902 不支持的链。TapeKit 页面被拦、被关、没加载出来、需要标签页这四种情况，错误里带 `data.reason` 和中英文提示 `data.messages`。

---

## Kernel API reference / 内核 API 参考

`@tapekit/kernel` reads, resolves and verifies; it never renders and never touches a wallet. Zero dependencies; runs in browsers, Service Workers and Node ≥ 18. Types: [`kernel/index.d.ts`](kernel/index.d.ts).

### Install and import / 安装与引入

Until the npm release, import from the repository:

```js
import { createKernel, createIdbCache, createFsCache, createMemoryCache } from './kernel/src/index.js';
```

Every export: `createKernel`, `statusText`, `STATUS_TEXT`, `SiteError`, `createRpc`, `RpcError`, `canonicalJson`, `parseInput`, `formatName`, `formatUrl`, `InputError`, `normalizePath`, `resolvePath`, `safeContentType`, `scanSite`, `scanHtml`, `scanCss`, `isExternal`, `collectReferences`, `keccak256`, `keccakHex`, `toChecksumAddress`, `sha256Hex`, `BSC_MAINNET`, `LIMITS`, `IMPL_SLOT`, `SEL`, `SIG`, `TOPIC`, `EVENT_SIG`, `createMemoryCache`, `createFsCache`, `createIdbCache`, `setLocale`, `getLocale`, `detectLocale`, `t`, `tt`, `both`, `messages`, `KernelError`.

### createKernel(options)

| Option | Default | Meaning |
|---|---|---|
| `rpcUrls` | the 4 public nodes in `BSC_MAINNET.rpcs` | JSON-RPC endpoints; use different operators |
| `quorum` | 2 | how many nodes must return identical results |
| `rpc` | — | bring your own client from `createRpc()` instead of `rpcUrls`/`quorum` |
| `fetchImpl` | global `fetch` | for tests or custom transports |
| `cache` | `createMemoryCache()` | persistent cache; see Caches |
| `cacheBytes` | 64 MiB | size of the default memory cache |
| `resolveTtlMs` | 60000 | how long a resolution result is reused (SPEC §10 says at most 60 s) |
| `isBlocked` | `() => false` | `({container, name}) => boolean` blocklist hook (SPEC §9) |
| `network` | `BSC_MAINNET` | override any constant (addresses, `expectedImpl`, `nameSuffix`) |
| `locale` | current | `'zh'` or `'en'` for messages |
| `skipImplCheck` | false | tests only; disables the ERC-1967 pin check |

Returns a `Kernel` with: `config`, `rpc`, `cache`, `parseInput`, `resolve`, `manifest`, `getFile`, `openSite`, `loadSite`, `checkStores`, `cpuIndexOf`, `cpuAt`, `domainLive`, `watch`, `normalizePath`, `resolvePath`, `setLocale`, `getLocale`, `statusText`.

> 中文：`createKernel` 的选项：节点列表与法定人数、缓存实现、解析结果缓存时长、屏蔽钩子、网络常量覆盖、语言。

### kernel.resolve(input, opts)

`input`: any SPEC §2.4 form, or a `ParsedInput` from `parseInput()`. `opts.fresh` bypasses the resolution cache; `opts.block` pins to a given block instead of choosing one.

Returns a `Resolution`:

| Field | Meaning |
|---|---|
| `status` | `ok` \| `unpaid` \| `not-opened` \| `no-such-cpu` \| `no-such-token` \| `not-tapeout` \| `blocked` \| `store-changed` |
| `name`, `url` | canonical name `4246.0.tape` and URL `tape://4246.0.tape/<path>` |
| `cpu`, `cpuName`, `circuits`, `tokenId` | processor number, name, contract; circuit #ID |
| `container`, `holder`, `opened` | derived container, current NFT holder, whether opened |
| `paid`, `paidUntil`, `paidVia` | activation; `paidVia` is `'name'`, `'container'` or null |
| `block`, `stores` | the pinned block and the implementation check (`stores.ok`, per-proxy details) |
| `path` | the path part of the input, if any |

Throws `InputError` for unparsable input and `RpcError` when nodes disagree or too few answer. Every step of SPEC §3.2/§3.3 is performed at `block`.

> 中文：接受 §2.4 的所有写法；返回状态、规范名字、网址、处理器、容器、持有人、开通信息、钉住的区块和实现核对结果。

### kernel.openSite(res) → site

Reads only the manifest (path list, fallback, registry) and returns an on-demand handle:

| Member | Meaning |
|---|---|
| `site.manifest` | `{ registry, paths, pathSet, fallback, truncated, block }` |
| `site.files` | `Map<realPath, SiteFile>` of everything read so far |
| `site.get(path)` | see below |
| `site.prefetch(paths, onProgress)` | batch read, requests merged |
| `site.info(realPath)` | on-chain `fileInfo` |
| `site.res` | the resolution it was opened from |

All reads are pinned to `res.block`.

### site.get(path) / site.prefetch(paths) / site.info(path)

`get(requestedPath)` applies SPEC §6 (normalise, `index.html`, fallback) and returns:

- a `SiteFile`: `{ path, bytes, size, contentType, declaredSha, sha256, updatedAt, verified, status, fromCache }` where `status` is `ok` (hash matches), `no-hash` (owner declared none; shown as unverified) or `incomplete` (length or hash mismatch: do not display);
- `{ status: 'too-large', … }` for files above 8,400,000 bytes;
- `null` for 404.

Verified files are stored in the cache under their on-chain sha256, so a second read anywhere (another site open, another day) is served locally without re-verification. Concurrent `get` calls for the same path share one read.

> 中文：`get` 按 §6 落到真实路径并读取校验；`status` 为 `ok` / `no-hash` / `incomplete`，超限返回 `too-large`，不存在返回 null。校验过的文件按链上 sha 进缓存。

### kernel.loadSite(res, opts)

Whole-site read for small sites (the viewer uses it in preview mode). `opts.maxBytes` (32 MiB), `opts.maxFiles` (2000), `opts.onProgress`. Throws `SiteError` (`too-many-files`, `too-large`) instead of rendering half a site. Returns `{ manifest, files, problems, totalBytes, site }`.

### kernel.watch(site, onChange, opts)

Polls `pathCount`, `fallbackPath` and the `fileInfo` of known paths (first `maxPaths` of the manifest plus everything read) every `intervalMs` (30 s). On any change it invalidates the resolution cache and calls `onChange({ changed, removed, added, fallbackChanged, count, block })`. Returns a `stop()` function. Used instead of `eth_getLogs` because public nodes rarely serve logs.

> 中文：轮询已知文件的链上信息，变了就回调并让解析缓存失效；返回停止函数。

### Caches / 缓存

Interface: `{ kind, get(key) → {meta, bytes} | undefined, set(key, meta, bytes), delete(key), clear() }`. Entries are LRU-evicted by total bytes.

| Factory | Where | Notes |
|---|---|---|
| `createMemoryCache({ maxBytes })` | anywhere | default, 64 MiB |
| `createFsCache(dir, { maxBytes })` | Node | one directory, `<hash>.bin` + `<hash>.json` per entry, 512 MiB default |
| `createIdbCache(name, { maxBytes })` | browsers, Service Workers | IndexedDB, 256 MiB default |

What is cached: files by on-chain sha256 (content-addressed, never stale), resolution results for `resolveTtlMs`, the processor number table (append-only, never expires). Bring your own implementation for anything else (SQLite, a KV store) by implementing the four methods.

### RPC client / 节点客户端

`createRpc({ urls, quorum, timeoutMs, hedgeMs, maxBatch, fetchImpl, shuffle, retries, backoffMs, cooldownMs })`:

- `many(reqs)`: a batch of `{ method, params }`; each request needs `quorum` identical answers from different nodes, otherwise it rejects with `RpcError` (`rpc.conflict` on disagreement, `rpc.short` when too few nodes answer). Extra nodes are asked after `hedgeMs` if the first ones are slow.
- `pinBlock()`: the second-highest head among the nodes minus 2 blocks.
- Object results (blocks, receipts) are compared as canonical JSON; the original object is in `raw`.
- Retries on HTTP 429 / 5xx / network errors with exponential backoff; a rate-limited node is ordered last for `cooldownMs`.
- `stats()`: per node `{ ok, fail, rateLimited, lastMs, lastError, cooldownUntil }`, what the gateway status page shows.

> 中文：多节点核对客户端：不一致即拒绝、慢了追加节点、429 退避与冷却、每节点统计。

### Errors and bilingual messages / 错误码与双语文案

All errors extend `KernelError`: `code` is stable, `message` follows the current locale, `messages` has both `{ zh, en }`, `detail` may carry extra data.

| Class | `code` | When |
|---|---|---|
| `InputError` | `input` | the address cannot be parsed (`input.empty`, `input.decimal`, `input.range`, `input.unknown`) |
| `RpcError` | `rpc` | `rpc.conflict`, `rpc.short`, `rpc.heads`, `rpc.none` |
| `SiteError` | `chain`, `too-many-files`, `too-large` | a chain call reverted unexpectedly; site above `loadSite` limits |

Locale: `setLocale('zh' | 'en')`, `getLocale()`, `detectLocale()` (from `navigator.languages` or `LANG`). Text: `t(key, vars)` current locale, `tt(key, vars)` both, `both(key, vars)` "中文 / English". `statusText(status)` gives the human text of a status code; `statusText(status, 'both')` both languages. All keys and texts are in `messages`.

### Helpers / 工具函数

| Function | Purpose |
|---|---|
| `parseInput(str)` | any §2.4 form → `{ kind: 'name' \| 'container' \| 'circuit', … }` |
| `formatName(tokenId, cpu)`, `formatUrl(tokenId, cpu, path)` | `4246.0.tape`, `tape://4246.0.tape/path` |
| `normalizePath(raw)`, `resolvePath(requested, pathSet, fallback)`, `safeContentType(ct)` | SPEC §6 and §5.6 |
| `scanHtml(text)`, `scanCss(text)`, `scanSite(files)`, `isExternal(url)` | the static "100% on-chain" scan (SPEC §8) |
| `collectReferences(text, 'html' \| 'css', fromDir)` | in-site references, for prefetching |
| `sha256Hex(bytes)`, `keccak256(input)`, `keccakHex(input)`, `toChecksumAddress(addr)` | hashing without dependencies |
| `BSC_MAINNET`, `LIMITS`, `IMPL_SLOT`, `SEL`, `SIG`, `TOPIC`, `EVENT_SIG` | constants: addresses, limits, ERC-1967 slot, selectors, event topics |

### Types / 类型

[`kernel/index.d.ts`](kernel/index.d.ts) describes every export (`Kernel`, `Resolution`, `Site`, `SiteFile`, `Cache`, `Rpc`, `KernelOptions`, …). It is hand-written and checked against a sample program with `npm run test:types`. Once published, `import type { Resolution } from '@tapekit/kernel'` works out of the box.
