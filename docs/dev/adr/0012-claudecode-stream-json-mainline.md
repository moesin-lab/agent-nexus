---
title: ADR-0012 claudecode 切到 stream-json 主路径——协议合约 / interrupt / Discord 呈现
type: adr
status: active
summary: 把 claudecode runtime 从 --print 单次调用切到 stream-json 持续子进程；锁定 protocol 一次性对齐 spec union、interrupt 暂保持 SIGINT 主路径待证据、Discord 工具调用 inline 渲染默认策略
tags: [adr, decision, agent-runtime, claude-code, stream-json, protocol, discord]
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

# ADR-0012：claudecode 切到 stream-json 主路径——协议合约 / interrupt / Discord 呈现

- **状态**：Proposed
- **日期**：2026-04-28
- **决策者**：senticx@foxmail.com
- **相关 ADR**：ADR-0002（CC CLI 作为 agent 后端）、ADR-0011（turn 分层）

## 状态变更日志

- 2026-04-28：Proposed

## Context

`docs/dev/spec/agent-backends/claude-code-cli.md` §交互式 session 已把 `--print --input-format stream-json --output-format stream-json` 标为 **MVP 主路径**，但 `packages/agent/claudecode/src/index.ts` 仍是 `--print` 单次调用形态——每次 `sendInput` spawn 一个新子进程，跑完即退。这个 spec/impl gap 是当前一组缺陷的共同上游：

- IM 端看不到 agent 的工具调用过程（issue #45：runtime 解析层裁掉 `tool_use` / `tool_result`，导致 final text 出现"输出如上"这类指代失效）
- partial output 在子进程异常退出时丢失（issue #28）
- interrupt / stopSession 在 `--print` 模式下只能 SIGINT 整个子进程；持续子进程模型下需要更精细的取消语义（issue #54）
- Discord 长回复必须切多片，没有流式 edit（issue #30 / #55-B）

把它们当成独立 issue 修，最后大概率在 stream-json 切换时被全部重写。本 ADR 立 epic 共识，为后续 4 个实现 PR（协议层 / claudecode runtime / daemon engine / Discord adapter）锁定方向。

观察到的关键事实：

1. **spec 已锁完整 AgentEvent union**——`docs/dev/spec/agent-runtime.md` §AgentEvent 已经把独立事件类型（`text_delta` / `thinking` / `tool_call_started` / `tool_call_progress` / `tool_call_finished`）和顺序保证（`text_delta` 拼起来等于 `text_final.text`、每个 `tool_call_started` 必有对应 `tool_call_finished`）定死。`packages/protocol/src/agent.ts:34-39` 的 union 是 spec 的**裁剪版**，注释挂 TODO，等本 ADR 解锁。
2. **spec 已锁 interrupt 主路径**——`docs/dev/spec/agent-backends/claude-code-cli.md` §中断 当前定义"首选向子进程发 SIGINT；stdin `control/interrupt` 作为补充，CC 后续版本稳定后可作备选"。issue #56 epic 提议反转（stdin control 升主、SIGINT 退化为 fallback）。
3. **message-protocol §流式语义 已留 ADR 位**——MVP 默认是模式 A（`text_delta` 缓冲到 `text_final` 整段发送），模式 B（分步 edit）写"作为后续增强，在独立 ADR 中评审"。Discord 长回复的 inline 流式 edit 命中本 ADR 范畴。
4. **Discord adapter 当前 capability 全为 false**——`packages/platform/discord/src/index.ts:193-206` 的 `CapabilitySet` 把 `supportsEdit` / `supportsThreads` / `supportsEmbeds` 都标 false。落实流式 edit 需要先把 `supportsEdit` 翻起来并实现 `edit()`。

## Options

四个决策点逐个列。

### 决策点 1：AgentEvent union 形态——protocol 该一次性对齐 spec，还是按 MVP 实际需要分批？

#### Option 1A：protocol 一次性对齐 spec 完整 union；runtime 选择性 emit

