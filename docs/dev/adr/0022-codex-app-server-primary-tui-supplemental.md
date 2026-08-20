---
title: ADR-0022：Codex 以 app-server 为主控制面，TUI 作为补充视图
type: adr
status: active
summary: Codex 跨 turn 主路径使用 daemon-owned app-server stdio 协议；真实 TUI 与通用 PTY host 保留为人工交互和非结构化 CLI 的补充
tags: [adr, decision, agent-runtime, codex, app-server, tui, pty]
related:
  - dev/adr/deprecated/0016-tui-hosted-agent-backends
  - dev/adr/0014-agent-backend-codex-cli
  - dev/adr/0020-publish-single-npm-cli-package
  - dev/spec/agent-runtime
  - dev/spec/agent-backends/codex-app-server
  - dev/spec/config-routing
  - dev/spec/security/tool-boundary
  - dev/architecture/session-model
adr_status: Proposed
adr_number: "0022"
decision_date: 2026-07-31
supersedes: "0016"
superseded_by: null
---

# ADR-0022：Codex 以 app-server 为主控制面，TUI 作为补充视图

- **状态**：Proposed
- **日期**：2026-07-31
- **决策者**：senticx@foxmail.com
- **相关 ADR**：ADR-0014、ADR-0020；取代 ADR-0016

## 状态变更日志

- 2026-07-31：Proposed

## Context

Issue #186 的直接缺口是：现有 `codex exec --json` 每个 user turn 启动新进程，conversation resume 不能恢复上一 turn 的 live control surface。飞书侧需要在同一 SessionKey 下跨 turn 输入、读取输出、查询状态、中断和终止；更长期还要覆盖人工终端、CLI-only 操作和没有 structured server 的其它 agent CLI。

最初的 Bun 1.3.9 实机 probe 已证明 `Bun.Terminal + @xterm/headless` 能启动 Codex 0.146.0 TUI、处理 bracketed paste 与 kitty keyboard flags、连续提交两轮、Ctrl-C 中断并清理 process group。它证明通用 TUI host 可行，但 screen parser 仍必须依赖版本化 banner、composer、footer 和 reply region；未知 UI 只能 fail closed，无法提供强顺序 turn/item/usage/approval 事件。

同日重新核实当前 Codex 后发现，0.146.0 已公开 `codex app-server`：它通过 JSON-RPC 提供 thread、turn、item、status、usage、interrupt、approval 与 request-user-input 等结构化 surface，并可用当前二进制生成版本一致的 TypeScript schema。真实 probe 已验证的稳定子集仅包括：initialize、ephemeral thread/start、同一 thread 连续两轮、`thread/status/changed active→idle`、最终 agentMessage，以及第三轮 `turn/interrupt → interrupted`。usage 虽在实测流中出现但尚未纳入断言；background terminal、process stdin/resize/terminate 等只出现在 `--experimental` schema 或尚未 probe，不能作为本 ADR 已证明的能力。

botmux 的 MIT 实现也已从单纯 PTY/tmux paste 演进为 hybrid：app-server 接受 `turn/start`，`codex --remote ... resume <threadId>` TUI 只作为同一 thread 的 viewer；tmux 负责 viewer 常驻与人工 attach。这证明 structured control 与真实 TUI 可以组合，不要求 pane text 成为业务事实源。该参考基于 `deepcoldy/botmux@0afba71643270504a22551800b0196c752f412d9`，只迁移经本项目 spec/TDD 验证的设计，不复制其高权限自动审批、安全配置或实现代码。

MaxMux 0.4.3 的公开包说明是 TypeScript/Bun 的 client-server mux，但其声明的 PTY stack 是 `node-pty + xterm-headless`，不能作为 `Bun.Terminal` 已被成熟 mux 验证的证据。Bun 官方 `Terminal` 仍是可用的原生 PTY primitive；它本身不提供 durable registry、reattach 或 daemon restart recovery。

后续复查还找到 MIT 的 `pty-manager` / `tmux-manager` adapter family：前者提供 TypeScript-first 的 PTY lifecycle、attach、sendKeys、bracketed paste、blocking prompt 与 completion detection，后者用相同 adapter surface 交给系统 tmux 托管。它比复制完整 MaxMux 更接近本项目 supplemental viewer 的最小边界，但其 prompt/completion detection 仍是弱观察，只能用于没有 structured server 的 CLI 或人工提示，不能覆盖 app-server 的 thread/turn terminal。

