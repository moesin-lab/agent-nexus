---
title: ADR-0012 claudecode 切到 stream-json 主路径——协议合约 / interrupt / timeout
type: adr
status: active
summary: 把 claudecode runtime 从 --print 单次调用切到 stream-json 持续子进程；锁定 protocol 一次性对齐 spec union、interrupt 暂保持 SIGINT 主路径、流式 timeout 三层分层、平台必须提供流式呈现能力门槛——具体 UI / UX 策略下沉到 spec 与 issue 演进
tags: [adr, decision, agent-runtime, claude-code, stream-json, protocol]
related:
  - dev/adr/0002-agent-backend-claude-code-cli
  - dev/adr/0011-turn-layering
  - dev/spec/agent-runtime
  - dev/spec/agent-backends/claude-code-cli
  - dev/spec/message-protocol
  - dev/spec/platform-adapter
adr_status: Proposed
adr_number: "0012"
decision_date: 2026-04-28
supersedes: null
superseded_by: null
---

# ADR-0012：claudecode 切到 stream-json 主路径——协议合约 / interrupt / timeout

- **状态**：Proposed
- **日期**：2026-04-28
- **决策者**：senticx@foxmail.com
- **相关 ADR**：ADR-0002（CC CLI 作为 agent 后端）、ADR-0011（turn 分层）

## 状态变更日志

- 2026-04-28：Proposed

## Context

`docs/dev/spec/agent-backends/claude-code-cli.md` §交互式 session 已把 stream-json 标为 MVP 主路径，但 `packages/agent/claudecode/src/index.ts` 仍是 `--print` 单次调用形态——每次 `sendInput` spawn 新子进程，跑完即退。这个 spec/impl gap 是当前一组缺陷的共同上游：

- IM 端看不到 agent 的工具调用过程（issue #45）
- partial output 在子进程异常退出时丢失（issue #28）
- interrupt / stopSession 只能 SIGINT 整子进程（issue #54）
- Discord 长回复必须切多片，没有流式 edit（issue #30 / #55-B）

把它们当独立 issue 修，最后大概率在 stream-json 切换时被全部重写。本 ADR 立 epic 协议层 + 实现层共识，**只锁不可逆的架构决策**——协议契约、interrupt 主路径、流式 timeout 分层、平台能力门槛。具体 UX / UI 文案 / 操作入口 / 视觉策略由 spec 修订 + 后续 issue 演进，不进 ADR（避免过度承诺会随用户反馈演进的产品决策）。

观察到的关键事实：

1. **spec 已锁完整 AgentEvent union**——`docs/dev/spec/agent-runtime.md` §AgentEvent 已经把独立事件类型（`text_delta` / `thinking` / `tool_call_started` / `tool_call_progress` / `tool_call_finished`）和顺序保证（`text_delta` 拼起来等于 `text_final.text`、每个 `tool_call_started` 必有对应 `tool_call_finished`）定死。`packages/protocol/src/agent.ts:34-39` 的 union 是 spec 的裁剪版，注释挂 TODO 等本 ADR 解锁。
2. **spec 已锁 interrupt 主路径**——`docs/dev/spec/agent-backends/claude-code-cli.md` §中断 当前定义"首选向子进程发 SIGINT；stdin `control/interrupt` 作为补充，CC 后续版本稳定后可作备选"。issue #56 epic 提议反转。
3. **message-protocol §流式语义 已留 ADR 位**——MVP 默认是模式 A（`text_delta` 缓冲到 `text_final` 整段发送），模式 B（分步 edit）写"作为后续增强，在独立 ADR 中评审"——本 ADR 命中此范畴。
4. **Discord adapter 当前 capability 全为 false**——`packages/platform/discord/src/index.ts:193-206` 把 `supportsEdit` / `supportsThreads` / `supportsTypingIndicator` 都标 false。流式落地需要先翻平台能力门槛。

## Options

四个真架构决策点。具体 UI / UX 策略由 spec 修订 + 后续 issue 跟踪，不进本 ADR。

### 决策点 1：AgentEvent union 形态——protocol 该一次性对齐 spec，还是按 MVP 实际需要分批？

#### Option 1A：protocol 一次性对齐 spec 完整 union；runtime 选择性 emit

