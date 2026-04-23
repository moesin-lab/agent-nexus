---
title: 错误处理规范
type: standards
status: active
summary: 错误四分类（user/platform/agent/internal）、传播规则、用户可见反馈与熔断重试策略
tags: [errors, standards]
related:
  - dev/spec/cost-and-limits
  - dev/spec/security
  - dev/standards/logging
---

# 错误处理规范

## 错误分类

每个错误必须属于下列四类之一。这个分类决定了日志等级、用户可见反馈、是否熔断、是否重试。

| 分类 | 含义 | 典型例子 | 用户可见 | 默认 level |
|---|---|---|---|---|
| `user` | 用户操作或输入导致 | 权限不足、格式错、超出预算 | 是（具体原因） | `warn` |
| `platform` | IM 平台侧故障 | Discord 429、gateway 断连 | 是（通用提示 + 重试中） | `warn`（重试成功） / `error`（最终失败） |
| `agent` | Agent 后端故障 | CC CLI 崩溃、超时、工具执行失败 | 是（通用提示） | `error` |
| `internal` | 本项目 bug | panic、状态不变量破坏、代码逻辑错 | 是（通用提示 + 错误 ID） | `error` |

## 错误结构（契约）

每个错误必须携带：

- `kind`：上面四类之一
- `code`：细分错误码（同一 kind 内唯一）
- `message`：给开发者看的简短原因（英文或中文均可，项目内统一）
- `cause`：原始错误（如有），便于追溯
- `traceId` / `sessionKey` / `messageId`：上下文

具体语言侧实现（struct / enum / class）等 ADR 0004 后定。

## 传播规则

- **边界捕获**：I/O、解析、反序列化在**最近的边界**捕获并分类
- **内部传递**：分类后的错误向上传递，不再重新分类
- **不吞错**：永远不 `catch {}` 或 `_ = err`，除非在分类层已经做过 logging 且明确决定降级
- **不盲重试**：只有 `platform` 和明确可重试的 `agent` 错误可重试；`user`/`internal` 永远不重试

## 用户可见反馈（IM 里回什么）

给用户的错误消息必须：

- **不暴露内部细节**（路径、栈、SQL、密钥）
- **告诉用户能做什么**（重试、换个命令、联系维护者）
- **带错误 ID**（traceId 截断，便于报 bug）

### 示例

| 错误场景 | IM 里的回复 |
|---|---|
| 用户不在 allowlist | "你不在允许使用的列表里。请联系管理员添加你的 Discord ID。" |
| 超出单会话预算 | "本会话已用完预算（$0.50）。输入 `/reset` 开新会话，或联系管理员提升额度。" |
| Discord 429 重试中 | "Discord 限流中，正在排队...（错误 ID：abc123）" |
| CC CLI 崩溃 | "Agent 出错了（错误 ID：abc123）。已记录，可以重试。" |
| 内部 panic | "出现内部错误（错误 ID：abc123）。已记录，请告诉维护者这个 ID。" |

## 做 / 不做

| 不做 | 做 |
|---|---|
| `return errors.New("failed")` | `return NewError(KindAgent, CodeCCCrashed, "cc process exited", cause)` |
| 把错误 `message` 直接发给用户 | 按"用户可见反馈"模板转换，再发 |
| 同一层捕获并重新 throw，信息丢失 | 捕获就分类，分类完带上 cause 继续向上 |
| 用 panic/unwrap 代替错误处理 | panic 只用于"不变量被破坏"（属于 internal），且被顶层 recover 转为 error |
| 对 `user` 错误疯狂重试 | user 错误**绝不**重试 |

## 熔断与重试

- **重试**：仅 `platform` 和标记为 `retryable` 的 `agent` 错误。退避 + jitter + 最大重试次数由 [`../spec/cost-and-limits.md`](../spec/cost-and-limits.md) 定义。
- **熔断**：同一 session 连续 N 次 `agent`/`platform` 错误 → 挂起 session，发用户通知。N 的值在 cost-and-limits.md。
- **降级**：某些场景可以降级（例如 gateway 断连时改走 webhook 重放）。降级路径要在 spec 里写明。

## panic / 崩溃策略

- 顶层有 recover / catch-all，把 panic 转成 `internal` 错误
- panic 出现即 bug，必须有 issue 追踪
- 不用 panic 做错误返回（用 error/Result/Either）

## 测试对错误的约束

- 每个可观察的错误路径都要有测试
- 断言 `kind` + `code`，不断言 message 的完整文本（message 允许改）
- 用户可见消息模板有单独测试（文案不能误改）

## 反模式

- 所有错误都用同一个 `error("xxx")`，无法分类
- catch 后 swallow（空 catch）
- 用错误 message 携带结构化信息（应该用字段）
- 把 `internal` 错误当 `user` 错误回给用户（泄漏内部细节）
- 对 `internal` 错误重试（重试也好不了，只是浪费资源）
