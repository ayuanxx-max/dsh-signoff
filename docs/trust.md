# 信任模型：这个提交当时真的过了？

同类工具通常只给你一个"通过"，落印给你**一串可以互相校验的证据**。每一层都能单独被打假，
合起来才构成"事后可核对"。

## 四层证据

| 层 | 内容 | 打假方式 |
| --- | --- | --- |
| 1. marker | `.signoff/passed` = `{tree, mode, ts}`，tree 是 `git write-tree` 的 40 位哈希 | 改动暂存内容后 tree 变，marker 失效 |
| 2. trailer | 提交信息尾部 `Signoff-Pass: <tree12>` + `Signoff-Key` + `Signoff-Sig` | 签名覆盖完整 40 位 tree，改一个字就验不过 |
| 3. 账本 | `.signoff/audit.log`，每条记录 `hash = sha256(prev + body)` | 改内容 → 本条 hash 对不上；改顺序 → prev 对不上 |
| 4. 检查点 | `.signoff/checkpoint.json` = `{seq, head, root, key, sig}`，root 是记录哈希的 Merkle 根 | 删掉末尾记录 → seq 与 root 对不上 |

第 4 层解决的是前三层的盲区：**删掉最后几条记录，链本身依然是自洽的**。
检查点写死了"第 N 条之后的样子"，并在仓库外留一行锚点：

```
signoff1:12:9f2c1ab34d0e:71b0c9d2e4a85f61
```

## 三种篡改，三种答复

| 攻击 | 结果 |
| --- | --- |
| 改提交信息里的 trailer | `audit --verify` 报 `bad-signature` |
| 改账本某条记录的内容 | `p4 verify` 报 `content hash mismatch (edited after the fact)` |
| 删掉账本末尾记录 | `p4 verify --checkpoint` 报 `records were removed` |
| 换一把 key 重新签 | 只有 key 在 `.signoff/allowed_signers` 里才算 `verified`，否则是 `self-signed` |
| 把锚点贴到别处对不上 | `p4 verify --checkpoint --anchor <那行>` 报锚点不匹配 |

## 怎么用

```bash
# 每个仓库一次：写第一个检查点
signoff p4 checkpoint

# 之后每次 guard 通过都会自动续签（同一份账本不重复签）
signoff guard

# 把锚点发布出去：发版说明、CI 步骤摘要、同事的消息，任选其一
signoff p4 anchor

# 事后核对
signoff p4 verify --checkpoint --anchor signoff1:12:9f2c1ab34d0e:71b0c9d2e4a85f61
```

CI 里：

```yaml
- run: signoff p4 checkpoint
- run: echo "signoff1:$(...)" >> "$GITHUB_STEP_SUMMARY"
```

## 它不证明什么

诚实地写明边界，比多给三个绿色对勾有用：

- **不证明"是谁"**：默认是仓库内自签。要绑定身份，把公钥写进 `.signoff/allowed_signers`。
- **不证明"活是真人干的"**：测试可以是假的，落印只证明"当时这套命令过了"。
- **不防 key 泄露**：拿到私钥的人可以重新签；锚点只能让"重写历史"变得可见，不能阻止。
- **同时重写账本与检查点并重新签名**，且没有发布过锚点——这种情况下本地无法察觉。
  锚点一旦发布到仓库之外，这条路就断了。

## 和同类的位置

- gitleaks / Vale / diff-cover：只有单关结论，没有账本。
- pre-commit / husky / lefthook：只负责"跑"，不负责"留下可核对的记录"。
- in-toto：有规范化的 attestation 与供应链验证，但要求 layout、签名密钥与验证器一整套基础设施。
- 落印：一条命令给出"提交 + 账本 + 检查点 + 可发布锚点"，代价是自签、格式私有。

一句话：**in-toto 的严谨性它没有，in-toto 的部署成本它也没有。**
