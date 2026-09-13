# Tapekit

**The open-source browser kernel for the TapeOut protocol.** Websites are stored byte-for-byte on BNB Chain; Tapekit reads them straight from the chain, verifies every byte, and opens them in the browser. No domain name, no DNS, no server.

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
| [`extension/`](extension/) | **Browser extension** (Chrome MV3) | Address-bar keyword `tape`; verifies that the current https page matches the on-chain bytes; optional gateway domain setting. Build with `node build-extension.mjs` → `dist/extension/` |
| [`viewer/`](viewer/) | **Web viewer** (preview mode) | Sandboxed-iframe shell with an opaque origin and strict CSP; the fallback when there is no extension and no gateway |
| [`GUIDE.md`](GUIDE.md) | 技术说明 (Chinese) | How to run, test, build and deploy each component; known limitations; next steps |
| [`test/`](test/) | Render fixture | Headless-Chrome regression fixture for the preview renderer |
| `dev-server.mjs` | Viewer dev server | `http://127.0.0.1:8095/viewer/` |
| `build-extension.mjs` | Extension build | Assembles `dist/extension/` and checks that no import leaves the package |
| [`LICENSE`](LICENSE) / [`LICENSE-SPEC`](LICENSE-SPEC) | Licenses | MIT for code; CC0 for the specification text |

### Quick start / 快速开始

```bash
npm install            # only dev dependencies (ethers, used by the unit tests as a second implementation)
npm test               # kernel unit tests, offline
npm run test:mainnet   # kernel mainnet read-only tests (no keys, no transactions)
npm run dev:gateway    # Service Worker gateway on http://localhost:8096  → try http://4246-0.localhost:8096/
npm run test:e2e       # gateway end-to-end test in real headless Chrome (needs Google Chrome installed)
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
| Any browser, via a gateway | `https://4246-0.<gateway domain>/` | nothing installed; the gateway serves only a bootstrap page |
| Chrome address bar, site-search shortcut | `tape` ⇥ `4246.0.tape` (shortcut URL `https://<gateway domain>/?open=%s`) | one-time setting in `chrome://settings/searchEngines` |
| Chrome address bar, extension | `tape` ␣ `4246.0.tape` | the extension |
| Links on web pages | `web+tape://4246.0.tape/` | one-time "allow this site to handle web+tape links" on the gateway home page |
| Desktop app (planned) | `tape://4246.0.tape/` | the app registers the scheme with the OS |

### Mainnet constants / 主网常量

BNB Smart Chain, chainId 56. Full list and pinned implementations in [SPEC.md §3.1 and §4.3](SPEC.md#31-mainnet-constants).

| Contract | Address |
|---|---|
| Processor factory | `0x68224F668083c29e9800Be2a646d42d18cedF7e2` |
| Container opener | `0x021745DE2f42A7839d96f2d3634d0294487D81F1` |
| SiteRegistry (proxy) | `0xd006ffdd5Ae313B17729621A00999cD3C71CE5e6` |
| DomainBinding (proxy) | `0x861EE183de2BBE4a6ecf9D15812C123b566a3DB7` |
| Sample site | `4246.0.tape` = container `0x86DDaEF00401E3F10418398D67D7189fc458eA95` |

### Status and roadmap / 状态与路线

- 2026-09-13: specification v0.2; kernel, viewer, extension and Service Worker gateway reference implementations; unit 22/22, mainnet read-only 9/9, gateway end-to-end 25/25. **Not yet independently audited; no official gateway deployed yet.**
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