- **是什么**：本 ADR 阶段 `packages/protocol/src/agent.ts` 把 spec/agent-runtime.md §AgentEvent 列出的所有事件类型一次性补齐（`text_delta` / `thinking` / `tool_call_started` / `tool_call_progress` / `tool_call_finished`）；runtime 本期 PR 只**实际产出** `text_delta` / `tool_call_started` / `tool_call_finished` 三类，`thinking` / `tool_call_progress` 类型在 protocol 上**有定义**但 runtime 不 emit
- **优点**：契约先行，protocol 一次到位与 spec 对齐；下游 daemon engine 的 exhaustive switch 一次配齐 case，未来加 emit 不再触发 breaking
- **缺点**：protocol 上有"暂无来源"的事件类型，可能让读者误判 runtime 已支持
- **主要风险**：低；类型层只是 union 扩展，没有运行时行为改变

#### Option 1B：按 MVP 分批暴露 union

- **是什么**：本 ADR 阶段 protocol 只补齐"runtime 实际会 emit"的三类，其余留下次 ADR
- **优点**：契约与实际产出严格一致，无"幽灵类型"
- **缺点**：违反"契约先行"原则，spec 已锁但 protocol 不对齐；TS discriminated union 后续逐个加 case 会接连击穿下游 exhaustive switch，造成多轮 breaking wave
- **主要风险**：制造二次 breaking change，每加一个事件都要改 daemon engine 的 switch

### 决策点 1 子问题：CC `user.tool_result` 怎么落 protocol？

#### Option 1-tr-A：合入 `tool_call_finished.payload.resultSummary`

- **是什么**：runtime 把 CC `user.content[].type=tool_result` 解析后写进对应 `tool_call_finished` 事件的 `resultSummary` 字段（spec 已留位）
- **优点**：daemon engine 路由更简——一次 finished 事件携带完整对偶；UI 端只需配对呈现
- **缺点**：依赖一个外部假设——CC 对每个 `tool_use_id` 恰好回**一条**终态 `tool_result`，且无"多块 / 结构化 / 空 + error" 等变体；该假设未经 fixture 实证
- **主要风险**：若假设不成立，`resultSummary` 收口会**静默丢信息**，且丢在 protocol 层而非 UI 层

#### Option 1-tr-B：新增独立 `tool_result` 事件类型

- **是什么**：protocol 加 `tool_result` 事件，runtime 把 CC `user/tool_result` 直接转发；finished 事件只在 spec 已留的 status 字段做配对
- **优点**：对 CC 输出多变体场景鲁棒；fixture 不全时也不丢信息
- **缺点**：spec 当前未列；多一类事件需要 daemon engine 多一处路由；与 spec §顺序保证"每个 started 必有对应 finished"语义重叠

### 决策点 2：interrupt 主路径——保持 SIGINT，还是升 stdin control？

#### Option 2A：保持 spec 现状（SIGINT 主，stdin control 备）；待证据再考虑反转

- **是什么**：runtime 实现 SIGINT 路径作为 `interrupt()` 的默认行为；stdin `control/interrupt` 路径**也实现**但默认不启用，由 `AgentCapabilitySet.supportsStdinInterrupt` flag 控制；本 ADR 只承诺"暂保持现 spec"，在补齐两类证据前不反转：
  - (i) stdin control 在 CC 2.1.x 的实测延迟 / 失效率
  - (ii) CC 卡在外部工具循环（spawn-tool-loop）时 SIGINT 的 reachability 数据
- **优点**：不强行翻 spec；为 interrupt 路径留容易切换的设施位
- **缺点**：本 ADR 不给 interrupt 路径下最终结论，留尾巴

#### Option 2B：跟随 issue #56 提议——stdin control 主，SIGINT fallback

- **是什么**：本 ADR 直接反转 spec，把 stdin control 升主路径；SIGINT 在 stdin 路径失败 / capability 不支持时降级使用
- **优点**：与 stream-json 协议层对齐；持续子进程下 stdin 控制语义最准
- **缺点**：CC 2.1.x 的 stdin control 稳定性未实测；推翻 spec 需要充分实证支撑——本 ADR 不具备
- **主要风险**：在缺证据时反转 spec，下次 CC 升级若改了 stdin control 语义会让本 ADR 立刻过期

### 决策点 3：Discord 工具调用呈现策略

