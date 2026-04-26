---
title: Commit 与分支编排
type: process
status: active
summary: 分支先行的硬性要求、分支生命周期、合并与同步策略、跨步骤的禁止行为
tags: [commit, process, branching]
related:
  - root/AGENTS
  - dev/process/workflow
  - dev/standards/commit-style
---

# Commit 与分支编排

本文件编排"何时开分支、何时打 commit、何时合并、失败如何处理"。**commit message 与分支名的产物形态合格条件**（Conventional Commits 格式、type 枚举、breaking change 写法、分支命名规则、commit 粒度合格条件、Co-Authored-By footer）住 [`../standards/commit-style.md`](../standards/commit-style.md)，本文件不复述。

## 分支先行（硬性要求）

一切改动——代码、文档、脚本、配置——必须先从 `main` checkout 新分支再动手。**禁止在 `main` 上直接编辑或 commit 未合入的改动**。即便是单行错别字也走分支 → PR → review → squash merge。

理由（详见 [`workflow.md` §分支先行（不可跳过）](workflow.md#分支先行不可跳过)）：

- PR 是 review 反馈与作者回应的承载窗口（codex review 当前手动触发，记录挂 PR 上）
- 分支隔离 → 单次改动可独立 revert / abandon
- 分支命名强制范围收敛
- 为未来分支保护、自动化 CI/review hook 留落点

## 主分支

- `main`：当前稳定分支。只接受来自 feature 分支的 squash merge PR，**任何人（包括维护者）不得在 `main` 上直接编写或 commit 未经 PR 的改动**
- 本阶段（单人 + 文档）不设置额外保护分支
- MVP 发版后会新增 `release/*` 分支与 tag 策略，届时本文件补充

## 分支生命周期

```
main
 ├── 从 main checkout 新分支（命名见 standards/commit-style.md §分支命名）
 ├── 开发 + commit（粒度见 standards/commit-style.md §Commit 粒度）
 ├── push + 开 PR
 ├── 跑 CI + codex review
 ├── 通过后 squash merge 回 main
 └── 分支删除
```

## 合并策略

- **squash merge**：默认。把分支上的多个提交压成一个，进入 main 的历史干净
- 保留分支内的原子 commit 信息：在 PR 描述里附上关键 commit 列表
- 禁止 merge commit 混入 main（设置 repo 默认为 squash）
- 禁止 force push 到 main

## 同步策略

- 分支落后 main 时 `git rebase main`，避免 merge commit
- 如果 rebase 冲突复杂，在分支上 `git merge main` 也可以，但合并到 main 时仍用 squash

## 禁止事项（行为）

- 禁止 `git commit --amend` 改已 push 到共享分支的 commit
- 禁止 `git push --force` 到 main（个人分支可以 `--force-with-lease`）
- 禁止跳过 hook：`--no-verify` 只有在 hook 本身出 bug 且得到维护者同意时才用
- 禁止在 `main` 上直接 commit / push 未经 PR 的改动

commit message 与分支名的合格条件违反（含 `wip` 信息、无 type 前缀、分支名超过 50 字符等）由 reviewer 拒绝——见 [`../standards/commit-style.md` §Reviewer 拒绝条件](../standards/commit-style.md#reviewer-拒绝条件)。
