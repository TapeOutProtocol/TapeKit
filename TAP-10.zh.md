---
tap: 10
title: TapeSend — DeWEB Messaging Between Circuit Containers
author: TapeOutProtocol
status: Draft
type: Standards Track
version: 1.0
created: 2026-09-17
updated: 2026-09-18
requires: tape:// specification v0.2 (SPEC.md)
license: CC0-1.0
---

# TAP-10：TapeSend —— 电路容器之间的 DeWEB 消息

[English](TAP-10.md)（正本） · **中文**

本文是 TAP-10.md 的中文译本，逐节对应；如有出入，以英文版为准。

- 状态：**草案（Draft）**，版本 **1.0**，2026-09-18。中枢封印（§3.7）之前一直是草案，封印后改为最终版（Final）。取代草案 v0.5（2026-09-17）。v0.5 描述的是单链中枢、索引器和载荷格式 `0x01`，这些都已不再使用。改动见附录 A。
- 已部署在 BNB Smart Chain（chainId 56）。§2.1 列出的其他链尚未启用。
- 依赖：tape:// 规范 v0.2（[SPEC.zh.md](SPEC.zh.md)）中的名字、解析与节点一致规则。
- 许可：本文以 CC0 贡献到公有领域（见 `LICENSE-SPEC`）；参考实现以 MIT 开源（见 `LICENSE`）。
- 关键词 **必须（MUST）**、**不得（MUST NOT）**、**应当（SHOULD）**、**不应（SHOULD NOT）**、**可以（MAY）** 按 RFC 2119 理解。
- **尚未经过独立审计**，目前的审查都是内部进行的。

## 0. 范围

TapeOut 电路容器是绑定在电路 NFT 上的 ERC-6551 账户。SPEC.md 让它成为一个网站的地址；本规范让同一个容器成为跨链收发消息的**端点**：

1. 端点与链表（§2）；
2. **DeWEB 中枢**合约：核对发件身份，保存链上收件信箱和发件目录（§3）；
3. 由钱包签名派生的加密公钥（§4）；
4. 载荷与内容格式，包括附件（§5、§6）；
5. 消息标识、最终性、读取与发送（§7–§10）。

消息写进**发件人所在链**上的中枢。收件人在自己声明的每条链上读取信箱（§4.3）。消息路径上没有跨链桥、没有索引器、没有服务器；每个客户端读到的内容都自己去链上核对。

发消息、发布公钥只花 gas。发件容器必须已开通（一次性开通费已付），收件容器不需要。

## 1. 名词与记号

| 名词 | 含义 |
|---|---|
| 处理器、处理器编号、#ID、容器 | 同 SPEC.md §1 |
| 处理器合约 | 某个处理器的电路 NFT 合约：`factory.cpuAt(处理器编号)` |
| 持有人 | 电路 NFT 当前的 `ownerOf(#ID)` |
| 普通账户 | 没有代码的地址，或代码恰好是 EIP-7702 委托标记（`0xef0100` 后接 20 字节，共 23 字节）的地址 |
| 已开通 | `payments.paid(容器)` 为真 |
| 端点、端点号 | §2.2 |
| 中枢 | 某条链上的 DeWEB 中枢合约（§3），各链地址相同 |
| 主链 | 容器所在的链；容器的公钥发布在主链的中枢上 |
| 条目 | 收件信箱里的一条记录（§3.6） |
| 载荷 | 一条消息携带的字节（§5） |
| 内容 | 载荷里的 JSON 对象（§6） |
| 钉住的区块 | §8.2 |
| 回答 | 节点返回的格式正确的 JSON-RPC 结果，包括 `null` 和执行回滚。传输错误、其他 JSON-RPC 错误、超时和格式错误的结果都不算回答 |
| 严格一致 | 向所有配置的节点发出同一个读取，只有在规范化之后所有回答都一致，并且一致的回答来自至少 max(2, min(3, 配置的运营方数量)) 家不同运营方时才采用。任何分歧都拒绝；回答太少记为 `unavailable`。每个节点都标注运营方，按运营方计数，不按网址计数 |

记号：`‖` 表示字节拼接。`uint256(x)` 是 `x` 的 32 字节大端编码；`uint64(x)`、`uint32(x)` 分别是 8 字节、4 字节大端。字节串里的地址是它的 20 个原始字节。`"TAP-10/key/v2"` 这类 ASCII 标签按原始字节使用，不带结束符。十六进制一律小写、带 `0x` 前缀，另有说明的除外。

## 2. 链与端点

### 2.1 链表

链表是本规范的一部分。每条链有固定的**序号**，用作收信链位图（§4.3）里的位。

| 序号 | 链 | chainId | 短名 | 状态 |
|---|---|---|---|---|
| 0 | BNB Smart Chain | 56 | `bnb` | 已启用（中枢已部署审查过的实现） |
| 1 | Base | 8453 | `base` | 已列出，未启用 |
| 2 | X Layer | 196 | `xlayer` | 已列出，未启用 |

一条链在部署了 TapeOut 电路协议和审查过的中枢实现、并把该实现加进 §3.2 之后才算启用。序号永不复用、永不重排；新链只追加在后面。

### 2.2 端点号

```
端点号 = uint32(0) ‖ uint64(chainId) ‖ 容器地址      （32 字节）
```

- 高 4 字节**必须**为 0，`chainId` **必须**非零，容器地址**必须**非零。其他情况中枢一律以 `BadEndpoint` 拒绝（§3.5）；
- 端点号全网唯一：同一个容器地址在两条链上是两个不同的端点；
- 客户端**必须**拒绝 `chainId` 超过 2^53 − 1 的端点号（不支持这样的链）。

### 2.3 显示形式与输入

```
#<#ID>@<处理器编号>             BNB Smart Chain 上
#<#ID>@<处理器编号>.<短名>      其他链上
```

- 两个数字都是不带前导零的十进制 ASCII（`0` 本身除外）；1 ≤ #ID ≤ 10^18，0 ≤ 处理器编号 ≤ 10^9。例：`#4246@0`、`#15324@30.base`；
- 不在 §2.1 里的链显示为 `.chain<chainId>`；
- 在 BNB Smart Chain 上，`#4246@0` 与 `4246.0.tape`（SPEC.md §2.2）指同一个容器，客户端对两者**必须**给出相同的解析结果；
- `#` 是网址里的片段分隔符，所以显示形式只用于显示和输入；网址里写 `4246.0` 或 `4246.0.tape`。

客户端**应当**接受 SPEC.md §2.4 列出的所有输入形式，解析后按上面的形式显示。其他输入**必须**拒绝，**不得**猜测。

### 2.4 解析

所有读取都在同一个钉住的区块（§8.2）上、以严格一致进行：

- 名字形式：SPEC.md §3.2 第 1–4 步；地址形式：SPEC.md §3.3 第 1–4 步，再做 SPEC.md §3.2 第 4 步；
- 然后读 `hub.keyFor(处理器合约, #ID)`（§3.5）。它返回的 `container` **必须**等于解析出的容器，`endpoint` **必须**等于所读那条链上的 `endpointID(chainId, 容器)`，否则客户端**必须**停止（`hub-mismatch`）；
- 客户端**必须**以严格一致读 `eth_chainId`，确认节点在预期的链上（否则 `wrong-chain`）。端点的链号只取自客户端的配置，绝不取自任何数据。

