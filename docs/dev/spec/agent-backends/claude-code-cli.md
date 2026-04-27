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

CC CLI 是 agent-nexus 的**产品依赖**，不是稳定库 API。本 spec 把本项目对 CC CLI 的具体期望**显式锁定**，避免"写入实现时锁定"的模糊造成返工与未知兼容性故障。

> **package 归属**：本契约是 `@agent-nexus/agent-claudecode` package 必须遵守的**外部约束**。该 package 实现 [`agent-runtime.md`](../agent-runtime.md) 定义的 `AgentRuntime` 接口，并在内部把 CC CLI 子进程行为按本契约固化。详见 [`adr/0004-language-runtime.md`](../../adr/0004-language-runtime.md) §TS-P7。

任何 CC CLI 行为偏离本契约 → 实现层通过自检拒绝启动，而不是默默试错。

## 支持版本（MVP 基线）

| 维度 | 取值 |
|---|---|
| CLI 命令名 | `claude` |
| 最低支持版本 | **待实现前跑 `claude --version` 锁定**；建议 `>= 2.0.0`（占位，实现首 PR 内敲定） |
| 已对账版本 | `2.1.119`（`testdata/cc-cli/help-2.1.119.txt` 是该版本 `claude --help` 的实测落盘） |
| 运行时 | 用户本机（ADR-0003），由用户自行维护 CC 的安装与升级 |
| 订阅 / API 支持 | 两类都支持；`usage.costUsd` 在订阅路径下可能缺失（见下文 UsageCompleteness） |

> **对账原则**：本 spec 的 flag / 子命令信息以 `testdata/cc-cli/help-2.1.119.txt` 为准；CC CLI 升级跨 minor 版本时，先把新版 `--help` 重新落盘对账，再改本 spec。详见下文 §Flag 参考矩阵。

## 启动命令模板

### 交互式 session（MVP 主路径）

```
claude \
    --print \
    --input-format stream-json \
    --output-format stream-json \
    --allowed-tools <comma-sep> \
    [--disallowed-tools <comma-sep>] \
    [--model <modelId>] \
    [--resume <sessionId>] \
    [--permission-mode default|plan]
```

