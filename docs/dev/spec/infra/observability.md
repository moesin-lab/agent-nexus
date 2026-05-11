---
title: Spec：Observability（可观测性）
type: spec
status: active
summary: 日志/trace/metric 字段契约；事件命名、LLM/IM 事件字段、禁止字段与采样策略
tags: [spec, observability, logging, tracing, metrics]
related:
  - dev/standards/logging
  - dev/spec/security/README
  - dev/spec/infra/cost-and-limits
---

# Spec：Observability（可观测性）

定义日志、trace、metric 的字段与事件契约。观测性留到后期补会漏字段、漏采集点、回归困难——本 spec 把观测字段定死，代码与之对齐。

## 三驾马车

| 类型 | 用途 | 形态 |
|---|---|---|
| **Log** | 事件线性流 | JSONL 文件（默认） + 可选 OTel logs |
| **Trace** | 请求链路 | 同 log 里的 `traceId` 字段（MVP 不上 OTel span） |
| **Metric** | 聚合数值 | 从 log 里按事件聚合；MVP 不额外采集 |

MVP 阶段不引入独立的 metric/tracing backend。所有观测从结构化日志派生。

## 强制字段

每条 log 必须有：

| 字段 | 类型 | 说明 |
|---|---|---|
| `ts` | string | RFC3339 毫秒 UTC |
| `level` | string | `trace|debug|info|warn|error` |
| `component` | string | 模块名，如 `adapter-discord`、`daemon-engine`、`agent-claudecode` |
| `event` | string | 事件名,小写加下划线，动宾短语 |
| `traceId` | string | 贯穿一次请求 |
| `msg` | string | 人类可读简述 |

涉及会话/消息时追加：

| 字段 | 条件 | 说明 |
|---|---|---|
| `sessionKey` | 有会话上下文 | 序列化字符串 |
| `messageId` | 有消息上下文 | 平台 messageId |
| `eventId` | Adapter 事件相关 | 见 message-protocol |

涉及用户时：

| 字段 | 条件 | 说明 |
|---|---|---|
| `userId` | 有用户上下文 | 平台 userId |
| `userDisplayName` | 可选 | 脱敏版（不含 email/phone） |

## TraceId

- 每次入站事件在 adapter 生成 `traceId`（UUIDv7 或类似带时间序列的形式）
- 该 traceId 贯穿整条处理链（daemon → agent → outbound）
- Adapter 之间不共享；每条入站事件独立一个 traceId
- 返回给用户的错误消息附带 traceId 截断（8 字符）便于报 bug

## 事件名命名

- 动宾短语、小写加下划线
- 形如 `<subject>_<verb>` 或 `<verb>_<subject>`
- 稳定性：事件名是对外 API，不能随便改

### 核心事件清单（持续补充）

