# 一诺过五关 / SignOff

> 签下的那句“做完了”，得自己走过五道关才算数。

五道关卡，五条命令，退出码即判决。每一关都对应 agent 交付时的一种失败方式：靠记忆跑测试、把“有开发页”当验证、多个 agent 撞同一文件、危险动作做过就忘、文档里塞空话。SignOff 把这五种失败变成五个可执行的检查。

```bash
npm i -g dsh-signoff      # 或 npx dsh-signoff
signoff p1                # 一关一关过
signoff all               # p1 + p2 + p5 + p4 verify
```

| 关 | 命令 | 判决什么 |
| --- | --- | --- |
| P1 验证 | `signoff p1` | 检查是否真的跑过、跑在预算内、用例数多少 |
| P2 覆盖 | `signoff p2` | 验证到了哪一级：scenario / harness / smoke / missing |
| P3 队列 | `signoff p3 validate\|plan\|collect` | 卡片是否齐、并发是否撞、谁越界谁没交 |
| P4 账本 | `signoff p4 ask\|confirm\|verify\|export` | 危险动作有没有票、回滚点是否还在 |
| P5 反空话 | `signoff p5` | 文档里有没有空话、`绝对`化断言、无数字的`已验证` |

## 一、案例：本次 DSH 2.0.22-next升级后在修复（dsh-session-fork-tree 0.9.34）bug里，五关各自做了什么？

这次修的是“升级 DSH 后，点侧栏「···」菜单，菜单闪一下就消失”。五关实际起了什么作用，逐条列出，包括没发挥作用的那一关。

| 关 | 本轮实际动作 | 证据 | 判定 |
| --- | --- | --- | --- |
| P1 | 手动跑 `precommit.ps1`；闸门第 10 层 pytest | `PASS 3666 ms`（101 用例）；第 10 层 `3438 ms` | 护栏有效；但它只跑工具自身的 Python 用例，**抓不到这次的前端问题**，也**没能自动拦提交**（插件目录是独立 git 仓库、没装钩子） |
| P2 | 三套真实 DOM 场景：`menu`(11) / `arrange`(13) / `perf`(6)；并把该包纳入覆盖率账本 | `coverage.py`：apps 4→5，scenario 5/5，断言 36→77 | **主力**。决定“修好没有”的是场景断言，不是肉眼；账本让这些断言不再是一次性证据 |
| P3 | 未使用：没写任务卡，没跑 `fanout.py` | 无 `card.json`、无 wave 记录 | **未发挥**。三件事有依赖顺序（修→测→说明引用实测数字），但这不等于可以不写卡留痕 |
| P4 | 事后审计抓到我自己填的假回滚点；补录发布记录 | `verify` 先 FAIL：`rollback point 'npm deprecate …' not a git ref`；修复后 `{"ok": true, "entries": 4, "problems": []}` | **事后有效，事前缺位**。`npm publish`、GitHub Release、改 profile 都是先做后记，没走取票 |
| P5 | 三份新文档过 slop 六规则；覆盖率表由工具重生成 | slop `{"ok": true, "files": 3, "hits": []}` | 有效；但把包登记进覆盖率是**发布之后**补的，说明里那组断言数当时还没进账本 |

一句话：**P2 决定“修好没有”，P5 决定“我有没有说大话”，P1 只证明没弄坏别处，P4 事后抓住了我自己的一笔脏账，P3 全程没上场。** 这个结论本身就是 SignOff 想要的输出：每一关都要能回答“发挥了没有”，不能只说“流程走过了”。

<h2 style="color:#c00000">你不需要做什么，照常进行任务，由它来守护这个过程；</h2>

## 二、自动守护：装一次，之后不用记

`signoff init` 把五关接进 git 与 CI，一次安装，之后正常 `git commit` / `git push` / 开 PR 都由它先查：

