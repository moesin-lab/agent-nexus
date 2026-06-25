---
title: Spec：Agent Runtime 接口
type: spec
status: active
summary: Agent 后端适配层接口契约；SessionConfig、AgentEvent 流、backend CLI 子进程管理
tags: [spec, agent-runtime, cc-cli, codex, subprocess]
related:
  - dev/adr/0002-agent-backend-claude-code-cli
  - dev/adr/0014-agent-backend-codex-cli
  - dev/adr/0012-claudecode-stream-json-mainline
  - dev/spec/config-routing
  - dev/spec/command-registry
  - dev/spec/agent-backends/claude-code-cli
  - dev/spec/agent-backends/codex-cli
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

定义 agent 后端适配层的接口契约。当前实现起点是 `claudecode`（Claude Code CLI，见 ADR-0002）；Codex CLI 作为第二后端按 ADR-0014 接入。接口保持**可扩展**，新增后端不得破坏本契约。

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
    handleCommand(session: AgentSession?, command: AgentCommandEnvelope) -> AgentCommandResult

    // 输出流（daemon 在 startSession 时订阅）
    onEvent(session, handler: fn(AgentEvent) -> void)

    // 控制
    interrupt(session: AgentSession) -> void // 相当于 Ctrl-C
}

interface AgentSession {
    key: SessionKey
    backend: string                          // "claudecode" | "codex"
    state: Spawning | Ready | Busy | Idle | Errored | Stopped
    startedAt: timestamp
    pid: int?                                // 本机子进程 pid（如适用）
    agentSessionId: string?                  // opaque agent conversation ref；如 Codex thread_id / CC session_id，daemon 只存取不解释
}
```

### Agent command envelope

Agent command 是 agent package 声明并实现的 command。daemon 已完成 auth、audit、active command map lookup、binding route 和 owner mismatch 检查；runtime 收到 envelope 后负责解释命令名、参数、可执行状态与用户可见结果。若当前 RoutingSession 没有活跃 `AgentSession`，daemon 仍可把 `session` 传为缺省值；runtime 必须自行决定 command 是无会话也可处理，还是返回 `rejected` / `unsupported`。

```text
AgentCommandEnvelope {
    canonicalId: CommandCanonicalId
    localName: string
    handlerKey: string
    args: map<string, CommandArgValue>
    rawText: string?
    traceId: string
    routingSession: {
        sessionKey: SessionKey
        platformName: string
        platformType: string
        channelId: string
        userId: string
    }
}

