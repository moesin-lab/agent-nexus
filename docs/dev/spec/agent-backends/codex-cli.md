---
title: Spec：Codex CLI 外部契约
type: spec
status: active
summary: Codex CLI backend 的命令模板、JSONL 协议、resume 多轮、中断、sandbox/approval 安全默认值、配置与兼容性自检
tags: [spec, codex, agent-runtime, subprocess]
related:
  - dev/adr/0014-agent-backend-codex-cli
  - dev/spec/agent-runtime
  - dev/spec/security/tool-boundary
  - dev/spec/infra/observability
contracts:
  - CodexInvocation
  - CodexJsonlEvent
  - CodexConfig
  - CompatibilityProbe
---

# Spec：Codex CLI 外部契约

本文件定义 agent-nexus 对 Codex CLI 的外部契约。`@agent-nexus/agent-codex` 必须实现 [`agent-runtime.md`](../agent-runtime.md) 的 `AgentRuntime` 接口，并在内部把 Codex CLI 子进程行为按本契约固化。

任何 Codex CLI 行为偏离本契约 → compatibility probe fail closed，拒绝启动 Codex backend，而不是静默降级。

## 支持版本（P2 基线）

| 维度 | 取值 |
|---|---|
| CLI 命令名 | `codex` |
| 已对账版本 | `codex-cli 0.133.0`（P1 本机实测） |
| 最低支持版本 | 不靠静态版本号放行；启动时必须通过 CompatibilityProbe |
| 主路径 | `codex exec --json`；后续 turn 用 `codex exec resume <thread_id> --json` |
| 运行时 | 用户本机，由用户自行维护 Codex CLI 安装与认证 |
| native tool whitelist | P1 未发现；必须声明不支持 |

## 配置契约

CLI 顶层配置用 selector 表达当前 agent backend：

```text
agent {
    backend: "claudecode" | "codex"        // 缺省保持 "claudecode"
}
```

Codex owner 配置块：

```text
codex {
    workingDir: path                        // 必填，传给 --cd
    bin: string = "codex"
    model: string?                          // 可选，传给 --model
    sandbox: "read-only" | "workspace-write" = "read-only"
    addDirs: path[] = []                    // 逐个传 --add-dir；仅显式配置时启用
    loadUserConfig: bool = false            // false -> 传 --ignore-user-config
    loadRules: bool = false                 // false -> 传 --ignore-rules
}
```

归属规则：

- `parseCodexConfig` / `CodexConfigError` / 默认值住 `@agent-nexus/agent-codex`，符合 [`config-ownership.md`](../../standards/config-ownership.md)。
- CLI 只读取 `agent.backend` 并调用对应 backend package 的 config parser / probe / runtime factory；不得在 `packages/cli` 里校验 Codex 字段语义。
- `claudeCode` 与 `codex` 配置块可以同时存在；只启用 `agent.backend` 选中的 backend。

安全默认值：

- 默认 `sandbox = "read-only"`；写文件能力必须由用户显式改为 `workspace-write`。
- 固定传 `--ask-for-approval never`，原因是 `codex exec` 是非交互路径；需要批准的动作应由 sandbox 失败返回给模型，不等待人类 prompt。P2 不提供 approval policy 配置字段。
- 默认 `loadUserConfig = false` 与 `loadRules = false`，避免继承用户全局 Codex 配置 / rules 带来的未审计工具或策略；认证仍通过 `CODEX_HOME`。
- 禁止 runtime 默认使用 `--dangerously-bypass-approvals-and-sandbox`。config parser 不提供该字段。
- `danger-full-access` 不进入 P2 配置枚举；若未来要支持，必须单独 ADR/spec 修订并声明安全边界。

## 启动命令模板

### 新会话 turn

```text
codex \
    --sandbox <sandbox> \
    --ask-for-approval never \
    --cd <workingDir> \
    [--add-dir <dir>]... \
    [--model <model>] \
    exec \
    --json \
    --skip-git-repo-check \
    [--ignore-user-config] \
    [--ignore-rules] \
    <prompt>
```