#### Option 3A：默认 inline 嵌入主消息流；流式 edit 在 capability + 长度预算内开启；超长退化到切片

- **是什么**：daemon → Discord 转发链路在主消息流中按时序穿插工具调用片段（如 `▸ **Glob**(*.md) → 12 results`，结果折叠在 code block 内、截断到 ~200 chars）；当 `CapabilitySet.supportsEdit` 为 true 且累计文本 ≤ `maxTextLength`（Discord 2000 chars）时持续 edit 单条消息；超长按 `message-protocol.md` §文本切片切片，本 ADR 不重新设计切片协议
- **优点**：保留时序信息，解决 #45 的"指代失效"；与 message-protocol §流式语义 §模式 B 对接，本 ADR 同时担任"模式 B 独立 ADR"角色
- **缺点**：当一次 turn 工具调用密度极高（≥10）时，单条消息频繁 edit 配合切片可能让 UX 变差；inline 折叠的 markdown 渲染受 Discord 客户端实现影响

#### Option 3B：折叠 thread / embed

- **是什么**：工具调用走 Discord embed 或 thread，主消息只放 final text
- **优点**：主消息整洁；高密度工具调用场景视觉负担低
- **缺点**：上下文切换成本高（用户需点开 thread）；当前 adapter 不支持 threads（`supportsThreads: false`），落地需先扩 capability；与 ADR 范围外的"工具结果体积控制"耦合

#### Option 3C：每个工具调用独立消息

- **是什么**：每次工具调用 send 一条新消息
- **优点**：实现最简
- **缺点**：channel 噪音大；Discord rate limit 更紧；时序在多人 channel 下易被打断

### 决策点 4：与 #45 的合并方式

#### Option 4A：本 ADR 吸收 #45 的 root cause 分析；#45 issue 保持 open 直到实施 PR 落地

- **是什么**：本 ADR 在 Context 段引用 #45 的三层 root cause 分析；#45 issue 不在 ADR 发布时关闭，而是在协议升级 PR + 实现 PR 真正解决可见性后，以 "fixed by ADR-0012 + PR-#NN" 关闭
- **优点**：追溯链最干净——既保留分析归属，又把"问题真正解决"的关闭锚点绑在实施而非文档
- **缺点**：#45 在 ADR 落地后还要继续追踪一段时间

#### Option 4B：ADR 吸收 + #45 close as duplicate

- **是什么**：本 ADR 落地即关闭 #45
- **优点**：issue 列表清爽
- **缺点**：实施未落地前关闭会让历史看起来像"问题被分类处理过"而非"问题被解决"——丢失一个仍然有效的验收锚点

#### Option 4C：分两个 ADR

- **是什么**：本 ADR 只覆盖 stream-json 升级；#45 单独再开一个 ADR
- **优点**：单一关注点
- **缺点**：制造"协议层先升级、运行时滞后"的中间态；两个 ADR 高度重合，评审成本翻倍

## Decision

四个决策点综合选：

- **决策点 1**：选 **Option 1A**（protocol 一次性对齐 spec；runtime 本期 PR 只 emit `text_delta` / `tool_call_started` / `tool_call_finished`）
- **决策点 1 子问题**：选 **Option 1-tr-A**（CC `user.tool_result` 合入 `tool_call_finished.payload.resultSummary`），但**附前提**——本 ADR 实施 PR 必须先落 fixture 验证 CC 对每个 `tool_use_id` 恰好回一条终态 tool_result；若 fixture 暴露多变体场景（多块 / 结构化 / 空 + error），escalate 到 Option 1-tr-B（新增独立 `tool_result` 事件），escalate 路径走 spec 修订 + 本 ADR Amendment，不再发新 ADR
- **决策点 2**：选 **Option 2A**（暂保持 SIGINT 主路径；runtime 实现 stdin control 路径但默认关闭，由 `AgentCapabilitySet.supportsStdinInterrupt` flag 控制；待补齐 stdin 延迟 / SIGINT reachability 两类证据后再决定是否反转 spec，反转走独立 ADR）
- **决策点 3**：选 **Option 3A**（默认 inline 嵌入；流式 edit 在 capability + 长度预算允许时开启；超长退化到 message-protocol §文本切片定义的切片机制；高工具密度场景的折叠 thread 留作后续可选优化，不在本 ADR 范围内）
- **决策点 4**：选 **Option 4A**（本 ADR 吸收 #45 root cause；#45 关闭条件绑实施 PR 而非 ADR 发布）

