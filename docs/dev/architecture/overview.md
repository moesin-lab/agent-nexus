---
title: 架构总览
type: architecture
status: active
summary: agent-nexus 的模块结构（cmd / core / agent / platform 中枢辐射模型）、数据流、横切关注点与架构反模式
tags: [architecture, hub-and-spoke, modules, session, discord, cc-cli]
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

## 模块结构

> **命名维度 disambiguation**：本文中 `cmd` / `core` / `agent` / `platform` 是**模块概念名**（按职责分类），物理对应 ADR-0004 的 monorepo packages（详见 §职责划分各模块的 package 标注）。文档里带点的 namespace prefix（`daemon.logger` / `daemon.idempotency` 等）= `@agent-nexus/daemon` 的 import path。
>
> **本项目不使用 "三层结构 / layered architecture" 措辞**——layered architecture 暗示线性堆叠 + 自上而下依赖，与 agent-nexus 实际的中枢辐射依赖关系不符（旧版措辞已归档到 [`docs/_deprecated/architecture/three-layer-vocabulary.md`](../../_deprecated/architecture/three-layer-vocabulary.md)）。本项目采用 **hub-and-spoke（中枢辐射）模块模型**，与权威开源对标（LSP / DAP / MCP / Continue.dev）使用 client/server/adapter/extension/binary 等角色名一致。

借鉴 cc-connect 的模块划分，但**依赖方向更严**（见 [`dependencies.md`](dependencies.md)）：

```
                       cli / cmd
                      （拼装入口）
                          │
        ┌─────────────────┼─────────────────┐
        │                 │                 │
     agent/*           daemon            platform/*
   （agent 适配器）   （核心引擎+横切）   （IM/transport 适配器）
        │                 │                 │
        └─────────────────┴─────────────────┘
                          │
                       protocol
                  （类型 + 接口契约）
```

### 职责划分

- **`core` 模块**（中枢）：引擎 + 横切能力。物理位置：`@agent-nexus/daemon` package。是 hub，只依赖语言标准库与少量通用工具，不感知具体 agent / platform 实现。
- **`agent/<name>` 模块**（agent 适配器）：具体 agent 后端实现。当前只有 `claudecode`。物理位置：`@agent-nexus/agent-<name>` 独立 package（如 `@agent-nexus/agent-claudecode`），通过注册表接入 daemon。
- **`platform/<name>` 模块**（IM/transport 适配器）：具体 IM 平台或 transport 实现。当前只有 `discord`。物理位置：`@agent-nexus/platform-<name>` 独立 package（如 `@agent-nexus/platform-discord`），通过注册表接入 daemon。
- **`cmd` 模块**（拼装入口）：可执行入口，拼装 daemon + 启用的 agent / platform，加载配置。物理位置：`@agent-nexus/cli` package。

接口契约（`PlatformAdapter` / `AgentRuntime`）和归一化类型（`NormalizedEvent` / `AgentEvent` / `OutboundMessage` 等）住 `@agent-nexus/protocol` package（leaf 包，无依赖）。

### 强约束

1. **所有跨模块交互必须走 `docs/dev/spec/` 定义的接口。** 新增能力先改 spec，再改代码。
2. **横切能力（观测、幂等、限流、脱敏）由 `core` 模块（`@agent-nexus/daemon`）强制提供，** 不允许 platform/agent 自己实现一套。
3. **platform/agent 不得引入除 `daemon` 与 `protocol` 以外的内部 package**，彼此也不得互相引用。

## 最小数据流

### 入站（用户 → agent）

```
Discord gateway event
        │
        ▼
platform/discord
  - 把 Discord 事件解析成 NormalizedEvent（见 spec/message-protocol）
  - 打 traceId、sessionKey
  - 不做业务决策（不做幂等、不做权限、不做限流）
        │
        ▼
daemon.Engine.dispatch(NormalizedEvent)
  - 权限/白名单检查（见 spec/security）
  - 幂等去重：daemon.idempotency.checkAndSet(sessionKey, messageId)（见 spec/idempotency）
  - 限流/预算检查（见 spec/cost-and-limits）
  - 路由到对应 session 的 FIFO 队列
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
daemon.Engine 聚合
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
- messageId 幂等表由 daemon 统一维护
- gateway 断连恢复策略由 daemon 驱动，platform 只负责重建连接

## 横切关注点

下列能力由 daemon 提供给 platform/agent 使用，**禁止重复实现**：

| 能力 | 入口 | spec |
|---|---|---|
| 结构化日志 + traceId | `daemon.logger` | `spec/observability.md` |
| Session 管理 | `daemon.sessions` | `architecture/session-model.md` |
| 幂等去重 | `daemon.idempotency` | `spec/idempotency.md` |
| 限流 / 退避 | `daemon.ratelimit` | `spec/cost-and-limits.md` |
| Usage 记账（turn / tool / wallclock / token / cost） | `daemon.counters` | `spec/cost-and-limits.md` |
| `$` 预算（opt-in） | `daemon.quota-enforcer` | `spec/cost-and-limits.md` |
| 权限 / allowlist | `daemon.auth` | `spec/auth.md` |
| 工具与工作目录边界 | `daemon.toolguard` | `spec/tool-boundary.md` |
| 密钥管理 | `daemon.secrets` | `spec/secrets.md` |
| 输出脱敏 | `daemon.redact` | `spec/redaction.md` |
| 持久化 | `daemon.store` | `spec/persistence.md` |

## 进程模型

- 单进程：一个 agent-nexus 进程
- 子进程：每个活跃 session 对应一个 CC CLI 子进程（或按策略共享，详见 `spec/agent-runtime.md`）
- 长连接：Discord gateway 一条 WebSocket
- 落盘：本地 SQLite（或等效） + JSONL 日志

## 反模式（架构）

- `platform/discord` 引用 `agent/claudecode`（违反模块边界 / 依赖方向）
- `core` 模块引用具体 platform 或 agent（违反中枢定位）
- 在 adapter 里自己写日志、自己做重试、自己管 session（横切能力重复实现）
- 用全局变量共享状态（一律走 daemon 的 registry 与依赖注入）
- 跨 adapter 复用 Discord 特定结构（必须先归一化到 NormalizedEvent）

## 不做的事

- 不做消息总线 / 事件溯源 / CQRS 等重型架构模式——单用户单机，直接函数调用就够
- 不做插件热加载——启动时注册即可
- 不做分布式 lock、集群——形态就是本机单机
