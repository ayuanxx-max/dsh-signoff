# 落印 / SignOff

> 中文名「落印」：印落纸面才算数，对应英文名 SignOff。曾用名「一诺过五关」「执印」。命令 `signoff`、包名 `dsh-signoff` 不变。

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
| 自查 | `signoff doctor [--json]` | 为什么没按预期生效：钩子、PATH、版本、安装点、账本、装钩子之后的缺失提交 |
| P5 反空话 | `signoff p5` | 文档里有没有空话、`绝对`化断言、无数字的`已验证` |

## 一张图看懂

![SignOff 完整能力与关系](https://raw.githubusercontent.com/ayuanxx-max/dsh-signoff/master/docs/diagrams/signoff-1-capability.png)

六个层次从左到右：**入口**（CLI / git 钩子 / CI / Agent 面）都走同一个 `guard.js`；**调度**决定跑哪几关、
谁算通过；**五关**每关都写清“读什么、判什么、怎么修”；**状态机**说明一次提交里 marker 与 trailer 是怎么产生的；
**产物**是判断留下的证据；最右是**外部依赖**——只有 Node ≥18 与 git 是硬要求，其余都可缺。
判定没有“部分通过”：退出码 0 通过、1 任一关判红、2 用法或环境错。

![用户路径：安装、使用、排错](https://raw.githubusercontent.com/ayuanxx-max/dsh-signoff/master/docs/diagrams/signoff-3-user.png)

上半部分按 0→5 的先后排：前置检查 → 安装 → 初始化 → 日常提交 → 红了怎么办 → 升级与卸载。
红框是必做，黄框是最容易踩的坑（`--chain`、`--lock-test`、npm proxy）。
下半部分三块是“不改你的流程、但会改变你看到的现象”：平台差异、环境差异，以及三条红线
（`--no-verify`、`SIGNOFF_SKIP=1`、调阈值让红变绿）。

两张图都由 Mermaid 生成，源文件在 [`docs/diagrams/src/`](docs/diagrams/src/)，改文案重渲一次即可，
不用重画。

## 零接触：装一次，之后不用管

目标是一条命令之后不再需要任何操作：`npm i -g dsh-signoff` 装完即生效，之后每次 `git commit` 都自动受五关约束。

| 层 | 什么时候发生 | 覆盖范围 |
| --- | --- | --- |
| 机器层 | `npm i -g` 的 postinstall 写 `core.hooksPath` → `~/.signoff/hooks` | 本机**所有**仓库，新克隆的也算 |
| 仓库层 | postinstall（在某个仓库里执行时）或 `signoff ensure` | 该仓库的 `.git/hooks`、`.signoff/config.json`、CI workflow、ledger |
| 关内 | 每次 commit | 已 opt-in 的仓库跑 P1–P5；未 opt-in 的仓库只跑 P1（测试必须过），不写任何状态 |

```bash
npm i -g dsh-signoff      # 一次；postinstall 自动装好机器层 + 当前仓库
signoff ensure            # 换个仓库想把五关都装上，跑这一条（幂等）
signoff ensure --global   # 只重装/修复机器层
signoff ensure --json     # 给脚本看的结构化结果
```

npm 11 会把 `postinstall` 放进 allowlist 提示，可能不执行——所以还有一层兜底：**在该仓库里第一次跑任何一关**（比如 `signoff p5 README.md`）会自动把五关装好。
要放行安装脚本就加 `npm i -g dsh-signoff --allow-scripts=dsh-signoff`。

行为约定：

- 已 opt-in（有 `.signoff/config.json`）：pre-commit 跑全套五关，PASS 才写 marker 和 trailer。
- 未 opt-in：只跑 P1（有测试才跑，没测试就明说"没检测到测试运行器"后放行），不写 `.signoff` 配置、不带 trailer。
- 仓库自带的钩子不会被绕过：机器层先执行 `.git/hooks/<stage>`，它若是 signoff 的钩子就直接以它的判决为准。
- 临时退出：`SIGNOFF_NO_BOOTSTRAP=1`（不做自动安装）、`SIGNOFF_NO_MACHINE=1`（不跑机器层的轻量关）。
- 撤销机器层：`signoff uninstall --global`。

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
signoff init --chain         # 已有钩子保留：存为 <name>.local，先跑它
signoff init --prepare       # 同时写进 package.json，队友 npm install 即装钩子
signoff status               # 这个仓库现在守不守？
signoff doctor               # 为什么没按预期生效（只读）
signoff doctor --fix         # 让它把能证明的修掉：重装缺失钩子、补执行位、清掉没暂存的标记
signoff guard --full         # 手动跑同一套（钩子调的就是它）
signoff audit --range origin/main..HEAD   # 这些提交真过过闸门吗？
signoff audit --since-install             # 只看装钩子之后的提交（安装点不在 HEAD 祖先里会直接拒绝）
signoff init --reset-install              # 历史被改写或换了克隆后，把安装点挪到当前 HEAD
signoff init --lock-test                  # 把识别到的测试命令写进配置，换机器不再漂移
signoff uninstall --all      # 卸掉钩子 + CI + 配置
signoff uninstall --keep-config  # 卸掉钩子 + CI + 运行时状态，保留配置与账本
signoff p4 export --merge ../other/.signoff/audit.log   # 多仓库合并成一张表
signoff p4 export --format json --out ledger.json       # 也可以导出 json / csv
signoff explain p2           # 这一关到底查什么、怎么判的
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

每关都会把结果写到 `.signoff/pN.json`（P4 的账本在仓库内 `.signoff/audit.log`，不在仓库里时退回 `~/.signoff/audit.log`；可用 `SIGNOFF_HOME` 改位置），便于 CI 存档与二次核对。

## 接入方式

- **CLI**（本体）：`npm i -g dsh-signoff`，任何能起进程的地方都能调，退出码即判决。
- **技能**：`integrations/skill/SKILL.md`，把“退出码是判决、不许绕过、先 doctor 再 explain”教给 agent。
- **MCP 服务器**：`npx -y dsh-signoff mcp`（或 `integrations/mcp/server.js`），给 Claude Desktop / DSH / IDE 用，五个工具，`isError` 跟随退出码；官方 MCP Registry 条目为 `io.github.ayuanxx-max/signoff`。
- **宿主插件**：可行但不推荐（只有要画 UI 时才值得），理由见 [docs/integrations.md](docs/integrations.md)。

推广与可发现性的现状和做法见 [docs/promotion.md](docs/promotion.md)。

## 六、边界（先说清不做什么）

- **只读不改**：五关不改你的代码，只在 `.signoff/`（P4 账本也在这里；非仓库目录才用 `~/.signoff/`）写结果。
- **P1 只看退出码**：不做交互、不猜意图；命令怎么写由你给。
- **P2 不生成断言**：断言要人写；它只负责数、分级、拦住“没到 scenario 级”的降级。
- **P4 是本机哈希链**，不是外部公证：能发现事后改账，不能防有人连链一起重写。要更强证据得接外部时间戳。
- **P5 是启发式**：词表可以按团队改（`--allow <rule>` 放行某条），它拦住的是“明显没数字的断言”，不是全部坏文档。
- **钩子按仓库各装一次**：`signoff init` 写在本机 `.git/hooks/`，别人 clone 不会自动有；CI 那条才是全员生效。
- **测试命令是“查出来的”，不是“猜出来的”**：按 `package.json` 的 `test` 脚本 → vitest/jest/mocha 依赖 → `Cargo.toml` → `go.mod` → `Makefile` 的 `test` → pytest → unittest 的顺序识别；`signoff init` / `status` / `doctor` 都会写出用的是哪一条、从哪认出来的。`tests/` 是空目录不算测试，不会让 p1 空跑一场报“没收集到用例”。
- **原有钩子不会被悄悄顶掉**：`signoff init` 默认把现有钩子备份成 `<name>.signoff-backup`（不串接）；加 `--chain` 则存成 `<name>.local`（Python/Node/PowerShell 钩子保留 `.py`/`.js`/`.ps1` 后缀，按后缀选解释器）并在我们的钩子里先执行——它失败就停，`signoff uninstall` 会把它原样装回 `<name>`。
- **账本可以跨仓库合并**：`signoff p4 export --merge <另一个仓库的 audit.log>` 会逐文件重算哈希链，链断了的那份会被标出来并以 1 退出——合并视图不会替坏链背书。
- **同一仓库同时只跑一次钩子**：`.signoff/lock` 是单实例锁（3.9.1 起是目录 + `owner.json`，用 `mkdir` 抢锁——`O_EXCL` 在 SMB/NFS 上可能两边都成功），第二个提交会拿到“谁在占用”并退 1；锁的持有进程已死或超过 10 分钟自动作废。`commit-msg` 不参与加锁——它不能把已经接受的提交再挡回去。
- **`doctor` 只读**：它从不安装、不改写、不删除，只把 `status` / `audit` / `p4 verify` 的结论摊开并给出修法；`ok` 判 0，有 `fail` 判 1，不在仓库里判 2。
- **安装点对不上就拒绝，不给出偏大的范围**：`audit --since-install` 先确认安装点是 HEAD 的祖先（`merge-base --is-ancestor`），rebase、强推、换克隆之后那条提交不在当前历史里，会退 2 并让你跑 `signoff init --reset-install`——审计结论不可信比审计报错更糟。
- **装钩子之前的历史不算账**：`signoff init` 把当时的提交记进 `.signoff/installed.json`，`signoff audit --since-install` 从那里起算；普通 `audit` 遇到装钩子之前的缺失提交，会多打一行 `N of M missing commit(s) predate the install point`，不用自己算范围。
- **钩子可绕过，但会留下证据**：`git commit --no-verify` 不触发钩子，提交里就没有 `Signoff-Pass` 标记，`signoff audit`（CI 自动跑）判红；`SIGNOFF_SKIP=1` 写 `Signoff-Skip` 并记进 `.signoff/skips.log`，`--strict` 下判红。
- **只需要 Node 18+**：闸门与钩子都是 Node；没有 Python、没有其它解释器也能跑完整五关。
- **不联网**：除 `git` 与本地解释器外不调用外部服务。

## English

### At a glance (English)

![SignOff capabilities and relations](https://raw.githubusercontent.com/ayuanxx-max/dsh-signoff/master/docs/diagrams/signoff-1-capability-en.png)

Six layers, left to right: **entry** (CLI / git hooks / CI / agents) all go through one `guard.js`; **dispatcher**
decides which gates run and what counts as pass; **the five gates** each state read → decide → fix; **the state
machine** shows how the marker and the trailer appear inside a single commit; **artifacts** are the evidence a
verdict leaves behind; **external dependencies** — only Node ≥18 and git are hard requirements.
There is no partial pass: exit 0 pass, 1 any gate red, 2 usage or environment error.

![User path: install, use, troubleshoot](https://raw.githubusercontent.com/ayuanxx-max/dsh-signoff/master/docs/diagrams/signoff-3-user-en.png)

Stages 0 → 5 in order: precheck → install → init → daily commits → when it goes red → upgrade and uninstall.
Red boxes are must-do; amber boxes are the places people trip on (`--chain` when the repo already has husky
hooks, `--lock-test` when the test command differs per machine, a corporate npm proxy).
The lower half covers the three dimensions that change what you see without changing the flow: platform
differences, environment differences, and three red lines (`--no-verify`, `SIGNOFF_SKIP=1`, loosening
thresholds to turn red green).


> "Done" is a promise. SignOff makes it walk through five gates before anyone signs it.

Five gates, five commands, the exit code is the verdict. Each gate maps to one way agent work goes wrong: tests run from memory, a dev page mistaken for verification, parallel workers colliding on the same file, risky actions nobody recorded, documents padded with empty words.

| Gate | Command | What it decides |
| --- | --- | --- |
| P1 verify | `signoff p1` | Did the checks actually run, inside the budget, with how many cases |
| P2 coverage | `signoff p2` | What level the verification reached: scenario / harness / smoke / missing |
| P3 queue | `signoff p3 validate\|plan\|collect` | Cards complete, waves collision-free, nobody out of scope or empty-handed |
| P4 ledger | `signoff p4 ask\|confirm\|verify\|export` | Did the risky action hold a ticket, is the rollback point still there |
| P5 anti-slop | `signoff p5` | Empty words, absolute claims, "verified" with no number |

### Zero-touch

One command, then nothing: `npm i -g dsh-signoff` writes a machine-wide `core.hooksPath`
(`~/.signoff/hooks`) and bootstraps the repo it is installed from.

| Layer | When | Scope |
| --- | --- | --- |
| machine | postinstall of the global install | every repo on this machine, including fresh clones |
| repo | postinstall inside a repo, or `signoff ensure` | `.git/hooks`, `.signoff/config.json`, CI workflow, ledger |
| gates | every commit | opted-in repos run all five; unopted repos run only P1 (tests), and write no state |

npm 11 may hold `postinstall` behind its script allowlist (`--allow-scripts=dsh-signoff` to allow it), so the
first gate command in a repo (`signoff p5 README.md`) installs the five gates as a fallback.

Exit hatches: `SIGNOFF_NO_BOOTSTRAP=1` (no auto install), `SIGNOFF_NO_MACHINE=1` (skip the light guard),
`signoff uninstall --global` (remove the machine layer). A repo's own hook always runs first and keeps its verdict.

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

- Read-only with respect to your code: results go to `.signoff/` (the P4 ledger included; `~/.signoff/` only outside a repo).
- P1 judges exit codes only.
- P2 counts and grades; it does not write assertions for you.
- P4 is a local hash chain, not external notarisation: it detects edits after the fact, and cannot stop someone rewriting the whole chain.
- P5 is heuristic; tune the word list with `--allow <rule>`.
- Hooks are installed per clone; a fresh clone needs `signoff init` again, while CI covers everyone.
- Hooks are bypassable, but not silently: `git commit --no-verify` leaves no `Signoff-Pass` marker, so `signoff audit` (run by CI) fails the range; `SIGNOFF_SKIP=1` leaves `Signoff-Skip` and is red under `--strict`.
- Needs Node 18+ only; no Python and no other interpreter is required.
- No network calls; only `git` and the local interpreters.

### Integrations

- **CLI** (the product): `npm i -g dsh-signoff`; anything that can spawn a process can run
  it, and the exit code is the verdict.
- **Skill**: `integrations/skill/SKILL.md` teaches an agent the three things it gets wrong:
  the exit code is the verdict, never bypass a red gate, and `doctor`/`explain` come before
  touching config.
- **MCP server**: `integrations/mcp/server.js` for Claude Desktop / DSH / IDEs — five tools,
  `isError` mirrors the exit code.
- **Host plugin**: possible but not recommended; it only pays off when gate results must be
  rendered in a host UI. Reasoning in [docs/integrations.md](docs/integrations.md).

Discovery and promotion notes: [docs/promotion.md](docs/promotion.md).

## License

MIT
