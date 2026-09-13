# Contributing / 参与贡献

Thank you for helping. This file explains how changes get in. English first; 中文摘要在最后。

## Before you start

- **Specification changes** (`SPEC.md`) are discussed first: open an issue describing the problem, or a pull request that changes only the spec. The promises in SPEC §15.1 do not change; everything else follows §15.2–15.3. Keep `SPEC.zh.md` in sync section by section (the English text is normative).
- **Security-sensitive changes** (verification, isolation, node agreement, the pinned implementation list) need a written rationale in the pull request and a test that fails without the change.
- Small fixes (typos, docs, obvious bugs) can go straight to a pull request.

## Set up

```bash
git clone https://github.com/TapeOutProtocol/TapeKit.git
cd TapeKit
npm install          # dev dependencies only: ethers (unit-test cross-check), typescript (type check)
```

Node ≥ 18 (the tests use Node's built-in test runner). Google Chrome is needed only for the gateway end-to-end test.

## Run the tests

| Command | What it checks | Needs network |
|---|---|---|
| `npm test` | kernel unit tests (encoding, name parsing, path rules, node agreement, retries, cache) | no |
| `npm run test:types` | `kernel/index.d.ts` compiles against a sample program | no |
| `npm run build:extension` | the extension assembles and no import leaves the package | no |
| `npm run test:mainnet` | kernel against BNB Chain mainnet, read-only, no keys | yes (public nodes) |
| `npm run test:e2e` | Service Worker gateway in real headless Chrome against mainnet | yes, plus Chrome |

Run the first three before every pull request; run the last two when you touch the kernel's chain code or the gateway. CI runs the offline checks on every push and pull request, and the mainnet checks as a non-blocking job.

## Making changes

- The kernel stays **zero-dependency** at runtime and must work in browsers, Service Workers and Node. Do not add imports of Node-only modules outside `createFsCache`.
- Keep files small and comments in the style you find: explain *why*, in the language the file already uses (most are Chinese with English identifiers; English is fine).
- Function selectors and event topics are hard-coded in `kernel/src/selectors.js` and re-derived by the unit tests: if you add a call, add it to both `SIG` and `SEL`.
- Status pages and notice pages in the gateway must stay **script-free**; the bootstrap must stay free of external resources.
- Update `kernel/index.d.ts` when you change a public signature, and `README.md` when behaviour visible to site owners or kernel users changes.
- Update the test vectors in SPEC §14 and `kernel/test/mainnet.test.mjs` together if the sample site changes.

## Pull requests

1. One topic per pull request; describe what changes and why, and which tests you ran.
2. Commit messages: a short imperative summary line (`Fix range read past the last chunk`), a blank line, then details if needed.
3. Commits must be your own: no bot or co-author trailers.
4. Maintainers review; changes to verification, isolation or node agreement get a second look and, when significant, an audit before release.
5. By contributing you agree that your code is released under MIT and your text changes to `SPEC.md` under CC0 (see `LICENSE` and `LICENSE-SPEC`).

## Releases

Maintainers tag releases (`vX.Y.Z`). A release note lists specification changes, and, when the pinned implementation list changes, the old and new implementation addresses and where the audit report is (SPEC §15.2).

---

中文摘要：改规范先开 issue 或只改规范的 PR，§15.1 的承诺不动，中英文同步；涉及校验、隔离、节点核对的改动要写清理由并附会失败的测试。`npm install` 后先跑 `npm test`、`npm run test:types`、`npm run build:extension`；碰链上代码或网关再跑 `test:mainnet` 和 `test:e2e`。内核运行时零依赖、浏览器和 Node 都要能跑；新增合约调用要同时改 `SIG` 和 `SEL`；网关状态页不能有脚本。一个 PR 一件事，提交信息一行祈使句摘要，提交必须是本人、不带机器人或合作者署名。贡献即同意代码 MIT、规范文本 CC0。
