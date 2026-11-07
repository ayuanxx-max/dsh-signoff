# SignOff 架构与生态图

三张图全部由 **Mermaid** 生成（`mermaid-js/mermaid` + `mermaid-cli`），源文件在 `src/`，
改文案只要改 `.mmd` 再渲染一次——不手画、不拼版、可 diff。

| 源文件 | 产物 | 回答的问题 |
| --- | --- | --- |
| `src/signoff-1-capability.mmd` | `signoff-1-capability.png` | 由哪些部分组成、判定发生在哪一层、什么会留在仓库里 |
| `src/signoff-2-market.mmd` | `signoff-2-market.png` | 已出现在哪些市场、哪些等审核、哪些物料备好未提交 |
| `src/signoff-3-user.mmd` | `signoff-3-user.png` | 用户怎么装怎么用，以及平台/环境差异与已知坑 |

## 重新生成

```powershell
$py = "$env:USERPROFILE\.openviking\venv\Scripts\python.exe"
& $py "$env:USERPROFILE\.dsh\tools\diagram.py" doctor          # 检查 mmdc + Brave
& $py "$env:USERPROFILE\.dsh\tools\diagram.py" render src --out . --size 2200 --theme neutral
```

这台机器上的全局规矩（`~/.dsh/AGENTS.md`「框架图」）：画图一律走这条链路。
选 Mermaid 的理由是它是**可代码驱动**的图工具里星标最多的（91 028）；
`excalidraw/excalidraw` 星更多（135 255）但它是画布应用，没有受支持的 headless CLI，结果不可复现。

## 图 1 的读法

从左到右：谁在调用 → 谁在判定 → 结果落在哪 → 依赖什么。要点：

- 四个入口（CLI、git 钩子、CI、MCP/技能）**共用同一个 `guard.js`**，结论不会互相矛盾；
- 五关并列，任一判红整体退出码就是 1，**没有“部分通过”**；
- 提交信息里的 `Signoff-Pass: <tree>` 是审计的唯一线索，`--no-verify` 会让它消失（审计里显示 `missing`）。

## 图 2 的读法

绿色=已上线可被搜索/安装；黄色=已提交等人工审核；灰色=物料已备未提交。
底部那句话是关键：**Registry 只是索引，不是流量**；真正带来访问的是人工清单与被引用。

## 图 3 的读法

上半部分是正常路径（安装 → 初始化 → 日常 → 排错 → 退出/边界），下半部分三支是
平台差异、环境差异、已知坑。排错那一支刻意写成链条：`doctor → doctor --fix → explain <gate> → 改配置`，
改阈值永远放最后——90% 的“没反应”是钩子没生效，不是阈值。