AgentCommandResult {
    status: "handled" | "rejected" | "unsupported"
    message: string?
    updatedAgentSessionId?: string | null
}
```

字段语义：

| 字段 | 语义 |
|---|---|
| `canonicalId` / `localName` / `handlerKey` | 来自 active reverse map 命中的 descriptor；runtime 用于 owner 内部分发 |
| `args` | platform-neutral slash command 参数；daemon 不做 agent 私有参数校验 |
| `rawText` | 可选原始文本形式；用于 text prefix 或平台无法结构化表达所有参数时的兼容输入 |
| `routingSession` | daemon 的路由上下文；不是 agent conversation 本身 |
| `status` | runtime 对该 command 的处理结果；`unsupported` 表示 agent package 声明或当前 runtime 状态不支持该 command |
| `message` | 可选用户可见回复文本；为空时 daemon 不为 agent command 合成业务文案 |
| `updatedAgentSessionId` | 更新 daemon 持久化的 opaque agent conversation ref；`null` 表示清除，缺省表示不变 |

约束：

- daemon 不得把 agent command 名映射到 `interrupt()`、`stopSession()`、`sendInput()` 或其它 runtime 方法；agent command 必须走 `handleCommand()`。
- daemon 不得为了处理 agent command 无条件创建 `AgentSession`；是否需要活跃 session 是 agent runtime 的语义。
- `handleCommand()` 必须自行决定 `/new`、`/stop`、`/steer`、`/model`、`/review`、`/compact` 等 command 是否支持以及如何执行。
- 若 command 只是 prompt shortcut，agent package 可以在 runtime 内部把它转换成 `sendInput()` 等价行为；转换规则不进入 daemon。
- `updatedAgentSessionId` 对 daemon 是 opaque token。daemon 可以持久化并在下一次 `SessionConfig.resumeFromAgentSessionId` 回传，但不得字符串解析或按 backend 类型解释。
- 若 command 终止当前 `AgentSession`，runtime 必须在返回前让 `isAlive(session)` 变为 `false`，或发出 `session_stopped` 事件；daemon 可据此释放 active handle。
- `handleCommand()` 必须有明确终态：返回 `handled`、`rejected` 或 `unsupported`，不得因当前没有 active turn 等 agent 私有状态让 daemon 猜测结果。

### AgentCapabilitySet

`AgentCapabilitySet` 必须描述 backend 已验证能力；未验证或不支持的能力必须填 `false`，不得为取悦上层流程硬填 `true`。

```text
AgentCapabilitySet {
    supportsThinking: bool
    supportsStreaming: bool
    supportsToolCallEvents: bool
    supportsInterrupt: bool
    supportsStdinInterrupt: bool
}
```

字段语义：

| 字段 | 含义 |
|---|---|
| `supportsThinking` | backend 能输出可归一化的 thinking 事件 |
| `supportsStreaming` | backend 能输出文本增量；若只能输出完整消息则为 `false` |
| `supportsToolCallEvents` | backend 能输出工具/命令开始与终态事件 |
| `supportsInterrupt` | runtime 能终止 in-flight turn，并产出 terminal `turn_finished` |
| `supportsStdinInterrupt` | backend 支持在长驻 stdin/stdout 会话内发送 interrupt 控制消息 |

### `AgentSession` 与 `Session` 的区分

本 spec 的 `AgentSession` 是 agent runtime 视角的句柄——表示某个具体 agent 后端（如 CC CLI 子进程）的运行实例。状态机：`Spawning / Ready / Busy / Idle / Errored / Stopped`。

架构层的 `RoutingSession`（见 [`../architecture/session-model.md`](../architecture/session-model.md)）是 daemon 路由状态——表示某个 IM 入口当前绑定到哪个 agent owner 与 opaque agent conversation ref。状态机：`Created / Active / Idle / Errored / Interrupted / Archived`。

两者关系：daemon 持有一个 `RoutingSession`，按需 spawn / stop 一个对应的 `AgentSession`。状态机不重叠——`AgentSession.state` 描述子进程运行态，`RoutingSession` 描述 IM 入口的路由生命周期；agent conversation 的内部生命周期由 agent package 拥有。

## SessionConfig

daemon 启动 agent session 时传入的配置。

```text
SessionConfig {
    sessionId: string                         // 持久化主键（见 session-model.md）
    workingDir: path                          // agent 后端运行的工作目录
    maxTokensPerTurn: int
    timeoutMs: int                            // 单次输入的处理超时（默认来自 agents[].timeoutMs；对应 limits.perInputTimeoutMs）
    env: map[string]string                    // 注入的环境变量（过滤敏感字段）
    transcriptFile: path?                     // 落盘 transcript 的位置
    resumeFromAgentSessionId: string?         // daemon 回传的 opaque agent conversation ref；如 Codex thread_id / CC session_id
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
    status                 // 非终端状态 / 进度提示（如 backend 重连）
    tool_call_started      // 工具调用开始
    tool_call_progress     // 工具调用中（可选）
    tool_result            // 工具结果（独立事件；CC 多形态 content 结构化承载，见 ADR-0012 决策点 1 子问题 1-tr-B）
    tool_call_finished     // 工具调用终态（不承载完整结果；结果走 tool_result）
    turn_finished          // 一个完整回合结束（等待下一条输入）
    usage                  // token/成本事件
    error                  // 错误事件
    session_stopped        // session 已结束
}
```

### 事件 payload 字段

| EventType | payload 字段 |
|---|---|
| `session_started` | `{ agentSessionId?, pid?, workingDir, capabilities }` |
| `thinking` | `{ text: string }` |
| `text_delta` | `{ text: string }` |
| `text_final` | `{ text: string }` |
| `status` | `{ message: string }` |
| `tool_call_started` | `{ callId, toolName, inputSummary }` |
| `tool_call_progress` | `{ callId, note }` |
| `tool_result` | `{ callId, resultSequence: int, content: ToolResultContent, isError: bool }` |
| `tool_call_finished` | `{ callId, toolName, status: "ok" | "error" | "cancelled", errorSummary? }` |
| `turn_finished` | `{ reason: TurnEndReason, turnSequence: int, source?: "runtime-synthesized" }` |
| `usage` | `UsageRecord` — 见下方 |
| `error` | `{ errorKind, code, message, cause? }` |
| `session_stopped` | `{ reason: "idle_timeout" | "user_stop" | "error" | "budget_exceeded" | "turn_limit" | "wallclock_timeout" }` |

### ToolResultContent

`tool_result.content` 字段类型 —— 按 `kind` 区分的判别联合，结构化承载 CC `tool_result.content` 多形态（不压扁为单字符串）。runtime 按以下**判别优先级**（自上而下首个匹配）归类，保证边界唯一：

1. content 字段缺失 / null → `{ kind: "empty" }`
2. string（含空串 `""`）→ `{ kind: "text", text: string }`
3. array：
   - 元素均 block-like（`type` 为 string 的 object）或空数组 `[]` → `{ kind: "blocks", blocks: ContentBlock[] }`
   - 否则（标量数组 / 混杂非 block）→ `{ kind: "unknown", raw: string }`
4. plain object → `{ kind: "object", object: <JSON object> }`
5. 其他 JSON scalar（number / bool）→ `{ kind: "unknown", raw: string }`

`ContentBlock = { type: string, ...保留原始字段 }`。**未识别的块原样保留在 `blocks` 数组内**（不上升为顶层 `unknown`）；仅当整个 content 落不进 1-4 时才用顶层 `unknown`。`unknown.raw` 为原始 JSON 截断字符串：截断上限默认 **4 KB**（够保留诊断信息又不爆日志；最终值可随 observability 日志策略校准），写入前**必须经 redactor 脱敏**（脱敏规则见 [`security/redaction.md`](security/redaction.md)）。截断上限是 ToolResultContent 的协议约束（本 spec owner），脱敏才属 redaction——实现不得落地无界 raw。

字段语义：

- `status`（`tool_call_finished`）是**工具调用块的终态**，由工具块终态决定、**不可由单条 `tool_result.isError` 推导**：`ok`=正常结束；`error`=执行失败 / 超时 / 后端错误，含 0 条 result 直接异常终止；`cancelled`=用户中断 / runtime 主动取消。`status != "ok"` 时 `errorSummary` 尽力填——这是 **0-result error case 唯一的错误信息来源**（完整结果一律走独立 `tool_result` 事件，不再压进 `tool_call_finished`）。
- `callId` = CC 后端的 `tool_use.id` / `tool_result.tool_use_id` 归一化 ID（对应 `tool_call_started.callId`）。
- `resultSequence` 同一 `callId` 内从 0 连续递增、不重复；不同 callId 间无可比性；最终投递顺序仍以 AgentEvent `sequence`（session 全局单调）为准。
- `isError` ← CC `tool_result.is_error`，单条 result 级。
- `status.message` 是非终端、可用户可见的进度 / 状态提示；它不表示 turn 失败，也不得触发 `turn_finished` 或 `session_stopped`。最终失败必须仍由 `error` / `turn_finished` / `session_stopped` 明确表达。

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

**daemon 注入**的 `turn_finished` 由 `daemon.quota-enforcer` 等横切模块主动构造并追加到事件流（见 `claude-code-cli.md` §"stop_reason 映射"）。adapter 收到 daemon 中断信号后也必须产出一条对应 reason 的 `turn_finished`，避免事件流不完整。

### UsageRecord（`usage` 事件 payload）

```text
UsageRecord {
    model: string
    inputTokens: int
    outputTokens: int
    cacheReadTokens: int
    cacheWriteTokens: int
    costUsd: float | null                // 订阅模式可能为 0 或 null；见 cost-and-limits.md §UsageRecord.completeness 语义
    turnSequence: int
    toolCallsThisTurn: int
    wallClockMs: int
    completeness: "complete" | "partial" | "missing"   // SSOT 在 cost-and-limits.md
}
```

**`usage` 事件与 `llm_call_finished` 日志事件的映射**：`daemon.counters` 收到 `AgentEvent{type: usage}` 后，按上表字段**原样**产出 `llm_call_finished` 结构化日志（见 [`observability.md`](infra/observability.md) §"LLM 调用事件必含字段"）。字段名一一对应；不存在"两套名字"。

### 顺序保证

- 同 session 的事件严格按 `sequence` 升序投递
- `text_delta` 的文本拼起来等于随后的 `text_final.text`
- 每个 `tool_call_started` 必有且仅有一个对应的 `tool_call_finished`
- 每个 callId 有 **0 条或多条** `tool_result`，且**全部在对应 `tool_call_finished` 之前**（模型 A：`tool_call_finished` 即该工具结果流终态——见 ADR-0012 决策点 1 子问题）
- 同一 callId 的多条 `tool_result` 按 `resultSequence` 升序投递
- `tool_call_finished` 之后到达的同 callId `tool_result` 是 late event，runtime **必须丢弃 + debug log，不得重排到 finished 前**（与 ADR-0012 §interrupt 投递契约 late event 规则一致）
- `turn_finished` 在一轮的最后一个 `text_final` / `tool_call_finished` 之后（`tool_result` 因 happens-before `tool_call_finished`，无需单独锚定）

## Backend selection 配置

backend 选择属于配置 / 路由层，不属于 `AgentRuntime` 接口。当前配置契约见 [`config-routing.md`](config-routing.md)：

- `agents[].backend` 只决定该命名 agent 启用哪个 `@agent-nexus/agent-<name>` package；daemon 不读取该字段。
- `agents[].timeoutMs` 是 backend 无关的 `SessionConfig.timeoutMs` 默认值；默认值由 [`config-routing.md`](config-routing.md#agentconfig) 定义。
- backend 自己的字段住各 owner 配置块：`agents[].claudeCode` 由 `@agent-nexus/agent-claudecode` 解析，`agents[].codex` 由 `@agent-nexus/agent-codex` 解析。
- CLI 可以按当前配置 schema 调用对应 parser / probe / runtime factory，但不得实现 backend 业务逻辑或校验 owner 字段。
- legacy 单实例配置中的顶层 `agent.backend` 只能作为迁移错误处理对象，不得静默混入新结构。

## Agent command descriptors

Agent package 可以暴露 platform-neutral command descriptors；字段形状、命名策略、alias 与 dispatch 语义见 [`command-registry.md`](command-registry.md)。

约束：

- agent descriptor 不得 import platform package、platform SDK 类型或 platform naming policy。
- agent descriptor 的 `owner.type` 必须是 `agent`，`owner.agentOwner` 必须与该 package 的稳定 owner id 一致；当前 owner id 与 `AgentRuntime.name()` / backend 枚举保持一致（`codex`、`claudecode`）。
- agent command handler 接收 daemon 已完成 routing / auth / reverse-map 解析后的 `AgentCommandEnvelope`；不得重新解释平台 command name。
- agent package 只能声明当前 agent-nexus runtime 真实支持的 command；不得照搬 TUI-only slash command 列表。

## Backend 专属说明

### CC CLI（Claude Code 实现）

`agent/claudecode` 实现 CC CLI 后端，但**具体的外部契约**（命令模板、stream-json 协议、stdin/stdout/stderr 分工、退出码、stop_reason 映射、UsageCompleteness、兼容性自检）已独立锁定在：

→ [`claude-code-cli.md`](agent-backends/claude-code-cli.md)

本节仅概括 adapter 侧的实现职责：

- **启动**：按 `claude-code-cli.md` §"启动命令模板"组装参数；跑 CompatibilityProbe 失败则拒启 session
- **输出解析**：维护行缓冲 + JSON 解析器，把 `ClaudeCodeStreamEvent` 翻译为 `AgentEvent`（映射表见 contract 文档）
- **stop_reason 映射**：按 contract §"stop_reason 到 turn_finished.reason 的映射"
- **中断**：首选 SIGINT，等 5s 未 `turn_finished` → SIGKILL
- **超时**：`SessionConfig.timeoutMs` 超过 → 走中断链 → 产出 `turn_finished { reason: "wallclock_timeout" }`
- **崩溃**：意外 exit → `error` + `session_stopped { reason: "error" }`；不自动重启
- **UsageCompleteness**：按 [`cost-and-limits.md` §`UsageRecord.completeness` 语义](infra/cost-and-limits.md#usagerecordcompleteness-语义) 取值；CC backend 的 envelope → completeness 映射见 contract §UsageCompleteness

contract 文档本身是 spec，任何映射或协议字段改动必须先改 contract 再改代码。

### Codex CLI 实现

`agent/codex` 实现 Codex CLI 后端，具体外部契约锁定在：

→ [`codex-cli.md`](agent-backends/codex-cli.md)

adapter 侧实现职责：

- **启动**：按 `codex-cli.md` §启动命令模板组装 `codex exec --json` 或 `codex exec resume --json`；跑 CompatibilityProbe 失败则拒启 Codex backend。
- **输出解析**：维护行缓冲 + JSON parser，把 `CodexJsonlEvent` 翻译为 `AgentEvent`（映射表见 contract 文档）。
- **多轮**：保存 `thread.started.thread_id` 到 `AgentSession.agentSessionId`；下一轮用 `exec resume <thread_id>`。
- **中断**：终止当前 in-flight Codex 子进程，并合成 `turn_finished { reason: "user_interrupt", source: "runtime-synthesized" }`。
- **安全默认值**：默认 `read-only` sandbox、固定 `--ask-for-approval never`、忽略 user config/rules；显式 `danger-full-access` 才进入 YOLO 模式。
- **能力声明**：`supportsStreaming=false`，除非后续 probe 坐实 text delta。

Codex 的 `exec-server` / `app-server` 未经当前 contract 验证，不属于主路径。

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
4. 超时 → 产出 `turn_finished { reason: "wallclock_timeout" }` + `error` 事件
5. 子进程崩溃 fixture → 产出 `error` + `session_stopped`
6. `usage` 事件的 token 数可被 daemon 成功记账
7. tool_result 多变体 + 边界 fixture：content 为 string / 空串 / null / 缺字段 / 块数组 / 空数组 / 非 block 数组 / 未识别块 / plain object 各形态 → 产出 kind 正确的 ToolResultContent（按判别优先级），未识别块原样留在 `blocks` 内
8. 排序与终态 fixture：同 callId 多条 result 按 `resultSequence` 升序且全在 `tool_call_finished` 前；0-result 异常终止 → `tool_call_finished.status` 为 error/cancelled 且 `errorSummary` 非空；finished 后 late result 被丢弃；`isError` 真假 × `status` ok/error 各组合不互相推导

transcript fixture 放在 `testdata/cc-cli/` 下（见 [`../testing/fixtures.md`](../testing/fixtures.md)）。

Agent command 实现还必须覆盖：

9. 已声明 agent command → `handleCommand()` 收到完整 envelope，daemon 不调用 agent 私有 handler。
10. unsupported / rejected command → 返回明确 `AgentCommandResult`，不让 daemon 猜测业务状态。
11. `updatedAgentSessionId` 缺省 / 字符串 / null 三种结果分别保持、更新、清除 daemon opaque ref。

## 多后端扩展（未来）

接入新 agent 后端（Gemini、其他）时：

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
- 把 agent command 语义放进 daemon，或要求 daemon 把 `/stop`、`/steer` 等 agent command 映射到 runtime intent
- 不实现必要的 runtime cleanup / interrupt 能力（让 daemon-owned timeout、shutdown、kill 无法释放资源）
- 错过 `usage` 事件（无法做成本归因）
- 两个不同的 session 共享一个 CC 子进程（违反隔离）
- 对 session_stopped 不落盘（重启后状态丢失）