Codex remote TUI 也存在大历史恢复风险：公开 issue #19837 记录 `codex --remote ... resume` 在较大 `thread/resume` response 上失败；后续 app-server 文档增加 `excludeTurns` 与分页 history surface。因而 remote viewer gate 必须包含大 conversation、分页与 viewer 重建测试，不能把本地小 thread attach 成功外推为任意历史可靠。

因此现在要决定：Codex 的业务控制面是否继续从 TUI screen 推断，还是使用官方 app-server；以及真实 TUI/mux 在整体架构中的位置。

## Options

### Option A：继续使用 `codex exec --json`，每 turn resume

- **是什么**：保留现有 structured backend，每次输入启动一次 `codex exec --json`，用 thread id 恢复 conversation。
- **优点**：实现已存在；事件结构化；不维护常驻 child。
- **缺点**：没有 live thread owner；无法对上一 turn 的 app-server/process/control request 做持续控制；人工 TUI 与 background terminal 不在同一 runtime。
- **主要风险**：把历史 resume 误当成 live operation continuity，继续无法满足 Issue #186。

### Option B：Bun PTY/TUI 作为 Codex 主控制面

- **是什么**：daemon 启动 Bun sidecar，以 `Bun.Terminal + @xterm/headless` 持有真实 Codex TUI，输入按键并解析 screen。
- **优点**：覆盖 CLI 可见 UI 和 slash command；同一 PTY 可扩 Web terminal；可复用于其它 CLI。
- **缺点**：业务终态依赖低层 UI fixture；Codex 版本升级会改变 keyboard mode、composer 和 chrome；approval、usage、tool item 不能可靠提升。
- **主要风险**：低置信度 screen observation 被误当成强状态，导致重复输入、漏终态或错误自动操作。

### Option C：app-server stdio 为主控制面，TUI/mux 为补充

- **是什么**：每个 live Codex session 由 daemon 通过匿名 stdio 持有一个 app-server connection；thread/turn/item/status 是业务事实源。真实 remote TUI 后续可订阅同一 thread，只负责人工显示与 UI-only 操作；Bun PTY host 保留给无 structured server 的 CLI。
- **优点**：跨 turn、输出、状态、interrupt、usage 和 server request 原生结构化；匿名 stdio 安全面较小；可按当前 Codex 版本生成 schema；后续仍能接 remote TUI。
- **缺点**：app-server 及部分字段仍标记 experimental；需要版本门禁、schema snapshot、双向 ServerRequest broker 和 thread lifecycle；首版没有人工 attach。
- **主要风险**：未处理的 server request 会卡住 turn；daemon crash 后 idle thread 可 resume 不代表 in-flight turn 或 background process 可恢复。

### Option D：首版同时上线 app-server + remote TUI hybrid

- **是什么**：每 session 启动 app-server WebSocket listener，同时启动 `codex --remote ... resume` viewer，并把 viewer 放入 durable mux。
- **优点**：具备同时承载 structured control 与真实 TUI viewer 的形态，并为 Web terminal、人工 attach 留出实现路径。
- **缺点**：同时引入端口/socket auth、viewer 重建、thread 广播同步、mux lifecycle 和两套兼容矩阵。
- **主要风险**：Issue #186 的最小控制路径被三层进程状态机掩盖，安全与恢复边界难以独立验证。

## Decision

选 **Option C**：Codex 新主路径使用 daemon-owned `codex app-server --listen stdio://`，以结构化 thread/turn/item/status 作为唯一业务事实源；remote TUI 与 durable mux 后置为同一 thread 的补充 viewer，Bun PTY host 只承担通用 CLI/人工终端能力，不再作为 Codex 业务状态主实现。

首版 app-server 不监听 TCP、WebSocket、Unix socket，不启用 daemon/remote-control，也不提供外部 attach。Node daemon 以 argv array 启动 child，使用匿名 stdin/stdout JSONL，固定方法 allowlist、cwd、sandbox 与 approval policy；未知 schema、method、notification、ServerRequest 或版本必须按 spec fail closed。每个 agent conversation generation 使用独立随机 homeId、跨 local child 持久的 conversation-private `CODEX_HOME`，thread id 通过 private registry 定位 home；SessionKey 只作为当前 binding 与审计信息，因此支持同 key 多 generation和跨 key rebind。home 只迁移受校验的 `auth.json` 快照与 agent-nexus 生成的最小安全配置；用户 config、rules、MCP、hooks、skills、plugins 和 feature flags 不继承。normal stop 保留 rollout；首版无 daemon archive hook，只有 operator 显式启用的 backend retention GC 才删除 committed home，且删除必须经过持久化 tombstone，使中断后能在下次 registry reconciliation 重试。