- **是什么**：本 ADR 阶段 protocol 把 spec 列出的所有事件类型一次性补齐（`text_delta` / `thinking` / `tool_call_started` / `tool_call_progress` / `tool_call_finished`）；runtime 本期 PR 只**实际产出** `text_delta` / `tool_call_started` / `tool_call_finished` 三类，其余在 protocol 上**有定义**但 runtime 不 emit
- **优点**：契约先行，protocol 一次到位与 spec 对齐；下游 daemon engine 的 exhaustive switch 一次配齐 case，未来加 emit 不再触发 breaking
- **缺点**：protocol 上会有"暂无来源"的事件类型，需要 spec 标注"声明位 vs 实际产出"

#### Option 1B：按 MVP 分批暴露 union

- **是什么**：本 ADR 阶段 protocol 只补齐"runtime 实际会 emit"的三类，其余留下次 ADR
- **优点**：契约与实际产出严格一致
- **缺点**：违反契约先行原则；TS discriminated union 后续逐个加 case 会接连击穿下游 exhaustive switch，造成多轮 breaking wave

### 决策点 1 子问题：CC `user.tool_result` 怎么落 protocol？

#### Option 1-tr-A：合入 `tool_call_finished.payload.resultSummary`

- **是什么**：runtime 把 CC `user.content[].type=tool_result` 解析后写进对应 `tool_call_finished` 事件的 `resultSummary` 字段（spec 已留位）
- **优点**：daemon engine 路由更简——一次 finished 事件携带完整对偶；UI 端只需配对呈现
- **缺点**：依赖一个外部假设——CC 对每个 `tool_use_id` 恰好回**一条**终态 `tool_result`，且无"多块 / 结构化 / 空 + error"等变体；该假设未经 fixture 实证
- **主要风险**：若假设不成立，`resultSummary` 收口会**静默丢信息**，且丢在 protocol 层而非 UI 层

#### Option 1-tr-B：新增独立 `tool_result` 事件类型

- **是什么**：protocol 加 `tool_result` 事件，runtime 把 CC `user/tool_result` 直接转发；finished 事件只在 spec 已留的 status 字段做配对
- **优点**：对 CC 输出多变体场景鲁棒；fixture 不全时也不丢信息
- **缺点**：spec 当前未列；多一类事件需要 daemon engine 多一处路由

### 决策点 2：interrupt 主路径——保持 SIGINT，还是升 stdin control？

#### Option 2A：保持 spec 现状（SIGINT 主，stdin control 备）；待证据再考虑反转

- **是什么**：runtime 实现 SIGINT 路径作为 `interrupt()` 的默认行为；stdin `control/interrupt` 路径**也实现**但默认不启用，由 `AgentCapabilitySet.supportsStdinInterrupt` flag 控制；本 ADR 只承诺"暂保持现 spec"，在补齐两类证据前不反转：
  - (i) stdin control 在 CC 2.1.x 的实测延迟 / 失效率
  - (ii) CC 卡在外部工具循环（spawn-tool-loop）时 SIGINT 的 reachability 数据
- **优点**：不强行翻 spec；为 interrupt 路径留容易切换的设施位
- **缺点**：本 ADR 不给 interrupt 路径下最终结论，留尾巴

#### Option 2B：跟随 issue #56 提议——stdin control 主，SIGINT fallback

- **是什么**：本 ADR 直接反转 spec
- **优点**：与 stream-json 协议层对齐；持续子进程下 stdin 控制语义最准
- **缺点**：CC 2.1.x 的 stdin control 稳定性未实测；推翻 spec 需要充分实证

### 决策点 3：Discord 平台必须提供流式呈现能力（capability 门槛）

#### Option 3A：本 ADR 只锁平台**能力门槛**，具体 UI 策略下沉到 spec + issue

- **是什么**：本 ADR 决定 Discord adapter `CapabilitySet` 必须翻 `supportsEdit: true` 与 `supportsTypingIndicator: true`，并实现对应方法（`edit()` / `setTyping()` / `clearTyping()`）；具体的 UI 决策——工具调用形态（inline 嵌入 / 折叠 thread / 独立消息）、typing 节奏（持续 / 阶段性）、错误呈现（inline ❌ / 独立 reply）、mid-stream 收尾标记、切片之间时序锚定（reply 链 / 扇出 / 不锚定）、interrupt 用户入口（slash command / emoji / 文本）——**不进本 ADR**，由 `docs/dev/spec/message-protocol.md` 修订 + 后续 issue 跟踪 PR-D 实施
- **优点**：ADR 守住"架构决策"本位（contract / 不可逆 / 跨模块边界）；UI / UX 决策由用户反馈演进而非一次性锁定，调整成本低
- **缺点**：本 ADR 不直接消解 #45 / #30；落地节奏取决于后续 issue 推进

