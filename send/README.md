# TapeSend · DeWEB messaging layer

Messages between TapeOut circuit containers. A container such as `#4246@0` is an address that can receive messages; its holder sends as it. Each message is written to a small contract (the **DeWEB hub**) on the sender's chain, encrypted end to end, and every client verifies what it reads against the chain. No bridge, no indexer, no server in the message path.

TapeOut 电路容器之间的消息。`#4246@0` 这样的容器就是一个收件地址，持有人以它的身份发消息。每条消息写进发件人所在链上的一个小合约（**DeWEB 中枢**），端到端加密，每个客户端读到的内容都自己去链上核对。消息路径上没有跨链桥、没有索引器、没有服务器。

> **Status / 状态（2026-09-18）**
> - Live on BNB Smart Chain. Other chains (Base, X Layer) are planned but not active.
> - The hub is **upgradeable until sealed**; it has not been sealed yet (see below).
> - **Not independently audited.** All reviews so far were internal.
> - The specification is [TAP-10.md](../TAP-10.md) v1.0 (English, normative; Chinese translation [TAP-10.zh.md](../TAP-10.zh.md)).
>
> - 已在 BNB Smart Chain 主网运行。其他链（Base、X Layer）在计划中，尚未启用。
> - 中枢在**封印之前可以升级**，目前还没有封印（见下文）。
> - **尚未经过独立审计**，目前的审查都是内部进行的。
> - 规范是 [TAP-10.md](../TAP-10.md) v1.0（英文为正本），中文译本见 [TAP-10.zh.md](../TAP-10.zh.md)。

## Deployment / 部署地址（BNB Smart Chain, chainId 56）

| | Address |
|---|---|
| Hub (proxy — the address clients use) / 中枢（代理，客户端使用的地址） | `0xe61A9C7213a6Aa616C246a2B569e555B417b25ee` |
| Current implementation (v3) / 当前实现（第三版） | `0x80aFE7B77F2dFD08e9feab7675780baC34a7EE85` |
| Boot implementation (same on every chain) / 启动实现（各链相同） | `0xC0D28CA8689248B0bed26cC0aa328CF16Aa4401e` |

The hub has the same address on every chain (deterministic boot implementation + proxy). All three addresses can be recomputed from source: `forge test --match-contract Pinned` checks them, and the client accepts only implementations listed per chain in `module/src/chain.js` (`HUB_IMPLEMENTATIONS_BY_CHAIN`).

中枢在每条链上地址相同（确定性部署的启动实现 + 代理）。三个地址都能由源码重新算出：`forge test --match-contract Pinned` 会核对；客户端只认 `module/src/chain.js` 里按链列出的实现（`HUB_IMPLEMENTATIONS_BY_CHAIN`）。

## How it works / 工作方式

- **Endpoint / 端点号**：`uint32(0) ‖ uint64(chainId) ‖ container`, globally unique. Shown as `#15324@30` on BNB and `#15324@30.base` elsewhere. 全网唯一；BNB 上显示 `#15324@30`，其他链带短名。
- **On-chain inbox / 链上信箱**：the hub stores, per recipient, `(sender container, block, timestamp, digest)` and per sender an outbox; clients page through them with `eth_call`, read strictly from several independent nodes. The payload itself is in the `Sent` event and is fetched from any single node, then checked against `digest = keccak256(ref ‖ keccak256(payload))`. 中枢为每个收件人存（发件容器、区块、时间、内容指纹），为每个发件人存发件目录；客户端用 `eth_call` 分页读取，多家节点严格一致。载荷在 `Sent` 事件里，任意一个节点取回后按内容指纹核对。
- **Message ID / 消息 ID**：`keccak256("TAP-10/msg/v2" ‖ chainId ‖ hub ‖ to ‖ inboxIndex)`.
- **Encryption / 加密**：payload format `0x02`; X25519 + XChaCha20-Poly1305; the key is derived from a wallet signature and published on the hub together with a bitmap of chains the recipient reads. 载荷格式 `0x02`；公钥由钱包签名派生，发布在中枢上，带"收信链"位图。
- **Metadata is public / 元数据公开**：who messages whom, when, and how long is visible on chain; only the content is encrypted. 收发关系、时间、长度在链上公开，只有内容加密。
- **Attachments / 附件**：small images inside the encrypted content; asset attachments are transfers into the recipient's container that the recipient's client verifies on chain (paid by the wallet that sent the message, not later than the message, at most one hour earlier, first reference only). 小图片放在加密内容里；资产附件是转进对方容器的转账，由收件方客户端到链上核对。