## Consequences

### 正向

- protocol 一次性对齐 spec，下游 exhaustive switch 一次配齐，未来增 emit 不触发 breaking wave
- runtime 切持续子进程后，IM 看到工具调用过程（解决 #45）；token 级 emit 让 partial output 自然不丢（自然消解 #28）
- interrupt 路径设施位齐备（双轨），未来切主备只需翻 capability flag，不需要新 ADR
- Discord 流式 edit + inline 渲染对接 message-protocol §模式 B，本 ADR 同时担任"独立 ADR 评审"角色，message-protocol 不需要额外 ADR

### 负向

- protocol 上会出现"暂无 runtime 来源"的事件类型（`thinking` / `tool_call_progress`），需要 spec/protocol 文档显式标注"声明位 vs 实际产出"
- interrupt 决策留尾巴——本 ADR 不锁死最终主路径，需要后续证据收集与可能的反转 ADR
- Discord adapter 需要先扩 `supportsEdit` capability 并实现 `edit()`，PR-D 体量增大
- `tool_call_finished.resultSummary` 收口依赖 fixture 验证；CC 升级若引入 tool_result 多变体，需要 Amendment + spec 修订

### 需要后续跟进的事

后续 PR / spec 落实清单（这是 Consequences 的工作面，非 ADR 决策本身）：

- **PR-A（协议层）**：`packages/protocol/src/agent.ts` 把 union 补齐到 spec 全集；扩 `AgentCapabilitySet` 加 `supportsStdinInterrupt` flag；删 `:34-39` 注释；新增/修改测试覆盖新事件类型的判别
- **PR-B（claudecode runtime）**：`packages/agent/claudecode/src/index.ts` 切持续子进程，stdin 持续 write `{type:user,...}`，stdout `for-await` 解析 stream-json 并 emit 三类事件（`text_delta` / `tool_call_started` / `tool_call_finished`）；`interrupt()` 实现 SIGINT 路径（默认）+ stdin control 路径（capability flag 控制）；`stopSession()` 关 stdin EOF + 等清理；落 fixture 验证 CC tool_result 单条假设
- **PR-C（daemon engine）**：`packages/daemon/src/engine.ts` 改流式消费——`text_delta` 累积 / 转发；`tool_call_started/finished` 路由到 platform；`turn_finished` 收尾不变
- **PR-D（Discord adapter）**：`packages/platform/discord/src/index.ts` 翻 `supportsEdit: true`，实现 `edit()`；落实 inline 工具调用片段格式 + 折叠 + 截断；超长走 message-protocol §文本切片
- **spec 修订**：`docs/dev/spec/agent-runtime.md` 在 union 表前补"声明位 vs 实际产出"说明；`docs/dev/spec/agent-backends/claude-code-cli.md` §中断 段补 capability flag；`docs/dev/spec/message-protocol.md` §流式语义 标记"模式 B 已由 ADR-0012 评审通过"
- **issue 处置**：#45 在 PR-A + PR-B 合入后由 reviewer 关闭，body 写 "fixed by ADR-0012 + PR-#NN"；#56 epic 在 PR-A/B/C/D 全部合入后关闭；#28 / #54（部分）/ #30 / #55-B 在对应 PR 合入后由 reviewer 评估关闭
- **证据收集（决策点 2 反转的前提）**：runtime PR-B 落地后，跑 `chaos-style` 长任务（10s+ 工具循环）记录两类数据 (i) stdin `control/interrupt` 从写入到 CC 产出 `turn_finished{user_interrupt}` 的延迟分布 (ii) SIGINT 在工具子进程链路下能否打到正确边界。数据落地后再决定是否发新 ADR 反转 spec

## Out of scope

