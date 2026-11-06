# Changelog

## 3.1.2 — 2026-11-06

- `pre-push` 不再写 `.signoff/passed`：标记是 `pre-commit` 交给 `commit-msg` 的一次性凭据，push 时留下会让仓库里多一个与提交无关的残片。
- 自查补 1 项（pre-push 不留标记），共 91 项全绿。

## 3.1.1 — 2026-11-06

- 提交标记改为严格一次性：`commit-msg` 无论标记是否匹配当前树都会消费掉它，`pre-commit` 写新标记前先清旧的。原来“树变了”的标记会留在 `.signoff/passed`，下一次同树提交可能重复追加 trailer。
- 自查补 3 项（无标记、陈旧标记、陈旧标记被消费），共 89 项全绿。

## 3.1.0 — 2026-11-06

- 新增 `commit-msg` 钩子与提交标记：闸门通过后在提交信息里写 `Signoff-Pass: <tree>`，`SIGNOFF_SKIP=1` 时写 `Signoff-Skip:`——`git commit --no-verify` 从此不再是“无记录”，而是“没有标记的提交”。
- 新增 `signoff audit [--range A..B] [--json] [--strict]`：逐个提交核对标记与提交树是否一致；缺失判红，`--strict` 时“有记录的跳过”也判红；合并提交跳过并计数。生成的 CI 工作流自带这一步。
- `signoff init` 升级：安装第三个钩子、新增 `--quiet` 与 `--prepare`（把 `signoff init --quiet` 并入 `package.json` 的 `prepare`，队友 `npm install` 后自动装钩子，幂等）；`status` 显示 `commit-msg` 与 `trailer` 状态。
- 自查 81 项（原 30 项 + 标记/审计/prepare/真实提交用例），Python 对拍仍 30/30。

## 3.0.0 — 2026-11-06

- 五关与自动守护全部改为纯 Node 实现（`lib/p1..p5.js`、`lib/guard.js`），**不再需要 Python**：`npm i -g dsh-signoff` 之后任何有 Node 18+ 的机器都能跑完整 P1–P5，没有降级模式、没有缺失的关。
- 与 Python 参考实现逐字节对拍：P1 43 例、P2 126 例、P3、P4 29 例（含真账本 7 条与混合引擎链）、P5 26 例；`npm test` 跑 Node 版 30 项自查，`npm run parity` 保留 Python 对拍。
- 自动守护同步改为 Node：钩子仍调 `signoff hook <stage>`，内部用 `node bin/signoff.js` 跑闸门；测试命令优先取 `package.json` 的 test，只在解释器可用时才探测 pytest。
- 修 Windows 上 `windowsHide` 导致 `cmd.exe` 输出 GBK 乱码、与 Python 不一致的问题。

## 2.0.2 — 2026-11-06

- CI 模式（`signoff guard --ci`）不再只看暂存区：改为对 `.signoff/config.json` 里声明的全部文档跑 P5，再跑 P1 与（有场景 fixture 时的）P2、P4。钩子模式仍只看本次暂存改动。
- 自查 30/30。

## 2.0.1 — 2026-11-06

- 修复：`guard --full`（pre-push 用的就是它）此前会强制跑 P2 `--strict`，导致没有 `verify/scenarios/` 的仓库（例如本项目）在 push 时被误判为覆盖不足。现在 P2 只在仓库确实有场景 fixture（或配置里声明了 `apps`）时才参与。
- 自查 30/30，行为其余不变。

## 2.0.0 — 2026-11-06

- 新增自动守护：`signoff init` 一次安装，写入 `.git/hooks/pre-commit`、`.git/hooks/pre-push`、`.github/workflows/signoff.yml`、`.signoff/config.json`，并把 `.signoff/` 加进 `.gitignore`。
- 新增 `signoff guard`（钩子与 CI 实际调用的入口）、`signoff status`、`signoff uninstall`；`signoff doctor` 增加 guard 一行。
- 稳定性：同一暂存树只判一次（缓存命中约 0 ms）；失败只打印失败关的尾部，完整日志在 `.signoff/hook.log`；超预算判红；CLI 缺失判红；`SIGNOFF_SKIP=1` 跳过并记入 `.signoff/skips.log`。
- 自查 30/30（原 17 项 + 13 项 guard 用例：安装、缓存、失败阻断、跳过留痕、卸载、dry-run）。
- 只新增能力，五关的判定逻辑未变。

## 1.0.4 — 2026-11-06

- 承诺句改为与 P1–P5 实际边界一致的表述：「你照常干活；它不替你判断对错，只把“做完了”变成能核对的东西。」中英同步。
- 只改文档，五个 gate 与 CLI 行为未变；自测仍 17 passed / 0 failed。

## 1.0.3 — 2026-11-06

- 承诺句改为 HTML 二级标题（与「一、案例」同级大小）并带红色内联样式，中英同步。
- 只改文档，五个 gate 与 CLI 行为未变；自测仍 17 passed / 0 failed。

## 1.0.2 — 2026-11-06

- 承诺句改回纯文字（加粗、左对齐、正文大小），中英同步；移除 PNG 图片与 docs/assets/。
- 只改文档，五个 gate 与 CLI 行为未变；自测仍 17 passed / 0 failed。

## 1.0.1 — 2026-11-06

- README 第一节改为案例式标题：本次 DSH 2.0.22-next 升级后修复 dsh-session-fork-tree 0.9.34 的 bug 里五关各自做了什么（中英同步）。
- 第一节末尾新增红色加粗承诺句（PNG，18 px 左对齐）：而你不需要做什么，照常进行任务，由它来守护这个过程；英文同款。
- 只改文档与图片，五个 gate 与 CLI 行为未变；自测仍 17 passed / 0 failed。

## 1.0.0 — 2026-11-06

- 首个发布版本：五道关各一条命令，退出码即判决。
- P1 `p1_verify.py`：跑项目的检查命令（可重复 `--run`），计时、解析用例数、写 `.signoff/p1.json`；`--install-hook` 写 git pre-commit 钩子。
- P2 `p2_coverage.py`：扫 `verify/scenarios/*.json`，四级分类（scenario / harness / smoke / missing），统计断言数，支持 `--strict`、`--min-scenario`、`--min-assertions`、`--md`。
- P3 `p3_queue.py`：任务卡校验（id / goal / scope / acceptance / rollback）、scope 冲突分波、`collect` 抓越界改动与空卡。
- P4 `p4_ledger.py`：单次取票（10 分钟过期）→ 消费 → 哈希链记账 → `verify` 复算链并校验回滚点必须是真实 git ref；`export` 出 Markdown 账本。
- P5 `p5_slop.py`：六条规则（`placeholder` / AI 味词表 / `绝对`化断言 / 空副词 / 无数字的`已验证` / 缺回滚），跳过代码块与表格行。
- 自测 `test/selftest.py`：在临时仓库里跑五关，17 条断言全覆盖（含篡改检测、假回滚点拒绝、票单次使用）。
- 兼容 Node 18+ 与 Python 3.9+；Windows 控制台输出全 ASCII，避免 GBK 乱码把 PASS 显示成乱码。
