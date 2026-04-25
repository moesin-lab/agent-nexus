---
title: Spec：Message Flow（dispatch pipeline 全景）
type: spec
status: active
summary: IM ↔ daemon ↔ agent 的入站/出站全链路 + 横切检查顺序 + 错误路径；整合各 spec 反向链接
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

本 spec **不重写**各步骤细节（见对应子 spec 反向链接），只提供**全景视图**——读完本 spec + 三大契约能在心里画出整条链路。

> **package 归属**：dispatch pipeline 实现住在 `@agent-nexus/daemon`（核心引擎 + 横切），由 `@agent-nexus/platform-<name>` 和 `@agent-nexus/agent-<name>` 在两端接入。详见 [`adr/0004-language-runtime.md`](../adr/0004-language-runtime.md) §TS-P7。

---

## 入站链路（外部 IM → agent 后端）

```
[外部 IM 服务，如 Discord gateway]
        │
        │  (1) IM 协议事件（Discord MESSAGE_CREATE / INTERACTION_CREATE / ...）
        ▼
@agent-nexus/platform-<name>  (PlatformAdapter 实现)
  - 解析 IM 协议为 NormalizedEvent (见 spec/message-protocol.md)
  - 打 traceId, sessionKey
  - 不做业务决策（不做 auth / 幂等 / 限流）
        │
        │  (2) NormalizedEvent
        ▼
@agent-nexus/daemon · daemon.Engine.dispatch(NormalizedEvent)
  ├─ daemon.auth          权限/白名单检查      (见 spec/security/auth.md §权限检查位置)
  │     拒绝 → 打 auth_denied 日志 + 可选 DM 通知 → 流程终止
  │     通过 ↓
  ├─ daemon.idempotency   幂等去重              (见 spec/infra/idempotency.md §流程)
  │     命中 "processed"  → 丢弃事件（已处理）
  │     命中 "processing" → 跳过（上一次还在）
  │     命中 "failed" 在窗口内 → 重试，标 "processing"
  │     未命中 → 标 "processing" ↓
  ├─ daemon.ratelimit     限流/预算检查        (见 spec/infra/cost-and-limits.md)
  │     拒绝 → 打 ratelimit_exceeded 日志 + 可选用户提示 → 流程终止
  │     通过 ↓
  └─ daemon.sessions      路由到 sessionKey FIFO 队列  (见 architecture/session-model.md)
        │
        │  (3) AgentInput（按 sessionKey 串行出队）
        ▼
@agent-nexus/agent-<name>  (AgentRuntime 实现)
  ├─ daemon.toolguard     工具与工作目录边界（出口前过）  (见 spec/security/tool-boundary.md)
  │     拒绝 → turn_finished{stop_reason: tool_denied} → 流程终止
  │     通过 ↓
  ├─ AgentRuntime.sendInput(session, input)
  │     管理 agent 后端进程（CC CLI 子进程 spawn / reuse）
  │     翻译 AgentInput 为后端可懂格式（如 CC CLI stdin 协议）
        │
        │  (4) 后端协议（如 CC CLI stdin JSON）
        ▼
[外部 agent 后端，如 Claude Code CLI 子进程]
```

---

## 出站链路（agent 后端 → 外部 IM）

```
[外部 agent 后端，如 CC CLI 子进程]
        │
        │  (1) 后端协议（如 CC CLI stdout stream-json）
        ▼
@agent-nexus/agent-<name>  (AgentRuntime 实现)
  - 解析后端 stdout 为 AgentEvent (见 spec/agent-runtime.md §AgentEvent，spec/agent-backends/claude-code-cli.md §事件映射)
  - 类型：thinking / tool_call / text_delta / final / usage / turn_finished
        │
        │  (2) AgentEvent 流（push 给 daemon）
        ▼
@agent-nexus/daemon · daemon.Engine 聚合
  ├─ daemon.counters     usage 记账                   (见 spec/infra/cost-and-limits.md / spec/infra/observability.md)
  │     AgentEvent{type:usage} → llm_call_finished 结构化日志
  ├─ daemon.redact       脱敏（绝对路径/token/secrets）  (见 spec/security/redaction.md)
  │     失败 → 打 redact_failure 日志 → 兜底丢弃可疑片段
  └─ daemon.sessions     按 sessionKey 切片合并        (见 architecture/session-model.md / spec/message-protocol.md §切片)
        │
        │  (3) OutboundMessage
        ▼
@agent-nexus/platform-<name>.send(sessionKey, OutboundMessage)
  - 把 OutboundMessage 反译为 IM 协议（Discord 消息 / 编辑 / 反应）
  - 记录 MessageRef（便于 edit/delete）
        │
        │  (4) IM 协议消息
        ▼
[外部 IM 服务]
```