| 安装物 | 作用 |
| --- | --- |
| `.git/hooks/pre-commit` | 暂存区一变就跑闸门：文档改动 → P5；能探到测试命令 → P1；有 `verify/scenarios/` → P2 `--strict`；有账本 → P4 `verify`。红了直接拒绝提交 |
| `.git/hooks/pre-push` | push 前跑同一套（`--full`，不吃缓存） |
| `.git/hooks/commit-msg` | 把 `Signoff-Pass: <tree>`（跳过时 `Signoff-Skip:`）写进提交信息；`signoff audit` 与 CI 据此判断这次提交真的过过闸门 |
| `.github/workflows/signoff.yml` | 每个 push / PR 跑 `npx dsh-signoff guard --ci`，绕不过去 |
| `.signoff/config.json` | 测试命令、预算、文档目录；`signoff status` 随时查看 |
| `.gitignore` | 追加 `.signoff/`，结果不进版本库 |

只依赖 **Node 18+**：闸门本身是 Node 实现（`lib/p*.js`），没有 Python 也能跑完整五关，不存在降级模式。

三条稳定性措施：**同一份暂存内容只判一次**（命中缓存约 0 ms，反复 `git commit --amend` 不重复付时间）；**失败只打印失败那一关的尾部**（完整日志在 `.signoff/hook.log`）；**超预算直接判红**（默认 180 秒，`--budget` 可改）。

**绕过的路仍然有，但不再无痕**：`signoff audit --range origin/main..HEAD` 逐个提交核对标记与提交树——缺失就是绕过（`git commit --no-verify`），判红；`SIGNOFF_SKIP=1` 的提交写成 `Signoff-Skip:` 并记进 `.signoff/skips.log`，`--strict` 下同样判红。生成的 CI 里已经带这一步。

**队友为什么也会被守住**：先把 `dsh-signoff` 放进 `devDependencies`（`npm i -D dsh-signoff`），再 `signoff init --prepare`，它会把 `signoff init --quiet` 并进 `package.json` 的 `prepare`，队友 `npm install` 完钩子就有了。没这个依赖时 `--prepare` 会拒绝写入并提示——否则 `npm install` 会因为找不到 CLI 直接失败。

```bash
signoff init                 # 装钩子 + CI + 配置
signoff status               # 这个仓库现在守不守？
signoff guard --full         # 手动跑同一套（钩子调的就是它）
signoff uninstall --all
signoff audit --range origin/main..HEAD   # did these commits really pass the gates?
signoff init --prepare       # also write it into package.json so npm install installs the hooks      # 卸掉
signoff audit --range origin/main..HEAD   # 这些提交真过过闸门吗？
signoff init --prepare       # 同时写进 package.json，队友 install 即装
```

## 三、在其它代码过程里能干什么

| 场景 | 五关怎么用 |
| --- | --- |
| 新功能 | P3 先写卡（目标 / scope / 验收 / 回滚）→ P1 让检查命令化并进钩子 → P2 把验收写成场景断言 → P4 发版取票 → P5 文档只留能被数字支撑的句子 |
| 修 bug | P1 把复现命令固化（`--run` 可重复）→ P2 加一条“反向断言”（旧写法必须红）→ P3 多人并行时按 scope 分波 → P4 单点回滚 → P5 说明里每个数字能落到事实表 |
| 重构 | P3 的 scope 锁死可动范围，`collect` 抓越界改动；P2 用零写入 / DOM 恒等这类断言证明“行为没变” |
| CI 流水线 | `signoff all` 一条命令，退出码直接当 CI 判决；P1 的预算参数防止测试变慢却没人发现 |
| 多 agent 并行 | P3 `plan` 输出 wave（scope 相交的卡绝不同波），`collect` 抓“改了不该改的文件”和“交了空活”的卡 |
| 交接与复盘 | P2 的覆盖表 + P4 `export` 出的账本，接手的人先看这两张表，再看代码 |
| 合规留痕 | P4 哈希链：改过的记录会被 `verify` 判为 `content hash mismatch`，事后补账能被发现 |

## 四、在 DSH 任务里能干什么