SPEC.md §3.2 第 5–7 步和 §4.3 **不**适用于消息：链上名字未付费、站点存储的实现被换、站点被列入屏蔽名单，都**不得**阻止收发消息。

解析结果是（链、处理器合约、处理器编号、#ID、容器、端点号、持有人、是否开通、公钥视图）。只有**发件方**必须已开通，由中枢强制检查。

## 3. DeWEB 中枢

### 3.1 性质

- ERC-1967 代理加 UUPS 实现。**封印**之前，owner 可以更换实现（§3.7）；`seal()` 之后没有 owner，也没有升级途径；
- 实现合约没有 payable 函数，没有 `receive`，也没有 `fallback`，所以任何带 BNB 的调用都会回滚；中枢不持有资产，也没有任何转移资产的函数；
- 不调用任何会改变其他合约状态的函数。读取其他合约只用有界的 `staticcall`：每次 100,000 gas，返回数据最多复制 32 字节，并且要求恰好 32 字节。读取失败或格式不对一律当作"未授权"（回滚、目标没有代码、返回数据不是 32 字节、布尔值不是 0 或 1、地址字的高 96 位非零）。注册表读取失败或返回零地址时回滚 `RegistryFailed`；
- 按 63/64 规则，gas 不足的交易会以授权错误回滚，而不是耗尽 gas。钱包**必须**使用 gas 估算；
- 不解析载荷。

### 3.2 部署

三个合约都通过确定性 CREATE2 部署器 `0x4e59b44847b379578588920cA78FbF26c0B4956C` 部署，每个地址都能由源码重新算出。

| 项目 | 值 |
|---|---|
| 编译 | solc 0.8.28，开启优化器 10,000 runs，EVM `shanghai`，传统管线（不用 via-IR），`bytecode_hash = none`，`cbor_metadata = false` |
| 启动实现 | 盐 `keccak256("DeWEB Boot v1")`；`DeWebBoot` 的创建代码，无参数。地址 **`0xC0D28CA8689248B0bed26cC0aa328CF16Aa4401e`**，各链相同 |
| 中枢（代理） | 盐 `keccak256("DeWEB Hub v1")`；`DeWebProxy` 创建代码 ‖ `abi.encode(启动实现, abi.encodeCall(initialize, (owner)))`。owner 为 `0x571d447f4f24688eC35Ccf07f1D6993655F6aF15` 时地址为 **`0xe61A9C7213a6Aa616C246a2B569e555B417b25ee`**，各链相同 |
| 正式实现 | 盐 `keccak256("DeWEB Hub impl v2")`；`DeWebHub` 创建代码 ‖ `abi.encode(uint256 expectedChainId, registry, accountImplementation, factory, payments, circuitBeacon, circuitImplementation, circuitCodehash)`。构造参数各链不同，所以地址各链不同 |

启动实现只允许 owner 升级（不能封印）；它的作用是让中枢地址不依赖任何一条链上的 TapeOut 合约地址。

**BNB Smart Chain 上审查过的实现**（只有实现槽里是"当前"那一个时，客户端才接受这个中枢，§3.8）：

| 版本 | 地址 | 状态 |
|---|---|---|
| v3 | `0x80aFE7B77F2dFD08e9feab7675780baC34a7EE85` | **当前**，自区块 122623031 起（2026-09-18） |
| v2 | `0x7dF03218910E0F37FC3A8DA8792831ab7580340F` | 已被替换，不再认可（它允许升级到仍处于启动阶段的代理） |
| v1 | `0xf5f18e3fe811b9b382C90539d14440654E789d92` | 当天即被替换，不再认可 |

BNB Smart Chain 实现的构造参数（部署后不可变）：

| 参数 | 值 |
|---|---|
| `expectedChainId` | `56`（在其他链上部署时构造函数回滚 `WrongChain`；链号为 0 或大于 2^64 − 1 时回滚 `BadEndpoint`） |
| `registry` | `0x000000006551c19487814612e58FE06813775758`（ERC-6551 注册表） |
| `accountImplementation` | `0xAf4E78a2257C9c5480c2F8310E3b00437260751d`（容器实现） |
| `factory` | `0x68224F668083c29e9800Be2a646d42d18cedF7e2`（处理器工厂，UUPS 代理） |
| `payments` | `0xc0C643eb9820eF208Ea38bb2c8E8377047D9fa4c`（容器付费表） |
| `circuitBeacon` | `0xf8D6d8EB894d6971c8976Ad8b4971cbEFE028156` |
| `circuitImplementation` | `0x8E1D125Def6d3826C278299273a0760D47626068`（部署时钉住的处理器实现） |
| `circuitCodehash` | `0xd8c4b0216e0aadd615fbd134465b6af060a11769edc7c844d8f14d1b8a783992`（所有处理器代理共同的运行代码哈希） |

### 3.3 存储

两块 ERC-7201 命名空间存储，升级后记录保留：

- `deweb.admin.v1`，位于 `0x736671d3d7aa7b8c7f898557852b1cc8f6b8b590d42594c0a8eca138259d9100`：`owner`、`sealed`、`initialized`、`pendingOwner`；
- `deweb.hub.v1`，位于 `0x52508d06499dccc2446f87bf89abfddc2d85f3e5a1bdd29ea2bc99cdfd6b2000`：公钥记录、收件计数与条目、发件计数与条目。

以后的实现**必须**保留这两块存储及其布局。

### 3.4 授权

每次写入都指明一枚电路 `(处理器合约, #ID)`。中枢按以下顺序检查：

1. `circuitBeacon.implementation()` 等于 `circuitImplementation`，否则 `CircuitsChanged`；
2. 处理器合约的代码哈希等于 `circuitCodehash`，否则 `NotCPU`；
3. `factory.isCPU(处理器合约)` 为真，否则 `NotCPU`；
4. `处理器合约.ownerOf(#ID)` 返回 `msg.sender`，否则 `NotHolder`；
5. 容器为 `registry.account(accountImplementation, 0, block.chainid, 处理器合约, #ID)`；读取失败回滚 `RegistryFailed`；
6. `payments.paid(容器)` 为真，否则 `NotOpened`。

通过后，容器就是这次写入的作者。由此：

- 只有已登记处理器上、已开通电路的当前持有人才能以它的容器写入；NFT 转手后，新持有人以同一个容器发言；
- `send` 和 `revokeKey` 接受**任何**持有人，包括合约。所以持有人授权过这枚电路 NFT 的合约（例如交易市场）可以在一笔交易里把 NFT 拿走、以容器身份写入、再还回去。中枢看不到这一点，由客户端识别（§8.6）；
- 处理器实现被长期替换后，所有写入都会被拒绝、所有公钥都变为不可用，需要新的中枢；
- 钉住的实现发现不了控制未封印工厂的人做的**临时**替换（§3.8）。

### 3.5 接口

**写入**（直接调用实现合约时一律回滚 `NotProxy`）：

