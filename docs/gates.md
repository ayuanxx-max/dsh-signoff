# Gates — SignOff / 落印

> English: [gates.en.md](gates.en.md)

每关一条命令，结果写 `.signoff/pN.json`，退出码 0 通过、1 失败、2 用法或前置条件问题。

## P1 `gates/p1_verify.py`

| 参数 | 含义 |
| --- | --- |
| `--run CMD`（可重复） | 要执行的命令；缺省：有 `tests/` 用 `python -m pytest tests -q`，否则 `npm test --silent` |
| `--budget SEC` | 全部命令合计预算，默认 180 秒 |
| `--install-hook` | 写 `.git/hooks/pre-commit`，内容为 `exec signoff p1` |
| `--json` / `--quiet` | 机器可读输出 / 只报错 |

输出：`{"gate":"p1","ok":true,"elapsedMs":39,"budgetMs":180000,"cases":3,...}`。用例数从 `N passed` / `N tests` / `N checks` / `N assertions` 里取最大值。

## P2 `gates/p2_coverage.py`

扫描根目录与 `packages/`、`apps/` 下带 `package.json` 或 `verify/` 的目录。级别：

- `scenario`：`verify/scenarios/*.json` 全部可解析且至少一个 `checks` 数组；
- `harness`：只有 `verify/` 下的页面；
- `smoke`：只有 `package.json`；
- `missing`：都没有。

| 参数 | 含义 |
| --- | --- |
| `--strict` | 任一目录没到 `scenario` 即失败 |
| `--min-scenario N` / `--min-assertions N` | 阈值 |
| `--md FILE` | 写 Markdown 覆盖表 |

## P3 `gates/p3_queue.py`

卡片默认在 `tasks/<id>/card.json`：

```json
{"id":"t1","goal":"修菜单","scope":["dsh-session-fork-tree/client.js"],"acceptance":["menu 11/11"],"rollback":"v0.9.34"}
```

| 子命令 | 行为 |
| --- | --- |
| `validate` | 五个字段齐全、id 不重复、scope 为字符串数组 |
| `plan` | scope 前缀或通配相交的卡不同波，输出 wave 列表 |
| `collect --changed FILES` | 每个改动文件必须被某张卡认领；同时列出“改了却没交东西”的卡 |

## P4 `gates/p4_ledger.py`

动作类别固定为 `config` / `profile` / `publish`，账本按仓库隔离：仓库内 `.signoff/audit.log`（非仓库目录退回 `~/.signoff/audit.log`，`SIGNOFF_HOME` 可强制指定）。每条记录带 `repo` 字段，`verify` 只校验本仓库的回滚点。

| 子命令 | 行为 |
| --- | --- |
| `ask --action --target [--ttl]` | 发票据，单次使用，默认 600 秒过期 |
| `confirm --ticket --decision allow\|deny [--detail] [--rollback]` | 消费票据并追加哈希链条目；`deny` 也记账，退出码 1 |
| `verify` | 复算链（`prev` + 内容哈希），并校验回滚点是存在的 git ref；自由文本回滚点判失败 |
| `export --out FILE [--format {md,json,csv}]` | 导出账本；md 是表格，json 是记录数组，csv 是一行一条 |

条目形如 `{"ts":...,"action":"publish","target":"x@1.0.0","detail":"...","rollback":"v1.0.0","decision":"allow","prev":"<sha256>","hash":"<sha256>"}`。

## P5 `gates/p5_slop.py`

六条规则：`placeholder`（未完成的占位标记：`TODO`、`TBD`、`FIXME`、`待补`、`待定`）、`ai-word`（`赋能`/`闭环`/`抓手`/`颗粒度`/`全链路`…）、`absolute-claim`（`100%`/`零缺陷`/`永不`/`绝对`/`完美`/`彻底`/`极致`/`无缝`）、`empty-adverbs`（一行两个及以上空副词）、`claim-without-number`（`已验证`/`已覆盖`/`全部通过`/`全绿` 所在行没有数字）、缺回滚（仅 P4 使用）。

跳过 fenced code 与以 `|` 开头的表格行，避免把示例当空话。`--allow <rule>` 可放行某条规则。

## 自动守护（2.0.0）

`signoff init` 之后，`pre-commit` / `pre-push` / CI 都会调 `signoff guard`：

| 场景 | 实际跑的关 |
| --- | --- |
| 暂存的文档（README、docs/ 下） | P5 |
| 能探到测试命令（package.json 的 test，或 pytest） | P1 |
| 存在 `verify/scenarios/` | P2 `--strict` |
| 存在账本（仓库内 `.signoff/audit.log` 或 `~/.signoff/audit.log`） | P4 `verify` |

缓存文件 `.signoff/cache.json` 以 `git write-tree` 的结果为键：同一份暂存内容重复提交只判一次。
`SIGNOFF_SKIP=1` 跳过并写 `.signoff/skips.log`；`git commit --no-verify` 是 git 自身口子，无记录，因此 CI 是不可绕过的边界。

> 自检记录（2026-11-06）：装好 `signoff init` 后，本条修正在 `pre-commit` 里跑过 P1（30 用例）与 P5（3 份文档 0 命中）。

## 运行环境（3.0.0 起）

## 审计边界

`audit --since-install` 先确认安装点是 HEAD 的祖先；rebase、强推、换克隆后对不上会退 2，用 `signoff init --reset-install` 把边界挪到当前 HEAD。

五关与守卫都是 Node 实现（`lib/p1..p5.js`、`lib/guard.js`），只需要 Node 18+；不再依赖 Python，也没有降级模式。`gates/*.py` 仅作为对拍参考（`npm run parity`）。
