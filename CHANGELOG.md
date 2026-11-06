# Changelog

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