已有 Bun TUI spike 与 package 仅作为通用 host 研究资产保留到新 spec 完成；它们不得先接入 CLI/飞书并宣称是 Codex production backend。是否把其整理成 `agent-tui-host`、保留为实验 package 或删除，由后续通用 CLI/TUI ADR 决定。

本 ADR 取代 ADR-0016 对“tmux-hosted TUI 作为 Codex 主控制面”的决定；它不自动确认通用 CLI 的稳定 TUI-hosted backend family。后者重新开放，等待独立 ADR。

## Consequences

### 正向

- 飞书同一 SessionKey 可以复用一个明确的 Codex thread，连续 turn 不再依赖 pane paste 与 screen 猜测。
- 已验证的 `thread/status/changed`、`turn/completed`、agentMessage 和 interrupt 具有结构化关联 id，可实现恰好一次终态和可审计错误映射；usage 仍需独立 contract test 后才能提升。
- 当前 Codex binary 可生成 TypeScript/schema snapshot，compatibility gate 能检测协议漂移。
- 后续 remote TUI 可以订阅同一 app-server thread；人工视图与业务控制无需竞争 PTY 输入所有权。
- Bun PTY 研究仍可服务 Claude/Gemini/任意 CLI，不与 Codex 特有协议耦合。

### 负向

- 新 backend 需要实现双向 JSON-RPC，而不是只消费 stdout notifications；approval、request-user-input、MCP elicitation 必须进入飞书交互或安全拒绝。
- app-server child、thread、turn、background process 和 daemon session 是不同生命周期；不能用 conversation resume 宣称 live process recovery。
- 首版不提供人工 attach、Web terminal 或所有未来 slash command；这些由 remote TUI supplemental 阶段补齐。
- app-server 本身及 process/background terminal 等 experimental surface 会增加 Codex 版本锁定、schema 更新和 release probe 成本。

### 需要后续跟进的事

- 落实并维护 `codex-app-server` contract：握手、schema/version gate、method allowlist、thread/turn 状态机、事件映射、ServerRequest broker、超时、断线与 cleanup。
- 真实验证 idle thread 在 app-server 重启后的 `thread/resume`，并单独验证 in-flight turn crash 的确定终态。
- 把 process/background terminal 的 experimental schema 与真实 list/write/resize/terminate probe 设为 live shell continuity 的 acceptance gate；未通过前不宣称该能力。
- 为 remote TUI viewer 另立 ADR，决定 authenticated loopback/Unix transport、viewer lifecycle、durable mux 与人工 attach。
- 对没有 structured server 的 CLI 再决定 Bun PTY host package 的稳定边界。

## Out of scope

- 不删除或替换现有 `codex exec --json` backend；它保持独立 backend id，不作为 app-server session 的静默 fallback。
- 不在本 ADR 决定 remote TUI transport、Web terminal UI、tmux/MaxMux/Zellij 选型或 adopt 协议。
- 不承诺 daemon crash 后恢复进行中的 turn、pending approval 或 background process。
- 不把 app-server 的全部公开方法直接暴露给飞书；只有 spec allowlist 内操作可调用。
- 不决定 Claude Code 或其它 CLI 是否存在类似 structured primary。

## Amendments

无。

## 参考

- 官方 Codex app-server：<https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md>
- botmux hybrid 参考：<https://github.com/deepcoldy/botmux/blob/0afba71643270504a22551800b0196c752f412d9/src/codex-rpc-engine.ts>
- Bun Terminal：<https://bun.com/reference/bun/Terminal>
- MaxMux：<https://github.com/maxischmaxi/maxmux>
- pty-manager / tmux-manager：<https://github.com/HaruHunab1320/pty-manager>
- Codex remote 大历史 resume 风险：<https://github.com/openai/codex/issues/19837>
- 相关 spec：[`../spec/agent-backends/codex-app-server.md`](../spec/agent-backends/codex-app-server.md)、[`../spec/agent-runtime.md`](../spec/agent-runtime.md)
- 相关 issue：[Issue #186](https://github.com/moesin-lab/agent-nexus/issues/186)
