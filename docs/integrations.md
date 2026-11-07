# 接入方式（同一套判决，六种入口）

落印不绑定平台：任何一个能跑命令的地方都能接入，判决与退出码一致（0 通过、1 红、2 用法/环境）。

## 1. 本机零接触（最快）

```bash
npm i -g signoff-cli && cd your-repo && signoff init
```

之后 `git commit` 自动过闸。

## 2. GitHub Actions

```yaml
- uses: ayuanxx-max/signoff-cli@v3.15.0
  with:
    args: all
```

红关会输出 `::error file=...,line=...` 注解并写步骤摘要。

## 3. pre-commit

```yaml
repos:
  - repo: https://github.com/ayuanxx-max/signoff-cli
    rev: v3.15.0
    hooks:
      - id: signoff-guard
```

## 4. lefthook

```yaml
pre-commit:
  commands:
    signoff:
      run: signoff guard
```

## 5. husky

```bash
echo 'signoff guard' > .husky/pre-commit
```

## 6. VS Code

```bash
signoff init --editor vscode
```

生成 6 个任务与问题匹配器，红关直接落到 Problems 面板。

## MCP

`io.github.ayuanxx-max/signoff` 已在 MCP Registry，可被支持 MCP 的客户端直接调用。