## Components / 组成

| Path | What it is |
|---|---|
| [`contracts/`](contracts/) | `DeWebHub` + `DeWebAdmin` (UUPS) behind `DeWebProxy`; `DeWebBoot` / `DeWebAdminBoot` are the frozen boot implementation. Foundry project: unit, fuzz and invariant tests, BSC fork tests, pinned-address test, and a browser deployment page (`script/deploy-page.mjs`) |
| [`module/`](module/) | `@tapekit/send`: key derivation, sealing/opening payloads, content and attachments, endpoint IDs, strict chain reads (inbox/outbox, keys, hub and factory status, finality). Test vectors in `module/test/vectors.json` |
| [`../apps/tapesend/`](../apps/tapesend/) | The client: web, desktop (Electron, with the `tape://` browser) and iOS/Android (Capacitor) |
| [`docs/`](docs/) | Design notes for the cross-chain layer |

| 路径 | 说明 |
|---|---|
| `contracts/` | 中枢合约（UUPS 可升级，代理 + 冻结的启动实现）。单元、模糊、不变量测试，主网分叉测试，地址钉住测试，浏览器部署页 |
| `module/` | 协议模块：公钥派生、加密解密、内容与附件、端点号、多节点严格读链 |
| `../apps/tapesend/` | 客户端：网页版、桌面版（Electron，含 `tape://` 浏览器）、iOS / Android（Capacitor） |
| `docs/` | 跨链消息层设计说明 |

## Trust and sealing / 信任与封印

1. **The hub is upgradeable until `seal()`.** Until then its owner can replace the implementation, which could forge messages or replace keys. The client checks that the implementation is on its allow-list, but cannot prove that storage was never rewritten during an upgrade. Seal once the logic is settled.
2. **Seal the TapeOut processor factory first, then the hub.** The hub pins the current circuit implementation; if the circuits are upgraded after the hub is sealed, the hub stops for good. `seal()` itself does not check this; the deployment page does (factory sealed, factory implementation pinned, beacon owned by the factory, circuit implementation unchanged).
3. **Known limitations, handled only in the client:** anyone with an opened container can flood an inbox (the client shows at most 3 messages per stranger per page); a contract that the holder approved for the circuit NFT (for example a marketplace) can borrow it within one transaction and send as the container (the client flags messages not sent directly by the holder's wallet).

1. **中枢在 `seal()` 之前可以升级。** 在此之前，owner 可以更换实现，从而伪造消息或替换公钥。客户端会核对实现是否在认可名单里，但证明不了升级过程中存储没被改写。逻辑稳定后尽快封印。
2. **先封印 TapeOut 处理器工厂，再封印中枢。** 中枢钉住了当前的电路实现；中枢封印后如果电路合约被升级，中枢会永久停用。`seal()` 本身不检查这一点，由部署页把关（工厂已封印、工厂实现是钉住的那份、beacon 归工厂、电路实现未变）。
3. **只在客户端处理的已知限制：** 任何有已开通容器的人都能往别人信箱里刷消息（客户端对陌生发件人每页只显示 3 条）；持有人授权过电路 NFT 的合约（例如交易市场）可以在一笔交易里借走电路、以容器身份发消息（客户端会标出不是由持有人钱包直接发出的消息）。

## Tests / 测试

```bash
cd send/contracts && forge test && forge test --match-contract Fork --fork-url https://bsc-dataseed.bnbchain.org
cd send/module && npm install && npm test && npm run test:mainnet && npm run test:fork
```

- `test:mainnet` reads the live hub (read-only). / 只读主网上的中枢。
- `test:fork` needs `anvil`, `cast` and a prior `forge build` in `send/contracts`: it forks BSC mainnet locally, deploys the current implementation at its deterministic address, upgrades the hub, publishes a key and sends from a real circuit, then reads everything back through the module. Nothing is sent to mainnet. / 需要 `anvil`、`cast`，并先在 `send/contracts` 里 `forge build`：在本机分叉主网，部署当前实现、升级中枢、用真实电路发布公钥并发消息，再用模块读回核对；不会向主网发送任何交易。
