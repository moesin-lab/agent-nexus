---
title: 贡献指南
type: root
status: active
summary: 外部贡献者的 PR 前置条件与流程入口，指向 AGENTS.md 与 process/
tags: [workflow, code-review, commit]
related:
  - root/AGENTS
  - dev/process/workflow
  - dev/process/code-review
  - dev/process/commit-and-branch
---

# 贡献指南

感谢你对 agent-nexus 感兴趣。

> **边界声明**：本文档只做摘要与外部流程说明；内部协作规则以 [`AGENTS.md`](AGENTS.md) 为准，架构与契约以 `docs/dev/**` 为准。CONTRIBUTING 不应长出独占的内部规则——规则需要变化时改 `AGENTS.md` 或 `docs/dev/**`，本文档只在必要时同步指针。

本项目当前处于**文档与规范骨架阶段**，尚无代码。如果你想参与：

1. 先读 [`AGENTS.md`](AGENTS.md)，了解本项目的核心协作规则。
2. 再读 [`docs/dev/README.md`](docs/dev/README.md)，按推荐顺序浏览开发文档。
3. 对文档内容有疑问或建议，请开 Issue（推荐）或直接发 PR（小的错别字、术语统一）。

## 开 PR 前的最低要求

- 改动范围收敛：一个 PR 只做一件事。
- 架构级改动：先提 ADR（见 [`docs/dev/adr/README.md`](docs/dev/adr/README.md)）。
- 新接口/新模块：先改 spec（见 [`docs/dev/spec/`](docs/dev/spec/)）。
- 代码改动：先有 failing test（TDD），再有实现。
- PR 描述里回答 [`AGENTS.md`](AGENTS.md) 的"三问"：对应哪条 ADR、哪个 spec、哪些测试。

## Commit 规范

使用 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/v1.0.0/)。详细约定见 [`docs/dev/process/commit-and-branch.md`](docs/dev/process/commit-and-branch.md)。

## Code review

所有 PR 必须经过 code review，并对大变更或跨层改动额外跑 codex review / ultrareview。流程与自查清单见 [`docs/dev/process/code-review.md`](docs/dev/process/code-review.md)。

## 行为准则

- 克制、直接、基于事实的技术讨论。
- 允许反对意见，不允许人身攻击。
- 对代码严格，对人温和。
