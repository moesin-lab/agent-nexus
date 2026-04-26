---
title: Spec：Agent Runtime 接口
type: spec
status: active
summary: Agent 后端适配层接口契约；SessionConfig、AgentEvent 流、CC CLI 子进程管理
tags: [spec, agent-runtime, cc-cli, subprocess]
related:
  - dev/adr/0002-agent-backend-claude-code-cli
  - dev/spec/agent-backends/claude-code-cli
  - dev/spec/message-protocol
  - dev/spec/security/README
  - dev/spec/infra/cost-and-limits
contracts:
  - AgentRuntime
  - AgentSession
  - SessionConfig
  - AgentInput
  - AgentEvent
---

# Spec：Agent Runtime 接口

定义 agent 后端适配层的接口契约。当前唯一实现是 `claudecode`（Claude Code CLI，见 ADR-0002）。接口保持**可扩展**，未来接其他后端（Codex / Gemini）时不应破坏本契约。

> **package 归属**：`AgentRuntime` 接口与相关类型（`AgentSession` / `SessionConfig` / `AgentInput` / `AgentEvent`）定义在 `@agent-nexus/protocol` package；**具体后端实现** 住在 `@agent-nexus/agent-<name>` 独立 package（如 `@agent-nexus/agent-claudecode`）。详见 [`adr/0004-language-runtime.md`](../adr/0004-language-runtime.md) §TS-P7。

## 目标

- 为 daemon 提供统一的 agent 接口，屏蔽具体后端（CLI 子进程、HTTP API、SDK）差异
- 管理 session 级的 agent 进程生命周期
- 把 agent 输出归一化为 `AgentEvent` 流
- 暴露权限与资源约束入口

## 接口

```text
interface AgentRuntime {
    // 元信息
    name() -> string                         // 例 "claudecode"
    capabilities() -> AgentCapabilitySet

    // Session 生命周期
    startSession(sessionKey, config: SessionConfig) -> AgentSession
    stopSession(session: AgentSession) -> void
    isAlive(session: AgentSession) -> bool

    // 输入
    sendInput(session: AgentSession, input: AgentInput) -> void

    // 输出流（daemon 在 startSession 时订阅）
    onEvent(session, handler: fn(AgentEvent) -> void)

    // 控制
    interrupt(session: AgentSession) -> void // 相当于 Ctrl-C
}

interface AgentSession {
    key: SessionKey
    backend: string                          // "claudecode"
    state: Spawning | Ready | Busy | Idle | Errored | Stopped
    startedAt: timestamp
    pid: int?                                // 本机子进程 pid（如适用）
}
```

### `AgentSession` 与 `Session` 的区分

本 spec 的 `AgentSession` 是 agent runtime 视角的句柄——表示某个具体 agent 后端（如 CC CLI 子进程）的运行实例。状态机：`Spawning / Ready / Busy / Idle / Errored / Stopped`。

架构层的 `Session`（见 [`../architecture/session-model.md`](../architecture/session-model.md)）是会话本体——表示一段用户对话的生命周期。状态机：`Created / Active / Idle / Errored / Interrupted / Archived`。

两者关系：daemon 持有一个 `Session`，按需 spawn / stop 一个对应的 `AgentSession`。状态机不重叠——`AgentSession.state` 描述子进程运行态，`Session.state` 描述对话生命周期态。

## SessionConfig

daemon 启动 agent session 时传入的配置。

```text
SessionConfig {
    sessionId: string                         // 持久化主键（见 session-model.md）
    workingDir: path                          // CC 运行的工作目录
    toolWhitelist: string[]                   // 允许使用的工具（见 tool-boundary.md）
    maxTokensPerTurn: int
    timeoutMs: int                            // 单次输入的处理超时（对应 limits.perInputTimeoutMs）
    env: map[string]string                    // 注入的环境变量（过滤敏感字段）
    transcriptFile: path?                     // 落盘 transcript 的位置
    budget: BudgetConfig?                     // 可选；opt-in $ 预算层（见 ADR-0006）
}

BudgetConfig {
    limitUsd: float                            // 启用时必填；不启用则 SessionConfig.budget = null
}
```