- **发 npm / 改 profile / 改 cordis 配置**：P4 先 `ask` 取票（单次、10 分钟过期、绑定动作类别），再 `confirm` 落账，账里带回滚点；回滚点必须是真的 git ref，写一句“npm deprecate …”会被 `verify` 拒绝。
- **插件发版**：P1 跑三套真实 DOM fixture，P2 把结果记进覆盖率表，P5 保证发布说明里没有`绝对`化的收尾句。
- **长任务 / 跨天任务**：P3 的卡片就是断点续传的凭据——scope、验收、回滚点三样齐了，换会话也能接上。
- **多分叉并行**：不同分叉各拿一张卡，`plan` 先算出不会撞文件的波次，避免两个 agent 同时改同一处。
- **收尾**：P5 的六条规则让“完成”这句话可以被机器反驳：无数字的`已验证`、`TODO`、`绝对`化断言、AI 味词表（`赋能` / `闭环` / `抓手`…），命中即失败。
- **插件回归**：`verify/scenarios/*.json` 是 P2 的输入格式，把 fixture 的 checks 数量直接变成覆盖率数字，不需要另写报表。

## 五、命令速查

```bash
# 自动守护：装一次，之后不用记
signoff init
signoff status
signoff guard --full
signoff uninstall --all

# P1：跑检查；默认 tests/ 用 pytest，否则 npm test
signoff p1 --run "pytest -q" --run "npm run lint" --budget 120
signoff p1 --install-hook            # 写入 .git/hooks/pre-commit

# P2：覆盖分级 + 阈值
signoff p2 --strict --min-scenario 4 --min-assertions 60 --md docs/coverage.md

# P3：卡片校验 / 波次规划 / 收集核对
signoff p3 validate --cards tasks
signoff p3 plan --cards tasks
signoff p3 collect --changed src/a.py src/b.py

# P4：取票 → 消费 → 校验 → 导出
signoff p4 ask --action publish --target "demo@1.2.0"
signoff p4 confirm --ticket 1a2b3c4d --decision allow --detail "npm publish" --rollback v1.2.0
signoff p4 verify
signoff p4 export --out docs/ledger.md

# P5：反空话
signoff p5 docs README.md
```

每关都会把结果写到 `.signoff/pN.json`（P4 的账本在 `~/.signoff/audit.log`，可用 `SIGNOFF_HOME` 改位置），便于 CI 存档与二次核对。

## 六、边界（先说清不做什么）

- **只读不改**：五关不改你的代码，只在 `.signoff/` 与 `~/.signoff/` 写结果。
- **P1 只看退出码**：不做交互、不猜意图；命令怎么写由你给。
- **P2 不生成断言**：断言要人写；它只负责数、分级、拦住“没到 scenario 级”的降级。
- **P4 是本机哈希链**，不是外部公证：能发现事后改账，不能防有人连链一起重写。要更强证据得接外部时间戳。
- **P5 是启发式**：词表可以按团队改（`--allow <rule>` 放行某条），它拦住的是“明显没数字的断言”，不是全部坏文档。
- **钩子按仓库各装一次**：`signoff init` 写在本机 `.git/hooks/`，别人 clone 不会自动有；CI 那条才是全员生效。
- **钩子可绕过，但会留下证据**：`git commit --no-verify` 不触发钩子，提交里就没有 `Signoff-Pass` 标记，`signoff audit`（CI 自动跑）判红；`SIGNOFF_SKIP=1` 写 `Signoff-Skip` 并记进 `.signoff/skips.log`，`--strict` 下判红。
- **只需要 Node 18+**：闸门与钩子都是 Node；没有 Python、没有其它解释器也能跑完整五关。
- **不联网**：除 `git` 与本地解释器外不调用外部服务。

## English

> "Done" is a promise. SignOff makes it walk through five gates before anyone signs it.

Five gates, five commands, the exit code is the verdict. Each gate maps to one way agent work goes wrong: tests run from memory, a dev page mistaken for verification, parallel workers colliding on the same file, risky actions nobody recorded, documents padded with empty words.

