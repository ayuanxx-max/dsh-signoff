# Changelog

## 1.0.0 — 2026-11-06

- 首个发布版本：五道关各一条命令，退出码即判决。
- P1 `p1_verify.py`：跑项目的检查命令（可重复 `--run`），计时、解析用例数、写 `.signoff/p1.json`；`--install-hook` 写 git pre-commit 钩子。
- P2 `p2_coverage.py`：扫 `verify/scenarios/*.json`，四级分类（scenario / harness / smoke / missing），统计断言数，支持 `--strict`、`--min-scenario`、`--min-assertions`、`--md`。
- P3 `p3_queue.py`：任务卡校验（id / goal / scope / acceptance / rollback）、scope 冲突分波、`collect` 抓越界改动与空卡。
- P4 `p4_ledger.py`：单次取票（10 分钟过期）→ 消费 → 哈希链记账 → `verify` 复算链并校验回滚点必须是真实 git ref；`export` 出 Markdown 账本。
- P5 `p5_slop.py`：六条规则（`placeholder` / AI 味词表 / `绝对`化断言 / 空副词 / 无数字的`已验证` / 缺回滚），跳过代码块与表格行。
- 自测 `test/selftest.py`：在临时仓库里跑五关，17 条断言全覆盖（含篡改检测、假回滚点拒绝、票单次使用）。
- 兼容 Node 18+ 与 Python 3.9+；Windows 控制台输出全 ASCII，避免 GBK 乱码把 PASS 显示成乱码。
