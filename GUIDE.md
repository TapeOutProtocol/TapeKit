# Tapekit 技术说明 —— tape:// 纯链上网站（内核 + 查看器 + 浏览器扩展 + Service Worker 网关）

HashPort 的网站文件本来就完整存在 BNB 链上。这个目录让客户端**直接读链**打开网站，不经过域名、DNS 和网关。

- **规范**：英文正本 [SPEC.md](SPEC.md)，中文版 [SPEC.zh.md](SPEC.zh.md)，包括网址格式、地址解析、校验方式、网站隔离要求、合约接口和变更规则。
- **内核** `kernel/`（npm 包名 `@tapekit/kernel`）：零依赖的 ES 模块，浏览器和 Node ≥ 18 都能用，MIT 许可。
- **网页查看器** `viewer/`：预览模式外壳。站点在沙盒 iframe 里运行，来源不透明。
- **浏览器扩展** `extension/`：在地址栏输入 `tape 4246.0.tape` 就能打开链上网站；弹出窗口可以校验当前 https 网页是否与链上字节一致。设了「网关域名」就改在网关的真实来源下打开。
- **Service Worker 网关** `sw-gateway/`：**普通 Chrome / Edge / Firefox / Safari 不装任何东西就能打开链上网站**，每个网站一个真实来源（能存数据、能用钱包扩展）。服务器只发一个引导页，读链全在用户浏览器里完成。用法与部署见 [sw-gateway/README.md](sw-gateway/README.md)。

> 状态（2026-09-13）：参考实现完成，单元 / 主网只读 / 无头 Chrome 端到端测试全过；**尚未经过独立审计，尚未正式部署**。

## 链上名字

```
<#ID>.<处理器编号>.tape              例：4246.0.tape = 0 号处理器（Genesis CPU）的 #4246
tape://<#ID>.<处理器编号>.tape/<路径>   主机名就是完整名字（Chromium 会把 4246.0 当 IPv4 解析，后缀不能省）
https://<#ID>-<处理器编号>.<网关域名>/  Service Worker 网关下的写法（通配证书只覆盖一层子域，所以用横线）
```

每个处理器的 #ID 都从 1 开始编号，所以名字里必须带上处理器编号。处理器编号就是工厂合约 `cpuAt(i)` 的下标，从 0 开始，只增不改。

**开通（收费）**：电路持有人调用现有的付费合约，不需要部署新合约：

```
DomainBinding(0x861EE183de2BBE4a6ecf9D15812C123b566a3DB7).bind("4246.0.tape", 容器地址, 月数)
msg.value = 月数 × 0.08 BNB
```

客户端只认「由名字推导出来的那个容器」付的费，所以不存在抢注。

**一个容器付一次费就够了**：只要这个容器为任何域名或名字付过费、还没到期（`DomainBinding.isContainerLive(容器)`），它的链上名字就算开通。比如为 test.hashport.ai 付过费的容器，`4246.0.tape` 也直接可用。

这需要把 DomainBinding 升级到新实现（在存储末尾追加 `containerPaidUntil`）：

```bash
forge build && node script/gen-binding-upgrade-page.mjs --binding 0x861EE183de2BBE4a6ecf9D15812C123b566a3DB7 --old-binding-impl 0x4E8684EaEA48b524245B2191DeE451eAa1c1cA94 --registry-impl 0x1d279D138A4D803378a7d4557c056f1beD53c261 --sync test.hashport.ai:0x86DDaEF00401E3F10418398D67D7189fc458eA95
```

这条命令在 `sites/` 下运行，生成 `dist/binding-upgrade.html`，用浏览器钱包分步完成：

1. 部署新实现；
2. 把网关的 `EXPECTED_IMPL` 改成旧、新两个实现都认，重启网关（这样升级时不停机）；
3. owner 升级代理；
4. 同步历史付费。

升级之前付的费，要调一次 `syncContainer(域名, 容器)` 才会算进来（任何人都能调）。在旧实现上调用 `isContainerLive` 会回滚，内核按「没有」处理。

链上数据是公开的，谁都能读到。收费靠的是官方内核和遵守规范的外壳只显示已开通的网站（规范 §3.4）。

## 运行

```bash
node dev-server.mjs
```

然后打开 `http://127.0.0.1:8095/viewer/`。