#### Option 3B：本 ADR 同时锁定具体 UI / UX 策略

- **是什么**：本 ADR 同时决定 inline vs thread / typing 节奏 / 错误文案 / 切片锚定方式 / interrupt 入口
- **优点**：实施 PR 启动时所有方向都明确
- **缺点**：UI / UX 决策本质会随用户反馈演进，锁 ADR 是过度承诺；调整需要发新 ADR / Amendment 成本高；ADR 体量膨胀脱离"架构决策"本位

### 决策点 4：流式下的 timeout 分层

`--print` 单次调用模式下 `perInputTimeoutMs`（默认 300s）直接绑 execa `timeout`——子进程跑超就杀。流式持续子进程下三类失败模式应该分开测、且子进程是 session 级资源不能因单 turn 超时就杀（否则丢失多 turn 续话能力）。

#### Option 4A：三层 watchdog——firstEvent / streamIdle / perTurnWallclock，只定义 runtime/backend 层

- **是什么**：
  - `limits.firstEventTimeoutMs`：sendInput 到**首个业务事件**（`text_delta` / `tool_call_started`，**不**含 `system/init` —— 后者归 spawn probe）的 TTFB 上限
  - `limits.streamIdleTimeoutMs`：首事件后**连续无新事件**的 idle 上限
  - `limits.perTurnWallclockMs`：sendInput 到 `turn_finished` 的整体 wallclock 兜底（沿用 `perInputTimeoutMs` 旧位）
  - **三层各自有独立的恢复策略**：
    - firstEvent 超时 → interrupt + 标记疑似"队列拥堵 / 网络问题"，session 不立刻 Errored，允许下一 turn 继续
    - streamIdle 超时 → interrupt + session Errored
    - perTurnWallclock 超时 → interrupt + session Errored
  - **超时处理链（强约束）**：触发 interrupt（按决策点 2 capability flag 选 SIGINT 或 stdin control）→ 等子进程在 5 秒内产出 `turn_finished{wallclock_timeout}`；**5s 内未产出** → 升级到 SIGKILL 子进程 + session 进 Errored + 投递 `error` + `session_stopped{error}`。子进程仅在 SIGKILL 路径或 `session.idleTimeoutMs` 命中时被杀；单 turn 超时本身**不**杀子进程
  - **本决策点只定义 runtime/backend watchdog 层**，不定义 daemon 视角的"等多久该告知用户超时"——后者归 daemon 层 spec / 后续独立 ADR
  - 默认阈值留 spec/cost-and-limits.md 修订（PR-B/PR-C 落实）；本 ADR 不锁数值
- **优点**：三类失败模式有不同恢复动作（不只是观测维度）；与 ADR-0011 分层一致；session 级子进程在单 turn 超时时不被杀，多 turn 续话能力受保护
- **缺点**：三个旋钮的运维负担

#### Option 4B：保持单一 wallclock，失败模式由观测层区分

- **是什么**：仍用 `perInputTimeoutMs` 单一阈值；TTFB / idle / runaway 在 log + metrics 区分
- **优点**：单一旋钮
- **缺点**：三类失败模式只能用同一阈值（必然偏向某类），且只能用同一恢复动作

#### Option 4C：idle-only

- **是什么**：取消 turn 级 wallclock，只看 idle；runaway 由 `maxToolCallsPerTurn` + 用户 interrupt 兜底
- **优点**：贴流式语义最直接
- **缺点**：runaway 失去硬约束；"长思考" idle 会被误判

## Decision

四个决策点综合选：