| Gate | Command | What it decides |
| --- | --- | --- |
| P1 verify | `signoff p1` | Did the checks actually run, inside the budget, with how many cases |
| P2 coverage | `signoff p2` | What level the verification reached: scenario / harness / smoke / missing |
| P3 queue | `signoff p3 validate\|plan\|collect` | Cards complete, waves collision-free, nobody out of scope or empty-handed |
| P4 ledger | `signoff p4 ask\|confirm\|verify\|export` | Did the risky action hold a ticket, is the rollback point still there |
| P5 anti-slop | `signoff p5` | Empty words, absolute claims, "verified" with no number |

### Case: what the five gates did in the 0.9.34 bug fix after the DSH 2.0.22-next upgrade

| Gate | Action in this fix | Evidence | Verdict |
| --- | --- | --- | --- |
| P1 | Ran `precommit.ps1` by hand; gate layer 10 ran pytest | `PASS 3666 ms` (101 cases); layer 10 `3438 ms` | Guard worked, but it only covers the tooling's own Python tests: it could not see the front-end bug, and it did not gate the commit automatically (the plugin directory is its own git repo without the hook) |
| P2 | Three real-DOM scenarios: `menu`(11) / `arrange`(13) / `perf`(6), and registered the package in the coverage ledger | `coverage.py`: apps 4→5, scenario 5/5, assertions 36→77 | **The main work.** Scenario assertions decided "fixed or not"; the ledger keeps them from being one-off evidence |
| P3 | Not used: no task cards, no wave plan | no `card.json`, no wave record | **Did not contribute.** The three asks were sequential, which is not a reason to skip the paper trail |
| P4 | Post-hoc audit caught a fake rollback point I wrote; the publish was then recorded properly | `verify` first failed with `rollback point 'npm deprecate …' is not a git ref`; after repair `{"ok": true, "entries": 4, "problems": []}` | **Effective after the fact, absent before it**: publish, release and profile edits ran before any ticket |
| P5 | Three new documents through the six slop rules; coverage table regenerated by the tool | slop `{"ok": true, "files": 3, "hits": []}` | Worked, but registering the package in coverage happened after the release, so the assertion counts in the notes were not in the ledger yet |

One line: **P2 decides whether it is fixed, P5 decides whether I am overclaiming, P1 only proves nothing else broke, P4 caught my own dirty entry after the fact, P3 never left the bench.**

<h2 style="color:#c00000">You do not have to do anything differently — just carry on with your task, and it guards the process.</h2>

### Auto-guard: install once, then it runs itself

`signoff init` wires the gates into git and CI, so an ordinary `git commit`, `git push` or pull request is checked first:

| Installed | What it does |
| --- | --- |
| `.git/hooks/pre-commit` | On a change to the index: docs → P5; detectable test command → P1; `verify/scenarios/` → P2 `--strict`; existing ledger → P4 `verify`. A red gate refuses the commit |
| `.git/hooks/pre-push` | The same set before a push, `--full`, no cache |
| `.git/hooks/commit-msg` | Writes `Signoff-Pass: <tree>` (or `Signoff-Skip:`) into the message; `signoff audit` and CI use it to tell a gated commit from a bypass |
| `.github/workflows/signoff.yml` | Every push / PR runs `npx dsh-signoff guard --ci`; not bypassable |
| `.signoff/config.json` | Test command, budget, doc roots; `signoff status` shows all of it |
| `.gitignore` | `.signoff/` is appended, so results stay out of the repo |

Requires **Node 18+ only**: the gates are pure Node (`lib/p*.js`), so no Python is needed and there is no degraded mode.

Three stability measures: the same staged tree is judged once (cache hit ~0 ms, so `git commit --amend` costs nothing); a failure prints only the tail of the failing gate (full log in `.signoff/hook.log`); exceeding the budget (default 180 s) is a red gate, not a silent twenty-minute hook.

