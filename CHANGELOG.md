## 3.10.0（2026-11-07）

**零接触安装**：`npm i -g dsh-signoff` 之后不再需要 `signoff init`。

- 新增 `signoff ensure [--global] [--json] [--quiet]`：幂等安装，仓库层 + 机器层。
- 新增 `lib/bootstrap.js`：机器层用 `core.hooksPath` 指向 `~/.signoff/hooks`，本机所有仓库（含新克隆）
  下一次 commit 就受约束；派发脚本先执行仓库自带的 `.git/hooks/<stage>`，判决仍归仓库。
- `package.json` 增加 `postinstall`：全局安装时自动装机器层，在仓库内安装时顺便把该仓库五关装好；
  postinstall 永不失败（失败也 exit 0，不会弄坏别人的 npm install）。
- 未 opt-in 的仓库只跑 P1（测试），不写 `.signoff/config.json`、不写 marker、不带 trailer：
  机器层不会把「没同意过 P2–P5 规矩」的仓库拦在门外。
- 两个逃生阀：`SIGNOFF_NO_BOOTSTRAP=1`、`SIGNOFF_NO_MACHINE=1`；撤销机器层用 `signoff uninstall --global`。
- 测试：新增 ensure / 机器层 / 轻量关 的用例（`npm test` 177 passed）。

## 3.9.8（2026-11-07）

- 文档：英文版两张图（能力图、用户路径图）从中文段落移到 `## English` 段内，英文读者按自己的语言路径阅读，
  不再需要先翻过中文内容。
- 版本号同步：`package.json` / `server.json` 3.9.8。

## 3.9.7（2026-11-07）

- 图表：三张框架图补齐**英文版**（`signoff-1-capability-en` / `signoff-2-market-en` / `signoff-3-user-en`），
  与中文版同结构、同配色、同源目录，`diagram.py` 一次渲染六张。
- 文档：README 增补 `### At a glance (English)`，英文读者不必先读中文；`docs/diagrams/README.md`
  列出中英对照表。
- 一致性：中文图 1 标题版本号同步到 3.9.7。

## 3.9.6（2026-11-07）

- 与 3.9.5 内容相同：3.9.5 因 npm 侧 staged 占用未能公开，改以 3.9.6 发布。

## 3.9.5（2026-11-07）

- 文档：README 顶部新增「一张图看懂」，用 Mermaid 生成的能力全景图与用户路径图解释五关、边界与已知坑。
- 图表：三张图全部改为 Mermaid 源文件（`docs/diagrams/src/*.mmd`），可 diff、可重渲；旧的 HTML 拼版已移除。
- 一致性：图里的判定标准与 `docs/diagrams/README.md`、`signoff explain p1..p5` 的文案同源，避免图文漂移。

# Changelog

## 3.9.4 — 2026-11-06

- `package.json` 增加 `mcpName: io.github.ayuanxx-max/signoff`：官方 MCP Registry 会校验已发布包的
  这个字段，缺失时拒绝发布（`NPM package 'dsh-signoff' is missing required 'mcpName' field`）。
- `server.json` 与包版本同步到 3.9.4。
- 自查 164 项、Python 对等 30 项全过。

## 3.9.3 — 2026-11-06

- 新增 `signoff mcp`：一条命令把五关挂到 stdio MCP 上，`npx -y dsh-signoff mcp` 即可被任何 MCP 客户端调用。
- 新增 `server.json`（官方 MCP Registry 清单）与 `smithery.yaml`（Smithery 配置），registry 名称 `io.github.ayuanxx-max/signoff`。
- `signoff explain` 与 MCP 工具描述同步指向同一套判定说明。
- 自查 164 项、Python 对等 30 项全过。

## 3.9.2 — 2026-11-06

- 新增 `signoff explain p1..p5`（`--json`）：每关查什么、怎么判、怎么修，答案与代码放在一起。
- 新增 `integrations/skill/SKILL.md`：给 agent 的技能说明书，只写模型容易做错的三件事（退出码是判决、不许绕过红关、先 doctor 再 explain）。
- 新增 `integrations/mcp/server.js`：零依赖 stdio MCP 服务器，五个工具（run/status/doctor/audit/explain），`isError` 跟随退出码；`initialize` / `tools/list` / `tools/call` 已实测。
- 新增 `docs/integrations.md`（四种形态对比，含“为什么不做宿主插件”）与 `docs/promotion.md`（GitHub 可发现性、清单收录、度量）。
- README 增加接入方式（中英两版）。
- 自查 164 项、Python 对等 30 项全过。

## 3.9.1 — 2026-11-06

