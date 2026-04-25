---
title: Spec：Message Flow（dispatch pipeline 全景）
type: spec
status: active
summary: IM ↔ daemon ↔ agent 的入站/出站全链路 + 横切检查顺序 + 错误路径；纯导航图，字段权威源指向各 spec
tags: [spec, message-flow, dispatch, pipeline, normalized-event, agent-event]
related:
  - dev/architecture/overview
  - dev/spec/platform-adapter
  - dev/spec/agent-runtime
  - dev/spec/message-protocol
  - dev/spec/security/auth
  - dev/spec/infra/idempotency
  - dev/spec/infra/cost-and-limits
  - dev/spec/security/redaction
  - dev/spec/security/tool-boundary
contracts:
  - DispatchPipeline
---

# Spec：Message Flow（dispatch pipeline 全景）

定义 agent-nexus 内部从外部输入到 agent 后端、再到外部输出的**完整 dispatch pipeline**——各步骤顺序、横切能力执行点、错误路径出口。

> **本 spec 是导航图，不是契约权威源**——所有具体字段、枚举值、接口签名以**各子 spec 为准**（每段标注权威源）。如果本文与子 spec 冲突，以子 spec 为准；同时本文需修正。

> **package 归属**：dispatch pipeline 实现住在 `@agent-nexus/daemon`（核心引擎 + 横切），由 `@agent-nexus/platform-<name>` 和 `@agent-nexus/agent-<name>` 在两端接入。详见 [`adr/0004-language-runtime.md`](../adr/0004-language-runtime.md) §TS-P7。

---

## 入站链路（外部 IM → agent 后端）

```
[外部 IM 服务，如 Discord gateway]
        │
        │  (1) IM 协议事件
        ▼
@agent-nexus/platform-<name>  (PlatformAdapter 实现，权威源：platform-adapter.md)
  - 解析 IM 协议为 NormalizedEvent（字段权威源：message-protocol.md §NormalizedEvent）
  - 打 traceId, sessionKey
  - 不做业务决策（不做 auth / 幂等 / 限流）
        │
        │  (2) NormalizedEvent
        ▼
@agent-nexus/daemon · daemon.Engine.dispatch(event)
  ├─ daemon.auth          权限/白名单检查      (权威源：security/auth.md §权限检查位置)
  │     拒绝 → 不插入幂等表（直接返回）→ 流程终止
  │     通过 ↓
  ├─ daemon.idempotency.checkAndSet(sessionKey, messageId)
  │                                              (权威源：infra/idempotency.md §流程)
  │     命中 "processed"  → 丢弃事件
  │     命中 "processing" → 跳过
  │     命中 "failed" 在窗口内 → 重试，标 "processing"
  │     未命中 → 插入 "processing"，继续 ↓
  ├─ daemon 限流/预算检查                       (权威源：infra/cost-and-limits.md)
  │     拒绝 → 流程终止
  │     通过 ↓
  └─ 投递到 sessionKey 的 FIFO 队列              (权威源：architecture/session-model.md)
                                                 处理完成后更新 status 为 "processed" / "failed"
        │
        │  (3) AgentInput（按 sessionKey 串行出队，字段权威源：agent-runtime.md §AgentInput）
        ▼
@agent-nexus/agent-<name>  (AgentRuntime 实现，权威源：agent-runtime.md)
  - AgentRuntime.sendInput(session, input)
  - 管理 agent 后端进程（CC CLI 子进程 spawn / reuse）
  - 翻译 AgentInput 为后端可懂格式（见 agent-backends/claude-code-cli.md §启动命令模板 / stdin 协议）
        │
        │  (4) 后端协议
        ▼
[外部 agent 后端，如 CC CLI 子进程]
```

**入站顺序硬约束**（权威源：security/auth.md §权限检查位置 + infra/idempotency.md §流程）：

`auth → idempotency → 限流/预算 → session 队列`

---

## 出站链路（agent 后端 → 外部 IM）

