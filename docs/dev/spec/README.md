---
title: Spec 索引
type: index
status: active
summary: 接口契约与跨层协议索引，分"核心三件套"与"横切四件套"
tags: [spec, navigation]
related:
  - dev/architecture/overview
  - dev/spec/platform-adapter
  - dev/spec/agent-runtime
  - dev/spec/message-protocol
---

# Spec（接口契约）

本目录定义**跨模块接口**与**跨层协议**。所有契约**语言无关**（用伪代码 + 字段表），具体实现在代码里对齐本目录。

## 核心原则

- **先改 spec，再改代码**：任何涉及接口/协议的改动，PR 必须同时包含本目录对应文件的更新。
- **字段表权威**：字段名、类型、语义以本目录为准；代码里字段必须与之对齐。
- **不做示例代码**：spec 里可以写伪代码，但不示例具体语言（具体示例放 `testing/` 或代码注释）。
- **边界清晰**：每个 spec 文件定义一个明确的接口或协议，不交叉。

## 文档清单

### 核心三件套（模块间接口）

- [`platform-adapter.md`](platform-adapter.md) — IM 平台适配层接口
- [`agent-runtime.md`](agent-runtime.md) — Agent 后端适配层接口
- [`message-protocol.md`](message-protocol.md) — 归一化消息与事件格式

### 横切四件套（跨层约束）

- [`persistence.md`](persistence.md) — 本地存储契约
- [`observability.md`](observability.md) — 日志/trace/metric 字段契约
- [`security.md`](security.md) — 权限、脱敏、密钥处理
- [`cost-and-limits.md`](cost-and-limits.md) — 预算、限流、熔断

## 阅读顺序

1. 先读 [`../architecture/overview.md`](../architecture/overview.md) 建立心智
2. 再读本目录核心三件套
3. 最后按需查阅横切四件套

## 与 ADR 的关系

- ADR 决定**选择什么**（例：Discord、CC CLI）
- Spec 决定**接口长什么样**（例：NormalizedEvent 的字段、错误码）

改 spec 字段语义 → 需要关联 ADR（若没有对应 ADR，先发一个）。
改 spec 的纯文档编辑（错别字、澄清）→ 不需要 ADR。

## 反模式

- 在 spec 里写"将来可能扩展 X"的占位（需要再写）
- 在 spec 里预设实现语言（一律伪代码）
- 在 spec 里展示示例代码（放测试或注释）
- 代码合入了但 spec 没同步更新（reviewer 必须拦下）