- 修 `audit --since-install` 会在安装点不是 HEAD 祖先时静默给出偏大范围：现在先 `git cat-file -e <sha>^{commit}` + `git merge-base --is-ancestor`，对不上退 2 并说明原因（rebase / 强推 / 换了克隆），提示改用 `signoff init --reset-install` 或 `--range`。审计结论不可信比审计报错更糟。
- 新增 `signoff init --reset-install`：把安装点重写为当前 HEAD（历史被改写后唯一的正确修法）。
- 新增 `signoff init --lock-test`：把识别到的测试命令写进 `test_cmd`，换机器不再从 vitest 漂到 pytest。
- 钩子锁从 `open(..., "wx")` 改为 `mkdir` + `owner.json`：`mkdir` 在 SMB/NFS 上仍是原子的，`O_EXCL` 不是；3.9.0 写的文件形状继续被识别，旧锁不会卡住新版本。
- 自查 164 项、Python 对等 30 项全过。

## 3.9.0 — 2026-11-06

- 修 `--chain` 在 Windows 上跑不了非 shell 钩子：串接文件保留 `.py`/`.js`/`.ps1`/`.cmd` 后缀，生成的钩子按后缀用 `python`/`node`/`powershell`/`cmd` 启动，`.local` 仍排第一（3.9.0 之前装的仓库不受影响）；`uninstall` 按同一顺序找回并还原。
- 新增 `signoff p4 export --format {md,json,csv}`（默认 md）：json 是记录数组，csv 是带表头的一行一条。
- 新增 `signoff doctor --fix`：重装缺失或被占的钩子、给 POSIX 钩子补执行位、删掉“什么都没暂存却留着”的 `.signoff/passed`；修完重新体检再出报告，没有可修的会明说。
- 自查 157 项、Python 对等 30 项全过。

## 3.8.0 — 2026-11-06

- 新增 `docs/gates.en.md`：与 `docs/gates.md` 一一对应的英文版（五关参数、P1 识别顺序、P4 `--merge`、钩子锁、运行时），两份互加链接；顺手修掉 gates.md 标题里的旧名「执印」。
- 新增钩子单实例锁 `.signoff/lock`：同一个仓库并发提交时，第二个 `pre-commit` / `pre-push` 退 1 并报出持有者 pid、阶段、时间；持有进程已死或锁超过 10 分钟自动作废；`SIGNOFF_LOCK_WAIT_MS` 可调等待（默认 8000 ms）。`commit-msg` 不加锁，它不能把 git 已接受的提交再挡回去。
- 自查 147 项、Python 对等 30 项全过。

## 3.7.0 — 2026-11-06

- 新增 `lib/detect.js`：P1 的测试命令改成“识别 + 说明来源”，顺序为 `package.json` 的 `test` 脚本 → vitest / jest / mocha 依赖 → `Cargo.toml` → `go.mod` → `Makefile` 的 `test` 目标 → pytest → unittest。`init` / `status` 打印 `<命令>  (<来源>)`，`doctor` 多一条 `test-runner` 检查。
- 修：空 `tests/` 目录不再被当成测试套件（以前会让 p1 空跑一场、pytest 退 5 报“没收集到用例”）。目录里没有 `.py` 文件就不算。
- 新增 `signoff p4 export --merge OTHER...`：把别的仓库的 `audit.log` 合并成一张带 `repo` 列的表；每份都独立重算哈希链，链断的会警告并以 1 退出。
- 新增 `signoff uninstall --keep-config`：卸钩子 + CI，并清掉 `passed` / `cache.json` / `installed.json` 这些运行时状态，保留配置与账本。默认 `uninstall` 也开始清 `passed` 标记（以前会留一个让 `status` 看着像已安装）。
- 自查 143 项、Python 对等 30 项全过。

## 3.6.0 — 2026-11-06

- 新增 `signoff init --chain`：仓库已有钩子时不再只备份，而是存成 `<name>.local` 并在我们的钩子里**先执行**；它失败就停，`signoff uninstall` 把它原样装回 `<name>`。默认行为不变（`<name>.signoff-backup`，不串接）。
- 修：生成的 CI 工作流在浅克隆下会红。`git rev-parse HEAD~1` 找不到对象时会把名字原样打印到 stdout，导致 `audit --range "HEAD~1..HEAD"` 解析失败退 2。现在工作流 `fetch-depth: 0`、用 `git cat-file -e "$BASE^{commit}"` 判断、必要时 `--unshallow`，取不到就打印跳过。
- 修：`signoff --version` / `-v` 之前落到“未知命令”退 2；现在打印版本退 0。HELP 里的旧名「一诺过五关」改回「落印」。
- 新增 `.github/workflows/ci.yml`：node 18/20/22 × ubuntu/macos/windows 矩阵跑 `node test/selftest.js`，另一个 job 跑 python 对等，再一个 job 做 `npm pack` + 全局安装 + `init`/`commit`/`audit --since-install`/`doctor` 冒烟。
- 自查 126 项（新增 `--version`、HELP 名字、CI 取全历史、CI 取已验证 rev、串接 8 项）全过，Python 对等 30 项全过。

