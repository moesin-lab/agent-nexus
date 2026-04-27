---
title: ADR-0011 turn 层级——daemon 视角外显两层，agent 内部留给 backend
type: adr
status: active
summary: 把"用户视角的一次推进"和"backend 进程寿命"显式拆成两个互相独立的概念；agent 内部多步推理留给 backend 自己，不升为外显概念
tags: [adr, decision, turn, runtime, timeout, lifecycle]
related:
  - dev/adr/0001-im-platform-discord
  - dev/adr/0002-agent-backend-claude-code-cli
  - dev/spec/agent-runtime
  - dev/spec/agent-backends/claude-code-cli
  - dev/spec/message-flow
  - dev/spec/infra/cost-and-limits
adr_status: Proposed
adr_number: "0011"
decision_date: 2026-04-27
supersedes: null
superseded_by: null
---

# ADR-0011：turn 层级——daemon 视角外显两层，agent 内部留给 backend

- **状态**：Proposed
- **日期**：2026-04-27
- **决策者**：senticx@foxmail.com
- **相关 ADR**：ADR-0001（IM 平台 Discord）、ADR-0002（CC CLI 作为 agent 后端）

## 状态变更日志

- 2026-04-27：Proposed

## Context

当前实现把"用户的一次推进"和"backend 子进程寿命"绑成同一回事：daemon 一次 inbound → spawn 一次 `claude --print` → 等子进程退出。一个超时 timer 同时承担两类职责——既是给用户看的 UX 上限（"等多久该告知超时了"），又是给资源用的兜底（"子进程跑飞了该杀"）。

这种耦合最近被一次事故暴露：用户在 IM 发了一条 7 字消息，子进程 60 秒内未结束，超时触发，进程被杀，daemon 报错并把这条互动算失败。事故的浅层原因是阈值过小、配置链路断了；但即便把阈值调大、把配置串通，**两类职责共用一个 timer** 的根因仍在——任何阈值都注定误杀长任务或漏判真卡死，因为两类职责对"健康度"的判据本来就不同。

进一步推：daemon 的本职（按 ADR-0001 / ADR-0002 / 已有 spec）是 IM 与 backend 之间的**桥接 + 安全网**——限流、配额、脱敏、超时兜底。这意味着 daemon 必然有自己的状态机：自己的等待 / 推送进度 / 倒计时 / 心跳 / 处理用户中途取消。这些行为不应当被 backend 子进程是否还活着所定义——agent 卡在思考 30 秒时 daemon 仍要能告诉用户"正在思考"，子进程崩了 daemon 仍要能干净结束这一回合（落 transcript、释放锁、发回执）。

把 daemon 自身的回合状态独立出来，是修事故根因的最小动作。再多就过头了。

## Options

### Option A：保持单层，仅调阈值与配置

- **是什么**：不动外显概念，只把超时阈值调大、把已有 spec 字段串通到实现，让事故现场不再触发
- **优点**：改动最小；事故立即止血
- **缺点**：UX 上限和资源兜底仍共用一个 timer；daemon 没有独立的回合状态机，仍只能在子进程退出时算"完成"
- **主要风险**：把根因修复包装成调参数；下一次 backend 形态变化（持久 session、流式输入）再次踩同款耦合

### Option B：外显三层（nexus / agent / backend）

- **是什么**：把"用户视角一回合"、"agent 内部一次想 + 调工具 + 再想"、"backend 进程寿命"三个概念都升为外显——daemon 能感知 agent 每一步、按步记账、按步限流、按步取消
- **优点**：未来如果 daemon 要主动调度 agent 多步推理（self-correction、tool routing、planning），位置已留好
- **缺点**：daemon 越过桥接 + 安全网职责，开始扮演 orchestrator——这与 ADR-0001 / ADR-0002 锁定的 daemon 角色冲突；为未付清的未来需求先付重构成本（事件名拆分、状态机扩展、观测字段拆分、限流口径切换）
- **主要风险**：把"未来某天可能要"当成"现在必须分"；当前事故事实只能证明"daemon 自身回合 ≠ 子进程寿命"，证不到"agent 内部循环必须外显"

### Option C：单层折叠（保留现状）

- **是什么**：维持当前实现——把"用户视角一回合"和"子进程寿命"等同，不引入额外层级，连 Option A 的阈值修复都不做
- **优点**：零改动
- **缺点**：事故根因不修；daemon 没有独立回合状态机，无法在 agent 思考期间向用户推送自身状态（思考中提示、倒计时、进度心跳）；用户中途取消、撤回、追发新消息没有干净的处理面
- **主要风险**：长期累积——backend 形态变更（持久 session）后耦合更深

### Option D：外显两层（daemon 视角的回合 / backend 进程寿命），agent 内部留给 backend

- **是什么**：把"用户视角一回合"和"backend 进程寿命"显式拆成两个互相独立的概念，各自有自己的状态机和 timer；agent 内部多步推理留给 backend 自己——daemon 通过事件流**看见过程**，但**不建模过程**

两个外显概念：

