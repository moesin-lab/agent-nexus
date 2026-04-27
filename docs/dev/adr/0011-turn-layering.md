---
title: ADR-0011 分层 turn 概念（nexus turn / agent turn / backend process）
type: adr
status: active
summary: 把当前混为一谈的"一次推进"拆成三层——nexus turn / agent turn / backend process——锁定各自的状态机、超时维度与取消语义
tags: [adr, decision, turn, runtime, timeout, lifecycle]
related:
  - dev/adr/0002-agent-backend-claude-code-cli
  - dev/spec/agent-runtime
  - dev/spec/agent-backends/claude-code-cli
  - dev/spec/message-flow
  - dev/spec/infra/cost-and-limits
adr_status: Proposed
adr_number: "0011"
decision_date: null
supersedes: null
superseded_by: null
---

# ADR-0011：分层 turn 概念

- **状态**：Proposed
- **日期**：2026-04-27
- **决策者**：senticx@foxmail.com
- **相关 ADR**：ADR-0002（CC CLI 作为 agent 后端）

## 状态变更日志

- 2026-04-27：Proposed

## Context

现行 spec 与代码里只有**一种** turn 概念：daemon 一次 `sendInput` → backend 产出 `turn_finished` → 这次 turn 结束。`agent-runtime.md` §AgentEvent 列出的 `turn_finished` 与 `cost-and-limits.md` 的 `perInputTimeoutMs` 默认 5 分钟，都是基于这个单层模型。

实现上，`agent/claudecode` 的 `sendInput` 用 `execa(claudeBin, args, { timeout })` spawn 一次 `claude --print`，等子进程退出。这等价于把三件事画上等号：

```
nexus turn  ==  agent turn  ==  backend 子进程的存活周期
```

只要后端是 `--print` one-shot 模式就侥幸成立。最近一次线上事故暴露了等号的代价：用户在 Discord 发 "副作用大的不测"（7 字），CC 在 60 秒内未完成单次 turn 处理，`execa` 的 wallclock timeout 触发，子进程被杀，daemon emit `errorKind: spawn_failed`。事故的浅层原因是 60s 默认值过小、`SessionConfig.timeoutMs` 配置链路断了；但**深层原因是 turn 概念没分层**——一个 timer 同时承担三种语义（用户体验上限 / agent 健康度判据 / backend 进程绝对兜底），任何一个阈值都注定误杀或漏判。

仅靠调阈值或闭合配置链路解决不了根因：

- **stream-json 持久 session**（spec 已标 TODO）落地后，一个常驻 CC 子进程会跨多次用户输入存活——backend process ≠ agent turn。
- 未来 nexus 可能在一次用户输入内调多次 backend（self-correction、tool routing、planning）——一次 nexus turn ↔ N 次 agent turn。
- 反过来，用户撤回 / 追发新消息 / 显式 `/cancel` 时，nexus 想结束当前 turn，但杀子进程 ≠ 干净结束 nexus turn（仍要 emit done、释放 sessionKey 锁、记账、回执）。

事故触发的修复决定（调超时、串通 `SessionConfig.timeoutMs`）只能短期止血。先锁定三层概念边界，下游 spec / 实现才知道把"超时""取消""完成"分别绑到哪一层。否则上 stream-json 也只是把现在的耦合换个壳。

## Options

### Option A：保持单层 turn，只调阈值与配置链路

把 `perInputTimeoutMs` 默认值调大到 5min（spec 写法），让 `sendInput` 优先读 `SessionConfig.timeoutMs`，runtime 级 `perInputTimeoutMs` 退化为兜底。

- **优点**：改动最小；不需要动 spec 的事件模型；当下事故立即止血
- **缺点**：单 timer 仍同时承担三种语义；stream-json 落地后必须再做一次概念拆分；用户取消 / 多 agent turn 拼一个 nexus turn 等场景仍无清晰位置安放
- **主要风险**：把"事故触发的设计修复"包装成"调参数"绕过——下次遇到 stream-json 或多轮 routing 时再次踩同款根因

### Option B：分层三类概念（Recommended）

显式定义并锁定三层：

| 层 | 语义 | 状态机所有者 | 超时维度 |
|---|---|---|---|
| **nexus turn** | 用户视角的一次推进（一条 inbound → 一次回执完成） | `daemon.engine` | 用户体验上限（"等多久该告知超时了"） |
| **agent turn** | runtime IPC 上的一次 request → response 循环 | `AgentRuntime` 实现 | 健康度判据（first-byte / inter-chunk idle） |
| **backend process** | 后端进程 / 连接的存活周期 | adapter 内部 | 资源绝对兜底（wallclock + idle） |

允许的拓扑关系：

- `nexus turn : agent turn = 1 : N`（self-correction / routing 场景）
- `agent turn : backend process = N : 1`（stream-json 持久 session）
- 当前 `--print` 模式是退化情形：三者 1:1:1 同步消亡

本 ADR 只锁定**概念分层与归属**；具体状态机字段、事件名、timer 默认值由后续 spec 修订承载。

- **优点**：每层超时 / 取消 / 完成各归各位；stream-json、多轮 routing、用户取消三类场景都有清晰位置；下游 spec 改动有锚点；事故的真因（一个 timer 三个语义）被消除
- **缺点**：需要修订 `agent-runtime.md` / `message-flow.md` / `cost-and-limits.md` 至少三处 spec；可能新增 `nexus_turn_started` / `nexus_turn_finished` 之类的事件名（与现有 `turn_finished` 共存或替代）；实现侧 daemon engine 要新建 nexus turn 状态机
- **主要风险**：分层概念若只在 spec 层做、不下沉到代码与日志字段（`turnSequence` / `nexus_turn_id` / `agent_turn_id`），实际仍会按旧模型实现，造成"文档说三层、代码写一层"的更糟状态。缓解：本 ADR 的 §"需要后续跟进的事" 列出 spec / 实现 / 观测三处必须同步到位的子项