**变更记录**：原有 `totalBudgetUsd: float`（必填）已按 ADR-0006 降为可选 `budget: BudgetConfig?`。订阅用户配置中应保持 `budget=null`；API 用户按需启用。

## AgentInput

```text
AgentInput {
    type: "user_message" | "tool_result" | "interrupt_ack"
    text: string?
    attachments: AttachmentRef[]?
    traceId: string
}
```

## AgentEvent（输出事件）

Agent 输出归一化为以下事件流。Adapter 必须把后端原生输出翻译成这些事件。

```text
AgentEvent {
    type: EventType
    traceId: string
    timestamp: timestamp
    sequence: int                             // session 内单调递增
    payload: <随 type 变>
}

enum EventType {
    session_started        // session spawn 完成
    thinking               // 内部推理片段（可选，不是所有后端支持）
    text_delta             // 文本增量（流式输出）
    text_final             // 一轮文本输出完成
    tool_call_started      // 工具调用开始
    tool_call_progress     // 工具调用中（可选）
    tool_call_finished     // 工具调用完成（含结果摘要）
    turn_finished          // 一个完整回合结束（等待下一条输入）
    usage                  // token/成本事件
    error                  // 错误事件
    session_stopped        // session 已结束
}
```

### 事件 payload 字段

| EventType | payload 字段 |
|---|---|
| `session_started` | `{ pid?, workingDir, capabilities }` |
| `thinking` | `{ text: string }` |
| `text_delta` | `{ text: string }` |
| `text_final` | `{ text: string }` |
| `tool_call_started` | `{ callId, toolName, inputSummary }` |
| `tool_call_progress` | `{ callId, note }` |
| `tool_call_finished` | `{ callId, toolName, status: "ok" | "error", resultSummary }` |
| `turn_finished` | `{ reason: TurnEndReason, turnSequence: int }` |
| `usage` | `UsageRecord` — 见下方 |
| `error` | `{ errorKind, code, message, cause? }` |
| `session_stopped` | `{ reason: "idle_timeout" | "user_stop" | "error" | "budget_exceeded" | "turn_limit" | "wallclock_timeout" }` |

### TurnEndReason 枚举

合并了"后端原生原因"与"daemon 注入的原因"：

| 值 | 来源 | 含义 |
|---|---|---|
| `stop` | 后端 | 正常完成（CC `stop_reason=end_turn`） |
| `max_tokens` | 后端 | CC 达到 output token 上限 |
| `user_interrupt` | 后端（SIGINT） | 用户主动中断 |
| `error` | 后端 / daemon | 工具错误 / CC 崩溃 / 其他异常 |
| `tool_limit` | **daemon 注入** | `maxToolCallsPerTurn` 命中（见 `cost-and-limits.md`） |
| `wallclock_timeout` | **daemon 注入** | `perInputTimeoutMs` 命中 |
| `budget_exceeded` | **daemon 注入** | opt-in $ 预算耗尽 |

**daemon 注入**的 `turn_finished` 由 `daemon.toolguard` / `daemon.quota-enforcer` 主动构造并追加到事件流（见 `claude-code-cli-contract.md` §"stop_reason 映射"）。adapter 收到 daemon 中断信号后也必须产出一条对应 reason 的 `turn_finished`，避免事件流不完整。

### UsageRecord（`usage` 事件 payload）

```text
UsageRecord {
    model: string
    inputTokens: int
    outputTokens: int
    cacheReadTokens: int
    cacheWriteTokens: int
    costUsd: float | null                // 订阅模式可能为 null；见 claude-code-cli-contract §UsageCompleteness
    turnSequence: int
    toolCallsThisTurn: int
    wallClockMs: int
    completeness: "complete" | "partial" | "missing"
}
```

**`usage` 事件与 `llm_call_finished` 日志事件的映射**：`daemon.counters` 收到 `AgentEvent{type: usage}` 后，按上表字段**原样**产出 `llm_call_finished` 结构化日志（见 [`observability.md`](infra/observability.md) §"LLM 调用事件必含字段"）。字段名一一对应；不存在"两套名字"。

