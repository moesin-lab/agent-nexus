---
title: ADR-0015：多平台多 Agent 命名配置
type: adr
status: active
summary: 用 platforms[] 与 agents[] 命名集合替代单 Discord bot + 单 agent selector，并通过平台侧 bindings 显式路由到 agent
tags: [adr, decision, config, routing, multi-agent]
related:
  - dev/adr/0014-agent-backend-codex-cli
  - dev/spec/config-routing
  - dev/spec/platform-adapter
  - dev/spec/agent-runtime
  - dev/spec/message-flow
adr_status: Proposed
adr_number: "0015"
decision_date: 2026-05-24
supersedes: null
superseded_by: null
---

# ADR-0015：多平台多 Agent 命名配置

- **状态**：Proposed
- **日期**：2026-05-24
- **决策者**：senticx@foxmail.com
- **相关 ADR**：ADR-0001、ADR-0002、ADR-0014

## 状态变更日志

- 2026-05-24：Proposed

## Context

agent-nexus 已经有两个 agent backend：Claude Code CLI 默认后端与 Codex CLI 显式后端。当前配置仍是单实例形态：顶层 `discord` 表示唯一 Discord bot，顶层 `agent.backend` 在 `claudeCode` 与 `codex` 之间选择唯一 agent runtime。这个形态无法表达同一进程里同时运行多个 Discord bot，也无法把不同 channel 或用户条件路由到不同 agent 配置。

多 bot / 多 agent 不能靠隐式默认规则扩展。若未命中 binding 时自动落到默认 agent，或多个 binding 同时命中时任取一个，会把跨 channel、跨 bot、跨安全边界的输入送到错误后端。配置契约必须让每个平台实例和每个 agent 实例有稳定名称，并让路由关系显式、可审计、fail-closed。

## Options

### Option A：保留单实例配置，给 Discord 增加 per-channel backend override

- **是什么**：保留顶层 `discord`、`agent`、`claudeCode`、`codex`，在 `discord` 下增加 channel 到 backend 的局部 override。
- **优点**：短期改动少，现有 loader 结构变化小。
- **缺点**：只能解决 Discord channel 到 backend 的局部问题，不能表达多个 bot token / statePath，也不能表达同一 backend 的多套工作目录和安全策略。
- **主要风险**：把平台路由、backend selector 和 backend owner 字段混在一个对象里，后续每个平台都要发明自己的 override 语义。

### Option B：引入顶层 `platforms[]` 与 `agents[]`，binding 住在 platform 实例

- **是什么**：顶层配置包含命名 `platforms[]` 与命名 `agents[]`；每个 platform 实例按自身类型携带平台字段与 `bindings[]`，binding 通过 `agentName` 引用命名 agent，并携带平台侧条件，例如 Discord `channelIds` / `allowedUserIds`。
- **优点**：
  - 平台实例、agent 实例、路由关系三者边界清楚。
  - Discord 可以同时配置多个 bot，每个 bot 有独立 tokenRef、statePath、allowed users 与 channel binding。
  - Claude Code 与 Codex 可以各有多套配置，同一 backend 的不同工作目录或安全策略不需要复制顶层 selector。
  - 未命中、重复命中、缺失引用、名称重复都能在 loader / router 层 fail-closed。
- **缺点**：需要一次配置迁移，CLI 组装逻辑要从单 platform / 单 agent 升级为集合。
- **主要风险**：如果 CLI 直接理解所有平台与 backend 私有字段，会破坏 owner parser 边界；缓解见 `config-routing.md` 的 owner 校验规则。

### Option C：把 binding 放在独立顶层 `routes[]`

- **是什么**：`platforms[]` 与 `agents[]` 仍为命名集合，但路由放在顶层 `routes[]`，每条 route 同时引用 `platformName` 与 `agentName`。
- **优点**：路由集中展示，跨平台通用字段可统一。
- **缺点**：平台侧条件会被迫住进顶层 route schema，CLI 必须理解 Discord 的 channel/user 条件；新增平台时 route schema 继续膨胀。
- **主要风险**：违反 platform package owner parser 校验平台专属字段的边界。

## Decision

选 **Option B：顶层 `platforms[]` 与 `agents[]`，binding 住在 platform 实例**。

## Consequences

### 正向

- 配置能同时表达多个平台 bot 与多套 agent runtime，路由关系通过名称引用可审计。
- Discord channel bind 是 platform-discord 的字段语义，CLI 只做组合校验和引用校验。
- daemon 可以继续不读取 backend / platform 私有配置，只接收 CLI 组装好的 platform adapter、agent runtime 与 routing table。
- 安全默认值明确：未命中 binding、多个 binding 命中、引用不存在、名称重复、平台条件非法都拒绝启动或拒绝 dispatch，不选择隐式默认 agent。

### 负向

- 现有 `config.json` 单实例形态不能静默半兼容；P9 需要给出迁移错误或显式迁移路径。
- `SessionKey` / routing context 需要包含 platform instance identity，避免两个 Discord bot 的同 channel/user 发生会话串线。
- CLI 需要维护 platform registry 与 agent registry，先解析 owner 字段，再组装 routing table。

### 需要后续跟进的事

- P9 实现新 config loader：解析 `platforms[]`、`agents[]`、binding；校验唯一性、引用、backend/type、空 binding、Discord 条件。
- P10 升级 runtime 组装与 routing：创建多个 platform adapter 与 agent runtime，按 platform instance + binding 条件选择 agent。
- P11 收口 Discord channel bind 与多 bot 会话隔离测试。
- P12 更新 README、product user guide、ops runbook 与端到端示例。

## Out of scope

- 不新增第二个 IM 平台；P8 只定义多 platform 实例机制，当前落地平台仍是 Discord。
- 不改变 Claude Code 或 Codex backend 的安全默认值；backend 专属字段仍由各自 package parser 拥有。
- 不定义 UI 管理配置的形态；当前配置源仍是本地 JSON 与 secret file/ref。
- 不决定从 `feature/codex_agent` 合入 `main` 的时间。

## Amendments

无。

## 参考

- 相关 spec：[`../spec/config-routing.md`](../spec/config-routing.md)、[`../spec/message-flow.md`](../spec/message-flow.md)、[`../spec/platform-adapter.md`](../spec/platform-adapter.md)、[`../spec/agent-runtime.md`](../spec/agent-runtime.md)
