---
title: Spec：Errors（错误契约）
type: spec
status: active
summary: daemon 内部错误对象与错误上下文的字段契约
tags: [spec, errors]
related:
  - dev/standards/errors
  - dev/spec/infra/observability
---

# Spec：Errors（错误契约）

定义 daemon 内部错误对象的字段契约。错误分类语义、传播写法和用户反馈标准见 [`../../standards/errors.md`](../../standards/errors.md)。

## 错误对象

每个错误必须携带：

| 字段 | 类型 | 说明 |
|---|---|---|
| `kind` | `user | platform | agent | internal` | 错误大类 |
| `code` | string | 同一 kind 内唯一的细分错误码 |
| `message` | string | 给开发者看的简短原因 |
| `cause` | unknown? | 原始错误（如有） |
| `traceId` | string | 请求链路 ID |
| `sessionKey` | string? | 有会话上下文时必填 |
| `messageId` | string? | 有消息上下文时必填 |

具体语言侧实现（struct / enum / class）等 ADR-0004 后定。