```
[外部 agent 后端，如 CC CLI 子进程]
        │
        │  (1) 后端协议
        ▼
@agent-nexus/agent-<name>  (AgentRuntime 实现)
  - 解析后端 stdout 为 AgentEvent
    （EventType 完整枚举权威源：agent-runtime.md §AgentEvent §EventType；含
     session_started / thinking / text_delta / text_final / tool_call_started /
     tool_call_progress / tool_call_finished / turn_finished / usage / error /
     session_stopped）
  - tool 调用前 daemon.toolguard 校验（见下文 §工具边界校验）
        │
        │  (2) AgentEvent 流（push 给 daemon）
        ▼
@agent-nexus/daemon · daemon.Engine 聚合
  ├─ daemon.counters     usage 事件记账           (权威源：infra/cost-and-limits.md +
  │                                                infra/observability.md §"LLM 调用事件必含字段")
  │                       AgentEvent{type:usage} → llm_call_finished 结构化日志（字段一一对应）
  ├─ daemon.redact       脱敏（绝对路径/token/secrets）
  │                                              (权威源：security/redaction.md)
  └─ daemon.sessions     按 sessionKey 切片合并   (权威源：message-protocol.md §切片 +
                                                  architecture/session-model.md)
        │
        │  (3) OutboundMessage（字段权威源：platform-adapter.md §OutboundMessage）
        ▼
@agent-nexus/platform-<name>.send(sessionKey, OutboundMessage)
  - 把 OutboundMessage 反译为 IM 协议
  - 记录 MessageRef（platform-adapter.md §MessageRef）
        │
        │  (4) IM 协议消息
        ▼
[外部 IM 服务]
```

---

## 工具边界校验（tool-boundary）

**位置**：tool 调用是 agent runtime 内部行为，校验发生在 agent 出口、daemon 内部 hook。

```
agent 后端尝试调用工具（如 CC CLI 触发 tool_use）
        │
        ▼
AgentRuntime 实现内调用 daemon.toolguard
        │                                    (权威源：security/tool-boundary.md)
        ├─ 工具不在 SessionConfig.toolWhitelist
        │     → adapter 不转发工具调用请求，不发送结果
        │     → 产出 AgentEvent{type: error, payload: {errorKind, code, message}}
        │       (权威源：agent-runtime.md §error 事件 payload)
        │
        └─ maxToolCallsPerTurn 命中
              → daemon.quota-enforcer 注入
              → 产出 AgentEvent{type: turn_finished, payload: {reason: "tool_limit"}}
                (权威源：agent-runtime.md §TurnEndReason，"daemon 注入"行)
```

> **TurnEndReason 完整枚举**（权威源 agent-runtime.md §TurnEndReason）：
> `stop` / `max_tokens` / `user_interrupt` / `error` / `tool_limit` / `wallclock_timeout` / `budget_exceeded`

---

## 错误路径汇总

| 出口位置 | 触发条件 | 行为 | 权威源 |
|---|---|---|---|
| auth 拒绝 | 身份不在 allowlist / 公开 channel 转私域失败 | 不插入幂等表，直接返回；打 `auth_denied` 日志 | [`security/auth.md`](security/auth.md) |
| 幂等命中 "processed" | 重放已处理的 messageId | 静默丢弃事件 | [`infra/idempotency.md`](infra/idempotency.md) |
| 幂等命中 "processing" | 上一次还在进行中 | 跳过 | [`infra/idempotency.md`](infra/idempotency.md) |
| 限流/预算拒绝 | 触发 turn / tool / wallclock / token 硬限或 $ 预算上限 | 流程终止；按策略产生用户提示 | [`infra/cost-and-limits.md`](infra/cost-and-limits.md) |
| 工具白名单外 | agent 调用未授权工具 | adapter 不转发；产出 `AgentEvent{type: error}` | [`security/tool-boundary.md`](security/tool-boundary.md) §合约测试 |
| `tool_limit` 命中 | maxToolCallsPerTurn 命中 | daemon 注入 `turn_finished{reason: "tool_limit"}` | [`agent-runtime.md`](agent-runtime.md) §TurnEndReason |
| `wallclock_timeout` | perInputTimeoutMs 命中 | daemon 注入 `turn_finished{reason: "wallclock_timeout"}` | [`agent-runtime.md`](agent-runtime.md) §TurnEndReason |
| `budget_exceeded` | opt-in $ 预算耗尽 | daemon 注入 `turn_finished{reason: "budget_exceeded"}` | [`agent-runtime.md`](agent-runtime.md) §TurnEndReason |
| redact 失败 | 脱敏规则匹配但替换异常 | 兜底丢弃可疑片段；打 redact 失败日志 | [`security/redaction.md`](security/redaction.md) |
| agent 子进程崩溃 | CC CLI 子进程退出码非 0 / SIGKILL | 产出 `AgentEvent{type: error}` + 按策略重启 | [`agent-backends/claude-code-cli.md`](agent-backends/claude-code-cli.md) §退出码 |
| platform 发送失败 | IM API 错误 / gateway 断连 | 重试指数退避 / 兜底丢弃 / 用户层降级提示 | [`platform-adapter.md`](platform-adapter.md) §发送语义 |

