# tape:// Service Worker 网关

让**普通浏览器不装任何东西**就能打开链上网站，而且每个网站有自己的真实来源（能保存数据、能用你已经装的钱包扩展）。做法和 IPFS 的「Service Worker 网关」一样：

1. 每个网站一个子域名：`https://4246-0.<网关域名>/` 就是链上名字 `4246.0.tape`；
2. 服务器对**所有子域名、所有路径**都只返回同一个引导页 `index.html`（外加 `/sw.js` 和 `/.tape/` 下几个静态文件）；
3. 引导页装上 Service Worker 然后刷新。从此这个来源下的每个请求都由 Service Worker 在你的浏览器里直接从 BNB 链公共节点读取、多节点核对、SHA-256 校验，**服务器再也不经手任何内容**；
4. 链外请求默认拦截并记录；每个网站的状态页 `/.tape/status` 显示身份、开通与校验状态、链外引用、拦截记录、节点情况，并能逐站放行、换节点、本机屏蔽。

> 状态（2026-09-13）：参考实现完成，端到端 25 项全过（真 Chrome 无头 + 主网只读）。**尚未经过独立审计，尚未正式部署。**

## 本机运行

```bash
node dev-server.mjs
```

- 首页 `http://localhost:8096/`：输入名字跳到子域名；
- 样例站 `http://4246-0.localhost:8096/`（Chrome 把 `*.localhost` 都解析到本机，不用改 hosts）；
- 状态页 `http://4246-0.localhost:8096/.tape/status`（加 `?json=1` 得 JSON）；
- 强制刷新（Shift+刷新）会绕过 Service Worker 一次，再普通刷新即可。

## 测试

```bash
node test/e2e.mjs
```

需要本机装有 Google Chrome（路径可用环境变量 `CHROME` 指定）。无头 Chrome 打开本机网关，连主网公共节点只读，不发交易。检查：Service Worker 接管、页面字节与链上 SHA-256 一致、独立来源能存数据且两个网站互不可见、前端路由回退、404、链外 fetch 与图片被拦截、状态页放行后能发出、状态页内容、未开通名字不显示、根域名首页与 `?open=` 跳转、坏主机名报错。

## 文件

| 文件 | 作用 | 谁读 |
|---|---|---|
| `index.html` + `boot.js` | 引导页：网站子域名上装 Service Worker；根域名上是首页（输入名字、注册 `web+tape://` 处理器） | 浏览器（从服务器取） |
| `sw.js` | Service Worker：读链、校验、拦截链外请求、状态页、设置 | 浏览器（从服务器取） |
| `pages.js` | 状态页与说明页模板，中英文，**无脚本** | `sw.js` |
| `../kernel/src/*` | 内核（部署时放到 `/.tape/kernel/`） | `sw.js` |
| `config.json` | 架设者配置：自己的节点（可选）、屏蔽名单地址、举报链接 | `sw.js` |
| `blocklist.txt` | 架设者的屏蔽名单（规范 §9 格式） | `sw.js` |
| `dev-server.mjs` | 本机静态服务器，行为与正式部署一致 | 开发 |

## 部署（任何人都可以架）

**最省事的方式：Cloudflare Workers 静态资源**（官方网关 tapekit.org 就是这样架的，零服务器）：

```bash
npm run build:gateway        # 生成 dist/gateway/
npx wrangler login           # 一次性，浏览器里点 Allow
npx wrangler deploy          # 按仓库根目录的 wrangler.toml 发布
```

`wrangler.toml` 里的 `routes` 把 `你的域名/*` 和 `*.你的域名/*` 都指到这个 Worker；域名要先加进同一个 Cloudflare 账号，并在 DNS 里加一条 `*` 的 A 记录（内容随便填，例如 `192.0.2.1`，开橙云代理）——Worker 只在代理过的主机名上生效。`not_found_handling = "single-page-application"` 就是「其它路径一律回引导页」这条规则。

**其它静态托管**：

把这些文件按下面的路径放到一个 https 域名下，并让通配子域名 `*.<网关域名>` 也指向它：