### 顺序保证

- 同 session 的事件严格按 `sequence` 升序投递
- `text_delta` 的文本拼起来等于随后的 `text_final.text`
- 每个 `tool_call_started` 必有且仅有一个对应的 `tool_call_finished`
- `turn_finished` 在一轮的最后一个 `text_final` / `tool_call_finished` 之后

## CC CLI 专属说明（Claude Code 实现）

`agent/claudecode` 实现 CC CLI 后端，但**具体的外部契约**（命令模板、stream-json 协议、stdin/stdout/stderr 分工、退出码、stop_reason 映射、UsageCompleteness、兼容性自检）已独立锁定在：

→ [`claude-code-cli-contract.md`](agent-backends/claude-code-cli.md)

本节仅概括 adapter 侧的实现职责：

- **启动**：按 `claude-code-cli-contract.md` §"启动命令模板"组装参数；跑 CompatibilityProbe 失败则拒启 session
- **输出解析**：维护行缓冲 + JSON 解析器，把 `ClaudeCodeStreamEvent` 翻译为 `AgentEvent`（映射表见 contract 文档）
- **stop_reason 映射**：按 contract §"stop_reason 到 turn_finished.reason 的映射"
- **中断**：首选 SIGINT，等 5s 未 `turn_finished` → SIGKILL
- **超时**：`SessionConfig.timeoutMs` 超过 → 走中断链 → 产出 `turn_finished { reason: "wallclock_timeout" }`
- **崩溃**：意外 exit → `error` + `session_stopped { reason: "error" }`；不自动重启
- **UsageCompleteness**：按 contract §"UsageCompleteness" 标注 complete / partial / missing，并在 partial/missing 时触发 `$ 预算`的 fail-closed

contract 文档本身是 spec，任何映射或协议字段改动必须先改 contract 再改代码。

## 权限边界

- 工作目录：只能访问 `workingDir` 下的文件（由 CC 本身的 allowlist 控制）
- 工具白名单：CC 的 `--allowed-tools` 参数决定可用工具集（见 [`security.md`](security/README.md)）
- 网络：CC 默认能访问网络；如需禁用，通过 env 或 hooks
- Shell 命令：默认拒绝；需要时通过白名单开启（本项目 MVP 建议保持拒绝）

## 合约测试

Agent runtime 实现必须有：

1. 固定 CC 输出 transcript（JSONL fixture）→ 产出符合 spec 的 AgentEvent 流
2. `sendInput` → 看到 `session_started` / `text_delta` / `turn_finished` 的合理序列
3. `interrupt` → 产出 `turn_finished { reason: "user_interrupt" }`
4. 超时 → 产出 `turn_finished { reason: "error" }` + `error` 事件
5. 子进程崩溃 fixture → 产出 `error` + `session_stopped`
6. `usage` 事件的 token 数可被 daemon 成功记账

transcript fixture 放在 `testdata/cc-cli/` 下（见 [`../testing/fixtures.md`](../testing/fixtures.md)）。

## 多后端扩展（未来）

接入新 agent 后端（Codex、Gemini、其他）时：

- 遵守本 spec 的接口与 AgentEvent 类型
- 如后端无某个 EventType 概念，**不触发**对应事件（不要造假）
- 如需新 EventType，改本 spec + 发 ADR

## 不在本 spec 的事

- CC CLI 的具体命令行参数（属于实现细节）
- 工具的具体白名单（见 security）
- 成本计算公式（见 cost-and-limits）
- Transcript 文件格式（见 persistence）

## 反模式

- 把 CC 原生 JSON 结构暴露给 daemon（违反归一化）
- 在 AgentEvent 上塞平台特有字段
- 不实现 interrupt（让用户长任务无法取消）
- 错过 `usage` 事件（无法做成本归因）
- 两个不同的 session 共享一个 CC 子进程（违反隔离）
- 对 session_stopped 不落盘（重启后状态丢失）