### Option C：只分两层（nexus turn / backend），跳过 agent turn

把"agent turn"折叠进 backend：runtime 层只暴露 `sendInput` / `nexus_turn_finished`，不区分 IPC 单次循环。

- **优点**：比 Option B 少一层概念；接口更简单
- **缺点**：失去对 backend 健康度的独立判据——idle timeout、first-byte timeout 没有合适归属层；多 agent turn 拼一个 nexus turn 的场景退化为"runtime 内部细节"，daemon 看不见、记不了账；observability 字段（每次 backend round-trip 的 token / wallClockMs）无处归属
- **主要风险**：把可观测性与限流的天然抓手（per agent turn）压到 runtime 内部，daemon.counters / quota-enforcer 失去最自然的统计单元

## Decision

选 **Option B：分层三类概念（nexus turn / agent turn / backend process）**。

本 ADR 只承载"为什么必须分三层而非保留单层或只分两层"的决策依据，**不**定义具体事件名、状态机字段、timer 名称或默认值——这些归后续 spec 修订（修 `agent-runtime.md` / `message-flow.md` / `cost-and-limits.md`）。

落地节奏：

1. 本 ADR 合入 → spec 修订 PR（按 SSOT 原则，事件 / 字段 / timer 默认值各归 owner）
2. spec 改完 → 实现 PR（daemon engine 新增 nexus turn 状态机；`agent/claudecode` 的 `sendInput` 拆出 agent turn 与 backend process 两层超时；事故修复的"60s → 5min + 串通 `SessionConfig.timeoutMs`"作为实现 PR 的子任务一并完成）
3. 实现完 → 观测字段补全（`nexus_turn_id` / `agent_turn_id` / 每层独立 `wallClockMs`）

## Consequences

### 正向

- 一个 timer 承担三种语义的根因被消除；超时 / 取消 / 完成三类语义各归其层
- stream-json 持久 session 落地有清晰落点——backend process 跨多次 agent turn 与 spec 一致而非冲突
- 多 agent turn 拼一个 nexus turn（self-correction / tool routing）有架构位置，未来不需要重新讨论
- 用户取消 / 撤回的语义清晰——nexus turn 可以"用户已撤回"结束，无需绑定 backend 是否还活着
- daemon 的可观测性 / 限流抓手稳定——每个 agent turn 是独立可计量单元

### 负向

- spec 修订量不小：`agent-runtime.md` 的 `AgentEvent` 模型需要把 `turn_finished` 区分到 nexus / agent 两层（命名与兼容路径待 spec 决定）
- daemon engine 新增 nexus turn 状态机，比当前"等 backend exit"复杂
- adapter 实现要分别维护 agent turn timer 和 backend process timer，工程量略增
- 早期实现可能仍处于"三层退化为 1:1:1"的形态（`--print` 模式），分层带来的成本先付而收益要等 stream-json 才完整兑现

### 需要后续跟进的事

- spec 修订 PR：`agent-runtime.md` / `message-flow.md` / `cost-and-limits.md` 同步引入三层 turn 概念与对应事件 / timer 字段
- 实现 PR：daemon engine 的 nexus turn 状态机；adapter 的 agent turn / backend process 拆层；事故修复（默认 5min + 串通 `SessionConfig.timeoutMs`）作为子项
- 观测字段：`turnSequence` 是否要分裂为 `nexusTurnSequence` / `agentTurnSequence` 由 spec 决定，但 ADR 要求二者必须可独立追踪
- 反模式守门：reviewer 看到"用一个 timer 同时管 UX / 健康度 / 兜底"或"用 backend exit 当 nexus turn 完成信号"应要求修正

## Out of scope

- **不决定**具体事件名（`nexus_turn_finished` vs 复用 `turn_finished` + scope 字段，由 spec 修订定）
- **不决定**三层各自的 timer 默认值（住 `cost-and-limits.md`）
- **不决定**取消 / 中断的具体协议（住 `agent-runtime.md` §中断 与 `message-flow.md`）
- **不决定**用户取消的 IM 触发面（`/cancel` 命令、撤回检测等，由 platform-adapter 与 message-flow 决定）
- **不决定**stream-json 持久 session 的具体落地方式（是否复用 `--input-format stream-json`、子进程池策略等，由 `agent-backends/claude-code-cli.md` 修订决定）
- **不决定**backend 健康度的具体判据（first-byte vs inter-chunk idle vs 心跳，住 backend contract）

## 参考

- 触发本 ADR 的事故 trace：daemon 日志 `traceId: 1c68898f-eba5-447f-89f6-884102fb8dc9`（discord session 60s wallclock timeout）
- 相关 spec：[`../spec/agent-runtime.md`](../spec/agent-runtime.md)、[`../spec/message-flow.md`](../spec/message-flow.md)、[`../spec/infra/cost-and-limits.md`](../spec/infra/cost-and-limits.md)、[`../spec/agent-backends/claude-code-cli.md`](../spec/agent-backends/claude-code-cli.md)
- 相关代码（事故现场，可能随后续 PR 变化）：`packages/agent/claudecode/src/index.ts`（`sendInput` 单层 timer 实现）、`packages/cli/src/index.ts`（`SessionConfig.timeoutMs` 配置入口）