| 函数 | 选择器 | 行为（按顺序） |
|---|---|---|
| `send(address circuits, uint256 tokenId, bytes32 to, bytes32 ref, bytes payload) returns (uint256 inboxIndex)` | `0xa181b579` | `to` 不是合法端点号（§2.2）时 `BadEndpoint`；载荷为空时 `EmptyPayload`；超过 16,000 字节时 `PayloadTooLarge(size, 16000)`；§3.4；收件信箱或发件目录已有 2^32 − 1 条时 `BoxFull`；追加一条收件条目和一条发件条目（§3.6）；发出 `Sent`。`to` 可以在任何链上，也不需要已开通 |
| `publishKey(address circuits, uint256 tokenId, uint8 suite, uint16 keyIndex, bytes32 key, uint64 chains)` | `0x23e0bbc6` | `suite != 1` 时 `BadSuite`；`key == 0` 时 `EmptyKey`；`chains == 0` 时 `NoChains`；§3.4；`msg.sender` 不是普通账户时 `ContractHolder`，`msg.sender` 没有代码却不是 `tx.origin` 时也是；保存记录，`holder = msg.sender`、`publishedAt = block.timestamp`，`version` 加 1；发出 `KeyPublished` |
| `revokeKey(address circuits, uint256 tokenId)` | `0x08394925` | §3.4；没有公钥时 `NoKey`；把 `key`、`holder`、`suite`、`keyIndex`、`chains` 清零，设置 `publishedAt`，`version` 加 1；发出 `KeyRevoked` |

**读取：**

| 函数 | 选择器 | 返回 |
|---|---|---|
| `keyFor(address circuits, uint256 tokenId)` | `0x3145c6cb` | `KeyView(address container, bytes32 endpoint, bool opened, address current, uint8 suite, uint16 keyIndex, bytes32 key, bool usable, uint32 version, uint64 chains)`。`current` 是 `ownerOf` 的结果，读取失败为 0。`usable` 只有在以下全部成立时为真：有公钥、`current != 0`、记录里的持有人等于 `current`、`current` 是普通账户、处理器是真的（§3.4 第 1–3 步）。**`usable` 为假时，`suite`、`keyIndex`、`key`、`chains` 一律返回 0**；`version` 总是返回。只会回滚 `RegistryFailed` |
| `keyOf(address container)` | `0xfa073d76` | 原始记录 `(bytes32 key, address holder, uint40 publishedAt, uint8 suite, uint16 keyIndex, uint32 version, uint64 chains)`，不做任何检查。客户端**不得**用它决定是否加密 |
| `inboxCount(bytes32 to)` | `0x9343ecd9` | 本链上 `inbox[to]` 的条数 |
| `inboxAt(bytes32 to, uint256 i)` | `0x3e605450` | `Entry`；`i ≥ inboxCount(to)` 时回滚 `OutOfRange` |
| `inboxPage(bytes32 to, uint256 start, uint256 n)` | `0x2eec4913` | 从 `start` 起、从旧到新的 `Entry[]`，最多 `min(n, 200)` 条；`start ≥ 总数` 时为空 |
| `outboxCount(address from)` | `0xf0549006` | 本链上容器 `from` 发出的消息数 |
| `outboxPage(address from, uint256 start, uint256 n)` | `0xcf082720` | `OutEntry[]`，规则同 `inboxPage` |
| `digestOf(bytes32 ref, bytes payload)` | `0x120950e3` | `keccak256(ref ‖ keccak256(payload))` |
| `endpointOf(address container)` | `0x4b893642` | `container` 在本链上的端点号 |
| `accountOf(address circuits, uint256 tokenId)` | `0x0c1905e5` | 容器地址（不检查 `circuits` 是否为处理器） |
| `MAX_PAYLOAD()`、`MAX_PAGE()`、`SUITE_X25519()` | `0xcfdd2b73`、`0x69fc09b9`、`0xda582a0e` | `16000`、`200`、`1` |
| `registry()`、`accountImplementation()`、`factory()`、`payments()`、`circuitBeacon()`、`circuitImplementation()`、`circuitCodehash()` | | 构造参数 |

`version` 按容器计，从 0 开始，每次发布和撤销恰好加 1，永不归零。合约不强制 `keyIndex` 递增，客户端用 `version` 判断记录是否变化。NFT 回到发布当前记录的那位持有人手上时，不必重新发布，`usable` 会重新为真。

**事件：**

| 事件 | topic0 |
|---|---|
| `Sent(bytes32 indexed to, address indexed from, bytes32 indexed ref, uint256 inboxIndex, uint256 outboxIndex, bytes payload)` | `0xd75bb8082dd3ae8bb88682115ee1412a8e8051cc81d0e4c01dc3b06c0cf61020` |
| `KeyPublished(address indexed container, address indexed holder, uint8 suite, uint16 keyIndex, bytes32 key, uint32 version, uint64 chains)` | `0x3508619c70f595e587bda151c8e0d612b9b2bb7b2e9f7d35696ff38cbdf0f85d` |
| `KeyRevoked(address indexed container, address indexed holder, uint32 version)` | `0xd360cbf79f51b9effe9910886c31cb5727df68b64e1cadc0be214931a7fb84c9` |
| `Upgraded(address indexed implementation)` | `0xbc7cd75a20ee27fd9adebab32041f755214dbc6bffa90cc0225b39da2e5c2d3b` |
| `OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner)` | `0x38d16b8cac22d99fc7c124b9cd0de2d3fa1faef420bfe791d8c362d765e22700` |
| `OwnerChanged(address indexed previousOwner, address indexed newOwner)` | `0xb532073b38c83145e3e5135377a08bf9aab55bc0fd7c1179cd4fb995d2a5159c` |
| `HubSealed()` | `0xa38d24a530434d3ab8b3f3f3f3a54ea1f987dddceba505bd3bd1f05dfa2106ad` |

`Sent` 的 topic1 是 `to`，topic2 是 `from`（取低 20 字节），topic3 是 `ref`；`data` 是 `(uint256 inboxIndex, uint256 outboxIndex, bytes payload)` 的 ABI 编码。

**错误码：** `BadEndpoint` `0xd98d0ab4`、`EmptyPayload` `0x2e3f1f34`、`PayloadTooLarge(uint256,uint256)` `0x04247564`、`BoxFull` `0x12b9de4e`、`BadSuite` `0xe9b6829d`、`EmptyKey` `0x3cd69fac`、`NoChains` `0xa41d7dc9`、`NoKey` `0x80246e7f`、`ContractHolder` `0xc21b8423`、`NotCPU` `0x853f2907`、`NotHolder` `0x7623fb52`、`NotOpened` `0x6d36408a`、`CircuitsChanged` `0x2ffa540a`、`RegistryFailed` `0x06215c9b`、`OutOfRange` `0x7db3aba7`、`WrongChain` `0x10dfc033`（构造函数）、`NotAContract` `0x09ee12d5`、`ZeroAddress` `0xd92e233d`、`NotProxy` `0xbf10dd3a`、`NotOwner` `0x30cd7471`、`NotPendingOwner` `0x1853971c`、`Sealed` `0x1b2d71eb`、`NotUUPS` `0xf2fc2b29`、`NotDelegated` `0x9ccd6d76`、`AlreadyInitialized` `0x0dc149f0`。