---

## 错误路径汇总

| 出口位置 | 触发条件 | 行为 | 详见 |
|---|---|---|---|
| auth 拒绝 | 身份不在 allowlist / 公开 channel 转私域失败 | `auth_denied` 日志 + 可选 DM 通知 + 流程终止 | [`security/auth.md`](security/auth.md) §权限检查位置 |
| 幂等命中 "processed" | 重放已处理的 messageId | 静默丢弃事件 | [`infra/idempotency.md`](infra/idempotency.md) §流程 |
| 幂等命中 "processing" | 上一次还在进行中 | 跳过 | [`infra/idempotency.md`](infra/idempotency.md) §流程 |
| ratelimit 拒绝 | 触发 turn / tool / wallclock / token 硬限或 $ 预算上限 | `ratelimit_exceeded` 日志 + 用户提示（按策略）+ 流程终止 | [`infra/cost-and-limits.md`](infra/cost-and-limits.md) |
| toolguard 拒绝 | agent 调用未授权工具或越界目录 | `turn_finished{stop_reason: tool_denied}` + 终止当前 turn | [`security/tool-boundary.md`](security/tool-boundary.md) |
| redact 失败 | 脱敏规则匹配但替换异常 | `redact_failure` 日志 + 兜底丢弃可疑片段 | [`security/redaction.md`](security/redaction.md) |
| agent 子进程崩溃 | CC CLI 子进程退出码非 0 / SIGKILL | `agent_crashed` 日志 + session 标 failed + 按策略重启 | [`agent-backends/claude-code-cli.md`](agent-backends/claude-code-cli.md) §退出码 |
| platform 发送失败 | Discord API 错误 / gateway 断连 | 重试指数退避 / 兜底丢弃 / 用户层降级提示 | [`platform-adapter.md`](platform-adapter.md) §发送语义 |

---

## 顺序硬约束

1. **auth 永远先于 idempotency**——拒绝事件不进入幂等表（避免 fail2ban-style 攻击者用 messageId 占位）
2. **idempotency 先于 ratelimit**——重放事件不应消耗限流配额
3. **ratelimit 先于 sessions FIFO 入队**——避免被拒绝的事件排队等待
4. **toolguard 在 sendInput 出口处**——agent 调用工具时实时校验，不在入站时一次性放行
5. **同 sessionKey 串行**——见 [`architecture/session-model.md`](../architecture/session-model.md) §FIFO 队列
6. **redact 在所有出站事件路径上无例外**——包括日志 / 数据库 / IM 输出，无绕过通道（见 [`security/redaction.md`](security/redaction.md)）

---

## 反模式

- **跨 daemon import**：platform-* 或 agent-* 直接 import 另一个 platform-* / agent-* package（违反 [`architecture/dependencies.md`](../architecture/dependencies.md) 禁止方向）
- **adapter 自实现横切**：platform / agent transfer 自己写 logger / 自己做幂等 / 自己管 session（违反 [`architecture/overview.md`](../architecture/overview.md) §"比 cc-connect 更严的约束" 第 2 条）
- **跳过 redact**：在某条出站路径上偷偷绕过 redact（违反 [`security/redaction.md`](security/redaction.md) §兜底原则）
- **打破顺序硬约束**：把 auth 移到 idempotency 之后 / 在 ratelimit 之前不做 idempotency / 等

---

## 与各 spec 的关系

本 spec 是 dispatch pipeline 的**导航图**——把分散在各 spec 的步骤串成完整链路，但不重述各步骤的细节字段 / 算法 / 边界。

| 维度 | 权威源 |
|---|---|
| NormalizedEvent / AgentEvent / OutboundMessage 字段定义 | [`message-protocol.md`](message-protocol.md) |
| PlatformAdapter 接口签名与能力声明 | [`platform-adapter.md`](platform-adapter.md) |
| AgentRuntime 接口签名与 session 生命周期 | [`agent-runtime.md`](agent-runtime.md) |
| 各横切能力具体规则 | [`security/`](security/) / [`infra/`](infra/) |
| 三层结构（已废止）/ hub-and-spoke 模块结构 | [`../architecture/overview.md`](../architecture/overview.md) §模块结构 |
| Session 模型与 FIFO 队列 | [`../architecture/session-model.md`](../architecture/session-model.md) |
| 各 package 物理位置与依赖方向 | [`../architecture/dependencies.md`](../architecture/dependencies.md) / [`../adr/0004-language-runtime.md`](../adr/0004-language-runtime.md) §TS-P7 |
