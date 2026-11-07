# 推广：GitHub 上没有浏览时怎么办

前提：这是一个**工具型**仓库，不是内容型。工具靠"被引用"传播，不靠刷。
所以顺序是：先让仓库在 GitHub 内部可被检索到，再让外部渠道有人替你说一句话，最后才是发帖。

## 第 0 层：GitHub 内部可发现性（今天就能做完，收益最确定）

| 项 | 现状 | 应做 |
| --- | --- | --- |
| 仓库 description | mojibake（`SignOff 4e00 8bfa...`） | 改成一句英文 + 一句中文，含关键词 |
| topics | **空** | 至少 8 个：`git-hooks` `pre-commit` `code-quality` `audit` `cli` `nodejs` `testing` `llm-agents` `ai-agents` `mcp` |
| README 首屏 | 中文长文，无英文 | 顶部三行：一句话 + 安装 + 一张门禁输出；`README.en.md` 供非中文读者 |
| Releases | 有 tarball，但说明只有几行 | 每个 Release 写安装 + 用法 + 变更（已按此改造） |
| License | 确认存在 | 无 LICENSE 的仓库会被企业用户直接跳过 |

GitHub 的搜索会索引 description、topics、README 正文；topics 为空等于不参与任何主题页。

## 第 1 层：进入别人的清单（一次性的、长期有效的流量）

优先级从高到低：

1. **awesome-mcp-servers** —— 我们有真正的 MCP server，这类清单审核看"能不能跑"，通过率高。
2. **awesome-git-hooks / awesome-pre-commit / awesome-static-analysis** —— 与本工具的定位完全对口。
3. **awesome-claude-code / awesome-ai-agents** —— agent 工作流清单，signoff 的"证明 done"是它们的空白格。
4. **awesome-nodejs**（门槛高、竞争大）——最后再试。

提交方式：fork → 在对应分类加一行（一句话 + 链接）→ PR。**一行就够，别写广告词**，
这类清单的维护者会直接关掉营销文案。

## 第 2 层：内容（发一次，长期被搜到）

英文主战场（选一个发，别群发）：

- **Show HN**：标题不要写 "SignOff — a tool for X"。写结论：
  `Show HN: A git hook that refuses to let an agent say "done" without proof`。
  正文三段：问题（agent 说完成了，凭什么信）、做法（五关 + 账本 + 退出码即判决）、
  一条真实输出。HN 会问"和 husky/lint-staged 有什么区别"，答案必须一句话说清。
- **dev.to / r/git**：偏教程，`How to make "done" verifiable in a repo`。

中文：

- **V2EX / 掘金 / 知乎**：标题带痛点——"让 AI 写完代码说'完成'这件事，怎么验？"
- 内容结构同上，附中文 README 链接。

## 第 3 层：定位（决定别人要不要点开）

不要和 lint 工具比，它们不判"完成"。可用的对比句：

- husky / lefthook：**装钩子**，不决定钩子里跑什么、失败算什么；
- pre-commit：**跑检查**，不产账本，也没有"这次提交真的过闸门了吗"的审计；
- SignOff：把"完成"变成一个**可验证的判决**（退出码）+ 一条**可审计的链**（账本）。

## 度量（别猜，读数据）

```bash
# 近 14 天浏览量/克隆量（需要 push 权限的 token）
curl -s -H "Authorization: token $TOKEN" \
  https://api.github.com/repos/ayuanxx-max/signoff-cli/traffic/views
# 每周 npm 下载
curl -s https://api.npmjs.org/downloads/point/last-week/signoff-cli
```

现实预期：这类工具前两周能到 20–50 star 就算不错；单个 awesome-list 收录常带来 10–30 star 的长尾。
**不做**：买赞、互 star、群发私信——GitHub 会判定为 spam，收益为负。

## 顺序建议

1. 今天：description + topics + README.en.md（**这一步的投入产出比最高**）。
2. 本周：三个 awesome-list PR。
3. 有第一波 star 后：Show HN（先有社会证明再发帖，转化率差 2–3 倍）。
4. 之后每月一次：Release 说明写成"这次解决了谁的什么问题"，Release 页面本身也会被搜到。
