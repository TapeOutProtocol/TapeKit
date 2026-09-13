# Security Policy / 安全政策

Tapekit reads on-chain websites and hands the bytes to a browser. A bug here can let a site escape its origin, show unverified bytes as verified, or leak a user's data. Please report such problems privately first.

## Reporting a vulnerability / 报告漏洞

**Preferred**: open a private report on GitHub: [Security → Report a vulnerability](https://github.com/TapeOutProtocol/TapeKit/security/advisories/new). Only the maintainers can see it.

**Or by email**: codongorg@gmail.com with the subject `[tapekit security]`.

Please include: the component (`kernel`, `sw-gateway`, `extension`, `viewer`, `SPEC`), steps to reproduce, and what an attacker gains. A minimal on-chain site or a script is ideal. Do not open a public issue for anything that could be exploited before a fix ships.

## What to expect / 处理时限

| Step | Target |
|---|---|
| Acknowledgement | within 3 days |
| First assessment (is it a vulnerability, how severe) | within 7 days |
| Fix or mitigation for confirmed high-severity issues | within 30 days; the report stays private until the fix is released |
| Credit | in the release notes, if you want it |

## Scope / 范围

In scope: everything in this repository, and the specification itself (a flaw in the rules counts).

Out of scope: the TapeOut and HashPort contracts already deployed on BNB Chain (report those to the HashPort team; their addresses are in SPEC.md §3.1), public RPC nodes run by third parties, and sites published by third parties (use the blocklist and the report link in the gateway status page).

## Design guarantees you can test against / 可以对照测试的设计承诺

- A file whose length or SHA-256 does not match the chain is never displayed (SPEC §5).
- Two sites never share an origin; site code never runs in a privileged context (SPEC §7).
- A single lying node cannot change what is displayed (SPEC §4.1).
- A store implementation that is not on the pinned list is refused (SPEC §4.3).
- Off-chain requests under the gateway are blocked by default (SPEC §7.8).

Anything that breaks one of these is a vulnerability.

---

中文摘要：请优先用 GitHub 的私密漏洞报告（仓库 Security 页 → Report a vulnerability），或发邮件到 codongorg@gmail.com，标题写 `[tapekit security]`。3 天内确认收到，7 天内给出评估，确认的高危问题 30 天内修复，修复发布前报告保密。范围是本仓库和规范本身；已部署的合约、第三方节点、第三方网站不在此列。上面列的五条设计承诺，任何一条被打破都算漏洞。
