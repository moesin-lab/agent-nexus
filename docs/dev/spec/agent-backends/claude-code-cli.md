---
title: Spec：Claude Code CLI 外部契约
type: spec
status: active
summary: 固定 MVP 依赖的 Claude Code CLI 版本、命令模板、stream-json 协议、退出码、自检与兼容策略
tags: [spec, cc-cli, claude-code, agent-runtime, subprocess]
related:
  - dev/adr/0002-agent-backend-claude-code-cli
  - dev/spec/agent-runtime
  - dev/spec/security/README
  - dev/spec/infra/observability
contracts:
  - ClaudeCodeInvocation
  - ClaudeCodeStreamEvent
  - CompatibilityProbe
---

# Spec：Claude Code CLI 外部契约

本文件定义 agent-nexus 对 Claude Code CLI 的外部契约。

> **package 归属**：本契约是 `@agent-nexus/agent-claudecode` package 必须遵守的**外部约束**。该 package 实现 [`agent-runtime.md`](../agent-runtime.md) 定义的 `AgentRuntime` 接口，并在内部把 CC CLI 子进程行为按本契约固化。详见 [`adr/0004-language-runtime.md`](../../adr/0004-language-runtime.md) §TS-P7。

任何 CC CLI 行为偏离本契约 → 实现层通过自检拒绝启动，而不是默默试错。

## 支持版本（MVP 基线）

| 维度 | 取值 |
|---|---|
| CLI 命令名 | `claude` |
| 最低支持版本 | **待实现前跑 `claude --version` 锁定**；建议 `>= 2.0.0`（占位，实现首 PR 内敲定） |
| 已对账版本 | help 落盘 `2.1.119`；CLI 行为实测 `2.1.148`（§stdout 映射 / §中断 / §权限边界 / json 输出形态 等实测标注以 2.1.148 为准）；工具隔离前置验证实测 `2.1.149`（`can_use_tool` 裸 CLI 主路径证伪，PreToolUse hook 为 P4 主强制点） |
| 运行时 | 用户本机（ADR-0003），由用户自行维护 CC 的安装与升级 |
| 订阅 / API 支持 | 两类都支持；`usage.costUsd` 在订阅路径下可能缺失（见下文 UsageCompleteness） |

> **对账锚点**：当前基线使用的 `claude --help` 实测落盘见 [`../../references/cc-cli/help-2.1.119.txt`](../../references/cc-cli/help-2.1.119.txt)。

## 启动命令模板

### 交互式 session（MVP 主路径）

```
claude \
    --print \
    --input-format stream-json \
    --output-format stream-json \
    --verbose \
    --allowed-tools <comma-sep> \
    [--disallowed-tools <comma-sep>] \
    [--model <modelId>] \
    [--resume <sessionId>] \
    [--permission-mode default|plan]
```