- **决策点 1**：选 **Option 1A**（protocol 一次性对齐 spec；runtime 本期 PR 只 emit `text_delta` / `tool_call_started` / `tool_call_finished`）
- **决策点 1 子问题**：选 **Option 1-tr-A**（CC `user.tool_result` 合入 `tool_call_finished.payload.resultSummary`），**附 fixture 前提**——本 ADR 实施 PR 必须先落 fixture 验证 CC 对每个 `tool_use_id` 恰好回一条终态 tool_result；多变体场景走 Amendment 切到 1-tr-B
- **决策点 2**：选 **Option 2A**（暂保持 SIGINT；runtime 双轨设施位，capability flag 切换；反转走独立 ADR）
- **决策点 3**：选 **Option 3A**（本 ADR 只锁平台**能力门槛**：Discord adapter `supportsEdit: true` + `supportsTypingIndicator: true` + 实现 `edit()`/`setTyping()`/`clearTyping()`；具体 UI 策略由 message-protocol.md 修订 + 后续 issue 演进）
- **决策点 4**：选 **Option 4A**（三层 watchdog + 三类不同恢复策略 + 强约束兜底链；单 turn 超时不杀子进程；只定义 runtime watchdog，不定义 daemon UX SLA）

## Consequences

### 正向

- protocol 一次性对齐 spec，下游 exhaustive switch 一次配齐，未来增 emit 不触发 breaking
- runtime 切持续子进程后，IM 看到工具调用过程的协议层条件就绪（解决 #45 的协议根因）；token 级 emit 让 partial output 自然不丢（自然消解 #28）
- interrupt 路径设施位齐备（双轨），未来切主备只需翻 capability flag，不需要新 ADR
- 三层 watchdog 让"队列拥堵 / 流中卡死 / runaway"区分到 timeout 层而非只在观测层；session 级子进程仅在 SIGKILL 路径或 session idle 时被杀，多 turn 续话能力在单 turn 超时时不被打断
- Discord 平台能力门槛锁定（`supportsEdit` + `supportsTypingIndicator`），后续 UI 决策有明确扩展位；ADR 守住"架构决策"本位，UI / UX 决策按用户反馈演进而非一次性锁定

### 负向

- protocol 上会有"暂无 runtime 来源"的事件类型（`thinking` / `tool_call_progress`），需要 spec 标"声明位 vs 实际产出"
- interrupt 决策留尾巴——本 ADR 不锁死最终主路径，需要后续证据收集与可能的反转 ADR
- `tool_call_finished.resultSummary` 收口依赖 fixture 验证；CC 升级若引入 tool_result 多变体，需要 Amendment + spec 修订
- 三层 timeout 增加运维负担（三个旋钮 + 阈值耦合关系约束），spec/cost-and-limits.md 修订需要写清三层默认值与互相关系（如 `streamIdleTimeoutMs < perTurnWallclockMs`）
- 长 TTFB（首个 LLM 事件 30s+）期间用户感受层缺反馈——本 ADR 不在 daemon 层补"等多久该提示用户"的 SLA，需要后续 daemon 层 spec / ADR 跟进
- 具体 UI 决策（工具调用呈现 / typing 节奏 / 错误呈现 / mid-stream 收尾 / interrupt 入口 / 切片时序）由后续 issue 演进，本 ADR 不一次性锁定——节奏更慢但每个决策更贴用户反馈

### 需要后续跟进的事

后续 PR / spec / issue 落实清单：

- **PR-A（协议层）**：`packages/protocol/src/agent.ts` 把 union 补齐到 spec 全集；扩 `AgentCapabilitySet` 加 `supportsStdinInterrupt` flag；删 `:34-39` 注释；新增/修改测试覆盖新事件类型的判别
- **PR-B（claudecode runtime）**：`packages/agent/claudecode/src/index.ts` 切持续子进程，stdin 持续 write `{type:user,...}`，stdout `for-await` 解析 stream-json 并 emit 三类事件（`text_delta` / `tool_call_started` / `tool_call_finished`）；`interrupt()` 实现 SIGINT 路径（默认）+ stdin control 路径（capability flag 控制）；`stopSession()` 关 stdin EOF + 等清理；落 fixture 验证 CC tool_result 单条假设
- **PR-C（daemon engine）**：`packages/daemon/src/engine.ts` 改流式消费——`text_delta` 累积 / 转发；`tool_call_started/finished` 路由到 platform；`turn_finished` 收尾不变
- **PR-D（Discord adapter 平台能力门槛）**：`packages/platform/discord/src/index.ts` 翻 `supportsEdit: true` + `supportsTypingIndicator: true`，实现 `edit()` / `setTyping()` / `clearTyping()`；具体 UI 策略按对应 UX issue 演进
- **spec 修订**：
  - `docs/dev/spec/agent-runtime.md` 在 union 表前补"声明位 vs 实际产出"说明
  - `docs/dev/spec/agent-backends/claude-code-cli.md` §中断 段补 capability flag；§超时 段把"超时 → SIGINT → 5s → SIGKILL"改写为本 ADR 决策点 4 的三层 watchdog 语义（含强约束兜底链）
  - `docs/dev/spec/message-protocol.md` §流式语义 标记"模式 B 已由 ADR-0012 决策点 3 评审通过"；UI 细节（工具调用呈现 / typing / 错误 / 切片锚定）按后续 UX issue 收敛
  - `docs/dev/spec/platform-adapter.md` 加 `setTyping` / `clearTyping` 接口与 `supportsTypingIndicator` capability
  - `docs/dev/spec/infra/cost-and-limits.md` §Wall-clock 硬限 把 `perInputTimeoutMs` 拆成 `firstEventTimeoutMs` / `streamIdleTimeoutMs` / `perTurnWallclockMs` 三层