### 续接 turn

```text
codex \
    --sandbox <sandbox> \
    --ask-for-approval never \
    --cd <workingDir> \
    [--add-dir <dir>]... \
    [--model <model>] \
    exec resume \
    --json \
    --skip-git-repo-check \
    [--ignore-user-config] \
    [--ignore-rules] \
    <thread_id> \
    <prompt>
```

命令构造不变量：

- `--sandbox`、`--ask-for-approval`、`--cd` 是顶层 flag，必须放在 `exec` 前；P1 实测 `codex exec --ask-for-approval never` 会被拒绝。
- `--json`、`--skip-git-repo-check`、`--ignore-user-config`、`--ignore-rules` 是 `exec` / `resume` 路径 flag，放在子命令后。
- runtime 每个 user turn spawn 一个 Codex 子进程；同一个 `AgentSession` 通过保存 `thread_id` 维持多轮语义。
- `AgentSession.pid` 表示当前 in-flight turn 的 Codex 子进程 pid；turn 空闲时可以为空。

## JSONL 事件格式

P1 实测 stdout 为每行一个 JSON object：

```jsonc
{"type":"thread.started","thread_id":"019e561a-5ac8-7872-8b24-5eaaee9157dc"}
{"type":"turn.started"}
{"type":"item.started","item":{"id":"item_0","type":"command_execution","command":"/bin/zsh -lc 'printf TOOL_OK'","aggregated_output":"","exit_code":null,"status":"in_progress"}}
{"type":"item.completed","item":{"id":"item_0","type":"command_execution","command":"/bin/zsh -lc 'printf TOOL_OK'","aggregated_output":"TOOL_OK","exit_code":0,"status":"completed"}}
{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"TOOL_OK"}}
{"type":"turn.completed","usage":{"input_tokens":50823,"cached_input_tokens":38144,"output_tokens":41,"reasoning_output_tokens":0}}
```

### 映射到 AgentEvent

| Codex JSONL 事件 | AgentEvent 类型 |
|---|---|
| `thread.started` | 首次绑定时发 `session_started`；保存 `thread_id` 到 `AgentSession.agentSessionId`；已绑定 session 再收到同 id 时只做一致性校验，不重发 `session_started` |
| `turn.started` | 内部 turn 边界；不单独映射 |
| `item.completed` + `item.type == "agent_message"` | `text_final` |
| `item.started` + `item.type == "command_execution"` | `tool_call_started`，`callId = item.id`，`toolName = "command_execution"` |
| `item.completed` + `item.type == "command_execution"` | `tool_result` 后接 `tool_call_finished` |
| 未识别 `item.type` | 不映射 AgentEvent；记 `codex_unknown_item` debug 日志，只保留 `type` / `id` / 安全摘要，不记录完整 payload |
| `turn.completed` | `usage` 后接 `turn_finished{reason:"stop"}` |
| `error` | `error` 诊断事件；永不单独结束 turn |
| `turn.failed` | `error` + `turn_finished{reason:"error"}` |
| 进程被 interrupt signal 终止且无 terminal JSONL | runtime 合成 `turn_finished{reason:"user_interrupt", source:"runtime-synthesized"}` |
| 未识别顶层 `type` | 不映射 AgentEvent；记 `codex_unknown_event` debug 日志，只保留顶层 `type` / 安全摘要，不记录完整 payload |

文本流语义：

- P1 未观察到文本 delta；Codex runtime 不得伪造 `text_delta`。
- `capabilities().supportsStreaming` 必须为 `false`，直到 probe 验证稳定 delta 事件。

工具事件语义：

- `command_execution.aggregated_output` 映射为 `tool_result.content = { kind:"text", text }`。
- `tool_call_started.inputSummary` 从 `command_execution.command` 生成短摘要，必须截断并经 redactor；不得把完整 command 原样送到 IM。
- `exit_code === 0` → `tool_call_finished.status = "ok"`。
- `exit_code !== 0` 或 `status` 非 completed → `tool_call_finished.status = "error"`，`errorSummary` 填 exit code / status。
- Codex 没有独立 tool whitelist 事件；`tool_call_started` 只是事实观测，不代表执行前可拦截。