- 在本机的地址后面加 `?dev`（例如 `/viewer/?dev#/4246.0.tape`），可以预览还没开通的名字，方便站长上线前自测。只有 localhost 下才生效。
- `test/render-fixture.html` 是渲染器的回归夹具，覆盖 CSS 的 `@import` / `url()`、模块导入与动态导入、fetch、动态图片、链接接管、链外资源拦截和沙盒隔离。

## 测试

```bash
cd kernel && node --test test/unit.test.mjs
```

```bash
cd kernel && node --test test/mainnet.test.mjs
```

- **单元测试**（22 个）：离线运行，用仓库根目录的开发依赖 ethers 做第二份实现，交叉核对编解码结果（先在仓库根目录 `npm install`）。
- **主网只读测试**（9 个）：连公共节点做 eth_call，不发交易，不需要任何密钥。

## 浏览器扩展

```bash
node build-extension.mjs
```

组装结果在 `dist/extension/`。然后按下面的步骤加载：

1. 打开 `chrome://extensions`；
2. 打开「开发者模式」；
3. 点「加载已解压的扩展程序」，选 `dist/extension`。

Chrome 137 以后不能再用启动参数自动加载扩展，所以扩展只能手动装进去试。扩展里的渲染器和网页查看器是同一份代码，查看器已经在无头 Chrome 里测过。

## 内核 v0.2 新增（2026-09-13）

| 项目 | 做法 |
|---|---|
| 持久缓存 | 可插拔缓存接口，自带内存 / Node 文件目录（`createFsCache(dir)`）/ 浏览器 IndexedDB（`createIdbCache()`）三种实现，按字节数 LRU 淘汰。文件按链上 SHA-256 内容寻址存放，哈希一变自然失效；解析结果缓存 60 秒；处理器编号表也存进去 |
| 按需读取 | `openSite(res)` 只取清单，`site.get(path)` 用到哪个读哪个，`site.prefetch(paths)` 合并预取。查看器先读入口页、它引用到的资源和全部脚本（import map 一旦开始就不能改），图片/字体/媒体/其它页面由沙盒运行时通过 `hp-need` 向外壳要。`loadSite()` 仍可整站预读 |
| 处理器编号表 | 容器地址反查编号时按下标分批扫描，扫过的都进缓存；以后只补扫新增的处理器 |
| 更新监听 | `watch(site, onChange)` 轮询已知文件的链上哈希、文件数和回退路径（普通读调用，四家公共节点都支持；事件查询 `eth_getLogs` 三家 dataseed 连 500 个区块都拒绝，所以不用）。有变化就让解析缓存失效并回调；查看器显示「站长更新了这个网站 · 重新读取」 |
| 双语 | 内核所有状态与错误文案中英文都有：`setLocale('zh'|'en')`、`statusText(status)`、错误对象带 `code` 和 `messages.{zh,en}`。查看器界面可切换，默认跟随系统语言，记住选择 |

## 已知限制（预览模式）

- **不能保存数据，不能接钱包。** 这是隔离要求本身决定的（规范 §7.1、§7.4）。真正的「独立来源 + 钱包」要靠桌面或手机 App 注册 `tape://` 协议。浏览器扩展（Chrome MV3）做不到：它不能把链上内容当成一个网址来源返回。
- **只接管了一部分资源地址。** 目前能改写的是：HTML 属性、CSS、模块导入、`fetch`/XHR，以及脚本动态插入的元素。脚本自己拼出来再赋给 `location.href` 的站内跳转接管不了；使用 History API 的前端路由只能显示首页。
- **脚本要全部预读**（import map 的限制），其余资源按需；`loadSite()` 整站预读上限 32 MB、2000 个文件。

## 为什么不把查看器部署到我们的域名

查看器放在我们的域名上，就等于我们的网址在展示别人的内容。这正是之前砍掉「预览子域」的原因（违法内容风险）。所以它以开源的形式发布，用户在本地或自己的环境里运行，由浏览器扩展和钱包来分发。

## 下一步

1. Service Worker 网关：定网关域名（官方架 / 只开源 / 独立小域名）、提交 Public Suffix List、审计后部署；
2. 控制台加一个「开通链上名字」按钮，调用 `bind`；
3. 桌面外壳（Electron）注册 `tape://` 协议（钱包方案待定；有了网关之后优先级下降）；
4. 部署一个只读适配合约，兼容 `web3://`（ERC-4804 / ERC-6860）；
5. 把内核单独开一个开源仓库。
