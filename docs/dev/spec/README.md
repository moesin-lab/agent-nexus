---
title: Spec 索引
type: index
status: active
summary: 接口契约与跨抽象层协议索引；分核心接口、横切基础设施、安全分区与 agent 后端契约
tags: [spec, navigation]
related:
  - dev/architecture/overview
  - dev/standards/spec
  - dev/standards/doc-ownership
  - dev/spec/platform-adapter
  - dev/spec/agent-runtime
  - dev/spec/message-protocol
---

# Spec（接口契约）

本目录定义**跨模块接口**与**跨抽象层协议**（这里"层"指 IM ↔ daemon ↔ agent 数据流的接口/抽象层，不是已废止的架构 layered architecture 概念；详见 [`../architecture/overview.md`](../architecture/overview.md) §模块结构）。所有契约**语言无关**（用伪代码 + 字段表），具体实现在代码里对齐本目录。

spec 触发条件（什么改动需要 spec / 何时可跳过）见 [`../standards/when-to-add-doc.md`](../standards/when-to-add-doc.md)；spec 产物写法标准（核心原则 / 合格条件 DoD / Seam 演进规则 / 反模式）见 [`../standards/spec.md`](../standards/spec.md)。

## 文档清单

### 核心接口（模块间契约，根下）

- [`platform-adapter.md`](platform-adapter.md) — IM 平台适配层接口
- [`agent-runtime.md`](agent-runtime.md) — Agent 后端适配层接口
- [`message-protocol.md`](message-protocol.md) — 归一化消息与事件类型定义

### `infra/` — 横切基础设施

- [`infra/idempotency.md`](infra/idempotency.md) — `(sessionKey, messageId)` 去重契约与 dispatch 流程
- [`infra/persistence.md`](infra/persistence.md) — 本地存储契约
- [`infra/observability.md`](infra/observability.md) — 日志/trace/metric 字段契约
- [`infra/cost-and-limits.md`](infra/cost-and-limits.md) — Limits（一等：失控保护 + 观测）/ $ 预算（二等 opt-in）
- [`infra/errors.md`](infra/errors.md) — daemon 内部错误对象与错误上下文字段契约

### `security/` — 安全分区（伞 + 四份子 spec）

- [`security/README.md`](security/README.md) — 威胁模型 + 跨分区索引 + Prompt Injection 综合缓解 + 启动自检清单
- [`security/auth.md`](security/auth.md) — 身份四元组 allowlist、会话绑定、公开 channel 转私域
- [`security/tool-boundary.md`](security/tool-boundary.md) — 工具白名单、工作目录、危险工具启用
- [`security/secrets.md`](security/secrets.md) — 密钥存储层级、禁止写入清单、轮换
- [`security/redaction.md`](security/redaction.md) — 出口脱敏 Redactor 必过滤项与合约测试

### `agent-backends/` — Agent 后端专属契约

- [`agent-backends/claude-code-cli.md`](agent-backends/claude-code-cli.md) — Claude Code CLI 的版本、命令模板、stream-json 协议、事件映射、UsageCompleteness、兼容性自检

## Spec 与 Package 对应关系

按 ADR-0004 §TS-P7 的 monorepo 包结构（详见 [`../adr/0004-language-runtime.md`](../adr/0004-language-runtime.md)）：

| Spec | 接口/类型住哪 | 实现住哪 |
|---|---|---|
| `platform-adapter.md` | `@agent-nexus/protocol`（`PlatformAdapter` 接口） | `@agent-nexus/platform-<name>`（如 `platform-discord`） |
| `agent-runtime.md` | `@agent-nexus/protocol`（`AgentRuntime` 接口） | `@agent-nexus/agent-<name>`（如 `agent-claudecode`） |
| `message-protocol.md` | `@agent-nexus/protocol`（`NormalizedEvent` / `AgentEvent` / `OutboundMessage` 等类型） | N/A（纯类型契约） |
| `agent-backends/*.md` | N/A（外部契约） | 各 `@agent-nexus/agent-<name>` 必须遵守 |
| `infra/*.md` | N/A | `@agent-nexus/daemon`（核心引擎 + 横切） |
| `security/*.md` | N/A | `@agent-nexus/daemon`（横切） |

## 阅读顺序

1. 先读 [`../architecture/overview.md`](../architecture/overview.md) 建立心智
2. 再读本目录核心三件套
3. 最后按需查阅横切四件套