Usage 映射：

| Codex 字段 | UsageRecord 字段 |
|---|---|
| `usage.input_tokens` | `inputTokens` |
| `usage.output_tokens` | `outputTokens` |
| `usage.cached_input_tokens` | `cacheReadTokens` |
| 无 | `cacheWriteTokens = 0` |
| 无 | `costUsd = null` |
| config.model 或 `"unknown"` | `model` |
| runtime 计时 | `wallClockMs` |
| 本 turn command_execution 数量 | `toolCallsThisTurn` |

派生规则：

- `costUsd = null`，因此 `completeness = "partial"`。
- `reasoning_output_tokens` 当前没有 `UsageRecord` 字段；runtime 不把它加到 `outputTokens`，避免在不知道 Codex 是否已把 reasoning 计入 `output_tokens` 时双算。若后续证据证明 `output_tokens` 不含 reasoning token，必须先修订 `UsageRecord` / cost-and-limits 语义再改实现。

## 错误映射

| Codex JSONL | AgentEvent `error.payload` |
|---|---|
| `error.message` | `{ errorKind:"agent", code:"codex_error", message }` |
| `turn.failed.error.message` | `{ errorKind:"agent", code:"codex_turn_failed", message }` |

终态只由 `turn.completed`、`turn.failed` 或 runtime 合成的 interrupt/timeout 驱动；单独的 `error` 事件不得触发 `turn_finished`。

## 多轮语义

- 新 session 第一轮必须从 `thread.started.thread_id` 取得后端会话 ID。
- 后续 `sendInput` 必须用 `codex exec resume <thread_id> <prompt>`。
- 若 `SessionConfig.resumeFromAgentSessionId` 非空，第一轮也用该 ID resume，并要求 stdout 返回同一个 `thread_id`；不一致 fail closed。
- `exec-server` / `app-server` 属 experimental 路径，P1 未验证 wire protocol；P2/P3/P4 默认不得依赖。

## 中断与超时

Codex P1 实测：在 in-flight `sleep` 命令期间发送 SIGINT / SIGTERM / SIGKILL，stdout 只停在 `item.started command_execution`，没有 `turn.completed` 或 `turn.failed`。被中断的 `thread_id` 后续仍能 `exec resume`。

runtime 契约：

- `interrupt(session)` 对当前 in-flight turn 发 SIGINT；短等待后仍未退出则 SIGTERM，再升级 SIGKILL。
- 一旦 runtime 接受 interrupt，就必须向 daemon 投递一次且仅一次 `turn_finished{reason:"user_interrupt", source:"runtime-synthesized"}`。
- 已合成 terminal 后，后续若迟到 terminal JSONL，只能用于 cleanup/debug，不得重复投递 `turn_finished`。
- `timeoutMs` 命中走同一进程终止链，但 `turn_finished.reason = "wallclock_timeout"`，并额外投递 `error`。

## 权限边界

Codex backend 不满足 Claude Code backend 的 native tool whitelist 强安全承诺。P1 未发现 `toolWhitelist`、allowlist、denylist 或执行前 control request flag。

Codex P2 安全边界：

- process-level sandbox：`--sandbox read-only|workspace-write`
- approval policy：`--ask-for-approval never`
- root directory：`--cd <workingDir>`
- optional extra writable dirs：`--add-dir`
- config/rules inheritance：默认关闭 `--ignore-user-config` / `--ignore-rules`

能力声明：

| Capability | Codex 0.133.0 取值 | 依据 |
|---|---:|---|
| `supportsThinking` | `false` | P1 未观察到 thinking event |
| `supportsStreaming` | `false` | P1 未观察到 text delta |
| `supportsToolCallEvents` | `true` | `command_execution` start/completed |
| `supportsInterrupt` | `true` | runtime 可终止 in-flight process 并合成 terminal |
| `supportsStdinInterrupt` | `false` | `exec` 非长驻 stdin 会话 |
| `supportsNativeToolWhitelist` | `false` | P1 help 未发现 tool allow/deny/control flag |