### 3.6 收件信箱与发件目录

每条消息，`send` 保存：

```
Entry    { address from; uint56 blockNumber; uint40 timestamp; bytes32 digest }      存在 inbox[to][inboxIndex]
outbox[from][outboxIndex] = uint256(to) << 32 | inboxIndex
digest   = keccak256(ref ‖ keccak256(payload))
```

`outboxPage` 返回 `OutEntry { bytes32 to; uint32 inboxIndex; uint56 blockNumber; uint40 timestamp; bytes32 digest }`，连同它指向的收件条目一起。两个列表都只增不减，条目永不修改、永不删除。

`inboxPage` 返回静态结构体数组：`偏移（= 0x20）‖ 长度 ‖ 长度 × 4 个字`；`outboxPage` 每个元素 5 个字。长度字超过 200、总字节数对不上、字段超出宽度（地址 160 位、`blockNumber` 56 位、`timestamp` 40 位、`inboxIndex` 32 位）的结果，客户端**必须**拒绝。

载荷本身**不**存在存储里，只在 `Sent` 事件中。内容指纹把载荷和 `ref` 绑定到条目上，但不绑定发件人、收件人和序号，所以客户端**不得**只凭内容指纹把日志对应到条目（§8.4）。

### 3.7 管理

| 函数 | 选择器 | 行为 |
|---|---|---|
| `owner()`、`pendingOwner()`、`isSealed()` | `0x8da5cb5b`、`0xe30c3978`、`0x631f9852` | 当前值 |
| `transferOwnership(address)` | `0xf2fde38b` | 仅 owner；传 0 时 `ZeroAddress`；设置 `pendingOwner` |
| `acceptOwnership()` | `0x79ba5097` | 仅待接受者；封印后 `Sealed` |
| `upgradeToAndCall(address impl, bytes data)` | `0x4f1ef286` | 仅 owner 且未封印；`ZeroAddress`、`NotAContract`；以下情况 `NotUUPS`：`impl` 是代理本身；`impl.proxiableUUID()` 返回的不是恰好 32 字节的 ERC-1967 实现槽；`impl.selfAddress()` 返回的不是恰好 32 字节、等于 `impl` 的地址。然后写入实现槽、发出 `Upgraded`，`data` 非空时再 delegatecall |
| `seal()` | `0x3fb27b85` | 仅 owner；清空 `pendingOwner` 和 `owner`，置 `sealed`；发出 `OwnerChanged(owner, 0)` 和 `HubSealed()`。不可逆。启动实现不能封印 |
| `proxiableUUID()` | `0x52d1902d` | 直接调用实现时返回 ERC-1967 实现槽；经代理调用时回滚 `NotDelegated` |
| `selfAddress()` | `0x12e905b0` | 实现合约自己的地址，经代理调用也一样 |

以后的每个实现都**必须**通过上面两项检查，并保留 §3.3 的存储。v2 和启动实现都没有 `selfAddress`，所以中枢无法从 v3 降级。

`seal()` 本身不检查 TapeOut 工厂是否已封印。**必须**先封印工厂（§3.8），否则之后处理器实现一旦被长期替换，已封印的中枢会永久停用。

### 3.8 封印状态与信任

客户端**必须**在钉住的区块上、以严格一致读取：

1. **工厂：** `factory.isSealed()`、工厂的 ERC-1967 实现槽、`circuitBeacon.owner()`、`circuitBeacon.implementation()`。只有 `isSealed()` 恰好返回 1、工厂实现是 `0xa68ccf4931d98ad0a4be15ee40542edc0dec6422`、beacon 的 owner 是工厂、beacon 的实现是 `circuitImplementation` 时，工厂封印才生效；
2. **中枢：** `hub.isSealed()`、`hub.owner()` 和中枢的 ERC-1967 实现槽。只有实现槽里是 §3.2 中该链"当前"的实现时，中枢才**被接受**（否则 `hub-changed`）。在此基础上 `isSealed()` 为 1 且 `owner()` 为 0 时，中枢封印才生效。

任何回滚、任何不规范的字（地址字的高 96 位非零）或其他值，都当作未生效。

- `circuitBeacon.implementation()` 不等于 `circuitImplementation` 时，这个中枢上的消息已经停止（`circuits-changed`）：客户端**不得**发送，并且即使之后又读到钉住的值，也**必须**保持这个状态；
- 中枢不被接受时，客户端**不得**发送；
- 任一封印未生效时，控制工厂或中枢 owner 的人可以冒充端点、替换公钥。客户端**应当**在显示发件身份或加密的地方提示这一点。客户端一旦见过工厂封印生效，之后又在不早于那一次的区块上读到未生效，**必须**一直当作封印已失效；
- 一次升级可以在同一笔交易里改写存储、再换回被接受的实现，只留下一条 `Upgraded` 日志。有支持日志查询的节点时，客户端**应当**读取中枢的全部 `Upgraded` 日志，只有其中每个实现都是启动实现或 §3.2 列出的实现（当前或已替换）时才接受这个中枢。

封印状态按链和中枢地址分别记录；一条链上的粘滞状态**不得**影响另一条链。

## 4. 公钥

### 4.1 套件

套件 `1`：X25519（RFC 7748）、HKDF-SHA256（RFC 5869）、XChaCha20-Poly1305（32 字节密钥、24 字节 nonce、16 字节认证标签）、SHA-256。公钥是 32 字节的 RFC 7748 编码，按字节原样存进 `bytes32 key`。

### 4.2 从钱包派生公钥

私钥从不存在链上或任何服务器上，而是由钱包对一段固定文字的签名派生出来。

1. 构造文字 `T`（EIP-4361 格式）：ASCII，恰好下面 14 行，行间用单个 `0x0A` 分隔，结尾没有换行。`<holder>`、`<container>`、`<hub>` 用 EIP-55 校验和格式；数字是不带前导零的十进制；`<chainId>` 是容器的**主链**；`#<#ID>` 是一个 `#` 后接十进制 #ID。签名文字按原样使用英文。

```
www.tapesend.com wants you to sign in with your Ethereum account:
<holder>

Create the TapeSend encryption key for #<#ID>@<processor number>. Anyone who obtains this signature can read your messages. Only sign this on www.tapesend.com or in the official TapeSend app.

URI: https://www.tapesend.com
Version: 1
Chain ID: <chainId>
Nonce: tapesendkey<k>
Issued At: 2026-09-17T00:00:00Z
Resources:
- tapesend:container:<container>
- tapesend:hub:<hub>
- tapesend:key-index:<k>
```

2. 请持有人的钱包对 `T` 做 `personal_sign`（EIP-191）。签名是 65 字节 `r ‖ s ‖ v`；`v` **必须**是 0、1、27 或 28。
3. `r` 或 `s` 为 0 或 ≥ n（secp256k1 的群阶）时拒绝。用签名原样恢复签名者，要求等于持有人。
4. 若 `s > n/2`，把 `s` 换成 `n − s`。丢弃 `v`。
5. ```
   seed = HKDF-SHA256(salt = "TAP-10/key/v2", IKM = r ‖ s,
                      info = endpointID(chainId, 容器) ‖ uint256(k) ‖ hub, L = 32)
   ```