- **`--print`**：非交互模式（不打开 TUI），走 stdin/stdout
- **`--input-format stream-json`**：stdin 按行读入 JSON 消息
- **`--output-format stream-json`**：stdout 按行输出 JSON 事件
- **工作目录**：不通过 CLI flag 传；由子进程 `cwd` 选项锁定，见 [`security/tool-boundary.md`](../security/tool-boundary.md#工作目录)。
- **`--allowed-tools` / `--disallowed-tools`**：工具白名单；**必须**显式传入，不依赖 CC 默认
- **`--resume`**：恢复上次被 Interrupted 的 session；无则新建
- **`--permission-mode`**：`default` 需要交互批准；`plan` 只读；MVP 不使用 `bypassPermissions` / `acceptEdits`（见 security）

### 一次性查询（probe 用）

```
claude --version
claude --print "<single prompt>" --output-format json
```

> **`--output-format json` 输出形态**：`--print` 下返回 JSON 事件数组而非单个 envelope；probe 解析要同时兼容数组和单 object。详见下文 §Flag 参考矩阵。

## Flag 参考矩阵

每条目对账 CC CLI 2.1.119（fixture：`testdata/cc-cli/help-2.1.119.txt`）。"项目用法"列：**必传** = MVP 启动命令固定带；**用** = 条件性使用；**计划用** = 当前未用、spec 内有 TODO；**不用** = 项目不依赖；**禁用** = 出现即视为安全/契约违规。

| Flag | CC CLI 2.1.119 实测语义 | 项目用法 | 引用 |
|---|---|---|---|
| `--print` / `-p` | 非交互模式，写完一次响应就退出；workspace trust 对话框被跳过 | **必传** | §交互式 session、§一次性查询 |
| `--input-format <text\|stream-json>` | 仅在 `--print` 下生效；`text` 默认（接 stdin 一段纯文本），`stream-json` 按行读 JSON | **计划用**（MVP 主路径走 stream-json，当前暂走 text） | §交互式 session（标 TODO 升级，见 `index.ts`） |
| `--output-format <text\|json\|stream-json>` | 仅在 `--print` 下生效；`json` 返回**单 array**（`[init, assistant…, result]`），`stream-json` 按行 JSON 流 | **必传**（probe 用 `json`、运行用 `stream-json`） | §一次性查询 / §stdout 事件格式 |
| `--allowed-tools` / `--allowedTools` | 工具白名单（逗号或空格分隔，支持 `Bash(git *)` 子模式） | **必传** | §权限边界、`security/tool-boundary.md` |
| `--disallowed-tools` / `--disallowedTools` | 工具黑名单 | **不用**（当前只用白名单） | §交互式 session（保留为可选） |
| `--model <id>` | 模型别名（`sonnet` / `opus`）或全名（`claude-sonnet-4-6`） | **用**（按 SessionConfig 注入） | §交互式 session |
| `--resume [value]` / `-r` | 按 session id（UUID）续话；裸用打开 picker | **用**（持有 `ccSessionID` 时传） | §交互式 session、`agent-runtime.md` |
| `--continue` / `-c` | 续接当前目录最近一条 session | **不用**（项目按显式 session id 续接） | — |
| `--session-id <uuid>` | 用指定 UUID 作为本次 session id（必须有效 UUID） | **不用**（项目让 CC 自分配，从 `system/init` 事件读回） | §stdout 事件格式 |
| `--fork-session` | 与 `--resume`/`--continue` 配合，恢复时新分配 session id | **不用** | — |
| `--no-session-persistence` | 仅 `--print`；不落盘，无法 resume | **不用**（项目依赖 resume） | — |
| `--permission-mode <…>` | 取值：`acceptEdits` / `auto` / `bypassPermissions` / `default` / `dontAsk` / `plan` | **用** `default` / `plan`；**禁用** `bypassPermissions` / `acceptEdits` | §权限边界、`security/tool-boundary.md` |
| `--dangerously-skip-permissions` | 等价于 `--permission-mode bypassPermissions` | **禁用** | `security/README.md` |
| `--allow-dangerously-skip-permissions` | 让用户可以**选择**开启 bypass，但不默认开启 | **禁用** | `security/README.md` |
| `--mcp-config <configs…>` | 加载 MCP server（JSON 文件或 JSON 串，空格分隔多个） | **计划用**（MVP 不开 MCP；future 接入要走显式配置） | `security/tool-boundary.md` §MCP 默认全禁 |
| `--strict-mcp-config` | 只用 `--mcp-config` 提供的 MCP，忽略其他配置源 | **计划用**（启用 MCP 时配套，避免继承用户全局配置） | `security/tool-boundary.md` |
| `--settings <file-or-json>` | 额外 settings JSON 文件或 JSON 串 | **不用**（敏感面太大，避免与项目契约冲突） | — |
| `--setting-sources <…>` | 限定加载的 settings 来源（`user,project,local`） | **不用** | — |
| `--add-dir <dirs…>` | 给工具开放访问的额外目录 | **计划用**（多 workingDir 场景） | `security/tool-boundary.md` §工作目录 |
| `--system-prompt <…>` / `--append-system-prompt <…>` | 覆盖 / 追加 system prompt | **不用**（MVP 用 CC 默认 prompt） | — |
| `--max-budget-usd <amount>` | 仅 `--print`；CC 自身 API 调用预算上限 | **不用**（项目自己做 `$ 预算`，见 `cost-and-limits.md`） | §UsageCompleteness |
| `--fallback-model <id>` | 仅 `--print`；主模型过载时自动 fallback | **计划用**（生产可启用） | — |
| `--include-partial-messages` | 仅 `--print + --output-format=stream-json`；流式 token-by-token | **计划用**（MVP 攒整段；流式 edit Discord 时启用） | `index.ts` §TODO |
| `--include-hook-events` | 仅 `--output-format=stream-json`；输出 hook lifecycle 事件 | **不用** | — |
| `--replay-user-messages` | 仅 `--input-format=stream-json + --output-format=stream-json`；回显 user 消息做 ack | **计划用**（升级 stream-json 主路径时评估） | — |
| `--verbose` | 覆盖 verbose 配置 | **用**（当前 sendInput argv 里带，便于诊断） | `packages/agent/claudecode/src/index.ts` |
| `--debug [filter]` / `-d` | 调试模式 + 过滤器（`api,hooks` 等） | **不用**（生产路径） | — |
| `--debug-file <path>` | 调试日志写到指定文件 | **不用** | — |
| `--bare` | 最小模式：跳过 hooks / LSP / 插件 / 自动 memory / 钥匙串读取 / CLAUDE.md 自动发现 | **计划用**（agent-nexus 子进程不需要这些副作用，未来切换） | — |
| `--name <name>` / `-n` | 给 session 起显示名 | **不用** | — |
| `--agent <name>` / `--agents <json>` | 自定义 agent 配置 | **不用** | — |
| `--brief` / `--effort` / `--exclude-dynamic-system-prompt-sections` / `--betas` / `--file` / `--from-pr` / `--json-schema` / `--mcp-debug` / `--plugin-dir` / `--remote-control-session-name-prefix` / `--tools` / `--disable-slash-commands` | 各类 CC 用户向 / 高级特性 | **不用** | — |
| `--chrome` / `--no-chrome` / `--ide` / `--tmux` / `--worktree` | 桌面 / IDE 集成 | **out of scope**（agent-nexus 在无头子进程里跑，不开 GUI 集成） | — |
| `--version` / `-v` | 输出版本号 | **必用**（probe step 1） | §兼容性自检 |
| `--help` / `-h` | 输出 help | 工具用（对账依据） | 本节 fixture |

> **`--max-turns` 不在 fixture 里**：`claude --help` 实测无此选项，但传入既不报"unknown option"也无可见副作用——疑为 commander 静默吃掉的别名/废弃位。**项目不依赖**；早期 spec 模板里的 `[--max-turns <n>]` 是误记，已移除。

> **`--cwd` 不在 fixture 里**：实测 `error: unknown option '--cwd'`。CC CLI 把工作目录绑定到子进程 cwd，无 CLI 侧 flag。详见 §权限边界 与 `security/tool-boundary.md` §工作目录。

## 子命令参考

`claude` 还有若干子命令（fixture 里 `Commands:` 段），本项目**不在运行时调用**它们；列在此处只为对账显式说明：

| 子命令 | 用途 | 项目用法 |
|---|---|---|
| `agents` | 管理 agent 配置 | 不用 |
| `auth` | 认证管理 | 不用（用户自己跑） |
| `auto-mode` | inspect auto-mode classifier | 不用 |
| `doctor` | 自检自动更新链路 | 不用 |
| `install [target]` | 安装/换版本 | 不用 |
| `mcp` | 管理 MCP server | 不用 |
| `plugin` / `plugins` | 管理插件 | 不用 |
| `setup-token` | 长期 token 配置 | 不用 |
| `update` / `upgrade` | 检查并升级 | 不用 |

## 对账维护

每次 CC CLI 升级或本项目新增依赖一个 flag：

1. 跑 `claude --version` 与 `claude --help`，把后者落到 `testdata/cc-cli/help-<version>.txt`（**不覆盖**已有版本，按版本号累积）
2. 与本节 §Flag 参考矩阵 / §子命令参考 对账；新增的 flag、改名的 flag、删除的 flag 都记一行
3. 更新 §支持版本 表里的"已对账版本"
4. 若发现行为级差异（不只是 flag 集合变化），同步看 §stdout 事件格式 / §UsageCompleteness 是否需要改

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

MVP 用最小集合：

```jsonc
// 用户消息（纯文本）
{"type": "user", "message": {"role": "user", "content": "请查看 main.ts"}}

// 用户消息（带附件引用，MVP 待实现）
{"type": "user", "message": {"role": "user", "content": [
    {"type": "text", "text": "帮我看这张图"},
    {"type": "image", "source": {...}}
]}}

// 中断（可选，MVP 优先走 SIGINT；见 §"中断"）
{"type": "control", "subtype": "interrupt"}
```

## stdout 事件格式（CC → agent-nexus）

`ClaudeCodeStreamEvent`，每行一个 JSON：

```jsonc
// session 建立
{"type": "system", "subtype": "init",
 "session_id": "...", "model": "...", "cwd": "...",
 "tools": ["Read", ...], "permissionMode": "default"}

// assistant 文本增量（流式）
{"type": "assistant", "message": {
    "content": [{"type": "text_delta", "text": "hello"}]
}}

// 工具调用开始
{"type": "assistant", "message": {
    "content": [{"type": "tool_use", "id": "toolu_123", "name": "Read",
                 "input": {"file_path": "..."}}]
}}

// 工具调用结果
{"type": "user", "message": {
    "content": [{"type": "tool_result", "tool_use_id": "toolu_123",
                 "content": "...", "is_error": false}]
}}

// 一轮结束 + 用量
{"type": "result", "subtype": "success",
 "session_id": "...",
 "duration_ms": 1234,
 "num_turns": 1,
 "usage": {"input_tokens": 100, "output_tokens": 50,
           "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0},
 "total_cost_usd": 0.01,        // 订阅路径下可能缺失或为 0
 "stop_reason": "end_turn"}

// 错误
{"type": "system", "subtype": "error",
 "error": {"kind": "...", "message": "..."}}
```

**映射到 agent-runtime 的 AgentEvent**（见 `agent-runtime.md`）：

| CC stdout 事件 | AgentEvent 类型 |
|---|---|
| `system / init` | `session_started` |
| `assistant / text_delta` | `text_delta` |
| `assistant / text`（完整块） | `text_final` |
| `assistant / tool_use` | `tool_call_started` |
| `user / tool_result` | `tool_call_finished`（status 由 `is_error` 决定） |
| `result / success` | `turn_finished { reason: stop_reason_to_enum(...) }` + `usage` 事件 |
| `result / error_*` | `turn_finished { reason: "error" }` + `error` 事件 |
| `system / error` | `error` 事件 |

## stop_reason 到 turn_finished.reason 的映射

| CC 的 `stop_reason` | AgentEvent `turn_finished.reason` |
|---|---|
| `end_turn` | `stop` |
| `max_tokens` | `max_tokens` |
| `tool_use`（中间态，不应成为 final stop） | 不触发 turn_finished |
| `interrupted` / 用户 SIGINT | `user_interrupt` |
| 其他错误态 | `error` |

**daemon 注入的额外 reason**（不来自 CC 本身）：`tool_limit` / `wallclock_timeout` / `budget_exceeded`（由 daemon 在判定命中时主动构造 turn_finished 事件，见 `cost-and-limits.md`）。完整枚举见 [`agent-runtime.md`](../agent-runtime.md) §TurnEndReason 枚举。

## UsageCompleteness

CC 输出的 `result.usage` 在不同路径下字段齐全度不同。daemon 在记 `usage` 事件时必须标注完整度：

| 级别 | 条件 | 行为 |
|---|---|---|
| `complete` | `input_tokens` / `output_tokens` / `cache_*` / `total_cost_usd` 全齐 | 正常记账；`$ 预算`（opt-in）可用 |
| `partial` | token 齐但 `total_cost_usd` 缺失或 `0`（订阅路径常见） | 记 token；`costUsd` 写 `null`；`$ 预算` 不生效（见下文） |
| `missing` | token 也缺 | 记 0 + `warn` 日志；turn 仍按 1 计数（不依赖 usage 做 turn 限制） |

**`$ 预算`（opt-in）的 fail-closed**：当近 N 次（默认 3）`llm_call_finished` 事件为 `partial/missing` → 自动禁用本 session 的 `$ 预算`并发 warn，避免用估算值做硬限制。

## 中断与超时

### 中断

- 首选：向子进程发 SIGINT（不是 stdin 写 interrupt 控制消息；避免 stdin buffering 延迟）
- 等待 CC 产出 `turn_finished { reason: "user_interrupt" }`；超时 5s 未返回 → SIGKILL
- 补充：若 CC 后续版本稳定支持 `{"type": "control", "subtype": "interrupt"}` 的 stdin 中断，可作为备选；保留 SIGINT 为 MVP 默认

### 超时

- `SessionConfig.timeoutMs` 对应 `limits.perInputTimeoutMs`（见 `cost-and-limits.md`）
- 处理链：超时 → SIGINT → 等 5s → SIGKILL；整个过程产出 `turn_finished { reason: "wallclock_timeout" }` + `error` + `session_stopped { reason: "error" }`

### 崩溃

- 子进程意外 exit（无对应 interrupt） → `error` + `session_stopped { reason: "error" }`
- **不**自动重启；用户需 `/resume` 或 `/end`

## 兼容性自检（CompatibilityProbe）

进程启动时执行，所有检查通过才开始接受 Discord 事件：

1. `claude --version` → 解析版本号，比对最低支持版本；失败 → 启动失败 + 清晰错误
2. `claude --print "ping" --output-format json` → 预期 `result.stop_reason == "end_turn"` + 非空 `assistant` 文本；超时 30s
3. 可选：跑一次 `claude --print "read README.md" --output-format stream-json --allowed-tools Read`（子进程 `cwd` 选项指向 `<testDir>`）→ 验证 stream-json 输出结构能被解析器消费
4. 失败则：打 `agent_spawn_failed` 日志（见 observability.md），拒绝启动 Discord gateway

## 权限边界（与 security.md 对齐）

- 工作目录：通过子进程 `cwd` 选项传入（CC CLI 没有 `--cwd` flag），**不继承** agent-nexus 进程的 cwd
- 工具白名单：**必须**显式传 `--allowed-tools`，不依赖 CC 默认集
- 危险工具（`Bash`、shell 类 MCP）默认不入白名单；用户显式启用时加 `warn`
- 网络：MVP 不在本 spec 约束（CC 本身行为）；如需阻断，通过 OS 级手段

## 合约测试

| 用例 | 断言 |
|---|---|
| `probe_ok` | probe 3 步全过 |
| `probe_version_too_low` | fake `--version` 返回低版本字符串 → 启动失败 |
| `probe_parser_mismatch` | 构造非预期结构 stdout → 启动失败 |
| `happy_turn` | 输入一条消息 → 看到 `session_started` / `text_delta...` / `turn_finished { stop }` / `usage` |
| `tool_call_roundtrip` | assistant 发 tool_use → user 发 tool_result → assistant 继续 → end_turn |
| `interrupt_sigint` | SIGINT → 5s 内收到 `turn_finished { user_interrupt }` |
| `interrupt_sigkill` | SIGINT 后 CC 不响应 → 5s 后 SIGKILL → `error` + `session_stopped { error }` |
| `usage_missing_subscription` | mock CC 输出 `total_cost_usd=0` → UsageCompleteness=`partial`；$ 预算 opt-in 启用时触发 fail-closed |
| `unknown_stop_reason` | 构造未知 `stop_reason` → 映射为 `turn_finished { reason: "error" }` 并记 warn |
| `non_json_stderr` | CC 写非结构化 stderr → 解析器跳过 + 记诊断日志 |

所有 fixture 放 `testdata/cc-cli/transcripts/v<ver>/`（见 `testing/fixtures.md`）。

## 兼容矩阵（占位）

| CC CLI 版本 | 支持 | 最后验证日期 | 备注 |
|---|---|---|---|
| `>= 2.0.0`（规划） | ✓ | 待实现首 PR | 基线 |

矩阵由 `scripts/cc-cli-probe`（待实现）维护，结果落盘 `testdata/cc-cli/compatibility-<version>.json`。

## 反模式

- `--output-format text` 或人类可读格式做解析（不稳定，必须 stream-json）
- 依赖 CC 的 stderr 做业务判断（stderr 是诊断通道）
- 不传 `--allowed-tools` 依赖 CC 默认（安全边界隐式）
- `bypassPermissions` 作为 MVP 默认（安全边界失守）
- 忽略 `result.stop_reason`（用来判定 turn 结束的唯一权威信号）
- 把 `total_cost_usd` 当硬预算依据（订阅路径可能为 0 或 null）

## Out of spec

- CC CLI 的具体命令行参数演进（出现 breaking 时发新 ADR）
- Windows 路径/换行符处理细节（实现层）
- MCP server 生命周期（见 security.md，另有单独 spec）
- CC 内部配置文件（`~/.claude/` 下的 settings、CLAUDE.md 等）：由用户维护，本项目不直接读写