---

## 顺序硬约束

入站（权威源：infra/idempotency.md §流程）：

1. **auth 永远先于 idempotency**——拒绝事件不进入幂等表（避免攻击者用 messageId 占位）
2. **idempotency 先于 限流/预算**——重放事件不应消耗限流配额
3. **限流/预算 先于 session FIFO 入队**——避免被拒绝的事件排队等待
4. **同 sessionKey 串行**——见 [`architecture/session-model.md`](../architecture/session-model.md)

出站：

5. **redact 在所有出站事件路径上无例外**——包括日志 / 数据库 / IM 输出（权威源：[`security/redaction.md`](security/redaction.md) §兜底原则）

---

## 反模式

- **跨 transfer import**：platform-* 或 agent-* 直接 import 另一个 platform-* / agent-* package（违反 [`architecture/dependencies.md`](../architecture/dependencies.md) 禁止方向）
- **adapter 自实现横切**：platform / agent transfer 自己写 logger / 自己做幂等 / 自己管 session（违反 [`architecture/overview.md`](../architecture/overview.md) §"强约束" 第 2 条）
- **跳过 redact**：在某条出站路径上偷偷绕过 redact
- **打破入站顺序**：把 auth 移到 idempotency 之后 / 在限流之前不做 idempotency / 等

---

## 与各 spec 的关系

本 spec 是 dispatch pipeline 的**导航图**——把分散在各 spec 的步骤串成完整链路，**不重述各步骤的细节字段 / 算法 / 边界**。

| 维度 | 权威源 |
|---|---|
| `NormalizedEvent` 字段定义 | [`message-protocol.md`](message-protocol.md) §NormalizedEvent |
| `AgentEvent` 完整 EventType 枚举与 payload 字段 | [`agent-runtime.md`](agent-runtime.md) §AgentEvent |
| `AgentInput` 字段 | [`agent-runtime.md`](agent-runtime.md) §AgentInput |
| `OutboundMessage` / `MessageRef` / `CapabilitySet` 字段 | [`platform-adapter.md`](platform-adapter.md) |
| `TurnEndReason` 枚举（含 daemon 注入项） | [`agent-runtime.md`](agent-runtime.md) §TurnEndReason |
| `UsageRecord` 字段 → `llm_call_finished` 日志映射 | [`agent-runtime.md`](agent-runtime.md) §UsageRecord + [`infra/observability.md`](infra/observability.md) |
| PlatformAdapter / AgentRuntime 接口签名 | [`platform-adapter.md`](platform-adapter.md) / [`agent-runtime.md`](agent-runtime.md) |
| 各横切能力具体规则 | [`security/`](security/) / [`infra/`](infra/) |
| 模块结构（hub-and-spoke） | [`../architecture/overview.md`](../architecture/overview.md) §模块结构 |
| Session 模型与 FIFO 队列 | [`../architecture/session-model.md`](../architecture/session-model.md) |
| 各 package 物理位置与依赖方向 | [`../architecture/dependencies.md`](../architecture/dependencies.md) / [`../adr/0004-language-runtime.md`](../adr/0004-language-runtime.md) §TS-P7 |