6. X25519 私钥就是 `seed`，公钥是 `X25519(seed, 9)`。

固定的域名让支持 EIP-4361 的钱包在其他网站索要这个签名时发出警告。这种保护并不完整（不是所有钱包都检查；WalletConnect 的来源是网站自己声明的）。因此：官方网页客户端**必须**只从 `https://www.tapesend.com` 提供，该来源**不得**做任何其他 EIP-4361 登录；签名和派生出的私钥**不得**离开设备。

**确定性。** 派生要求钱包签名是确定性的（RFC 6979）。发布新公钥之前，客户端**必须**取得两次对 `T` 的签名，并且规范化后的 `r ‖ s` 相同。只要 `keyFor` 显示一把可用、持有人是当前钱包、`keyIndex` 相同的公钥，客户端每次派生后都**必须**把派生出的公钥和链上的比对，不一致时**不得**使用、**不得**发布。比对一致时**可以**省略第二次签名。智能合约钱包派生不出公钥（§3.5 也会拒绝它们）。

### 4.3 发布与收信链

持有人在容器主链的中枢上调用 `publishKey(处理器合约, #ID, 1, k, 公钥, chains)`。`chains` 是**收信链位图**：第 `i` 位为 1 表示持有人在 §2.1 序号为 `i` 的链上读取自己的信箱。它**不得**为 0。客户端**应当**发布所有已启用的链，**不应**设置自己不读取的链的位。

`keyFor` 已显示同一把公钥和 `keyIndex` 可用时，客户端**应当**跳过这笔交易；同一次请求**不应**发布两次（例如钱包超时后，**必须**先重新读 `keyFor` 再决定是否重试）。

### 4.4 使用收件人的公钥

加密给某个端点之前，客户端**必须**：

1. 在它的主链上解析它（§2.4），并在新钉住的区块上以严格一致读 `keyFor`；
2. 要求 `suite == 1` 且 `usable == true`；
3. 以下情况拒绝这把公钥：第 31 字节最高位为 1；按小端读出的值 ≥ 2^255 − 19；是低阶点（u = 0、1、325606250916557431795983626356110631294008115727848805560023387167927233504、39382357235489614581723060781553021112529911719440698176882885853963445705823 或 p − 1）。X25519 运算出错、共享密钥全零，也都拒绝；
4. 按原始位图判断，要求收件人位图里**发件链**那一位为 1（客户端不认识的位不算）。否则收件人不读这条链，客户端**不得**发送（`wrong-chain`）。

端点没有可用公钥时，客户端**可以**发公开消息（§5.2），但必须先用平实的话告诉发件人"所有人都能看到"，**不得**悄悄退回公开消息。没有可用公钥的收件人，视为只读主链。

### 4.5 公钥的有效期与轮换

- 公钥记录绑定发布它的持有人；转手之后 `usable` 为假，直到新持有人发布；
- 同一持有人对同一容器、链、中枢和 `k`，总是派生出同一把公钥；
- 轮换就是用更大的 `k` 重新发布。已经加密给旧公钥的消息，持有旧私钥的人仍能读；
- `k` 取值 0..65535。客户端**应当**第一次用 `k = 0`，轮换时用 `max(version, keyIndex + 1)`（只有当前记录是本人可用的公钥时才用 `keyIndex + 1`）；
- 打开旧消息时，客户端**可以**尝试同一持有人更早的 `k`；只有指纹对得上某个槽位时才用派生出的公钥。

## 5. 载荷

### 5.1 头部

| 偏移 | 长度 | 字段 |
|---|---|---|
| 0 | 2 | 魔数 `0x54 0x53`（`TS`） |
| 2 | 1 | 格式版本 `0x02` |
| 3 | 1 | 类型：`0x00` 公开，`0x01` 加密 |

魔数、版本（包括草案 v0.5 的 `0x01`）或类型不同，短于 4 字节或长于 16,000 字节的载荷，都是 `unsupported`，**不得**继续解释。

### 5.2 公开载荷（类型 `0x00`）

第 4 字节起是明文内容（§6）。

### 5.3 加密载荷（类型 `0x01`）

| 偏移 | 长度 | 字段 |
|---|---|---|
| 4 | 32 | `E`：临时 X25519 公钥 |
| 36 | 24 | `N`：nonce |
| 60 | 32 | `D`：密钥承诺 `SHA-256("TAP-10/commit/v2" ‖ K)` |
| 92 | 1 | `n`：密钥槽位数，1 ≤ n ≤ 16 |
| 93 | 56·n | 槽位，每个是 `指纹（8）‖ 包裹后的密钥（48）` |
| 93 + 56·n | 其余 | `C`：加密后的内容，含 16 字节认证标签 |

记 `P` 为前 93 字节，并令

```
X = "TAP-10/X/v2" ‖ endpointID(to) ‖ endpointID(from) ‖ ref ‖ hub
```

其中 `to` 是传给 `send` 的收件端点号，`from` 是发件端点号（它的链就是发件链），`ref` 是 32 字节的 `ref`，`hub` 是中枢地址。

**加密：**

1. 用密码学安全的随机数生成器生成 `e`（32 字节）、`E = X25519(e, 9)`、`N`（24 字节）和 `K`（32 字节），每条消息都要重新生成；
2. 公钥列表：收件人的可用公钥（§4.4）；**应当**再加上发件容器自己的可用公钥（如果它属于当前钱包），这样发件人也能读自己发出的消息。公钥**必须**互不相同，并通过 §4.4 第 3 步；
3. `D = SHA-256("TAP-10/commit/v2" ‖ K)`；`P = 0x54 ‖ 0x53 ‖ 0x02 ‖ 0x01 ‖ E ‖ N ‖ D ‖ n`；
4. 按顺序对每把公钥 `R`：`ss = X25519(e, R)`（全零则拒绝）；`kek = HKDF-SHA256(salt = "TAP-10/wrap/v2", IKM = ss, info = E ‖ R ‖ X, L = 32)`；`wrapped = XChaCha20-Poly1305-Encrypt(kek, N, K, aad = P ‖ X)`；槽位 = `SHA-256(R)[0..8) ‖ wrapped`；
5. `S` 为所有槽位；`C = XChaCha20-Poly1305-Encrypt(K, N, 内容, aad = P ‖ S ‖ X)`；
6. 载荷 = `P ‖ S ‖ C`，最多 16,000 字节（一个槽位时内容最多 15,835 字节，两个时 15,779 字节）。

**解密**（私钥 `r`、公钥 `R`；`to`、`from`、`ref` 取自核对过的条目和事件）：

1. 短于 93 字节、`n` 不在 1..16、短于 `93 + 56·n + 16`、或 `E` 通不过 §4.4 第 3 步：`damaged`；
2. 对每个指纹等于 `SHA-256(R)[0..8)` 的槽位：算出 `kek`，解开 `wrapped`；只有解密成功并且 `SHA-256("TAP-10/commit/v2" ‖ K) = D` 时才得到 `K`；
3. 没有槽位得到 `K`：有指纹对上时为 `damaged`，否则为 `not-for-key`；
4. 用 `aad = P ‖ S ‖ X` 解密 `C`；失败为 `damaged`，不得显示任何内容。