```
/index.html            ← sw-gateway/index.html
/sw.js                 ← sw-gateway/sw.js
/.tape/boot.js         ← sw-gateway/boot.js
/.tape/pages.js        ← sw-gateway/pages.js
/.tape/config.json     ← sw-gateway/config.json
/.tape/blocklist.txt   ← sw-gateway/blocklist.txt
/.tape/kernel/*.js     ← kernel/src/*.js
```

规则：**这些路径按静态文件返回，其它任何路径都返回 `/index.html`（状态码 200）**。JS 文件的 Content-Type 必须是 `text/javascript`。

nginx 示例：

```nginx
server {
  server_name tape.example.org *.tape.example.org;
  root /srv/tape-gateway;
  location = /sw.js { add_header Cache-Control "no-cache"; }
  location /.tape/ { add_header Cache-Control "no-cache"; }
  location / { try_files /index.html =404; add_header Cache-Control "no-cache"; }
}
```

Cloudflare Pages：把目录整个上传，加一个 `_redirects` 文件，内容 `/* /index.html 200`（静态文件优先于这条规则）。

证书：通配证书只覆盖一层子域名，所以网站段是 `4246-0` 而不是 `4246.0`。Cloudflare 的免费证书覆盖 `*.example.org`，不覆盖 `*.tape.example.org`；要么用独立域名的一层子域，要么买覆盖多层的证书。

正式部署**应当**把网关域名提交到 [Public Suffix List](https://publicsuffix.org/)，让每个子域名成为独立的「站点」（Cookie 不能跨子域污染，浏览器给独立进程和存储分区）。

## 节点是谁的

**不属于网关。** 读链发生在用户浏览器里，默认用内核里那 4 家不同运营方的公共节点，每次读取至少 2 家结果一致才采用。架网关的人可以在 `config.json` 里加自己的节点（只算一票，规则不变）；用户可以在状态页换成自己的节点（只存在自己浏览器里）。**不要把带密钥的节点地址写进 `config.json`**——它是公开文件，会被白嫖；要用就架一个限流代理。

## 信任模型（如实说明）

- 需要信任的只有引导页这几个文件（服务器换掉它们就能篡改网站）。它们开源、没有外部资源，任何人都能自己架，扩展将来可以对它们做哈希钉住。
- Service Worker 接管后，每个文件仍按规范 §5 与链上 SHA-256 逐个核对；多节点核对挡得住单个节点作假。
- 「已与链上核对」只说明字节与链上一致，不说明网站可信。名字一直在子域名里；钱包扩展按来源记授权，一个子域名一个授权。
- Service Worker 拦不住 WebSocket 和 WebRTC。
- 地址栏显示的是网关域名。谁架网关，谁的域名就在展示别人的内容——这是架设者要自己权衡的事。

## 审计前自查清单

- [ ] 引导页、`sw.js`、`pages.js`：没有任何外部资源、没有 eval、状态页与说明页没有脚本
- [ ] `/sw.js`、`/.tape/*` 之外的路径一律走链；网站文件里同名路径读不到（保留路径）
- [ ] 主机名解析：只接受 `<十进制>-<十进制>`，不带前导 0；坏主机名给明确报错，不当首页
- [ ] 非 `ok` 状态一律不给内容（开发预览开关只放行 `unpaid`，且只存在本机）
- [ ] 文件：长度与 SHA-256 不符不显示；超限不读；`no-hash` 标未校验
- [ ] 链外请求：默认 403；节点地址例外；放行按名字存本机；导航类请求给说明页
- [ ] 设置表单：只接受同源 POST（`Sec-Fetch-Site`）；节点地址只收 https；换节点后重建内核
- [ ] 响应头：`nosniff`、`no-referrer`、`x-tape-*`；文本类补 `charset=utf-8`
- [ ] 内核：429 退避、冷却排序、节点统计；对象型结果规范化比较
- [ ] 部署：通配证书覆盖范围、Public Suffix List、`_redirects` / `try_files` 规则、JS 的 Content-Type