- **daemon 视角的回合**：从一次 IM inbound 起、到 daemon 决定本回合已落幕（正常完成、用户取消、UX 上限触发、错误终结）。daemon 拥有自己的状态机、自己的 timer、自己的 UX 输出（思考中提示、倒计时、进度消息），独立于 backend 子进程是否退出。
- **backend 进程寿命**：backend 实现侧的资源生命周期（CC `--print` 子进程、未来的持久 session、HTTP 连接等）。adapter 内部维护看门狗 / 资源兜底，不外显给 daemon。

agent 内部"想 → 调工具 → 再想"的多步推理是 backend 自己的事——daemon 通过 backend 输出的事件流（文本增量、工具调用开始 / 结束、usage 等）**看见过程**，但**不建模过程**：不把"agent turn"升为外显概念、不在事件命名 / 状态机 / 限流口径里建立这一层。

- **优点**：精确解决事故根因（UX 上限和资源兜底解耦）；daemon 拿回独立状态机，能在 agent 思考期间做自己该做的事；不为未付清的未来需求先付成本；与 ADR-0001 / ADR-0002 的 daemon 桥接 + 安全网定位一致
- **缺点**：未来若真要把 daemon 升为多步推理的 orchestrator，要再开一份 ADR 把 agent 内部循环升为外显概念（但那时已有真实需求支撑）
- **主要风险**：实现层若把 daemon 回合简单等同于"等到 backend 给最终结果"，会退回 Option C 的事实形态；缓解：daemon 状态机必须以"自己的 timer + UX 输出"为主轴，不以"子进程是否退出"为唯一终结条件

## Decision

选 **Option D**：外显两层（daemon 视角的回合 / backend 进程寿命），agent 内部多步推理留给 backend 自己。

核心约束：daemon 通过事件流**看见**agent 内部过程，但**不建模**该过程——"看见"和"建模"的边界是本决策的根本判据，也是 D 区别于 B 的支点。

本 ADR 只承载"为什么外显两层、为什么不顺手把 agent 内部也升为外显"的决策依据。具体事件命名、字段、状态机、timer 默认值、限流口径——**不**在本 ADR 决定，由后续 spec 修订承载（owner 矩阵：契约去 spec、规则本体去 standards、流程编排去 process）。

## Consequences

### 正向

- 事故的真因（UX 上限和资源兜底共用 timer）被消除——两类职责各归各位
- daemon 重新拥有与桥接 + 安全网定位匹配的独立状态机；agent 思考期间 daemon 仍能输出自身状态（思考中提示、倒计时、进度心跳、处理用户中途动作）
- 未来 backend 形态变化（持久 session、流式输入、HTTP API）落地时，daemon 侧不需要重新定义"一回合是什么"——daemon 回合是 daemon 自己的事，不绑死 backend 形态
- 没有把 agent 内部循环升为外显概念，避免在尚未出现"daemon 主动调度多步推理"的需求时为重构提前付成本

### 负向

- 实现层要在 daemon 与 adapter 之间清晰划线："谁该感知什么"——比 Option C 的现状复杂
- "看见过程而不建模过程"的边界没有显式失败信号——若 daemon 不慎在状态机或限流口径里偷偷塞入 agent 内部循环的感知，事实形态会静默退化为 Option B；这种漂移只能靠 reviewer 与后续 ADR 监督发现

### 需要后续跟进的事

- 如果未来出现"daemon 必须调度 agent 多步推理"的真实需求（self-correction、tool routing、planning 被列入产品路径），开新 ADR supersede 本决策、显式把 agent 内部循环升为外显概念，而不是悄悄在 spec 或实现里塞进去
- 如果实现层出现"daemon 回合事实上仍以 backend 子进程退出为唯一终结条件"的退化形态，应视为本决策未真正落地

## Out of scope

- **不决定**事件命名、字段、状态机字段——属 spec 范畴
- **不决定**timer 默认值与限流口径——属 spec 范畴（cost-and-limits）
- **不决定**用户中途取消的具体协议（IM 触发面、撤回检测、`/cancel` 命令等）——属 spec 范畴
- **不决定**daemon 思考中提示、倒计时、心跳的具体形态与触发条件——属 spec 范畴
- **不决定**backend 进程寿命的看门狗判据（first-byte、idle、心跳）——属 backend contract 范畴
- **不决定**未来是否引入持久 session、流式输入等 backend 形态——属新 ADR 范畴

## 参考

- 触发本 ADR 的事故 trace：`1c68898f-eba5-447f-89f6-884102fb8dc9`（本机 daemon 结构化日志，事件 `inbound` / `agent_error` / `outbound`；trace 字段定义见 [`../spec/infra/observability.md`](../spec/infra/observability.md)）
- 相关 spec：[`../spec/agent-runtime.md`](../spec/agent-runtime.md)、[`../spec/message-flow.md`](../spec/message-flow.md)、[`../spec/infra/cost-and-limits.md`](../spec/infra/cost-and-limits.md)、[`../spec/agent-backends/claude-code-cli.md`](../spec/agent-backends/claude-code-cli.md)
- 相关 ADR：[ADR-0001](0001-im-platform-discord.md)、[ADR-0002](0002-agent-backend-claude-code-cli.md)