持有多把私钥的客户端逐一尝试：任一把打开为 `ok`；否则任一把给出 `damaged` 为 `damaged`；否则为 `not-for-key`。

`to`、`from`（也就是两边的链）、`ref` 和中枢都绑定在 `X` 里，所以载荷被换一个发件人、换一个收件人、换一个 `ref`、换一条链或换一个中枢重放时，都解不开。承诺保证所有读者得到同样的内容。发件人可以把同一份载荷再发一次成为新消息；`(from, to, digest)` 相同的消息客户端只显示一条（§8.5）。

## 6. 内容

内容是 UTF-8 的 JSON 对象（RFC 8259），前后允许有空白。

| 字段 | 类型 | 必填 | 含义 |
|---|---|---|---|
| `v` | 数字 | 是 | `1` |
| `kind` | 字符串 | 是 | `"message"` |
| `subject` | 字符串 | 否 | 最多 200 个码点 |
| `body` | 字符串 | 是 | 可以为空 |
| `ts` | 数字 | 否 | 发件人声称的 Unix 毫秒时间，仅供参考 |
| `attachments` | 数组 | 否 | 最多 4 个附件（§6.1） |

**解码**，按以下顺序：

- 不是合法 UTF-8、以 `EF BB BF` 开头、不是 JSON 对象、嵌套超过 32 层、任一层出现重复的成员名（反转义后比较）、任一字符串或成员名里有孤立的代理项转义：`damaged`；
- `v` 是 1 以外的数字，或 `kind` 是 `"message"` 以外的字符串：`unsupported`；
- `v` 或 `kind` 缺失或类型不对、`body` 缺失或不是字符串、`subject` 不是字符串：`damaged`；
- 否则是一条消息：`subject` 截到 200 个码点；`ts` 不是 0..2^53−1 之间的整数时忽略；未知成员忽略。

**附件**永远不会让消息变成 `damaged`。`attachments` 数组只看前 4 个元素；通不过 §6.1 的附件丢弃，客户端**必须**告诉读者丢弃了几个（第 4 个之后的元素算作丢弃；`attachments` 不是数组时算丢弃一个）。

**显示：** `subject` 和 `body` **必须**当作纯文本显示，不得当作 HTML 或任何标记语言。双向控制字符（U+061C、U+202A–U+202E、U+2066–U+2069）、U+200B、U+200E、U+200F、U+2028、U+2029、U+2060–U+2064、U+FEFF、U+115F、U+180E、U+3164、U+FFA0，以及除换行、制表符以外的 C0/C1 控制字符，**必须**变成可见形式或删除。打开网址前**必须**显示完整网址。消息时间是区块时间，不是 `ts`。

### 6.1 附件格式

| `type` | 字段 | 规则 |
|---|---|---|
| `image` | `mime`、`data`、`w`、`h` | `mime` 是 `image/webp`、`image/jpeg` 或 `image/png`；`data` 是带填充的标准 base64（长度是 4 的倍数），解码后 1..11,000 字节，开头字节与声明的格式一致；从文件头读出的**真实**宽高**必须**在 1..2048 之间，并且**必须**等于 `w`、`h`。拒绝：动图 PNG（`IDAT` 之前有 `acTL` 块）、带动画标志（0x02）的 WebP `VP8X`、非基线 JPEG（第一个 SOF 标记必须是 SOF0 或 SOF1） |
| `native` | `chainId`、`amount`、`tx` | 转进收件容器的该链原生币 |
| `erc20` | `chainId`、`token`、`amount`、`tx` | 转进收件容器的代币 |
| `erc721` | `chainId`、`token`、`tokenId`、`tx` | 转进收件容器的 NFT |

`chainId` 是大于 0 的安全整数；`tx` 是 32 字节交易哈希；`token` 是 20 字节地址；`amount` 是非零、不带前导零的十进制字符串（最多 78 位）；`tokenId` 是十进制字符串（可以为 0）。十六进制一律按小写比较。

资产附件只是一项**声明**：资产由发件人钱包在另一笔交易里直接转进收件容器，中枢从不经手资产。收件方客户端核对这项声明（§9）。客户端**不得**把电路 NFT 当作附件提供（以严格一致读取 `factory.isCPU` 为真的合约；读取失败按"是"处理）。

## 7. 消息标识、顺序、回复与最终性

- **消息 ID** = `keccak256("TAP-10/msg/v2" ‖ uint256(chainId) ‖ hub ‖ endpointID(to) ‖ uint256(inboxIndex))`，其中 `chainId` 是保存这条条目的中枢所在的链。它只取决于以严格一致从存储里读出的值；
- **顺序：** 先按区块时间，再按链，再按区块号，再按序号；
- **回复：** `ref` 由发件人自选，公开且不经核实；客户端**不得**假定被引用的消息存在或涉及同样的双方，会话按端点对分组，不按 `ref` 分组；
- **最终性：** 消息所在区块高于已最终确认高度 `F` 时，消息为 `pending`（确认中）。`F` 的取法：向每个节点请求 `eth_getBlockByNumber("finalized")`，至少 3 个节点回答，取其中**最小**的。取不到 `F` 时，距离钉住的区块 30 个块以内的消息为 `pending`。链重组可能改变某个信箱序号上是哪条消息，从而改变它的 ID。对 `pending` 的消息，客户端**不得**核对附件、**不得**记录任何持久信息、**不得**把它作为回复对象；
- `from` 标识的是容器，不是某个人；它只证明在那个区块时，持有人（或作为持有人的合约，§3.4）控制着这个容器。

## 8. 读取

### 8.1 来源

消息唯一的来源，是配置地址上中枢的收件信箱和发件目录存储（用 `eth_call` 读取），以及同一地址发出的 `Sent` 日志（用来取载荷）。其他地址发出的日志都不是消息。不使用、也不需要索引器。

### 8.2 钉住的区块与新鲜度

客户端钉住一个至少默认法定数量的节点都已到达的区块：取第 quorum 高的区块头再往回 2 个块，并最多等待 1.5 秒让所有节点报告区块头。用于解析、读公钥和发送的每个钉住的区块，客户端都**必须**以严格一致读它的区块头：区块时间比本机时钟早 300 秒以上时以 `stale-block` 拒绝，晚 60 秒以上时以 `clock-skew` 拒绝。

### 8.3 列出消息

对自己的端点，在位图里对应位为 1 的每条已启用链上，客户端在同一个钉住的区块上以严格一致读取：

- `inboxCount(端点号)` 和 `inboxPage(端点号, start, n)`，先读最新的一页；
- 发出的消息：主链上的 `outboxCount(容器)` 和 `outboxPage(容器, start, n)`。

每个条目都**必须**属于正在读的信箱（收件条目的 `to` 是读者的端点，发件条目的 `from` 是读者的容器），否则丢弃并报告。客户端**可以**用普通（非严格）读取轮询 `inboxCount`、`outboxCount` 来发现新消息，但显示任何内容之前**必须**通过严格读取重新加载；总数持续变化时**应当**逐步拉长间隔。

