---
title: ADR-0014：Agent 后端扩展——Codex CLI
type: adr
status: active
summary: 在保留 Claude Code 默认后端的同时新增 Codex CLI 后端；以 exec --json + exec resume 作为已验证主路径
tags: [adr, decision, codex, agent-runtime]
related:
  - dev/adr/0002-agent-backend-claude-code-cli
  - dev/adr/0011-turn-layering
  - dev/spec/agent-runtime
  - dev/spec/agent-backends/codex-cli
adr_status: Proposed
adr_number: "0014"
decision_date: 2026-05-23
supersedes: null
superseded_by: null
---

# ADR-0014：Agent 后端扩展——Codex CLI

- **状态**：Proposed
- **日期**：2026-05-23
- **决策者**：senticx@foxmail.com
- **相关 ADR**：ADR-0002、ADR-0011

## 状态变更日志

- 2026-05-23：Proposed

## Context

agent-nexus 当前只有 Claude Code CLI 后端。它满足最初的"从 IM 遥控本机 Claude Code"目标，但 `AgentRuntime` 本身已经按可插拔后端设计，第二个后端会反向检验接口、配置归属和能力声明是否真实。

本次接入 Codex CLI。接入前验证已经确认 `codex-cli 0.133.0` 的可用路径：`codex exec --json` 输出 JSONL，`codex exec resume <thread_id>` 可以续接上下文，`command_execution` 事件能表达 shell 工具开始/完成，`turn.completed.usage` 提供 token 用量，认证/模型错误会落到 `error` 与 `turn.failed`。中断时 Codex 不产 terminal JSONL，runtime 必须合成 `turn_finished{reason:"user_interrupt"}`。

Codex CLI 与 Claude Code CLI 的关键差异是进程模型和安全模型。Claude Code 主路径是长驻 stream-json 子进程，且可通过已验证的 `can_use_tool` control 通道实现执行前工具白名单。Codex 当前只把非交互 `exec --json` + `resume` 纳入 contract 主路径；help 中没有 tool whitelist / allowlist / denylist 语义，安全默认值只能先由 sandbox、approval、working directory、add-dir 与 user config/rules 加载策略表达。

因此本 ADR 不是替换 ADR-0002，而是决定把 Codex 作为第二个可选 backend 接入，并把"哪些能力真实可声明"锁到 backend contract spec。CLI 只做配置路由和拼装，daemon 继续只依赖 `AgentRuntime`。

## Options

### Option A：替换默认后端为 Codex CLI

- **是什么**：把 CLI 默认 agent 从 Claude Code 改为 Codex，并迁移现有配置。
- **优点**：实现路径单一，减少多 backend 分支。
- **缺点**：破坏已有 Claude Code 用户路径；Codex 工具白名单能力弱于现有 CC 强制点；无法作为第二后端检验 `AgentRuntime` seam。
- **主要风险**：为了接 Codex 牺牲已有默认能力和安全承诺。

### Option B：保留 Claude Code 默认，新增 Codex 可选后端

- **是什么**：新增 `@agent-nexus/agent-codex` package；配置用 `agent.backend = "claudecode" | "codex"` 选择；默认仍为 `claudecode`。
- **优点**：
  - 不破坏现有用户配置和默认行为。
  - 第二后端能真实施压 `AgentRuntime` / capability / config ownership。
  - Codex 安全能力可按 probe fail-closed，不需要伪装成 Claude Code 等价能力。
- **缺点**：CLI 需要路由两个 backend package；后续要维护两套 backend contract fixture。
- **主要风险**：如果 config 路由写进 CLI 业务逻辑，会违反 hub-and-spoke 边界；缓解见 spec 中的配置归属约束。

### Option C：先做验证脚本，不接入产品配置

- **是什么**：只保留 standalone verifier，不新增 runtime package。
- **优点**：短期改动最少。
- **缺点**：不能让 daemon/cli 选择 Codex backend，无法满足验收；验证结果不能转化为产品契约。
- **主要风险**：实验长期游离在仓库外，后续实现继续重复调研。

## Decision

选 **Option B：保留 Claude Code 默认，新增 Codex CLI 可选后端**。

## Consequences

### 正向

- `AgentRuntime` 第一次有两个真实实现，接口和 capability 声明会被 Codex 的非长驻进程模型反向校准。
- 现有 Claude Code 默认路径保持稳定，Codex 通过显式配置启用。
- Codex backend 的安全边界按已验证事实 fail-closed：默认不用危险 bypass，不声称 native tool whitelist。

### 负向

- CLI 配置需要引入一个 backend selector，并同时保留 `claudeCode` 与 `codex` owner 配置块。
- Codex 的 `sendInput` 要用"每 turn 一个 exec/resume 子进程"实现，`AgentSession.pid` 只能表示当前 in-flight turn 子进程。
- Codex 无原生 terminal interrupt JSONL，runtime 必须维护去重和合成终态逻辑。

### 需要后续跟进的事

- 新增 `packages/agent/codex`，导出 `createCodexRuntime`、`parseCodexConfig`、`CodexConfigError`、`runCompatibilityProbe`。
- runtime 必须覆盖 JSONL fixture、resume、多轮、错误、usage、tool events、interrupt 合成。
- CLI 只按 `agent.backend` 做路由，不在 `packages/cli` 写 Codex 业务逻辑。
- 端到端 verifier 必须验证两轮会话、中断和错误路径；认证缺失时给明确 skip/fail reason。

## Out of scope

- 不决定把 Codex 设为默认后端；默认 backend 已在本 ADR 与 spec 中定为 `claudecode`，未来若要调整默认值需另行修订。
- 不决定支持 Codex experimental `exec-server` / `app-server` wire protocol；当前 contract 未验证该路径，默认不用。
- 不决定 Codex 的 native tool whitelist；当前未发现对应 CLI flag，能力声明必须标为不支持。
- 不决定从 `feature/codex_agent` 合入 `main` 的时间。

## Amendments

无。

## 参考

- 相关 spec：[`../spec/agent-backends/codex-cli.md`](../spec/agent-backends/codex-cli.md)、[`../spec/agent-runtime.md`](../spec/agent-runtime.md)
- 验证资产：[`../../../packages/agent/codex/testdata/jsonl/`](../../../packages/agent/codex/testdata/jsonl/)、[`../../../scripts/verify-codex-agent.sh`](../../../scripts/verify-codex-agent.sh)
