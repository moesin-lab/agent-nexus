---
title: ADR-0016：TUI-hosted Agent Backend Family
type: adr
status: active
summary: 新增 TUI-hosted agent backend family；用 tmux 承载真实交互式 CLI，并用旁路 parser 抽取可消费状态
tags: [adr, decision, agent-runtime, tui, tmux, parser]
related:
  - dev/adr/0012-claudecode-stream-json-mainline
  - dev/adr/0014-agent-backend-codex-cli
  - dev/architecture/session-model
  - dev/spec/agent-runtime
  - dev/spec/security/tool-boundary
  - dev/spec/security/auth
adr_status: Proposed
adr_number: "0016"
decision_date: 2026-06-05
supersedes: null
superseded_by: null
---

# ADR-0016：TUI-hosted Agent Backend Family

- **状态**：Proposed
- **日期**：2026-06-05
- **决策者**：senticx@foxmail.com
- **相关 ADR**：ADR-0012、ADR-0014

## 状态变更日志

- 2026-06-05：Proposed

## Context

agent-nexus 当前的主路径把 Claude Code 与 Codex 当作结构化 CLI backend 接入。Claude Code 走 stream-json，Codex 走 `exec --json` / `resume`，这让 `AgentEvent` 合约清晰、测试稳定，也让 daemon 不需要理解 TUI 屏幕。

这个路径的代价是：它只覆盖 CLI 暴露给非交互协议的能力。真实交互式 CLI 的 TUI、slash command、plan mode、提示状态、resume 体验和新功能，可能先出现在人类终端界面里，而不是稳定 JSON protocol 里。若 agent-nexus 只接受已结构化的 backend，接入新 CLI 或追随 CLI 快速迭代会变慢。

StarAgent / botmux 类方案提示了另一条适配路径：把真实 CLI 放进长期存在的 tmux TTY，再从旁路读取 CLI 原生 transcript、JSONL、进程信息和 terminal pane，解析出 working、latest reply、message history、token usage 等状态。tmux 在这里不是 UI，而是可 attach、可 capture、可 send input 的观测基座；parser 是把真实 TUI 运行态提升为系统可消费状态的兼容层。

这条路径不能继承 structured backend 的所有安全和事件顺序承诺。尤其是 ADR-0012 锁定的执行前工具拦截依赖 Claude Code stream-json / stdio control 通道；真实交互式 CLI 在 tmux 内自主运行时，parser 多数只能事后观察，不能天然阻止工具执行。TUI-hosted backend 必须把这种能力回退显式声明出来，而不是假装复用现有工具边界即可。

这类 backend 与现有 `codex` / `claudecode` structured backend 不是替代关系。它适合"保留真实交互式 CLI 行为"的场景；structured backend 仍适合自动化、强协议测试和事件顺序保证。需要一个架构决策来承认这是一类新的 backend family，而不是把 TUI 解析逻辑塞进现有 backend 或 daemon。

## Options

### Option A：继续只支持结构化 CLI protocol backend

- **是什么**：只接入 stream-json、JSONL exec、SDK 或 HTTP API 这类可直接产出结构化事件的后端；交互式 TUI 不纳入 agent-nexus runtime。
- **优点**：
  - `AgentEvent` 的来源稳定，测试夹具简单。
  - daemon 和 backend 不需要处理 ANSI、TTY、screen capture、prompt 识别。
  - 安全边界更容易描述，输入输出都走明确协议。
- **缺点**：
  - 无法原样利用真实 TUI CLI 的新能力和交互体验。
  - 新 agent CLI 若没有稳定 JSON protocol，接入成本会被迫升高。
  - 人工 attach / adopt / 旁路观察能力弱，调试仍依赖外部终端习惯。
- **主要风险**：agent-nexus 只能消费 CLI 的协议子集，长期落后于真实 CLI 产品形态。

### Option B：把 TUI parser 塞进现有 structured backend

- **是什么**：在现有 `codex`、`claudecode` backend 内部直接增加 tmux 启动、pane capture 和 parser fallback。
- **优点**：
  - backend id 不增加，用户配置表面更少。
  - 可以复用现有 package 与测试目录。
- **缺点**：
  - structured protocol 与 TUI observation 的可靠性等级混在一起，容易让上层误以为所有事件同样可信。
  - backend 内部同时承担 process host、TTY input、transcript locator、screen parser 和 structured parser，边界变厚。
  - 现有 backend 的安全默认值和 capability 声明会变得难以解释。
- **主要风险**：为了兼容 TUI，把原本清晰的 `AgentRuntime` contract 和 backend capability 混成多语义实现。

### Option C：新增 TUI-hosted backend family

- **是什么**：把 `codex-tui`、`claudecode-tui` 等作为独立 backend 实现族；它们仍实现 `AgentRuntime`，但运行形态是 tmux-hosted interactive CLI，状态来源是 native transcript / JSONL / pane text 的旁路 parser。
- **优点**：
  - provider 身份与运行形态都清楚：Codex / Claude 是 provider，`tui` 是 backend mode。
  - 保留真实交互式 CLI 能力，同时不污染 structured backend 的强协议承诺。
  - parser 可以区分观测来源与可信等级，避免把 terminal fallback 伪装成稳定事件。
  - tmux session 可被 attach、capture、adopt，便于人工接管和调试。