### 8.4 取回载荷

对区块 `b` 上的一个条目，客户端向**任意一个**节点请求中枢在区块 `b` 的 `Sent` 日志（`eth_getLogs`，`fromBlock = toBlock = b`，地址为中枢，topics 为 `[Sent, to]`）；该节点不提供日志时改为请求 `eth_getBlockReceipts(b)`。只接受能解码为中枢发出的 `Sent`、`to`、`from`、`inboxIndex` 与条目一致、并且 `keccak256(ref ‖ keccak256(payload))` 等于条目内容指纹的日志，否则换下一个节点。从节点那里只取 `ref` 和 `payload`。

日志里的交易哈希只是**线索**（`txHint`）。使用它的地方（§8.6、§9）**必须**以严格一致确认。客户端**不得**缓存没有线索的载荷；线索确认失败时**必须**丢弃缓存的线索，让下次加载换一个节点。

### 8.5 显示消息

- 静音发件人的消息不取回；
- `(from, to, digest)` 相同的消息是同一份载荷又发了一次；客户端只显示一条，**可以**显示次数；
- 收件信箱和发件目录读出同一个消息 ID、内容指纹却不同时，说明两次读取之间发生了链重组：客户端保留一条，标为 `pending` 并重新加载；
- 为了限制刷消息，客户端**应当**对每个从未写过信的发件人每页只取回少量消息（参考实现：3 条），其余计为已折叠，并让用户可以展开。

### 8.6 发件钱包

发出消息的钱包由这条消息自己的交易决定，绝不取电路当前的持有人：

1. 以严格一致读 `txHint` 的回执；要求状态为 1、区块等于条目的区块，并且其中有一条中枢发出的 `Sent` 日志，`to`、`from`、`inboxIndex`、`ref` 和载荷都与条目一致；
2. 同一回执里有任何 ERC-721 `Transfer` 日志（topic0 为 `0xddf252ad…`，4 个 topic）时，发件人为**间接**；
3. 以严格一致读取交易。`tx.to` 是中枢，或 `tx.to == tx.from`（EIP-7702 账户自己调用自己）时，发件钱包是 `tx.from`；否则发件人为**间接**。

间接发出的消息可能是持有人授权过的合约写的（§3.4），客户端**应当**在这条消息旁边说明。联系人的发件钱包变了，或者与初次联系时记录的不同，客户端**应当**提示这枚电路换了持有人。

### 8.7 状态码

| 状态 | 含义 |
|---|---|
| `ok` | 公开消息，或加密消息已打开，并且内容解码成功 |
| `unsupported` | §5.1 或 §6 的不支持 |
| `damaged` | §5.3 或 §6 的损坏 |
| `not-for-key` | 客户端持有的任何私钥都打不开槽位 |
| `pending` | 高于已最终确认高度（§7） |
| `unavailable` | 回答有分歧、回答的节点太少，或没有节点返回与内容指纹一致的载荷；稍后重试 |
| `stale-block`、`clock-skew` | §8.2 |
| `wrong-chain` | 节点不在预期的链上，或收件人不读发件链（§4.4） |
| `hub-mismatch` | 中枢给出的容器或端点号与解析结果不同（§2.4） |
| `hub-missing` | 配置的地址上没有中枢 |
| `hub-changed` | 中枢实现不被接受（§3.8） |
| `circuits-changed` | 处理器实现已被更换（§3.8） |
| `no-key`、`key-stale`、`bad-key` | 没有公钥；公钥不可用；公钥通不过 §4.4 第 3 步 |
| `key-changed` | 收件人的公钥或持有人与上次往来时不同（§10 第 3 步） |

状态码只增不减。

## 9. 资产附件核对

客户端在附件 `chainId` 指定的链上核对消息 `m` 的每个资产附件；客户端不读的链上的附件显示为未核对（`other-chain`）。所有读取都用严格一致。按以下顺序检查，第一条成立的就是结果：

1. `pending`：`m` 还在确认中（§7）；
2. `mismatch`：所有节点一致表示 `tx` 既没有回执也没有这笔交易；
3. `unavailable`：回执或交易无法以严格一致读到；
4. `mismatch`：回执状态不是 1；
5. `unverifiable`：仅 `native`：`tx.to` 不是收件容器（合约钱包的内部转账看不到）；
6. `mismatch`：没有对应的转账。`native` 为 `tx.value ≠ amount`；`erc20` 为没有由 `token` 发出、转给容器、恰好 3 个 topic 且 data 等于 `amount` 的 `Transfer` 日志；`erc721` 为没有由 `token` 发出、转给容器、4 个 topic 且 topic3 等于 `tokenId` 的 `Transfer` 日志；
7. `late`：转账所在区块晚于 `m` 所在区块；
8. `unavailable`：无法确定 `m` 的发件钱包（§8.6）；
9. `indirect`：`m` 是间接发出的（§8.6）；
10. `third-party`：付款方不是发件钱包。`native` 的付款方是 `tx.from`，代币的付款方是 `Transfer` 日志里的 `from`；从发件人自己的容器转出的，只有在 `tx.from` 是发件钱包时才算发件人付的；
11. `unavailable`：无法读到转账所在区块的时间；
12. `stale`：转账的区块时间比 `m` 的区块时间早 3,600 秒以上；
13. `crowded`：在同一个信箱里从 `m` 往回数，转账区块及之后的条目超过 60 条；
14. `not-first`：上述更早的条目中有来自同一个发件容器的，或者它的消息（§8.6）的发件钱包相同（有更早条目的发件钱包无法确定时，结果为 `unavailable`）；
15. `ok`：以上都不成立。

只有 `ok` 能证明发件人为这条消息向这位收件人付了款。客户端**应当**只对常见代币名单里的合约把 `ok` 显示为正面结果；其他代币以中性方式显示；符号里含非 ASCII 字符或模仿常见代币符号的，**应当**提示可能是仿冒。同一条消息里，第二个 `tx` 相同的附件是重复引用，**不得**再算一次。`mismatch`、`not-first` 和重复引用**应当**显示为警告。

## 10. 发送

1. 在新钉住的区块上解析收件人（§2.4），执行 §4.4；
2. 解析发件人自己的端点；要求 `opened`，并且 `holder` 等于当前钱包；要求中枢被接受、处理器实现未被更换（§3.8）；
3. 如果以前和这位收件人往来过，比较收件人的公钥、`keyIndex` 和持有人与当时记录的是否相同；有任何不同，显示 `key-changed` 并要求确认。往来成功后记录下来；
4. 附带资产时：每笔转账由持有人钱包直接转进收件容器，一拿到交易哈希就**立即**记在本机，不等上链。已记录的转账**不得**再转一次；只有所有节点一致确认交易回滚，或已被取消（同一 nonce 上链的是另一笔交易），才删除记录。钱包加速时，用替换交易的哈希替换记录。已记录的转账随下一条发给同一收件人的消息一起发出，**应当**在一小时内发出（§9 的 `stale`）；
5. 用 `to` = 收件端点号、`from` = 发件端点号、以及将要传给 `send` 的 `ref`，构造内容（§6）和载荷（§5）；
6. 请钱包签名之前，再读一次收件人的 `keyFor`；`version` 变了就回到第 1 步；
7. 由持有人钱包调用 `send(发件处理器合约, 发件 #ID, 收件端点号, ref, 载荷)`；
8. 结果不明时（超时、钱包出错），记下交易哈希；在该交易确认上链、或所有节点一致确认它不会上链之前，**不得**允许同一容器、同一钱包再发。