- **`--print`**：非交互模式（不打开 TUI），走 stdin/stdout
- **`--input-format stream-json`**：stdin 按行读入 JSON 消息
- **`--output-format stream-json`**：stdout 按行输出 JSON 事件
- **`--verbose`**：`--print --output-format stream-json` 组合的**强制前提**——不带会直接报错 `Error: When using --print, --output-format=stream-json requires --verbose` 退出（CC 2.1.148 实测）；不是可选诊断 flag，不能省
- **工作目录**：不通过 CLI flag 传；由子进程 `cwd` 选项锁定，见 [`security/tool-boundary.md`](../security/tool-boundary.md#工作目录)。
- **`--allowed-tools`**：**必传**（表配置意图，不依赖 CC 默认）；但 `--print` 非交互主路径下白名单**不强制**（见 §权限边界 ⚠️），不可当隔离保证
- **`--disallowed-tools`**：可选；实测有效，仅作 defense-in-depth / 临时禁危险工具，**不替代** allowlist 安全模型
- **`--resume <id>`**：按 session id 续话（跨进程恢复上下文，不限于被中断的 session）；无则新建。裸用打开 picker，本项目不用
- **`--permission-mode`**：`default`（交互式需批准，但 `--print` 非交互下 `init` 实报 `bypassPermissions`，见 §权限边界 ⚠️）/ `plan`（交互式只读，非交互**不**阻止写）；MVP 不使用 `bypassPermissions` / `acceptEdits`（见 security）

### 一次性查询（probe 用）

```
claude --version
claude --print "<single prompt>" --output-format json
```

> **`--output-format json` 输出形态**（CC 2.1.148 实测）：`--print` 下返回**单个 result envelope object**（不是数组）；probe 直接读**顶层 `stop_reason`**（不是 `result.stop_reason` 嵌套——`result` 是同级的文本字段）。详见下文 §Flag 参考矩阵。

## Flag 参考矩阵

只列项目当前依赖或明确禁止的 flag。未列出的用户向 / GUI / IDE / worktree / 调试增强类 flag，一律视为**不依赖**；后续若开始依赖，再补进本表。

| Flag | CC CLI 实测语义（help 落盘 2.1.119；stream-json 行为以 2.1.148 实测为准） | 项目用法 | 引用 |
|---|---|---|---|
| `--print` / `-p` | 非交互模式，写完一次响应就退出；workspace trust 对话框被跳过 | **必传** | §交互式 session、§一次性查询 |
| `--input-format <text\|stream-json>` | 仅在 `--print` 下生效；`text` 默认（接 stdin 一段纯文本），`stream-json` 按行读 JSON | **计划用**（MVP 主路径走 stream-json，当前暂走 text） | §交互式 session（标 TODO 升级，见 `index.ts`） |
| `--output-format <text\|json\|stream-json>` | 仅在 `--print` 下生效；`json` 返回**单 object** result envelope（顶层含 `type:"result"` / `stop_reason` / `result`(文本) / `usage` / `session_id`，**非数组**；2.1.148 实测），`stream-json` 按行 JSON 流 | **必传**（probe 用 `json`、运行用 `stream-json`） | §一次性查询 / §stdout 事件格式 |
| `--allowed-tools` / `--allowedTools` | 工具白名单（逗号或空格分隔；`Bash(git *)` 子模式语法被接受但 2.1.148 实测**不拦截**非匹配命令）；`--print` 非交互下白名单**不强制**（见 §权限边界 ⚠️） | **必传**（表配置意图，非隔离保证） | §权限边界、`security/tool-boundary.md` |
| `--disallowed-tools` / `--disallowedTools` | 工具黑名单 | **不用**（当前只用白名单） | §交互式 session（保留为可选） |
| `--model <id>` | 模型别名（`sonnet` / `opus`）或全名（`claude-sonnet-4-6`） | **用**（按 SessionConfig 注入） | §交互式 session |
| `--resume [value]` / `-r` | 按 session id（UUID）续话；裸用打开 picker | **用**（持有 `agentSessionId` 时传） | §交互式 session、`agent-runtime.md` |
| `--permission-mode <…>` | 取值：`acceptEdits` / `auto` / `bypassPermissions` / `default` / `dontAsk` / `plan`；`--print` 非交互下 `default` 的 `init` 实报 `bypassPermissions`、`plan` 不阻止写（见 §权限边界 ⚠️） | **用** `default` / `plan`；**禁用** `bypassPermissions` / `acceptEdits` | §权限边界、`security/tool-boundary.md` |
| `--dangerously-skip-permissions` | 等价于 `--permission-mode bypassPermissions` | **禁用** | `security/README.md` |
| `--allow-dangerously-skip-permissions` | 让用户可以**选择**开启 bypass，但不默认开启 | **禁用** | `security/README.md` |
| `--mcp-config <configs…>` | 加载 MCP server（JSON 文件或 JSON 串，空格分隔多个） | **计划用**（MVP 不开 MCP；future 接入要走显式配置） | `security/tool-boundary.md` §MCP 默认全禁 |
| `--strict-mcp-config` | 只用 `--mcp-config` 提供的 MCP，忽略其他配置源 | **计划用**（启用 MCP 时配套，避免继承用户全局配置） | `security/tool-boundary.md` |
| `--add-dir <dirs…>` | 给工具开放访问的额外目录 | **计划用**（多 workingDir 场景） | `security/tool-boundary.md` §工作目录 |
| `--max-budget-usd <amount>` | 仅 `--print`；CC 自身 API 调用预算上限 | **不用**（项目自己做 `$ 预算`） | §UsageCompleteness |
| `--fallback-model <id>` | 仅 `--print`；主模型过载时自动 fallback | **计划用**（生产可启用） | — |
| `--include-partial-messages` | 仅 `--print + --output-format=stream-json`；流式 token-by-token | **计划用**（MVP 攒整段；流式 edit Discord 时启用） | `index.ts` §TODO |
| `--replay-user-messages` | 仅 `--input-format=stream-json + --output-format=stream-json`；回显 user 消息做 ack（回显行带 `isReplay:true`，区分真实 tool_result user 消息） | **计划用** | — |
| `--include-hook-events` | 仅 `--output-format=stream-json`；输出 hook 生命周期事件 | **不传**；但 2.1.148 实测**不传也会出现** SessionStart hook 事件，runtime 仍须防御性过滤 `hook_*`（不能依赖"不传"） | §hook 事件与未知 type 兜底 |
| `--verbose` | 覆盖 verbose 配置；**与 `--print --output-format=stream-json` 同用时为强制项**，缺失直接报错退出（2.1.148 实测） | **必传**（stream-json 输出前提；当前 sendInput argv 里已带） | §交互式 session、`packages/agent/claudecode/src/index.ts` |
| `--bare` | 最小模式：跳过 hooks / LSP / 插件 / 自动 memory / 钥匙串读取 / CLAUDE.md 自动发现 | **计划用**（agent-nexus 子进程不需要这些副作用，未来切换） | — |
| `--version` / `-v` | 输出版本号 | **必用**（probe step 1） | §兼容性自检 |
| `--help` / `-h` | 输出 help | 工具用（对账依据） | 本节 reference |

> 其余已观测但当前不依赖的 flag，如 `--continue`、`--session-id`、`--settings`、`--debug`、`--agent`、`--tools`、`--worktree` 等，统一视为 out of scope。

> **`--max-turns` 不在 reference 里**：项目不依赖；早期 spec 模板中的 `[--max-turns <n>]` 已移除。

> **`--cwd` 不在 reference 里**：CC CLI 把工作目录绑定到子进程 `cwd`，无 CLI 侧 flag。详见 §权限边界 与 `security/tool-boundary.md` §工作目录。

## stdin / stdout / stderr 分工

| 流 | 方向 | 内容 |
|---|---|---|
| **stdin** | agent-nexus → CC | 每行一个 JSON 消息（`{"type":"user", "message": {...}}` 等） |
| **stdout** | CC → agent-nexus | 每行一个 JSON 事件（见下文 ClaudeCodeStreamEvent） |
| **stderr** | CC → agent-nexus | 诊断信息 / 版本 / 警告；**不**承载业务语义；解析失败要容错 |

约定：

- **stdin EOF** 表示会话结束；agent-nexus 关闭 stdin 后 CC 应当清理并在合理时间内退出
- **stdout 以 `\n` 分隔 JSON 行**；实现侧解析按行缓冲，容错非 JSON 行（记日志跳过）
- CC 非 0 退出 → session 状态 `Errored`（见 agent-runtime.md）

## stdin 输入格式（agent-nexus → CC）

MVP 只依赖两类输入：

- `user`：`{"type":"user","message":{"role":"user","content":"..."}}`
- `control/interrupt`：可选；MVP 默认仍优先走 SIGINT

## stdout 事件格式（CC → agent-nexus）

`ClaudeCodeStreamEvent`，每行一个 JSON。MVP 需要**识别并容忍**下面这些 stdout 结构（部分仅需容忍 / 记录，并非都是业务事件）：

```jsonc
// type/subtype 为 CC 2.1.148 实测形态。init 每 turn 重发；stdout 还会混入 hook 事件与
// rate_limit_event，见下方映射表与 §hook 事件与未知 type 兜底。
{"type":"system","subtype":"init","session_id":"...","model":"...","cwd":"..."}
// assistant 文本：MVP 默认攒整段，是完整 text 块（不是 text_delta）：
{"type":"assistant","message":{"content":[{"type":"text","text":"完整文本块"}]}}
// 加 --include-partial-messages 时，token 增量以 stream_event（Anthropic SSE 包裹）出现，不在 assistant content 里：
// {"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"hel"}}}
{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_123","name":"Bash","input":{"command":"..."}}]}}
// tool_result.content 在本次实测样例中为 string；多形态（string/块数组/object/空/其他）由独立 tool_result 事件承载，见 agent-runtime.md §ToolResultContent
{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_123","content":"...","is_error":false}]}}
// PreToolUse hook deny：工具未执行，CC 回传错误 tool_result；result envelope 汇总 permission_denials
{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_123","content":"Error: ...","is_error":true}]}}
{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1779441000,"rateLimitType":"five_hour","overageStatus":"..."}}
{"type":"result","subtype":"success","stop_reason":"end_turn","usage":{"input_tokens":100,"output_tokens":50}}
{"type":"system","subtype":"error","error":{"kind":"...","message":"..."}}
```

**映射到 agent-runtime 的 AgentEvent**：

| CC stdout 事件 | AgentEvent 类型 |
|---|---|
| `system / init`（**每 turn 重发，session_id 不变**） | 仅首个 init / session_id 变化时发 `session_started`；后续同 session_id 的 init 当 turn 边界，**不重复**发 |
| `assistant / text`（完整块，**MVP 默认形态**） | `text_final` |
| `stream_event`（`event.type:content_block_delta`，`delta.type:text_delta`；**仅 `--include-partial-messages` 下出现**，Anthropic SSE 包裹，不在 assistant content） | `text_delta`（默认模板无此事件，攒整段走 `text`→`text_final`） |
| `assistant / tool_use` | `tool_call_started`（`callId` ← `tool_use.id`） |
| `user / tool_result` | `tool_result`（独立事件；`content` 按 [`agent-runtime.md`](../agent-runtime.md) ToolResultContent 判别优先级映射，`isError` ← `is_error`，`callId` ← `tool_use_id`，同 `tool_use_id` 多条按到达序 `resultSequence` 0+ 递增）¹ |
| （工具块终结，无独立 CC 事件，runtime 合成） | `tool_call_finished`：runtime 在该 `tool_use_id` 结果流终结时合成；`callId` ← 对应 `tool_call_started.callId`、`toolName` ← 缓存的 `tool_use.name`；`status` 由工具块**终结态**决定（**不得仅凭某条中间 result 的 `is_error` 推导**）——0-result 异常终止、或该 `tool_use_id` 的终结性 result 为 error（执行失败 / backend error / timeout）→ `error`，中断 / 取消 → `cancelled`，否则 `ok`；`status != "ok"` 时 `errorSummary` 尽力填² |
| `result / success` | `turn_finished { reason: stop_reason_to_enum(...) }` + `usage` 事件 |
| `result / error_during_execution` + `terminal_reason:"aborted_streaming"`（SIGINT 中断） | `turn_finished { reason: "user_interrupt" }`（见 §中断；runtime 识别 terminal_reason 或合成，**不**走 error 路径） |
| `result / error_*`（其余错误态） | `turn_finished { reason: "error" }` + `error` 事件 |
| `system / error` | `error` 事件 |
| `system / hook_*`（SessionStart 等 hook 生命周期） | **过滤丢弃**，不进解析路径（见 §hook 事件与未知 type 兜底） |
| `rate_limit_event` | 暂不映射 AgentEvent；限额信号是否接入 limits 由 [`cost-and-limits.md`](../infra/cost-and-limits.md) 决定（TODO） |
| **未列出的 type / subtype** | **debug log + 忽略，不报错**（兜底，见下） |

¹ `tool_result` 形态已按 ADR-0012 决策点 1 子问题（1-tr-B 独立事件）落地：CC `user/tool_result` 映射为独立 `tool_result` AgentEvent，content 五类承载见 [`agent-runtime.md`](../agent-runtime.md) §ToolResultContent。

² `tool_call_finished` 无 CC 原生事件，由 runtime 据结果流终结合成——终结判定：该 `tool_use_id` 不再有后续 result + turn 推进 / stop。`status` / `errorSummary` 字段语义 SSOT 在 [`agent-runtime.md`](../agent-runtime.md)。

PreToolUse hook deny 仍以 `user / tool_result` 进入映射：`is_error:true` 映射到 `tool_result.isError=true`；该 `tool_use_id` 的 `tool_call_finished.status` 为 `error`。最终 `result.permission_denials` 应包含对应 `tool_name` / `tool_use_id` / `tool_input`，但安全合约仍以“副作用未发生”为最低断言（见 [`tool-boundary.md`](../security/tool-boundary.md) §合约测试）。

## hook 事件与未知 type 兜底

CC 子进程 stdout 实际混入两类 spec 早期未覆盖的事件（CC 2.1.148 实测）：

1. **SessionStart hook 事件**：`{"type":"system","subtype":"hook_started"}` / `{"type":"system","subtype":"hook_response",...}`。`hook_response.output` 可能携带任意 hook 注入内容（如自动 memory 摘要），既是噪声也是**信息泄露面**（可能含其它 session 的 memory）。
   - runtime **必须过滤** `type:"system"` 且 `subtype` 以 `hook_` 开头的事件，不进 AgentEvent 解析路径。（注意 hook 是 `type:system` 下的 *subtype*，不是顶层新 type——见下条兜底，按 type/subtype 双层判定。）
   - 彻底消除方案：spawn 时加 `--bare`（见 §Flag 参考矩阵；跳过 hooks / 自动 memory / 插件 / CLAUDE.md 自动发现），启用后本类事件不再产生。脱敏边界见 [`security/redaction.md`](../security/redaction.md)。

2. **未列出的 type / subtype**：CC 版本演进会新增顶层 type（如 `rate_limit_event`）或已知 type 下的新 subtype（如 `system` 下的 `hook_*`）。runtime 解析遇到**映射表未列出的 type 或 subtype**，一律 **debug log + 忽略**，不得报错或中断 session。此处是「合法 JSON 的未知事件」，区别于 §stdin/stdout 约定 里「非 JSON 行」的容错。
   - **debug log 只记 `type` / `subtype` / 必要元数据**，payload 按 [`security/redaction.md`](../security/redaction.md) 处理或不记录（hook_response / 未知事件 payload 可能含敏感内容，避免整包落日志）。

## stop_reason 到 turn_finished.reason 的映射

| CC 的 `stop_reason` | AgentEvent `turn_finished.reason` |
|---|---|
| `end_turn` | `stop` |
| `max_tokens` | `max_tokens` |
| `tool_use`（中间态，不应成为 final stop） | 不触发 turn_finished |
| 用户 SIGINT（CC 2.1.148 实测产 `result/error_during_execution` + `terminal_reason:"aborted_streaming"`，**不产 `interrupted`**） | `user_interrupt`——runtime 据 `terminal_reason` 识别或按 ADR-0012 投递契约合成，**不能等 CC 给 interrupted 终态**（见 §中断） |
| 其他错误态 | `error` |

daemon 还会额外注入 `tool_limit` / `wallclock_timeout` / `budget_exceeded`；完整枚举见 [`agent-runtime.md`](../agent-runtime.md)。

## UsageCompleteness

`completeness` 语义的 SSOT 在 [`../infra/cost-and-limits.md` §`UsageRecord.completeness` 语义](../infra/cost-and-limits.md#usagerecordcompleteness-语义)。本节只描述 CC backend 在 result envelope → `completeness` 取值上的映射：

| CC `result.usage` 形态 | `costUsd` | `completeness` |
|---|---|---|
| `total_cost_usd` 是有限正数（API 路径） | 该数值 | `complete` |
| `total_cost_usd === 0`（订阅 / Max plan 常见） | `0` | `partial` |
| `total_cost_usd` 字段缺失 / 非数字 / 负数 / 非有限值 | `null`（解析层折叠） | `partial` |
| `usage` 事件本身不产生（spawn 失败 / 子进程错退） | — | 不发 usage 事件（走 `error` 路径） |

`missing` 是协议保留位，CC backend 当前不会产生该值（见 SSOT 表）。

## 中断与超时

### 中断

- 首选：向子进程发 SIGINT（不是 stdin 写 interrupt 控制消息；避免 stdin buffering 延迟）
- **CC 2.1.148 实测**：SIGINT 后 CC 产出 `result/error_during_execution`（`stop_reason:null`，`terminal_reason:"aborted_streaming"`，`is_error:true`），**不产 `interrupted` 终态**。runtime 必须据 `terminal_reason:"aborted_streaming"` 映射为 `user_interrupt`，或按 [`ADR-0012`](../../adr/0012-claudecode-stream-json-mainline.md) §interrupt 投递契约 毫秒级合成 synthetic `turn_finished{user_interrupt}`——**不能依赖 CC 主动产中断终态**；超时 5s 未见进程退出 → SIGKILL
- **terminal 去重**：单个 turn runtime **只 emit 一次** terminal `turn_finished`。若已毫秒级合成 synthetic `turn_finished{user_interrupt}`，随后到达的真实 `result/error_during_execution` 仅用于 cleanup / usage 记账，**丢弃**、不再重复 emit terminal（避免双发；与 [`ADR-0012`](../../adr/0012-claudecode-stream-json-mainline.md) §interrupt 投递契约的 late event 处置一致——该段随 ADR-0012 修订 PR 合入 main）
- 补充：若 CC 后续版本稳定支持 `{"type": "control", "subtype": "interrupt"}` 的 stdin 中断，可作为备选；保留 SIGINT 为 MVP 默认

### 超时

- `SessionConfig.timeoutMs` 对应 `limits.perInputTimeoutMs`（见 `cost-and-limits.md`）
- 处理链：超时 → SIGINT → 等 5s → SIGKILL；整个过程产出 `turn_finished { reason: "wallclock_timeout" }` + `error` + `session_stopped { reason: "error" }`

### 崩溃

- 子进程意外 exit（无对应 interrupt） → `error` + `session_stopped { reason: "error" }`
- **不**自动重启；用户需 `/resume` 或 `/end`

#### Backend 私有事件 `claudecode_subproc_error`

`agent/claudecode` adapter 在 stream-json 解析过程中或之后 CC 子进程非零退出时打的 warn 日志事件。命名前缀 `claudecode_` 表明 backend-private（见 [`observability.md`](../infra/observability.md) §事件名命名），不进通用清单。字段由本 contract spec 拥有（backend-private 事件的字段 owner = 该 backend contract）。

| 字段 | 类型 | 说明 |
|---|---|---|
| `errorKind` | string | `agent`（见 [`errors.md`](../infra/errors.md)） |
| `code` | string | `spawn_failed`；对齐 [`observability.md`](../infra/observability.md) §错误日志必含 |
| `cause` | string | 安全 cause 字符串：仅允许 execa / Error 结构化字段（`name` / `code` / `exitCode` / `signal` / `timedOut` / `isCanceled`），**禁止**写 `err.message` / `err.shortMessage` —— 后者在 execa 中拼接了 `escapedCommand`（含完整 argv 与 `input.text`，可能泄露用户消息正文 / 密钥 / PII） |
| `textBufLength` | int | 已缓冲但未发到 IM 的 assistant 文本字符长度（JS string length，UTF-16 code unit；窗口 = since turn start） |

issue #28 选 C：CC 完整输出后才异常退出时不发 partial 文本到 IM（避免没有"这是断片"标识的部分内容混淆用户），仅 warn 记 `textBufLength` 便于诊断该罕见路径。**升级路径**：本 PR 是临时止血；stream-json 主路径（[`ADR-0012`](../../adr/0012-claudecode-stream-json-mainline.md) §Consequences）落地后，流式 assistant 增量 emit 减少 / 消除 textBuf 丢失（消除程度取决于 PR-B 是否启用 `--include-partial-messages`，由 ADR-0012 实施 PR-B 决定）；cleanup-after-output 失败本身不会消失，语义从"丢 textBuf 内容"变成"已发 delta 后如何收尾/标脏/记账"，须在 PR-B 重新定义。

catch 路径若已收到 `result.usage`，仍 emit `usage` 事件，避免 daemon counters / `$ 预算` 把有 token 成本的一回合误算成零成本；`completeness` 按上文 §UsageCompleteness 字段完整度判定（与 happy path 一致），turn 失败由 `turn_finished.reason='error'` 表达，**不**靠 `completeness` 区分 "turn 失败 vs usage 数据缺失"。

## 兼容性自检（CompatibilityProbe）

进程启动时执行，所有检查通过才开始接受 Discord 事件：

1. `claude --version` → 解析版本号，比对最低支持版本；失败 → 启动失败 + 清晰错误
2. `claude --print "ping" --output-format json` → 返回单 object envelope，校验**顶层** `stop_reason == "end_turn"` + **顶层** `result` 文本非空（`stop_reason` / `result` 均为 envelope 顶层字段，**不是** `result.stop_reason` 嵌套）；超时 30s
3. 可选：跑一次 `claude --print "read README.md" --output-format stream-json --verbose --allowed-tools Read`（`--verbose` 为 stream-json 输出强制项；子进程 `cwd` 选项指向 `<testDir>`）→ 验证 stream-json 输出结构能被解析器消费
4. 启用工具隔离时，跑一次临时 PreToolUse hook deny：向 CC 发起白名单外工具调用请求，断言 hook deny 生效（副作用未发生、对应 `user / tool_result` 的 `is_error:true`、`permission_denials` 非空）；哨兵工具与临时目录由实现决定
5. 失败则：打 `agent_spawn_failed` 日志（见 observability.md），拒绝启动 Discord gateway

## 权限边界（与 security.md 对齐）

> **权限边界实测结论（CC 2.1.148 / 2.1.149）**：`--print` 非交互模式下，CC **不强制** `--allowed-tools` 白名单 / `Bash(git *)` 子模式 / `--permission-mode default` 的工具隔离——
> - `--permission-mode default` 的 `init` 事件实报 `permissionMode:"bypassPermissions"`；`plan` 不阻止写操作
> - 白名单**外**的工具、子模式不匹配的命令照常执行，`permission_denials` 为空（实测：白名单只给 `Read`，模型用 `Bash` 跑 echo 仍成功）
>
> - `--disallowed-tools` 黑名单**实测有效**（黑名单工具不出现在模型工具列表），但黑名单**不能替代** allowlist 安全模型，只作 defense-in-depth / 临时禁危险工具
>
> CC 2.1.149 实测进一步确认：裸 CLI control `initialize` 可用，但允许工具执行时不触发 `can_use_tool`；`--allowed-tools Read` 或 CC 自身 auto-deny 也不是 agent-nexus control deny。这些事实说明裸 CLI control 路径不能提供 agent-nexus 自定义白名单的执行前判定权。`--bare` 只减少 hook / memory / 插件注入面，**不修工具隔离**，不算隔离替代。

### PreToolUse hook 主强制点

agent-nexus 使用 PreToolUse hook 时，必须在启动 CC 前加载 hook 配置；配置路径要求由 [`tool-boundary.md`](../security/tool-boundary.md) 拥有。hook deny 的 stdout 信号为 `user / tool_result` `is_error:true` + result envelope `permission_denials` 非空。CompatibilityProbe 在 §兼容性自检 中定义启动时自检步骤。安全合约（fail-closed 条件、测试最低断言、实现约束）由 [`tool-boundary.md` §工具隔离强制点](../security/tool-boundary.md#工具隔离强制点) 拥有。

- 工作目录：通过子进程 `cwd` 选项传入（CC CLI 没有 `--cwd` flag），**不继承** agent-nexus 进程的 cwd
- 工具白名单：**必须**显式传 `--allowed-tools`，不依赖 CC 默认集
- 危险工具（`Bash`、shell 类 MCP）默认不入白名单；用户显式启用时加 `warn`
- 网络：MVP 不在本 spec 约束（CC 本身行为）；如需阻断，通过 OS 级手段


## 反模式

- `--output-format text` 或人类可读格式做解析（不稳定，必须 stream-json）
- 依赖 CC 的 stderr 做业务判断（stderr 是诊断通道）
- 不传 `--allowed-tools` 依赖 CC 默认（安全边界隐式）
- `bypassPermissions` 作为 MVP 默认（安全边界失守）
- 把 `--allowed-tools` / `--permission-mode` 当作 `--print` stream-json 主路径的工具安全边界（2.1.148 实测不强制，见 §权限边界 ⚠️）
- 忽略 result 事件的 `stop_reason`（stream-json 下 turn 结束的权威信号；注意 `--output-format json` 单 object 模式 `stop_reason` 是 envelope 顶层字段，非 `result.stop_reason` 嵌套）
- 把 `total_cost_usd` 当硬预算依据（订阅路径可能为 0 或 null）

## Out of spec

- CC CLI 的具体命令行参数演进（出现 breaking 时发新 ADR）
- Windows 路径/换行符处理细节（实现层）
- MCP server 生命周期（见 security.md，另有单独 spec）
- CC 内部配置文件（`~/.claude/` 下的 settings、CLAUDE.md 等）：由用户维护，本项目不直接读写