## 3.5.1 — 2026-11-06

- 修：重复 `signoff init` 时把 `.signoff/installed.json` 里的 `version` 更新成当前钩子版本（`sha`/`ts` 仍保留第一次安装点）。否则 `doctor` 每次升级后都会报一条永久的 `install-version` 警告——那正是 doctor 要避免的噪音。
- 自查新增 1 项（重复 init 后版本跟随钩子），共 112 项全过。
## 3.5.0 — 2026-11-06

- 新增 `signoff doctor [--json] [--quiet]`：回答“为什么它没按预期生效”，只读、不装不改不删。
- 检查项：Node 版本、git 是否在 PATH、引擎、钩子三件套是否在且可执行、钩子的旧钩子备份（备份了但没串接会警告）、`signoff` 是否在非交互 shell 的 PATH 里、CLI 版本与安装点记录是否一致、`config.json` 字段合法性、`test_cmd` 是否可启动、`.signoff/passed` 残留、`skips.log` 条数、账本链与别仓库条目、安装点之后的缺失提交。
- 组合既有命令（`status` / `audit --since-install` / `p4 verify`）而不是重算逻辑：doctor 说 ok 和闸门后面判绿不会互相矛盾。
- 退出码：全绿 0，有失败 1，不在 git 仓库 2；`--quiet` 只打非 ok 项。
- 自查新增 8 项（未装仓库判 1、装好判 0、`--json` 结构、`--quiet` 过滤、非仓库判 2、标记残留只警告且能被看见），共 111 项全过。

## 3.4.0 — 2026-11-06

- `signoff init` 记录安装点 `.signoff/installed.json`（`{sha, ts, version}`）；重复 init 不覆盖第一个安装点——装钩子之前的历史是历史，不是失败。
- `signoff audit --since-install`：从安装点起算，不再手写 `--range`；没有安装点时直接报错退出 2，不猜。
- 普通 `audit` 遇到装钩子之前的缺失提交会多打一行：`N of M missing commit(s) predate the install point (<sha12>); use --since-install`；`--json` 增加 `install: {sha, pre_install_missing}`。
- 自查新增 5 项（安装点存在、带 sha、`--since-install` 空区间通过、重复 init 不改安装点、装钩子之前的缺失提交给出提示），共 103 项全过。

## 3.3.0 — 2026-11-06

- **账本改为仓库级**：默认写 `<repo>/.signoff/audit.log`（非仓库目录退回 `~/.signoff/audit.log`，`SIGNOFF_HOME` 仍可强制指定）。原来的用户级账本会把 A 仓库的回滚点拿去 B 仓库校验，`p4 verify` 在除写入者之外的任何仓库都报 `missing`。
- **记录新增 `repo` 字段**（参与哈希）：`verify` 只校验属于本仓库的条目，别仓库的条目跳过。3.3.0 之前的记录没有 `repo`，仍按旧的 6 个字段重算哈希，所以老账本照常通过。
- **自动迁移**：第一次在某个仓库里用到账本时，若用户级 `~/.signoff/audit.log` 的整条链在本仓库全部能解析，就整份复制进来；有任何一条解析不了（说明它属于别的仓库）就不复制，从空链开始。
- `test/selftest.js` 新增 5 项：仓库级落点、`repo` 字段、旧链迁移、别仓库条目跳过、本仓库条目仍会红。96 项全过；Python 对等 30 项全过。

## 3.2.1 — 2026-11-06

- 中文名从「执印」改为 **落印**：动作词（印落纸面才算数），与英文名 SignOff 的“签了才放行”对应；曾用名「一诺过五关」「执印」。
- 只改展示名与描述，命令 `signoff`、包名 `dsh-signoff`、行为均不变。

## 3.2.0 — 2026-11-06

- 中文名定为 **执印**，原名「一诺过五关」保留为曾用名。英文名 SignOff、命令 `signoff`、包名 `dsh-signoff` 不变。
- 定名依据：GitHub 星标 >2000 的 34 022 个仓库里，按星标取前 1 000 个逐页扫描，名字含中文的为 0 个；中文开源项目成功的是「ASCII slug + 2–3 字中文品牌」（积木 48 389 / 芋道 40 278 / 若依 8 640），所以中文名取两字，五个字以上留给口号。
- README、`docs/gates.md`、`package.json` 描述同步；其余行为无改动。

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