**A bypass leaves a trace**: `signoff audit --range origin/main..HEAD` checks every commit's marker against its tree. Missing means the gates were skipped (`git commit --no-verify`) and is red; a `SIGNOFF_SKIP=1` commit carries `Signoff-Skip` and turns red under `--strict`. The generated CI already runs this step.

**Why a teammate ends up guarded too**: with `dsh-signoff` in `devDependencies` (`npm i -D dsh-signoff`), `signoff init --prepare` appends `signoff init --quiet` to `package.json`'s `prepare`, so their `npm install` installs the hooks; without it, CI is the backstop.

### Beyond this fix: other code work

- **New feature**: card first (P3: goal / scope / acceptance / rollback), then a failing check wired into the hook (P1), then scenario assertions (P2), then a publish ticket (P4), then prose that every number supports (P5).
- **Bug fix**: freeze the reproduction as a command (P1 `--run`), add a reverse assertion that must go red on the old code (P2), split parallel work into waves (P3), keep one rollback point (P4), and publish only numbers (P5).
- **Refactor**: scope bounds what may change and `collect` flags out-of-scope edits (P3); zero-write and DOM-identity assertions prove behaviour did not move (P2).
- **CI**: `signoff all` is one command whose exit code is the verdict; `--budget` catches a suite that quietly got slower.
- **Multi-agent**: `plan` emits waves where overlapping scopes never share a wave; `collect` reports both "changed a file nobody owns" and "card shipped nothing".
- **Handover**: the coverage table (P2) plus the exported ledger (P4) are the first two things a new owner should read.

### In DSH tasks

- **npm publish, profile edits, cordis config changes**: P4 `ask` mints a single-use ticket (10 minute TTL, bound to the action category); `confirm` appends a hash-chained entry with a rollback point that must be a real git ref.
- **Plugin releases**: P1 runs the real-DOM fixtures, P2 records them in the coverage ledger, P5 keeps the release notes free of absolute claims.
- **Long or multi-day tasks**: a card with scope, acceptance and rollback is the resume token - a new session can pick it up.
- **Parallel forks**: each fork takes a card; `plan` computes waves that cannot collide.
- **Closing**: P5's six rules make "done" falsifiable by a machine: a numberless "verified", a `TODO`, an absolute claim, or a banned buzzword fail the run.
- **Plugin regression**: `verify/scenarios/*.json` is P2's input, so fixture check counts become coverage numbers with no extra reporting.

### Usage

```bash
# auto-guard: install once
signoff init
signoff status
signoff guard --full
signoff uninstall --all

signoff p1 --run "pytest -q" --budget 120
signoff p1 --install-hook
signoff p2 --strict --min-scenario 4 --min-assertions 60 --md docs/coverage.md
signoff p3 validate --cards tasks
signoff p3 plan --cards tasks
signoff p3 collect --changed src/a.py
signoff p4 ask --action publish --target "demo@1.2.0"
signoff p4 confirm --ticket 1a2b3c4d --decision allow --rollback v1.2.0
signoff p4 verify
signoff p5 docs README.md
```

### Boundaries

- Read-only with respect to your code: results go to `.signoff/` and `~/.signoff/`.
- P1 judges exit codes only.
- P2 counts and grades; it does not write assertions for you.
- P4 is a local hash chain, not external notarisation: it detects edits after the fact, and cannot stop someone rewriting the whole chain.
- P5 is heuristic; tune the word list with `--allow <rule>`.
- Hooks are installed per clone; a fresh clone needs `signoff init` again, while CI covers everyone.
- Hooks are bypassable, but not silently: `git commit --no-verify` leaves no `Signoff-Pass` marker, so `signoff audit` (run by CI) fails the range; `SIGNOFF_SKIP=1` leaves `Signoff-Skip` and is red under `--strict`.
- Needs Node 18+ only; no Python and no other interpreter is required.
- No network calls; only `git` and the local interpreters.

## License

MIT
