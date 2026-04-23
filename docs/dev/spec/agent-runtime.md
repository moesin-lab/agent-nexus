# Spec：Agent Runtime 接口

定义 agent 后端适配层的接口契约。当前唯一实现是 `claudecode`（Claude Code CLI，见 ADR-0002）。接口保持**可扩展**，未来接其他后端（Codex / Gemini）时不应破坏本契约。

## 目标

- 为 core 提供统一的 agent 接口，屏蔽具体后端（CLI 子进程、HTTP API、SDK）差异
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

    // 输出流（core 在 startSession 时订阅）
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

## SessionConfig

Core 启动 agent session 时传入的配置。

```text
SessionConfig {
    workingDir: path                          // CC 运行的工作目录
    toolWhitelist: string[]                   // 允许使用的工具（见 security.md）
    maxTokensPerTurn: int
    totalBudgetUsd: float
    timeoutMs: int                            // 单次输入的处理超时
    env: map[string]string                    // 注入的环境变量（过滤敏感字段）
    transcriptFile: path?                     // 落盘 transcript 的位置
}
```

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
| `turn_finished` | `{ reason: "stop" | "max_tokens" | "user_interrupt" | "error" }` |
| `usage` | `{ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd }` |
| `error` | `{ errorKind, code, message, cause? }` |
| `session_stopped` | `{ reason: "idle_timeout" | "user_stop" | "error" | "budget_exceeded" }` |

### 顺序保证

- 同 session 的事件严格按 `sequence` 升序投递
- `text_delta` 的文本拼起来等于随后的 `text_final.text`
- 每个 `tool_call_started` 必有且仅有一个对应的 `tool_call_finished`
- `turn_finished` 在一轮的最后一个 `text_final` / `tool_call_finished` 之后

## CC CLI 专属说明（Claude Code 实现）

以下是 `agent/claudecode` 实现必须处理的细节。对 core 透明。

### 启动

- 以子进程启动 CC CLI，传入 working dir、env、工具白名单参数
- 子进程 stdin / stdout 使用管道（或 pty，以支持颜色/交互）
- 解析 CC 输出为 AgentEvent 流

### 输出解析

- CC 支持 JSON 流输出模式（具体标志随 CC 版本，写入实现时锁定）
- 解析器维护状态机：识别 `message_start` / `content_block_delta` / `tool_use` 等类型
- 把 CC 的内部事件归一化为 AgentEvent

### 中断

- `interrupt` 发送 SIGINT 给子进程
- 等待 CC 返回 `turn_finished { reason: "user_interrupt" }`
- 超时未返回则 SIGKILL 并标记 session Errored

### 超时

- `SessionConfig.timeoutMs` 是单次 `sendInput` 到 `turn_finished` 的超时
- 超时触发 interrupt；如仍未响应则强杀

### 崩溃恢复

- 子进程意外退出 → 投递 `error` + `session_stopped { reason: "error" }`
- 不自动重启 session；交给 core / 用户决策

## 权限边界

- 工作目录：只能访问 `workingDir` 下的文件（由 CC 本身的 allowlist 控制）
- 工具白名单：CC 的 `--allowed-tools` 参数决定可用工具集（见 [`security.md`](security.md)）
- 网络：CC 默认能访问网络；如需禁用，通过 env 或 hooks
- Shell 命令：默认拒绝；需要时通过白名单开启（本项目 MVP 建议保持拒绝）

## 合约测试

Agent runtime 实现必须有：

1. 固定 CC 输出 transcript（JSONL fixture）→ 产出符合 spec 的 AgentEvent 流
2. `sendInput` → 看到 `session_started` / `text_delta` / `turn_finished` 的合理序列
3. `interrupt` → 产出 `turn_finished { reason: "user_interrupt" }`
4. 超时 → 产出 `turn_finished { reason: "error" }` + `error` 事件
5. 子进程崩溃 fixture → 产出 `error` + `session_stopped`
6. `usage` 事件的 token 数可被 core 成功记账

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

- 把 CC 原生 JSON 结构暴露给 core（违反归一化）
- 在 AgentEvent 上塞平台特有字段
- 不实现 interrupt（让用户长任务无法取消）
- 错过 `usage` 事件（无法做成本归因）
- 两个不同的 session 共享一个 CC 子进程（违反隔离）
- 对 session_stopped 不落盘（重启后状态丢失）
