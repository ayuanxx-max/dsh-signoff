# 四种接入形态：CLI / 技能 / MCP / 宿主插件

`signoff` 的内核只有一个：在用户的仓库里跑命令、读退出码、写账本。四种形态是它的四种外壳，
可靠性依次递减、耦合依次递增。**默认选 CLI，需要 agent 自己会用就加技能，需要别的客户端也能调就加 MCP；
宿主插件只在"要把结果画进 UI"时才值得做。**

## 对比

| 形态 | 已提供 | 谁调用 | 成本 | 局限 |
| --- | --- | --- | --- | --- |
| 外部 CLI | 本仓库本身（npm 全局安装） | 人、CI、编辑器任务、任何脚本 | 一个进程，无协议 | 需要 PATH 上有 `signoff` |
| 技能（SKILL.md） | `integrations/skill/SKILL.md` | DSH / Claude 等支持技能的 agent | 零进程，纯文档 | 模型要自己记得去看技能 |
| MCP 服务器 | `integrations/mcp/server.js` | Claude Desktop、DSH、IDE 等 MCP 客户端 | 每次调用起一个 node 进程 | stdio 单行 JSON-RPC；工具粒度就是命令粒度 |
| 宿主插件（Cordis） | 未实现，仅设计 | 宿主进程内其他插件 | 与宿主同生命周期 | 跨仓库语义变复杂；只有 UI 呈现时才有独有价值 |

## 1. CLI（当前主形态）

```bash
npm i -g dsh-signoff
signoff init          # 装钩子 + CI
signoff run           # 退出码即判决
```

任何地方能起进程就能用：`lefthook` 的 `run:`、GitHub Actions 的 `run:`、`Makefile`、
编辑器保存时任务、别的 agent 的 shell 工具。**这是唯一不需要额外适配层的形态**，也是
"npm 安装后 P1–P5 全量可用"这条承诺所依赖的形态。

## 2. 技能（推荐给 agent 用）

`integrations/skill/SKILL.md` 已经写好，内容不是命令清单的复述，而是三件模型容易做错的事：

1. 退出码是判决，不要从源码重新推断；
2. 红线——不许用 `SIGNOFF_SKIP=1` / `--no-verify` 绕过红关，两者都会留痕；
3. 修的顺序——先看 `doctor`，再看 `explain <gate>`，最后才改配置。

安装（任选）：

```bash
# 本地技能目录
mkdir -p ~/.dsh/skills/signoff-gates && cp integrations/skill/SKILL.md ~/.dsh/skills/signoff-gates/
# 或 OpenViking
ov skills add integrations/skill          # 需要 ov CLI
```

为什么技能优于插件：它没有进程、没有协议、没有版本对齐问题，改了 SKILL.md 立刻生效；
代价是"模型得想起来用"，而这正是技能描述（frontmatter 的 `description`）负责的事。

## 3. MCP 服务器（给别的客户端用）

```jsonc
{ "mcpServers": { "signoff": {
  "command": "node", "args": ["E:/path/to/dsh-signoff/integrations/mcp/server.js"] } } }
```

工具：`signoff_run`、`signoff_status`、`signoff_doctor`、`signoff_audit`、`signoff_explain`。
每个工具返回 `exit N` + 合并输出，`isError` 与退出码一致——因为在 SignOff 里退出码**就是**判决。

已实测（`initialize` / `tools/list` / `tools/call` 全通，见 `integrations/mcp/README.md`）。
实现上固定用包内自带的 `bin/signoff.js` + 当前 node 启动：不查 PATH、不经 shell，
既保证版本与服务器一致，也避开 Windows 上 `shell: true` 的弃用警告。

## 4. 宿主插件（Cordis）：可行，但不首选

若确实要做，最薄的一层是**只做转发**，不要在插件里重新实现任何判定：

```js
// 概念示意，未实现
ctx.plugin({ name: "signoff", apply(ctx) {
  ctx.tool("signoff_run", { description: "run the gates", schema: { type: "object" } },
    async ({ cwd }) => runCli(["run", "--json"], cwd));   // 退出码 + JSON 原样返回
}});
```

只有两种情况值得升级到插件：

1. **要画 UI**：gate 结果作为卡片/面板呈现，需要宿主的事件与渲染能力；
2. **要被别的插件当 Service 调**：`signoff.verify({cwd})` 让别的插件直接调它。

否则插件带来的是三个新问题：与宿主的生命周期绑定（宿主崩了闸门也没了）、跨平台 spawn 语义、
版本对齐（插件版本 ≠ npm 上的 signoff 版本）。**这三样都比"多起一个进程"贵得多。**

## 结论

- 现在：CLI 是本体；技能是给 agent 的说明书；MCP 是给别的客户端的适配器。
- 不做：插件形态。除非出现"必须在 UI 里看 gate 结果"的真实需求，否则它只增加维护面。
