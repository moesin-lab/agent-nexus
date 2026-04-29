---
title: Spec 索引
type: index
status: active
summary: 接口契约与跨抽象层协议索引，分核心接口、横切基础设施、安全分区与 agent 后端契约
tags: [spec, navigation]
related:
  - dev/architecture/overview
  - dev/spec/platform-adapter
  - dev/spec/agent-runtime
  - dev/spec/message-protocol
---

# Spec（接口契约）

本目录定义**跨模块接口**与**跨抽象层协议**（这里"层"指 IM ↔ daemon ↔ agent 数据流的接口/抽象层，不是已废止的架构 layered architecture 概念；详见 [`../architecture/overview.md`](../architecture/overview.md) §模块结构）。所有契约**语言无关**（用伪代码 + 字段表），具体实现在代码里对齐本目录。

## 核心原则

- **先改 spec，再改代码**：任何涉及接口/协议的改动，PR 必须同时包含本目录对应文件的更新。
- **字段表权威**：字段名、类型、语义以本目录为准；代码里字段必须与之对齐。
- **不做示例代码**：spec 里可以写伪代码，但不示例具体语言（具体示例放 `testing/` 或代码注释）。
- **边界清晰**：每个 spec 文件定义一个明确的接口或协议，不交叉。

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

## 什么情况写 spec

满足任一条件就需要新增或修改 spec：

- 新增模块或新增模块间交互
- 改变已有接口的字段、语义、错误码
- 新增横切约束（observability 字段、限流策略、session 存储）

只改单一模块内部实现、不影响外部契约的，不需要改 spec。

## 何时可跳过 spec

以下改动允许在主路径"判断是否需要 spec"那一步直接跳过：

- 单一模块内部实现细节（无对外接口字段 / 错误码 / 语义变化）
- 文档错别字、链接修复、注释调整
- 测试代码新增 / 重构（spec 契约未变）
- 性能优化但接口与可观测行为未变

跳过 spec ≠ 跳过流程——**分支、PR、review、squash merge 不可跳过**，见 [`../process/workflow.md` §分支先行](../process/workflow.md#分支先行不可跳过)。是否同 PR 改 ADR / 测试，分别按 [`../adr/README.md` §何时可跳过 ADR](../adr/README.md#何时可跳过-adr) 与 [`../standards/testing.md` §何时可跳过新增/修改测试](../standards/testing.md#何时可跳过新增修改测试) 判定。

## 产物合格条件（DoD）

spec 合格的判据：

- frontmatter 字段齐（按 [`../standards/metadata.md`](../standards/metadata.md)）
- 至少包含字段表或伪代码接口（不是纯散文描述）
- 字段名 / 类型 / 语义清晰，无"将来再补"占位
- 边界清晰：每个 spec 文件定义一个明确的接口或协议，不交叉
- 每个方法显式标注调用顺序约束 / 并发安全语义 / 错误分类 / 幂等性——光有签名或字段表不算契约完整，caller 必须知道的不变量都属于接口
- reviewer 通读确认，无含糊或冗余表述

## Seam 演进规则

每个 spec'd 接口对应一个 seam（如 `PlatformAdapter` / `AgentRuntime`）。**单实例时接口形状是假说**——第一个实现跑通不代表接口设计正确，要等第二个 adapter 反向施压才知道哪些字段多了、哪些不变量错了。

规则：

- 接口形状在第二个 adapter 落地前**冻结**——不允许"为了未来 N 个后端"提前往接口加 flag / 字段 / 钩子。
- 真要为某条具体决策留设施位（如 `AgentCapabilitySet.supportsStdinInterrupt` 之于 ADR-0012 决策点 2），必须走 ADR Amendment 显式说明触发条件与回退路径，不在 spec 默默加。
- 第二个 adapter 接入时由它反向施压；接口与新 adapter 真实需求不符的，改接口形状，不用 capability flag 绕。

reviewer 在 spec PR 看到"为未来 N 个 X 准备"的字段、且无对应 ADR，应直接拒稿。

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
