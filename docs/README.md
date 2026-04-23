---
title: 文档总导航
type: index
status: active
summary: 开发文档与产品文档两个中心的总导航与阅读顺序
tags: [navigation]
related:
  - dev/README
  - product/README
  - ops/runbook
---

# 文档总导航

本项目的文档分为两个独立的中心：**开发文档** 与 **产品文档**。两者面向不同读者，结构、语气、维护节奏都不同，**不要混放**。

## 两个中心

### `dev/` — 开发文档中心

面向**实现者**（人或 agent），回答：

- 为什么这么设计？（→ `dev/adr/`）
- 接口契约是什么？（→ `dev/spec/`）
- 整体架构怎么组织？（→ `dev/architecture/`）
- 开发流程怎么走？（→ `dev/process/`）
- 测试怎么分层？（→ `dev/testing/`）
- 代码与文档规范？（→ `dev/standards/`）

**当前阶段的主线**。入口：[`dev/README.md`](dev/README.md)。

### `product/` — 产品文档中心

面向**使用者**，回答：

- 怎么安装？
- 怎么配置？
- 怎么在 IM 里使用？
- 遇到问题查哪？

**当前阶段仅占位**，等 MVP 有可运行产物后再填写。入口：[`product/README.md`](product/README.md)。

### `ops/` — 运维文档

介于开发与产品之间，给"部署并运维这个系统的人"看。当前占位：[`ops/runbook.md`](ops/runbook.md)。

## 文档风格

- **语言**：当前只写中文。双语翻译等 MVP 后由 LLM 统一处理。
- **长度**：每篇文档至少做到"读完就能动手"或"读完就能决策"；过长要拆。
- **更新**：文档与代码同 PR 修改；文档落后于代码即被视为 bug。
- **规范细则**：见 [`dev/standards/docs-style.md`](dev/standards/docs-style.md)。

## 阅读顺序建议

**第一次进入项目**（无论人或 agent）按这个顺序：

1. 仓库根的 [`README.md`](../README.md)
2. 仓库根的 [`AGENTS.md`](../AGENTS.md)
3. [`dev/README.md`](dev/README.md)
4. [`dev/architecture/overview.md`](dev/architecture/overview.md)
5. 按需进入 `dev/adr/`、`dev/spec/`、`dev/process/`

## 不做的事

- 不把使用手册和接口契约混在同一篇文档里
- 不在产品文档里讨论内部架构
- 不在开发文档里写面向最终用户的步骤
