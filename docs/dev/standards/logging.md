---
title: 日志规范
type: standards
status: active
summary: 结构化日志写法约束；字段契约、等级语义、禁止打印清单与测试对日志的约束
tags: [logging, standards, observability]
related:
  - dev/spec/infra/observability
  - dev/standards/errors
  - dev/spec/security
---

# 日志规范

本文件是 [`../spec/observability.md`](../spec/infra/observability.md) 的代码侧落地。spec 定义**字段契约**，本文件定义**写法约束**。

## 基本原则

- **结构化优先**：用 key-value 形式，不拼字符串
- **字段一致**：字段名来自 spec；不自创同义词
- **人机双读**：生产用 JSONL（机器读），开发可选彩色 pretty（人读）；内容一致
- **非阻塞**：日志 I/O 不能阻塞主业务路径

## 字段契约

所有日志必须包含下列字段（见 `spec/observability.md` §2）：

- `timestamp`：RFC3339 含毫秒
- `level`：`trace | debug | info | warn | error`
- `component`：发生日志的模块名（如 `adapter-discord`、`core-engine`）
- `event`：事件名（动宾短语，小写加下划线，如 `message_received`）
- `traceId`：贯穿一次请求链的 ID
- `sessionKey`：涉及会话时必填
- `messageId`：涉及消息时必填

特定事件有额外字段（见 spec）。**缺字段不是"info 级别不严格"的借口，是 bug**。

## 等级语义

| level | 用途 | 触发条件 |
|---|---|---|
| `trace` | 超详细调试 | 默认关闭，需要时打开；生产不输出 |
| `debug` | 开发时调试 | 开发启用、生产关闭 |
| `info` | 关键业务事件 | 会话建立/结束、LLM 调用完成、消息发送成功 |
| `warn` | 非预期但可继续 | rate limit 命中、重试、降级路径 |
| `error` | 业务中断 | 请求失败、异常未捕获、熔断触发 |

### 做 / 不做

| 不做 | 做 |
|---|---|
| `info: "everything ok"` | 只在值得追踪的业务事件打 `info` |
| `error: "小错误不影响"` | 不影响就不是 error，用 warn |
| 把堆栈塞进 message 字段 | 用独立字段 `stack` 或 `cause` |
| 每条用户消息打一条 log | 去重/聚合，或提升为 trace |

## 禁止打印的内容

- **密钥/Token**：Discord bot token、Anthropic API key、OAuth secret
- **环境变量的原值**（尤其带 `KEY`、`SECRET`、`TOKEN` 字样）
- **用户的绝对路径**（替换为项目相对路径或 `~/`）
- **用户消息正文在 IM 级别**（sessionKey + messageId 引用即可；需要时另存脱敏快照）
- **CC CLI 的完整输出原文**（摘要或 hash；要完整输出走专门的 transcript 落盘）

脱敏在日志系统入口拦截，详见 [`../spec/security.md`](../spec/security/README.md) §3。

## 输出格式

- **生产**：JSONL 落盘到本地 `.data/logs/<date>.jsonl`，每行一个 JSON
- **开发**：彩色 pretty 输出到 stderr，内容与 JSONL 等价
- **可选**：OTel 导出器对接用户自选后端

## 采样

- `error` 与 LLM 调用事件：100% 保留
- IM 事件：100% 保留（量级不大）
- 内部 `debug` / `trace`：按需采样，默认关闭

## 性能

- 日志组装是 hot path：避免在 log 站点做昂贵计算
- 字段构造用 lazy / guard：`if isDebugEnabled() { log.debug(...) }`（具体语言机制随 ADR 0004）
- 禁止在循环内同步 flush

## 错误日志的必含字段

当 level 为 `error`：

- `errorKind`：错误分类（来自 [`errors.md`](errors.md) 的分类）
- `cause`：原始错误信息（字符串化）
- `stack`：完整栈（如有）
- 触发时的上下文字段（`sessionKey`、`messageId`、业务入参摘要）

## 测试对日志的约束

- 关键业务事件必须有测试断言对应 log 被打出（防止重构意外移除）
- 禁止在测试里断言 log 内容的完整文本（只断言 event 名与关键字段）

## 反模式

- 用日志代替 metric（"统计本小时消息数"——用 metric，不是 grep log）
- 把 debug 日志留在生产代码里作为"保险"
- 对同一事件打多条不同 level 的 log（选一个）
- 日志信息互相矛盾（"sending..." 后面紧跟 "send failed"，但没有解释 failed 的原因）