若当前 `AgentCapabilitySet` 代码尚无 `supportsNativeToolWhitelist`，Codex 实现 PR 必须先扩展 protocol 类型与 claudecode/codex 两端测试；不得用 `supportsToolCallEvents` 代替工具隔离能力。

## 兼容性自检（CompatibilityProbe）

`runCompatibilityProbe` 至少验证：

1. `<bin> --version` 可执行，版本字符串可记录。
2. `<bin> --help` 和 `<bin> exec --help` 暴露 `exec`、`exec resume`、`--json`、`--sandbox`、`--ask-for-approval`、`--cd`、`--add-dir`、`--ignore-user-config`、`--ignore-rules`；配置了 `model` 时还必须验证 `--model` / `-m` 可用。
3. 构造命令时危险 bypass flag 不出现。
4. 用配置的 sandbox 跑一次 `exec --json` ping，校验 `thread.started`、`turn.started`、`item.completed agent_message`、`turn.completed usage`。当 `sandbox=workspace-write` 时，probe 还必须用哨兵文件验证工作目录可写并清理。
5. 用返回的 `thread_id` 跑 `exec resume --json`，校验同一 `thread_id` 且能引用上一轮上下文。
6. 跑一次只读 shell 样本，校验 `command_execution` start/completed；失败则 `supportsToolCallEvents=false` 且相关测试必须覆盖降级。
7. 跑一次 interrupt 样本或在测试环境中覆盖等价 fake child process，证明 runtime 合成 `user_interrupt` terminal 且不双发。
8. no-auth / invalid-model 形态由 fixture 或真实 probe 覆盖，错误消息必须可诊断。

任何必需步骤失败 → Codex backend 启动失败；不得回退到 claudecode，也不得假装能力存在。

## 合约测试

`@agent-nexus/agent-codex` 必须有：

1. JSONL fixture：baseline text → `session_started` / `text_final` / `usage` / `turn_finished`。
2. JSONL fixture：`command_execution` start/completed → tool events 顺序正确。
3. JSONL fixture：`error` + `turn.failed` → `error` + `turn_finished{reason:"error"}`。
4. JSONL fixture：未知 `item.type` 与未知顶层 `type` → debug 记录，不产 text/tool/terminal 事件，不崩溃。
5. resume 测试：第一轮保存 `thread_id`，第二轮 argv 使用 `exec resume <thread_id>`；resume 回同 id 不重发 `session_started`。
6. interrupt 测试：in-flight child 被终止后合成 `turn_finished{reason:"user_interrupt"}`，迟到 terminal 不双发。
7. config 测试：默认 read-only / fixed `--ask-for-approval never` / ignore user config / ignore rules；禁止 dangerous bypass；非法 sandbox / addDirs 类型报 `CodexConfigError`。
8. probe 测试：缺 `--json`、缺 resume、JSONL schema 不匹配、工具能力缺失时 fail closed。

## Backend 私有日志事件

允许 `agent-codex` 产生 `codex_*` backend-private 日志事件；backend-private 命名空间由 [`observability.md`](../infra/observability.md) §事件名命名授权，字段 owner 为本 contract spec：

| 事件名 | level | 字段 |
|---|---|---|
| `codex_compat_probe_failed` | error | `{ step, cause }` |
| `codex_subproc_error` | warn/error | `{ code, exitCode?, signal?, stderrSummary? }` |
| `codex_interrupt_synthesized` | debug | `{ threadId?, pid?, signal }` |
| `codex_unknown_item` | debug | `{ itemId?, itemType, summary? }` |
| `codex_unknown_event` | debug | `{ eventType, summary? }` |

日志不得记录完整 prompt、完整 stdout/stderr 或未脱敏路径；长文本只允许摘要并走 redactor。

## Out of spec

- Codex `exec-server` / `app-server` 协议。
- Codex Cloud。
- Codex 内部配置文件格式。
- native tool whitelist；当前明确不支持。
- 将 Codex 设为默认后端。
