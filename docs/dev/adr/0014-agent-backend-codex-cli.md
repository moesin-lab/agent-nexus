---
title: ADR-0014：Agent 后端扩展——Codex CLI
type: adr
status: active
summary: 新增 Codex CLI agent 后端实现；以 exec --json + exec resume 作为已验证主路径
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

Codex CLI 与 Claude Code CLI 的关键差异是进程模型和安全模型。Claude Code 主路径是长驻 stream-json 子进程，且可通过已验证的 `can_use_tool` control 通道实现执行前工具白名单。Codex 当前只把非交互 `exec --json` + `resume` 纳入 contract 主路径；help 中没有 tool whitelist / allowlist / denylist 语义，安全边界只能先由 sandbox、approval、working directory、add-dir 与 user config/rules 加载策略表达。

远程控制目标要求 agent-nexus 能表达高权限运行形态。Codex CLI 0.142.0 已把 `danger-full-access` 列为 `--sandbox` 可选值，因此 Codex backend contract 允许用户显式选择该 sandbox 作为 YOLO 模式；默认仍保持 `read-only`，且不透传 `--dangerously-bypass-approvals-and-sandbox` 作为独立配置入口。

因此本 ADR 不是替换 ADR-0002，也不定义最终配置 schema。它只决定把 Codex 作为第二个可选 backend 实现接入，并把"哪些能力真实可声明"锁到 backend contract spec。CLI 只做配置组合和运行时拼装，daemon 继续只依赖 `AgentRuntime`。

## Options

### Option A：替换 Claude Code 后端为 Codex CLI

- **是什么**：把 agent runtime 主实现从 Claude Code 改为 Codex，并迁移现有调用路径。
- **优点**：实现路径单一，减少多 backend 分支。
- **缺点**：破坏已有 Claude Code 用户路径；Codex 工具白名单能力弱于现有 CC 强制点；无法作为第二后端检验 `AgentRuntime` seam。
- **主要风险**：为了接 Codex 牺牲已有默认能力和安全承诺。

### Option B：保留 Claude Code 后端，新增 Codex 可选后端

- **是什么**：新增 `@agent-nexus/agent-codex` package；对外暴露 `codex` backend id 与 `CodexConfig` owner parser；具体选择语法由当前配置 schema 定义。
- **优点**：
  - 不破坏现有用户配置和默认行为。
  - 第二后端能真实施压 `AgentRuntime` / capability / config ownership。
  - Codex 安全能力可按 probe fail-closed，不需要伪装成 Claude Code 等价能力。
- **缺点**：CLI 需要路由两个 backend package；后续要维护两套 backend contract fixture。
- **主要风险**：如果 CLI 直接解释 Codex 私有字段，会违反 owner parser 边界；缓解见 spec 中的配置归属约束。

### Option C：先做验证脚本，不接入产品配置

- **是什么**：只保留 standalone verifier，不新增 runtime package。
- **优点**：短期改动最少。
- **缺点**：不能让 daemon/cli 选择 Codex backend，无法满足验收；验证结果不能转化为产品契约。
- **主要风险**：实验长期游离在仓库外，后续实现继续重复调研。

### Option B 的权限子决策：Codex sandbox 枚举

在 Option B 内，Codex backend 的 sandbox 枚举有三种候选：

- **只保留 `read-only` / `workspace-write`**：安全叙述最简单，但不能表达远程等价本机操作，用户会绕开 agent-nexus 直接跑 Codex。
- **允许显式 `sandbox: "danger-full-access"`**：默认仍安全，高权限模式进入配置、文档、日志和 review 视野；代价是该模式不再有工作目录文件系统边界。
- **新增 `yolo: true` 或透传 bypass flag**：名字直观，但会让 `sandbox` 与 `yolo` 两个权限入口组合出矛盾状态，也更难审计。

## Decision

选 **Option B：保留 Claude Code 后端，新增 Codex CLI 可选后端**。权限子决策选 **显式 `sandbox: "danger-full-access"`**，默认仍为 `read-only`，不新增 `yolo` 字段，也不透传 bypass flag 配置。

## Consequences

### 正向

- `AgentRuntime` 第一次有两个真实实现，接口和 capability 声明会被 Codex 的非长驻进程模型反向校准。
- 现有 Claude Code 路径保持稳定，Codex 通过当前配置 schema 显式启用。
- Codex backend 的安全边界按已验证事实 fail-closed：默认 `read-only`，显式 `danger-full-access` 才进入 YOLO 模式；不声称 native tool whitelist。

### 负向

- 配置 schema 需要能引用 `codex` backend id，并把 Codex 私有字段交给 `@agent-nexus/agent-codex` owner parser。
- Codex 的 `sendInput` 要用"每 turn 一个 exec/resume 子进程"实现，`AgentSession.pid` 只能表示当前 in-flight turn 子进程。
- Codex 无原生 terminal interrupt JSONL，runtime 必须维护去重和合成终态逻辑。
- `danger-full-access` 下 `workingDir` / `addDirs` 不再构成文件系统边界，只能作为启动根和配置意图；外层隔离与入口 allowlist 必须承担风险控制。

### 需要后续跟进的事

- 新增 `packages/agent/codex`，导出 `createCodexRuntime`、`parseCodexConfig`、`CodexConfigError`、`runCompatibilityProbe`。
- runtime 必须覆盖 JSONL fixture、resume、多轮、错误、usage、tool events、interrupt 合成。
- CLI 可以选择和实例化 Codex backend，但不得在 `packages/cli` 写 Codex 私有字段校验或 runtime 业务逻辑。
- 端到端 verifier 必须验证两轮会话、中断和错误路径；认证缺失时给明确 skip/fail reason。

## Out of scope

- 不决定整体配置 schema、默认 backend 或路由模型；这些由配置 / 路由 spec 决定。Codex 私有 sandbox 枚举由 Codex backend contract spec 定义。
- 不决定支持 Codex experimental `exec-server` / `app-server` wire protocol；当前 contract 未验证该路径，默认不用。
- 不决定支持 Codex `remote-control` / `app-server` 命令；当前 contract 未验证该路径，默认不用。
- 不决定 Codex 的 native tool whitelist；当前未发现对应 CLI flag，能力声明必须标为不支持。
- 不决定从 `feature/codex_agent` 合入 `main` 的时间。

## Amendments

- 2026-06-25：Codex sandbox 范围修订 —— 为远程等价本机执行场景纳入显式 YOLO 模式；默认安全值与不透传 bypass flag 的约束不变。

## 参考

- 相关 spec：[`../spec/agent-backends/codex-cli.md`](../spec/agent-backends/codex-cli.md)、[`../spec/agent-runtime.md`](../spec/agent-runtime.md)
- 验证资产：[`../../../packages/agent/codex/testdata/jsonl/`](../../../packages/agent/codex/testdata/jsonl/)、[`../../../scripts/verify-codex-agent.sh`](../../../scripts/verify-codex-agent.sh)
