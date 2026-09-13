# Tapekit

[中文](#中文) · [English](#english) · [한국어](#한국어)

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
