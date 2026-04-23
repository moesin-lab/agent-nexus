---
title: Commit 与分支规范
type: process
status: active
summary: Conventional Commits 格式、分支命名与生命周期、合并策略、commit 粒度
tags: [commit, process]
related:
  - root/AGENTS
  - dev/process/workflow
---

# Commit 与分支规范

## Conventional Commits

所有 commit 遵循 [Conventional Commits 1.0](https://www.conventionalcommits.org/zh-hans/v1.0.0/)。

### 格式

```
<type>(<scope>): <subject>

<body>

<footer>
```

- `type`：见下表
- `scope`：可选，模块或子系统名（`core` / `adapter-discord` / `agent-cc` / `docs` / `ci` / ...）
- `subject`：祈使句、小写开头、结尾不加句号
- `body`：解释**为什么**要做这个改动，而不是做了什么
- `footer`：Breaking change、关联 issue、Co-Authored-By 等

### Type 取值

| type | 用途 |
|---|---|
| `feat` | 新增功能 |
| `fix` | 修 bug |
| `docs` | 文档改动 |
| `refactor` | 不改行为的重构 |
| `perf` | 性能改进 |
| `test` | 只改测试 |
| `build` | 构建系统、依赖 |
| `ci` | CI 配置 |
| `chore` | 杂项（脚本、版本号、.gitignore 等） |
| `revert` | 回滚 |

### 示例

```
feat(adapter-discord): handle slash command dispatch

Discord slash command 事件需要映射到 NormalizedEvent 的 command 字段。
按 spec/platform-adapter.md §3.2 的字段表实现，并加合约测试。

Refs: docs/dev/spec/platform-adapter.md
Closes: #42
```

### Breaking change

在 footer 里用 `BREAKING CHANGE:` 或在 type 后加 `!`：

```
feat(core)!: change session key to include threadId

BREAKING CHANGE: session key 从 (platform, channelId, userId) 改为
(platform, channelId, threadId, userId)。所有 adapter 需要同步升级。
```

## 分支策略

### 分支先行（硬性要求）

一切改动——代码、文档、脚本、配置——必须先从 `main` checkout 新分支再动手。**禁止在 `main` 上直接编辑或 commit 未合入的改动**。即便是单行错别字也走分支 → PR → review → squash merge。

理由：PR 是本项目强制的 codex review 触发点。跳过分支 = 跳过 review。

### 分支命名

```
<type>/<short-description>
```

- `type` 同 commit 的 type
- `short-description` 小写、短横线分隔
- 长度 ≤ 50 字符

示例：

- `feat/discord-slash-command`
- `fix/session-idempotency-race`
- `docs/update-spec-observability`

### 主分支

- `main`：当前稳定分支。只接受来自 feature 分支的 squash merge PR，**任何人（包括维护者）不得在 `main` 上直接编写或 commit 未经 PR 的改动**。
- 本阶段（单人 + 文档）不设置额外保护分支。
- MVP 发版后会新增 `release/*` 分支与 tag 策略，届时本文件补充。

### 分支生命周期

```
main
 ├── 从 main checkout 新分支
 ├── 开发 + commit（原子提交，频繁 push）
 ├── 跑 CI + codex review
 ├── 通过后 merge 回 main
 └── 分支删除
```

### 合并策略

- **squash merge**：默认。把分支上的多个提交压成一个，进入 main 的历史干净。
- 保留分支内的原子 commit：在 PR 描述里附上关键 commit 列表。
- 禁止 merge commit 混入 main（设置 repo 默认为 squash）。
- 禁止 force push 到 main。

### 同步策略

- 分支落后 main 时 `git rebase main`，避免 merge commit。
- 如果 rebase 冲突复杂，在分支上 `git merge main` 也可以，但合并到 main 时仍用 squash。

## Commit 粒度

- 一个 commit 只做**一件逻辑上的事**。
- 新增功能 + 重构混在一个 commit 里——拆开。
- 修 bug + 顺手改别的——顺手的部分不要做，或开独立 commit。
- 纯格式化（缩进、换行）单独一个 commit。

## 禁止事项

- 禁止 `git commit -m "wip"` 式无意义信息
- 禁止 `git commit --amend` 改已 push 到共享分支的 commit
- 禁止 `git push --force` 到 main（个人分支可以 `--force-with-lease`）
- 禁止跳过 hook：`--no-verify` 只有在 hook 本身出 bug 且得到维护者同意时才用

## Co-Authored-By

使用 AI 辅助生成的 commit，在 footer 加上对应的 Co-Authored-By 行，便于审计。

```
Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```