- **issue 处置**（不属本 ADR 决策本身，列在此处便于实施 PR 时回检）：#45 在 PR-A + PR-B 合入后由 reviewer 关闭（"fixed by ADR-0012 + PR-#NN"）；#56 epic 在 PR-A/B/C/D 全部合入后关闭；#28 / #54（部分）/ #30 / #55-B 在对应 PR 合入后由 reviewer 评估关闭
- **证据收集（决策点 2 反转的前提）**：runtime PR-B 落地后，跑长任务（10s+ 工具循环）记录两类数据 (i) stdin `control/interrupt` 从写入到 CC 产出 `turn_finished{user_interrupt}` 的延迟分布 (ii) SIGINT 在工具子进程链路下能否打到正确边界。数据落地后再决定是否发新 ADR 反转 spec
- **UX / UI 实施细节（不在本 ADR，独立 issue 跟踪 PR-D）**：
  - typing 持续策略与心跳节奏（持续 vs 阶段性 / 8s 心跳还是其他）
  - 错误呈现策略（工具失败 inline ❌ / turn 失败独立 reply / 错误文案）
  - mid-stream 失败的视觉收尾（edit 末尾 `[interrupted]` / 独立 reply）
  - 切片之间时序锚定（reply 链 / 扇出 / 不锚定）
  - interrupt UX 入口（`/stop` slash command / emoji react / 纯文本）——与 #54 合并跟踪
  - 工具调用呈现形态（inline / 折叠 thread / 独立消息）
  - 已开 issue 列表见 §参考

## Out of scope

本 ADR 明确不决定的事项：

**架构层（留给后续 ADR / spec）**：
- 跨 backend 抽象（GPT / Gemini / 其他 agent）——本 ADR 仅 claudecode
- MCP 接入——见 `docs/dev/spec/security/tool-boundary.md`
- 跨 turn 的 thinking 持久化
- capability flag `supportsStdinInterrupt` 翻起的具体时机——证据补齐后由独立 ADR 决定
- 双轨期间 legacy `--print` 路径保留期限——由 PR-B 内部决定，不写入 spec
- daemon 视角的"等多久该告知用户超时"UX SLA——daemon 层 spec / 独立 ADR
- 三层 watchdog 默认阈值——spec/cost-and-limits.md 修订

**UX / UI 层（留给后续 issue）**：
- 工具调用呈现形态、typing 持续策略、错误呈现、mid-stream 收尾、切片时序锚定、interrupt UX 入口、长回复体积控制（截断 / 外链 / 附件）
- 工具结果脱敏边界（issue #58）
- 多用户 channel 并发 UX（issue #59）
- turn 收尾摘要消息（issue #60）
- firstEvent 超时后的重试可见性（issue #61）
- Discord rate limit 累计预算（issue #62）

## Amendments

> Accepted 之后对决策内容 / 范围 / 命名的非反转修订。决策反转走 supersede 流程。

（暂无）

## 异议 & 回应（来自 argue self-check）

本 ADR 起草过程中用 codex-review skill（gpt-5 系列异构模型）跑了多轮反方分析；用户视角也在第三轮覆盖了 ADR 体量边界。要点 + 回应如下。

**第一轮 argue（协议层）**：

- **异议 1（决策点 1）**：草案最初写"按 MVP 分批暴露 union"，违反契约先行；TS discriminated union 加 case 会打爆下游 exhaustive switch 制造二次 breaking。
  **回应**：采纳。Decision 改为 protocol 一次性对齐 spec。

