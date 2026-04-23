---
title: 架构总览
type: architecture
status: active
summary: agent-nexus 的三层结构（cmd/core/agent+platform）、数据流、横切关注点与架构反模式
tags: [architecture, layering, session, discord, cc-cli]
related:
  - dev/architecture/session-model
  - dev/architecture/dependencies
  - dev/spec/platform-adapter
  - dev/spec/agent-runtime
  - dev/spec/message-protocol
---

# 架构总览

## 定位

agent-nexus 是一个**本机进程**，负责把 IM 平台（当前 Discord）的事件与本机 Claude Code CLI 的会话打通。它**不是**：

- 不是云服务（见 ADR-0003 本机桌面）
- 不是多 agent 编排器（一个 session 对一个 CC CLI 子进程）
- 不是通用 IM 机器人框架（Discord 是第一且当前唯一平台）

## 三层结构

参考 cc-connect 的三层划分，但**依赖方向更严**（见 [`dependencies.md`](dependencies.md)）：

```
┌──────────────────────────────────────────────────┐
│                       cmd/                       │  入口：CLI、daemon、配置加载
├──────────────────────────────────────────────────┤
│                       core/                      │  引擎、接口定义、session、幂等、限流、脱敏、观测
├───────────────────────┬──────────────────────────┤
│       agent/          │        platform/         │
│   └── claudecode/     │    └── discord/          │
│                       │                          │
│   （实现 core 定义的   │   （实现 core 定义的      │
│    AgentRuntime 接口）  │    PlatformAdapter 接口）│
└───────────────────────┴──────────────────────────┘
```

### 职责划分

- **`core/`**：引擎 + 接口 + 横切能力。是**中枢**，只依赖语言标准库与少量通用工具。
- **`agent/<name>/`**：具体 agent 后端实现。当前只有 `claudecode`。每个实现通过注册表接入 core。
- **`platform/<name>/`**：具体 IM 平台实现。当前只有 `discord`。每个实现通过注册表接入 core。
- **`cmd/`**：可执行入口，拼装 core + 启用的 agent + 启用的 platform，加载配置。

### 比 cc-connect 更严的约束

1. **所有跨层交互必须走 `docs/dev/spec/` 定义的接口。** 新增能力先改 spec，再改代码。
2. **横切能力（观测、幂等、限流、脱敏）由 `core/` 强制提供，** 不允许 platform/agent 自己实现一套。
3. **platform/agent 不得引入除 `core/` 以外的内部模块**，彼此也不得互相引用。

## 最小数据流

### 入站（用户 → agent）

```
Discord gateway event
        │
        ▼
platform/discord
  - 把 Discord 事件解析成 NormalizedEvent（见 spec/message-protocol）
  - 执行 messageId 幂等检查（调 core 的去重表）
  - 打 traceId、sessionKey
        │
        ▼
core.Engine.dispatch(NormalizedEvent)
  - 路由到对应 session
  - 跑限流/预算检查（见 spec/cost-and-limits）
  - 跑权限/白名单检查（见 spec/security）
        │
        ▼
agent/claudecode.SendInput(session, input)
  - 管理 CC CLI 子进程（spawn / reuse）
  - 写入 stdin，启动/恢复会话
        │
        ▼
CC CLI 产生输出事件流（stdout）
```

### 出站（agent → 用户）

```
CC CLI stdout 流
        │
        ▼
agent/claudecode
  - 解析 stdout 为标准化 AgentEvent（thinking / tool_call / text_delta / final）
        │
        ▼
core.Engine 聚合
  - 记账（token、成本）
  - 应用脱敏规则（去除绝对路径、token）
  - 按策略合并/切片（Discord 消息 2000 字符限制）
        │
        ▼
platform/discord.Send(sessionKey, OutboundMessage)
  - 调用 discord 发送消息
  - 记录 MessageRef 便于 edit/delete
```

## 核心接口（概览）

具体字段见各 spec 文件。此处只列**形状**：

```text
interface PlatformAdapter {
    start(ctx)                              // 建立 gateway / 注册 webhook
    stop(ctx)
    onEvent(handler: (NormalizedEvent) -> void)
    send(sessionKey, OutboundMessage) -> MessageRef
    edit(messageRef, OutboundMessage) -> void
    delete(messageRef) -> void
    // 能力声明：支持的富交互形式
    capabilities() -> CapabilitySet
}

interface AgentRuntime {
    startSession(sessionKey, config) -> AgentSession
    sendInput(sessionSession, input) -> void
    stopSession(agentSession) -> void
    onEvent(handler: (AgentEvent) -> void)
}

interface Engine {
    dispatch(NormalizedEvent) -> void
    // 内部持有：sessions, idempotencyStore, rateLimiter, budgetTracker, redactor
}
```

## 会话模型

详见 [`session-model.md`](session-model.md)。核心：

- Session 由 `(platform, channelId, userId)` 作为 key
- 同 key 的消息串行处理
- messageId 幂等表由 core 统一维护
- gateway 断连恢复策略由 core 驱动，platform 只负责重建连接

## 横切关注点

下列能力由 `core/` 提供给 platform/agent 使用，**禁止重复实现**：

| 能力 | 入口 | spec |
|---|---|---|
| 结构化日志 + traceId | `core.logger` | `spec/observability.md` |
| Session 管理 | `core.sessions` | `architecture/session-model.md` |
| 幂等去重 | `core.idempotency` | `spec/message-protocol.md` |
| 限流 / 退避 | `core.ratelimit` | `spec/cost-and-limits.md` |
| Token / 成本记账 | `core.budget` | `spec/cost-and-limits.md` |
| 权限 / allowlist | `core.auth` | `spec/security.md` |
| 输出脱敏 | `core.redact` | `spec/security.md` |
| 持久化 | `core.store` | `spec/persistence.md` |

## 进程模型

- 单进程：一个 agent-nexus 进程
- 子进程：每个活跃 session 对应一个 CC CLI 子进程（或按策略共享，详见 `spec/agent-runtime.md`）
- 长连接：Discord gateway 一条 WebSocket
- 落盘：本地 SQLite（或等效） + JSONL 日志

## 反模式（架构层）

- `platform/discord` 引用 `agent/claudecode`（违反分层）
- `core/` 引用具体 platform 或 agent（违反中枢定位）
- 在 adapter 里自己写日志、自己做重试、自己管 session（横切能力重复实现）
- 用全局变量共享状态（一律走 core 的 registry 与依赖注入）
- 跨 adapter 复用 Discord 特定结构（必须先归一化到 NormalizedEvent）

## 不做的事

- 不做消息总线 / 事件溯源 / CQRS 等重型架构模式——单用户单机，直接函数调用就够
- 不做插件热加载——启动时注册即可
- 不做分布式 lock、集群——形态就是本机单机