- **缺点**：
  - 需要新增 backend package、parser 测试夹具和 host 适配层。
  - `AgentEvent` 与 observation state 的边界需要后续 spec 明确，不能直接把低置信度 pane text 提升为强事件。
  - 安全、audit、owner、可写 terminal 输入都需要单独约束。
- **主要风险**：如果 parser 过度承诺，TUI 文案变化会造成错误状态；必须把 native transcript 优先级、fallback 语义和置信度写进后续 contract。

## Decision

选 **Option C：新增 TUI-hosted backend family**，以 `codex-tui` / `claudecode-tui` 等独立 backend 表达“tmux 承载真实交互式 CLI + 旁路 parser 抽状态”的运行形态。

TUI-hosted backend 是能力较弱但兼容面更广的运行形态。它不得默认声称具备 structured backend 的执行前工具拦截、完整 `AgentEvent` 顺序保证或 daemon 重启 rediscover 能力；这些能力必须在后续 spec / probe 中逐项证明后再声明。

## Consequences

### 正向

- agent-nexus 可以接入真实交互式 CLI，而不要求每个 provider 先暴露稳定 JSON protocol。
- structured backend 与 TUI-hosted backend 的 capability、风险和测试边界可以分开声明。
- tmux session 成为 TUI backend 的观测与接管基座，支持 attach、capture、send input 和 adopt。
- parser 可以按来源分层：优先 CLI 原生 transcript / JSONL，其次 terminal pane fallback，最后 generic tail。

### 负向

- TUI-hosted backend 的事件可信度低于 structured protocol，不能默认等价产出所有 `AgentEvent`，也不能默认满足现有 `AgentEvent` 顺序不变量。
- TUI-hosted backend 默认不具备 ADR-0012 依赖的执行前工具拦截能力；落地前必须按较低工具边界 capability 处理，或限制在受信 / 只读 / 沙箱化工作目录。
- 需要维护 provider-specific parser；CLI TUI 文案或 transcript 格式变化会带来解析回归。
- 可写 terminal 输入与人工 attach 都是高权限输入面；daemon 外直接 attach 不能天然进入 daemon auth/audit，只能通过部署边界与 tmux socket 访问控制降低风险。
- tmux 成为该 backend family 的运行依赖；无 tmux 环境需要明确 probe fail-closed 或选择其它 host。

### 需要后续跟进的事

- 在 `agent-runtime` 相关 spec 中定义 TUI-hosted backend 的 host、观测来源、可信等级与 `AgentEvent` 提升规则。
- 明确是否新增 non-`AgentEvent` observation channel；若新增，必须定义谁消费、是否持久化、是否能进入平台展示。
- 为首个候选 backend 做 POC，建议从 `codex-tui` 开始：tmux launch、send input、interrupt、capture pane、native rollout locator、parser fixture。
- 明确命名规则：backend id 在前、mode 在后，例如 `codex-tui`、`claudecode-tui`，避免把 `tui` 当成独立 agent provider。
- 增加安全约束：terminal writable input、attach、file preview、工具边界能力回退、工作目录沙箱和 redaction 都必须有单独 spec。
- 评估 daemon 重启恢复是否为 TUI-hosted backend 增加 rediscover 流程；如果增加，必须同步修订 session model。
- parser 必须有版本 / 格式 probe 或等价失配检测；不匹配时 fail-closed，不静默产出高置信状态。

## Out of scope

- 不决定具体 TypeScript 接口字段；字段契约由后续 spec 修改承载。
- 不决定替换现有 Claude Code stream-json 或 Codex `exec --json` backend。
- 不决定 Web dashboard、远程 node、Tailscale 或浏览器 terminal 的产品形态。
- 不决定所有 TUI parser 都必须产出完整 `AgentEvent`；低置信度 observation 可以只用于展示和调试。
- 不决定是否把 TUI slash command 暴露成 agent-nexus command；该问题属于 command registry 与具体 backend spec。
- 不决定 daemon 重启后的 rediscover 状态机；若后续采用，必须另行修改 session model。
- 不决定 tmux 之外的 host（container、PTY-only、SSH remote）是否进入主路径。

## Amendments

无。

## 参考

- 相关 spec：[`../spec/agent-runtime.md`](../spec/agent-runtime.md)
- 相关 architecture：[`../architecture/session-model.md`](../architecture/session-model.md)
- 相关 security spec：[`../spec/security/tool-boundary.md`](../spec/security/tool-boundary.md)、[`../spec/security/auth.md`](../spec/security/auth.md)
- 相关 ADR：[`0012-claudecode-stream-json-mainline.md`](0012-claudecode-stream-json-mainline.md)、[`0014-agent-backend-codex-cli.md`](0014-agent-backend-codex-cli.md)
- 外部参考：[SiriusNEO/StarAgent](https://github.com/SiriusNEO/StarAgent)、[deepcoldy/botmux](https://github.com/deepcoldy/botmux)