- **异议 2（决策点 1 子问题）**：草案最初的论证抓错风险——真正风险不是 daemon 路由层数，而是 CC 外部契约是否成立；若不成立，`resultSummary` 收口会在 protocol 层静默丢信息。
  **回应**：采纳。附 fixture 前提；多变体场景走 Amendment 切 1-tr-B。

- **异议 3（决策点 2）**：草案最初的论证有循环论证味——"保持 SIGINT 因为 spec 已锁"不足以支撑 ADR；缺 SIGINT 在 spawn-tool-loop 下的 reachability 证据 + stdin interrupt 延迟 / 失效率证据。
  **回应**：部分采纳。降级为"暂保持 + 待证据"；runtime 实现两路径设施位但默认 SIGINT；反转走独立 ADR。

**第二轮 argue（流式 timeout）**：

- **异议 4（决策点 4 阈值）**：草案最初给 30s/60s/300s 默认值偏激进——`streamIdleTimeoutMs=60s` 在工具静默 / 长思考 / 长 LLM 回复中会误杀；且"事件"定义不清。
  **回应**：采纳。Decision 不锁数值，留 spec 修订；spec 写清"`firstEventTimeoutMs` 计 sendInput 到首个**业务事件**——`text_delta` / `tool_call_started`，**不**含 `system/init`"。

- **异议 5（决策点 4 vs 单一 wallclock）**：若三层超时最后动作都一样，单一 wallclock + 观测层区分会更简；要为三层辩护必须证明"三层有不同动作"。
  **回应**：采纳并强化论证。Decision 明确三层有**不同恢复策略**：firstEvent 仅 interrupt 不 Errored；streamIdle / perTurnWallclock 超时 interrupt + session Errored。

- **异议 6（决策点 4 兜底链）**：interrupt → 5s → kill 必须升格为强约束。
  **回应**：采纳。Decision 把兜底链写成**强约束**，单 turn 超时本身不杀子进程；interrupt 失败 5s 内必升级到 SIGKILL + session Errored。

- **异议 7（决策点 4 与 ADR-0011 分层）**：本 ADR 不该顺手定义 daemon UX SLA，否则又把 ADR-0011 已分的两层打穿。
  **回应**：采纳。Decision 明确"本决策点只定义 runtime/backend watchdog"。

**第三轮（用户覆盖：作用域瘦身）**：

- **用户覆盖（ADR vs PRD 边界）**：第二轮迭代后 ADR 一度膨胀到 416 行，把 6 个 UI / UX 决策点（typing 持续 / 错误呈现 / mid-stream 收尾 / interrupt 入口 / 切片锚定 / 工具调用呈现具体形态）写进 ADR，并在 Decision 段锁定具体文案（`▸ **Glob**` / `[interrupted]` / `❌` / `📝 Turn complete`）。reviewer 反思指出这些是 PRD 范畴（用户感受 / UI 文案 / 操作入口选择），不是架构决策（契约 / 不可逆 / 跨模块边界）；锁 ADR 是过度承诺，UI / UX 决策应随用户反馈演进。
  **回应**：采纳。本 ADR 瘦身——决策点 3 收敛为"平台必须提供流式呈现能力门槛"（capability + 接口实现），具体 UI 策略转 issue + spec 修订。原决策点 4（与 #45 issue 关闭管理）从 ADR 删除（这是 PR / issue 管理动作，不属决策记录），改写在 §Consequences §issue 处置段。Decision 段从 10 个决策点收敛到 4 个真架构决策。

## 参考

- 相关 issue：#56（本 epic 来源）、#45（root cause 分析）、#28、#54（interrupt 路径与用户入口）、#30、#55、#58 / #59 / #60 / #61 / #62（产品维度待办）；本 ADR 瘦身后转出的 UX 实施 issue 列表见 [PR #57](https://github.com/moesin-lab/agent-nexus/pull/57) description
- 相关 spec：见 §Consequences §需要后续跟进的事
- 相关 ADR：ADR-0002（CC CLI 选型）、ADR-0011（turn 分层）
- 当前实现：`packages/protocol/src/agent.ts:34-98`（裁剪版 union + TODO）、`packages/agent/claudecode/src/index.ts:120-333`（`--print` 单次调用 / interrupt no-op / 解析层）、`packages/platform/discord/src/index.ts:193-206`（capability set）
