# DeWEB Hub

DeWEB 跨链消息层的链上合约。记录电路容器之间的消息（链上信箱：每条存发件容器、区块、时间和内容指纹，载荷在 `Sent` 事件里）和加密公钥（含收信链位图）。各链同一个地址（启动实现 + 代理，确定性部署）。

The DeWEB cross-chain messaging hub. Stores an on-chain inbox/outbox per endpoint (sender, block, timestamp, content digest; the payload itself is in the `Sent` event) and encryption keys with a receiving-chains bitmap. Same address on every chain (boot implementation + proxy, deterministic deployment).

**可升级（UUPS）、有 owner**：封印（`seal()`）之前，owner 可以把代理升级成任意实现。新实现必须满足：直接调用时 `proxiableUUID` 返回标准槽位、经代理调用时回滚；`selfAddress()` 返回它自己的地址；继续使用 `deweb.admin.v1` 与 `deweb.hub.v1` 两块命名空间存储。只有处理器工厂封印之后才能封印中枢。

**Upgradeable (UUPS) with an owner** until `seal()`. Until the processor factory is sealed, whoever controls it can impersonate any container.

```bash
forge build
forge test                                            # 单元测试
forge test --match-contract Fork --fork-url bsc       # BSC 主网分叉：真实工厂、登记表、持有人
forge script script/Deploy.s.sol --fork-url bsc       # 打印确定性地址，不广播
node script/deploy-page.mjs                           # 生成 dist/deploy-deweb-hub.html，由钱包签名部署
```

构建可复现（solc 0.8.28，optimizer 10,000 runs，EVM `shanghai`，无元数据哈希）。`DeWebAdminBoot.sol` 是冻结的，改它会改变启动实现和中枢地址。

注意：`seal()` 合约本身不检查工厂是否已封印，这个前提由部署页把关（工厂已封印、工厂实现是钉住的那份、beacon 归工厂、电路实现未被换），属于操作规程。`seal()` does not itself check that the factory is sealed; the deploy page enforces it.