- **不决定**跨 backend 抽象（GPT / Gemini / 其他 agent）——本 ADR 仅 claudecode
- **不决定**IM 工具结果体积控制的具体策略（截断阈值 / 外链 / 附件）——独立 spec 处理
- **不决定**MCP 接入——见 `docs/dev/spec/security/tool-boundary.md` §MCP 默认全禁
- **不决定**跨 turn 的 thinking 持久化
- **不决定**高工具密度场景下"inline → thread"自动降级的阈值——决策点 3 留作后续可选优化
- **不决定**capability flag `supportsStdinInterrupt` 翻起的具体时机——证据补齐后由后续 ADR 决定
- **不决定**双轨期间的 legacy `--print` 路径保留期限——由 PR-B 内部决定，可以保留为 `claude-code-legacy-print` env flag 但不写入 spec

## Amendments

> Accepted 之后对决策内容 / 范围 / 命名的非反转修订。决策反转走 supersede 流程。

（暂无）

## 异议 & 回应（来自 argue self-check）

本 ADR 起草前用 codex-review skill（gpt-5 系列异构模型）跑了一轮反方分析，要点 + 回应如下：

- **异议 1（决策点 1）**：草案最初写"按 MVP 分批暴露 union"，与"契约先行"原则冲突；TS discriminated union 加 case 会打爆下游 exhaustive switch 制造二次 breaking。
  **回应**：采纳。Decision 改为 protocol 一次性对齐 spec，runtime 选择性 emit。

- **异议 2（决策点 1 子问题）**：草案最初的论证抓错风险——真正风险不是 daemon 路由层数，而是 CC 外部契约是否成立（每个 tool_use_id 是否恰好一条终态 tool_result）；若不成立，`resultSummary` 收口会在 protocol 层静默丢信息。
  **回应**：采纳。Decision 附 fixture 前提；escalate 路径写明（多变体场景下走 Amendment 切到 Option 1-tr-B 独立 `tool_result` 事件）。

- **异议 3（决策点 2）**：草案最初的论证有循环论证味道——"保持 SIGINT 因为 spec 已锁"不足以支撑 ADR；缺 SIGINT 在 spawn-tool-loop 下的 reachability 证据 + stdin interrupt 延迟 / 失效率证据。
  **回应**：部分采纳。Decision 降级为"暂保持 + 待证据"，明确两类证据要求；runtime 实现两路径设施位但默认 SIGINT；反转走独立 ADR。

- **异议 4（决策点 3）**：草案最初写"统一 inline 单条持续 edit"与现有 message-protocol § 文本切片硬冲突——超 2000 chars 协议要求切片，"单条消息保持时序连贯"在物理上不成立；Discord adapter 当前 `supportsEdit: false`。
  **回应**：采纳。Decision 改为"默认 inline；流式 edit 由 capability + 长度预算决定；超长退化到既有切片机制"；后续跟进事项明确 PR-D 要先翻 `supportsEdit`。

- **异议 5（决策点 4）**：草案最初写 "#45 close as duplicate"——会让实现落地前丢掉验收锚点。
  **回应**：采纳。Decision 改为"#45 保持 open 直到实施 PR 落地，再以 'fixed by ADR + PR' 关闭"。

## 参考

- 相关 issue：[#56](https://github.com/moesin-lab/agent-nexus/issues/56)（本 epic 来源）、[#45](https://github.com/moesin-lab/agent-nexus/issues/45)（root cause 分析被吸收）、#28、#54、#30、#55
- 相关 spec：
  - `docs/dev/spec/agent-runtime.md` §AgentEvent / §UsageRecord / §顺序保证
  - `docs/dev/spec/agent-backends/claude-code-cli.md` §交互式 session / §stdin 输入格式 / §stdout 事件格式 / §中断
  - `docs/dev/spec/message-protocol.md` §文本切片 / §流式语义
  - `docs/dev/spec/platform-adapter.md` §edit
- 相关 ADR：ADR-0002（CC CLI 选型）、ADR-0011（turn 分层）
- 当前实现：`packages/protocol/src/agent.ts:34-98`（裁剪版 union + TODO）、`packages/agent/claudecode/src/index.ts:120-333`（`--print` 单次调用 / interrupt no-op / 解析层）、`packages/platform/discord/src/index.ts:193-206`（capability set）