| event | 触发点 | 附加字段 |
|---|---|---|
| `gateway_connected` | Discord gateway 建立 | `latencyMs` |
| `gateway_disconnected` | 断连 | `reason`, `durationMs` |
| `gateway_reconnecting` | 重连尝试 | `attempt` |
| `inbound_received` | 收到 IM 事件 | `rawContentType`, `sizeBytes` |
| `inbound_normalized` | 归一化完成 | `type` |
| `idempotency_hit` | 幂等命中 | `status` |
| `session_created` | 新会话 | `agentBackend`, `workingDir` |
| `session_state_changed` | 状态转换 | `from`, `to`, `reason` |
| `session_archived` | 归档 | `reason`, `durationMs` |
| `auth_denied` | 权限拒绝 | `reason`, `userId` |
| `agent_spawn_started` | 启动 CC | `pid?` |
| `agent_spawn_succeeded` | CC 就绪 | `pid`, `latencyMs` |
| `agent_spawn_failed` | CC 启动失败 | `errorKind`, `cause` |
| `claudecode_subproc_error` | CC 子进程在输出过程或之后非零退出（issue #28，选 C：不发 partial 文本到 IM，仅 warn 记 textBufLength 便于诊断） | `errorKind`, `cause`, `textBufLength` |
| `agent_input_sent` | 发输入给 CC | `inputType` |
| `agent_event_received` | CC 事件 | `agentEventType`, `sequence` |
| `llm_call_started` | LLM 调用开始 | `model` |
| `llm_call_finished` | LLM 调用结束 | `model`, `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `latencyMs`, `costUsd` |
| `tool_call_started` | 工具调用 | `toolName`, `callId` |
| `tool_call_finished` | 工具结束 | `toolName`, `callId`, `status`, `latencyMs` |
| `inbound` | daemon engine 收到 platform 归一化事件 | `sessionKey`, `length`（info）；`text`（debug 且过 redaction） |
| `outbound` | daemon engine 完成回送后立即发 | `sessionKey`, `length`（info）；`text`（debug 且过 redaction）；`errored`（仅错误路径） |
| `outbound_send_started` | 开始发送 | `platform` |
| `outbound_send_succeeded` | 发送成功 | `platform`, `latencyMs`, `messageId` |
| `outbound_send_failed` | 发送失败 | `platform`, `errorKind`, `cause` |
| `rate_limit_hit` | 命中限流 | `scope`, `retryAfterMs` |
| `turn_limit_hit` | session turn 数达上限 | `turnsUsed`, `maxTurns` |
| `tool_limit_hit` | 单 turn 工具调用数达上限 | `turnSequence`, `toolCalls`, `maxToolCalls` |
| `wallclock_timeout` | 单次 sendInput 超时 | `turnSequence`, `elapsedMs`, `limitMs` |
| `budget_threshold_crossed` | $ 预算阈值（opt-in） | `threshold`, `currentUsd`, `limitUsd`, `scope` |
| `circuit_opened` | 熔断触发 | `sessionKey`, `reason`, `consecutiveFailures` |
| `circuit_reset` | 熔断恢复 | `sessionKey`, `cooldownMs` |
| `error_reported` | 通用错误 | `errorKind`, `code`, `cause` |

## 采样

- `error`：100%
- `warn`：100%
- `info`：100%（MVP 规模下不必采样）
- `debug`：按 env `AGENT_NEXUS_DEBUG` 开启
- `trace`：按 env `AGENT_NEXUS_TRACE` 开启；对单 session 可过滤

## LLM 调用事件必含字段

`llm_call_finished` 的字段 = `AgentEvent{type: usage}` 的 `UsageRecord`（见 [`agent-runtime.md`](../agent-runtime.md) §UsageRecord）+ 日志通用字段（`traceId` / `sessionId` / `sessionKey` 等）。`daemon.counters` 收到 `usage` 事件后**原样**转写为 `llm_call_finished` 结构化日志，**不发明新字段名**。

必含字段：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `model` | string | 是 | `claude-opus-4-7` 等 |
| `inputTokens` | int | 是 | |
| `outputTokens` | int | 是 | |
| `cacheReadTokens` | int | 是 | |
| `cacheWriteTokens` | int | 是 | |
| `latencyMs` | int | 是 | |
| `costUsd` | float \| null | 否 | 按模型定价表计算；订阅模式下 CC 可能不返回，留 null |
| `turnSequence` | int | 是 | 本 session 的第几个 turn |
| `toolCallsThisTurn` | int | 是 | 本 turn 至此的工具调用数 |
| `wallClockMs` | int | 是 | 本 turn 从 sendInput 至今的墙钟时长 |
| `completeness` | string | 是 | `complete` / `partial` / `missing`（见 `claude-code-cli-contract.md` §UsageCompleteness） |

- `costUsd` 允许为 null（订阅用户主要路径）；为 null 不视为错误、不产生 warn。
- 定价表由 daemon 维护，支持热更新（配置文件）；仅 `$ 预算 opt-in 启用`时生效。
- 见 [`cost-and-limits.md`](cost-and-limits.md) 的 Usage 记账强制条款。

## IM 事件必含字段

| 事件 | 字段 |
|---|---|
| `inbound_received` | `platform`, `rawContentType`, `sizeBytes` |
| `outbound_send_succeeded` | `platform`, `latencyMs`, `messageId`, `attempts` |
| `rate_limit_hit` | `platform`, `scope`, `retryAfterMs`, `resource` |

## inbound / outbound 对偶事件

`inbound` 与 `outbound` 形成对偶：每条入站消息在 daemon engine 处理完成后对应一条出站日志，`traceId` 串联全链路。

| 字段 | level | 说明 |
|---|---|---|
| `traceId` | info | 与对应 `inbound` 相同 |
| `sessionKey` | info | 序列化会话键 |
| `length` | info | 消息字符数；不含正文 |
| `errored` | info | 仅错误路径设为 `true` |
| `text` | **debug only** | 消息正文，**必须过 redaction**；prod 默认 info level 不记 |

**禁止在 info 及以上 level 把消息正文写入日志。** debug level 也须经 `docs/dev/spec/security/redaction.md` 脱敏后才落盘。

## 禁止字段

清单见 [`../security/redaction.md` §必过滤项](../security/redaction.md#必过滤项)（owner）。日志 sink 在出口前调用 redactor 拦截，本 spec 不复述清单。

## 输出

### 生产

- JSONL 落盘 `~/.agent-nexus/logs/<date>.jsonl`
- 每行一个 JSON
- 默认 30 天滚动

### 开发

- 彩色 pretty 输出到 stderr
- 字段一致，格式为人类可读

### OTel（可选）

- 通过环境变量 `OTEL_EXPORTER_OTLP_ENDPOINT` 开启
- 只导出 logs；MVP 不做 traces/metrics 导出

## 错误日志必含

当 `level: error`：

- `errorKind`：`user|platform|agent|internal`（见 [`../../standards/errors.md`](../../standards/errors.md)）
- `code`：错误码
- `cause`：原始错误字符串
- `stack`：栈（如有）

## 测试约束

- 关键业务事件有断言测试（确保不被无意移除）
- 禁止断言 log 消息的完整文本（只断 event + 关键字段）
- 脱敏规则有单独的 red-team 测试（构造含密钥的事件，断言 log 里不出现）

## 反模式

- 用字符串拼接代替结构化字段
- 自创与本 spec 不同义的字段名（例：用 `trace_id` 而 spec 是 `traceId`）
- 把密钥或 PII 放进 `msg` 字段
- 一个业务动作打 5 条 log（选最能代表整件事的那条）
- 缺 `traceId` 不敢打 log（宁可生成一次性 `traceId`，也不要没有）
