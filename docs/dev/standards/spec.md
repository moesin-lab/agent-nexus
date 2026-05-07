---
title: spec 产物写法标准
type: standards
status: active
summary: spec 这个产物的核心原则、产物合格条件 DoD、Seam 演进规则、反模式
tags: [spec, standards]
related:
  - dev/spec/README
  - dev/standards/doc-ownership
  - dev/standards/docs-style
  - dev/standards/when-to-add-doc
---

# spec 产物写法标准

本文件是 spec 这个产物的**价值标准**：spec 文件应包含什么、不应包含什么、什么算合格。**spec 触发条件**（什么改动需要新增 / 修改 spec）见 [`when-to-add-doc.md`](when-to-add-doc.md)。

## 核心原则

- **先改 spec，再改代码**：任何涉及接口/协议的改动，PR 必须同时包含 spec 对应文件的更新。
- **字段表权威**：字段名、类型、语义以 spec 为准；代码里字段必须与之对齐。
- **不做示例代码**：spec 里可以写伪代码，但不示例具体语言（具体示例放 `testing/` 或代码注释）。
- **边界清晰**：每个 spec 文件定义一个明确的接口或协议，不交叉。

## 产物合格条件（DoD）

spec 合格的判据：

- frontmatter 字段齐（按 [`metadata.md`](metadata.md)）
- 至少包含字段表或伪代码接口（不是纯散文描述）
- 字段名 / 类型 / 语义清晰，无"将来再补"占位
- 边界清晰：每个 spec 文件定义一个明确的接口或协议，不交叉
- 每个方法显式标注调用顺序约束 / 并发安全语义 / 错误分类 / 幂等性——光有签名或字段表不算契约完整，caller 必须知道的不变量都属于接口
- reviewer 通读确认，无含糊或冗余表述

## Seam 演进规则

每个 spec'd 接口对应一个 seam（如 `PlatformAdapter` / `AgentRuntime`）。**单实例时接口形状是假说**——第一个实现跑通不代表接口设计正确，要等第二个 adapter 反向施压才知道哪些字段多了、哪些不变量错了。

规则：

- 接口形状在第二个 adapter 落地前**冻结**——不允许"为了未来 N 个后端"提前往接口加 flag / 字段 / 钩子。
- 真要为某条具体决策留设施位（如 `AgentCapabilitySet.supportsStdinInterrupt` 之于 ADR-0012 决策点 2），必须走 ADR Amendment 显式说明触发条件与回退路径，不在 spec 默默加。
- 第二个 adapter 接入时由它反向施压；接口与新 adapter 真实需求不符的，改接口形状，不用 capability flag 绕。

reviewer 在 spec PR 看到"为未来 N 个 X 准备"的字段、且无对应 ADR，应直接拒稿。

## 反模式

- 在 spec 里写"将来可能扩展 X"的占位（需要再写）
- 在 spec 里预设实现语言（一律伪代码）
- 在 spec 里展示示例代码（放测试或注释）
- 代码合入了但 spec 没同步更新（reviewer 必须拦下）