## 11. 安全考虑

- **元数据公开且永久。** 谁给谁写信、什么时候、多长、用了哪些链，所有人都看得到。只有加密内容受保护；长度没有填充；槽位指纹暴露了消息是加密给哪把公钥的；
- **没有前向保密。** 以后拿到某把私钥、或派生它的签名的人，能打开所有加密给它的消息；
- **签名就是私钥。** 拿到 §4.2 签名的人就拿到了私钥。往网页注入钱包的客户端（tape:// 外壳）**必须**拒绝对原始哈希签名，并拒绝任何含 `tapesend:hub:` 的 `personal_sign` 文字。官方客户端**不得**从同时托管用户网站的域名提供；
- **封印前的中枢 owner。** owner 可以更换实现，并在同一笔升级交易里改写公钥记录或收件条目、再换回被接受的实现（§3.8）。只检查实现地址证明不了存储没被动过。先封印工厂，再尽早封印中枢；
- **封印前的工厂。** 控制工厂的人可以临时替换处理器实现，以任何容器身份写入、撤销公钥，而中枢看不到任何痕迹。工厂封印前埋下的状态，之后仍可能以普通转账的形式挪走电路；
- **被授权的合约。** 被授权处理某枚电路 NFT 的合约，可以在一笔交易里以它的容器身份写入、撤销它的公钥（§3.4）。客户端会标出这类消息（§8.6）。持有人**应当**只做单枚授权，用完就撤销；
- **刷消息。** 任何有已开通容器的人都能往任何信箱追加条目，条目永远删不掉。按 0.05 gwei、BNB 725 美元计，一条约 0.004 美元。客户端依靠陌生人限量和静音（§8.5）；扫描一个被刷爆的信箱，每 200 条要一次 `eth_call`；
- **串通的节点。** 身份、公钥、收件条目、回执和封印状态都用严格一致读取，伪造它们需要控制所有回答的节点。单个节点只能让读取变成 `unavailable`，或扣住载荷不给；
- **资产声明。** 附件证明的是一笔转账，不是付款意图。§9 把它绑定到发出消息的钱包、时间和第一条消息上；它证明不了这笔钱是为什么付的，也不覆盖合约钱包付的款；
- **电路转手。** 买家继承容器和它的联系人。§10 第 3 步和 §8.6 让这种变化可见；出售前刚加密的消息，卖家仍可能读到；
- **相似的端点和链。** 只有处理器编号和链后缀能区分端点；客户端**必须**始终同时显示两者；
- **显示与随机数。** 内容由攻击者控制（§6）。重复使用 `(kek, N)` 或 `(K, N)` 会破坏保密性。

## 12. 测试向量

`send/module/test/vectors.json` 包含以下内容，每个实现都**必须**能复现：

1. §4.2：`#4246@0`、容器 `0x86DDaEF00401E3F10418398D67D7189fc458eA95`、固定的测试钱包和测试中枢，`k = 0` 和 `k = 1`：文字、字节、长度和 SHA-256，签名哈希，签名，规范化的 `r ‖ s`，HKDF info，seed 和公钥；
2. §5.3：固定的 `e`、`N`、`K`，两把收件公钥，`to`、`from`、`ref` 和中枢：`E`、`D`、`X`、`P`，每个槽位的共享密钥、`kek`、指纹和包裹后的密钥，`C` 和载荷；
3. §5.2：同一内容的公开载荷；
4. §7：消息 ID，包括一条链号不是 56 的；
5. §6：解码用例（合法；重复成员名，普通与转义两种；非法 UTF-8；BOM；值和成员名里的孤立代理项；缺 `v`；`v` 是字符串；未来的 `v`；其他 `kind`；缺 `body`；32 层和 33 层嵌套；前后空白；超长 `subject`）；
6. §5.3：打开结果，包括旧的版本 1 载荷（`unsupported`）；
7. §4.4 被拒绝的公钥，以及 §4.2 的签名变体。

`send/module/test/crypto.test.mjs` 还覆盖附件规则（§6.1），包括 PNG、WebP（VP8、VP8L、VP8X）、JPEG 的文件头解析，拒绝动图和渐进式 JPEG，以及端点号校验。

## 13. 变更规则

对格式版本 `0x02`，以下内容不会改变：§2.2 的端点号；§2.1 的链序号；§4.2 的文字、标签和步骤；§5 的载荷布局、标签和步骤；§7 的消息 ID；中枢的写入接口、事件、存储布局和授权规则。新链追加到 §2.1，它的实现追加到 §3.2。其他必须改变的内容，使用新的格式版本、新的套件或新的中枢，客户端继续读取旧的。

计划中：启用 Base 和 X Layer、跨链读取公钥、群组会话、由中枢强制执行的收信规则。

## 14. 参考实现

| 组件 | 位置 |
|---|---|
| 中枢合约 | `send/contracts/`：`DeWebHub`、`DeWebAdmin`、`DeWebProxy`、`DeWebBoot`；单元、模糊、不变量、分叉和地址钉住测试；部署页 |
| 协议模块 | `send/module/`：公钥、载荷、内容与附件、端点、严格一致读链、最终性；测试向量；主网只读测试和分叉端到端测试 |
| 身份核心 | `kernel/src/identity.js`：与 tape:// 内核共用 |
| 客户端 | `apps/tapesend/`：网页版、桌面版（Electron）、iOS/Android（Capacitor）；实现 §8–§10，包括附件核对、陌生人折叠、间接发件提示。中枢不被接受或处理器实现被更换时禁止发送 |

## 附录 A. 相对草案 v0.5 的改动

- 以地址作为收件方的单链 `TapeSendHub`，换成了 DeWEB 中枢：端点号带链号；中枢保存链上收件信箱和发件目录；`send` 返回收件序号；`publishKey` 多了收信链位图；`keyFor` 返回端点号和位图，不可用时把公钥字段清零；
- 中枢在各链地址相同（启动实现 + 代理），封印前可以升级，升级时检查 `selfAddress` 和 `proxiableUUID`；
- 载荷格式 `0x02`：所有标签改为 `v2`，`X` 绑定端点号，不再单独绑定地址和链号；
- 公钥派生绑定端点号；签名文字里的 `Chain ID` 是容器的主链；
- 消息 ID 由存储计算（`chainId`、中枢、`to`、收件序号），不再用交易哈希和日志序号；
- 内容增加 `attachments`（图片和资产声明），核对规则见 §9；
- 规定了最终性、发件钱包、间接发件和陌生人折叠；
- 删除了索引器和通知服务接口（v0.5 §10、§11）。
