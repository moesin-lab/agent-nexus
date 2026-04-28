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

### 决策点 5：流式期间 Discord typing indicator

#### Option 5A：仅在"首条可见输出之前"触发 typing；首条 send/edit 落地后停止

- **是什么**：daemon 在 `sendInput` 后向 Discord adapter 发 typing 信号；adapter 翻 `supportsTypingIndicator: true` 并按 ~8s 心跳触发 Discord `POST /channels/{id}/typing`（typing 衰减约 10s，留余量）；**首个**业务事件（`text_delta` 或 `tool_call_started`）被 send/edit 落到 channel 后立即停止 typing；切片路径启动后也不再触发 typing（已有可见输出）；任何后续 turn 重启时再次进入"首条前 typing"窗口
- **优点**：贴 Discord 官方文档语义（"短暂反馈"而非"持续状态"）；首条消息后用户已看到 agent 在做事，typing 失去意义反而干扰；不依赖"edit 自动结束 typing"这个无官方保证的假设
- **缺点**：长 TTFB（agent 思考 30s+ 才 emit 首事件）期间用户只看到 typing 没有别的反馈；高密度短工具循环（每 2s 一个 tool_call_finished）下 typing 不再触发，UX 略显单调

#### Option 5B：agent 进 Busy 状态即持续 typing 直到 turn_finished

- **是什么**：daemon 在 `sendInput` 后向 Discord adapter 发 typing 信号；adapter 按 ~8s 心跳持续触发 Discord `POST /channels/{id}/typing` 直到 `turn_finished`；流式 edit 与 typing 并存；切片路径下 typing 仍持续
- **优点**：贴用户实际感受——长 turn（多工具循环 / 长思考）期间持续 typing 比"首条后停"更能传达"agent 还在做事"，避免用户误判 agent 卡死；工具调用之间的"思考阶段"有 typing 兜底；agent-nexus 是交互式 IM agent，"持续 typing" 与"反复短暂提示"在用户感受上等价
- **缺点**：Discord 官方文档对 typing 接口写"generally bots should not use this route"——但这是给非交互场景的告诫，不适用本场景；首条消息后 typing 与流式 edit 形成两个并列"在做事"信号，但用户实测不构成 UX 灾难（typing 是辅助提示，主信息在消息内容）；不同 Discord 客户端对 typing 衰减处理不一致——用 8s 心跳兜底

#### Option 5C：仅工具调用期间 typing

- **是什么**：`tool_call_started` → `tool_call_finished` 期间触发 typing；text_delta 流期间不触发
- **优点**：把 typing 限定在"用户感知 agent 在做事"的离散区间
- **缺点**：流式文本期间也是"在做事"——按工具调用切分 typing 反而让 UX 跳变；与本 ADR 决策点 3 inline 嵌入的连续呈现不一致

### 决策点 6：流式下的 timeout 分层

`--print` 单次调用模式下 `perInputTimeoutMs`（默认 300s）直接绑 execa `timeout`——子进程跑超就杀。流式持续子进程下三类失败模式应该分开测、且子进程是 session 级资源不能因单 turn 超时就杀（否则丢失多 turn 续话能力）。

#### Option 6A：三层 watchdog——firstEvent / streamIdle / perTurnWallclock，只定义 runtime/backend 层

- **是什么**：
  - `limits.firstEventTimeoutMs`：sendInput 到**首个业务事件**（`text_delta` / `tool_call_started`，**不**含 `system/init` —— 后者归 spawn probe 与 runtime spawn timeout 管）的 TTFB 上限
  - `limits.streamIdleTimeoutMs`：首事件后**连续无新事件**（任何 AgentEvent 都算心跳）的 idle 上限
  - `limits.perTurnWallclockMs`：sendInput 到 `turn_finished` 的整体 wallclock 兜底（沿用 `perInputTimeoutMs` 旧位）
  - **三层各自有独立的恢复策略**，不只是观测维度：
    - firstEvent 超时 → interrupt + 标记疑似"队列拥堵 / 网络问题"，session 不立刻 Errored，允许下一 turn 继续（用户可以重试）
    - streamIdle 超时 → interrupt + session 进 Errored（流中卡死视为不可恢复）
    - perTurnWallclock 超时 → interrupt + session 进 Errored（runaway 视为不可恢复）
  - **超时处理链（强约束）**：触发 interrupt（按决策点 2 的 capability flag 选 SIGINT 或 stdin control）→ 等子进程在 5 秒内产出 `turn_finished{wallclock_timeout}`；**5s 内未产出** → 升级到 SIGKILL 子进程 + session 进 Errored + 投递 `error` + `session_stopped{error}`。子进程仅在 SIGKILL 路径或 session 级 idle 命中（`session.idleTimeoutMs`）时被杀；单 turn 超时本身**不杀**子进程。
  - **本决策点只定义 runtime/backend watchdog 层**，不定义 daemon 视角的"等多久该告知用户超时"——后者归 daemon 层 spec / 后续独立 ADR（与 ADR-0011 分层一致）
  - 默认阈值留给 spec/cost-and-limits.md 修订（PR-B/PR-C 落实），本 ADR 不锁数值；只锁"三层架构 + 三类不同恢复策略 + interrupt-then-kill 兜底"
- **优点**：三类失败模式有不同恢复动作（不是只换报表），互相不替代；与 ADR-0011 分层一致（runtime 层独立于 daemon UX 层）；子进程保活让多 turn 续话不在单 turn 超时时被打断
- **缺点**：三个旋钮的运维负担；阈值之间的耦合关系（streamIdle < perTurnWallclock 等）需要 spec 写清

#### Option 6B：保持单一 wallclock，失败模式由观测层区分

- **是什么**：仍用 `perInputTimeoutMs` 单一阈值，定义改为"sendInput 到 turn_finished"；不分层；TTFB / idle / runaway 在 log + metrics 区分
- **优点**：单一旋钮，运维简单；与现 spec 表面兼容
- **缺点**：三类失败模式只能用同一阈值（必然偏向某类），且只能用同一恢复动作；流式持续子进程下"无新事件"和"还在跑"在单一 wallclock 下不可区分

#### Option 6C：idle-only

- **是什么**：取消 turn 级 wallclock，只看 idle；runaway 由 `maxToolCallsPerTurn` + 用户 interrupt 兜底
- **优点**：贴流式语义最直接
- **缺点**：runaway 失去硬约束（`maxToolCallsPerTurn` 命中也只是 turn_finished 不是超时）；"长思考" idle 会被误判

### 决策点 7：流式期间出错的 IM 呈现策略

#### Option 7A：工具单次失败 inline ❌；turn 整体失败 reply 独立 error message

- **是什么**：单个工具调用失败（`tool_call_finished{status:"error"}`）→ Discord 在对应 inline 工具片段位置 edit 加 `❌` + 错误摘要（截断）；turn 整体失败（subprocess 崩溃 / wallclock 超时 / streamIdle 超时 / `turn_finished{reason:"error"}`）→ daemon 让 platform reply 用户原 inbound 发独立 error message，**不**覆盖已有流式内容
- **优点**：失败定位清晰——单工具失败有 inline 锚点；turn 失败的错误说明独立可追溯不被切片混淆；用户回看历史能区分两类失败
- **缺点**：channel 多一条 reply

#### Option 7B：工具失败 inline ❌；turn 失败 edit 主消息追加错误

- **是什么**：turn 整体失败时直接在最后一条流式主消息末尾 edit 追加 `\n⚠️ <error>`
- **优点**：channel 不多消息
- **缺点**：覆盖部分主内容；主消息已被切片时 edit 哪一片有歧义；大错误堆栈撑爆 2000 chars

#### Option 7C：工具 / turn 失败都 send 新消息

- **是什么**：不 edit 任何已有流式片段
- **优点**：最简
- **缺点**：channel 噪音大；inline 流的视觉连贯被打破

### 决策点 8：mid-stream 失败的视觉收尾

#### Option 8A：edit 最后流式片段末尾追加 `[interrupted]` 标记

- **是什么**：当流到一半子进程崩 / wallclock 超时 / 用户主动 interrupt 时，daemon 让 platform 在最后一条 inline 片段末尾 edit 追加 `\n⚠️ [interrupted: <reason>]`（reason 截断到 ~100 chars）
- **优点**：用户在原位看到流被打断的标记，符合"持续 edit"主线；不需要滚屏找说明
- **缺点**：reason 文本受单条 message 2000 chars 上限约束，长 reason 必须截断

#### Option 8B：send 独立 reply 说明被打断

- **是什么**：另发一条 reply "⚠️ 上方流被打断: <reason>"
- **优点**：reason 不挤主消息；翻聊天历史能看到独立标记
- **缺点**：channel 多一条；用户视觉锚点要跳

#### Option 8C：edit + send 同时做

- **是什么**：edit 主流加 `[interrupted]` 标记 + send 独立 reply 完整说明
- **优点**：兼顾原位标记 + 独立可追溯
- **缺点**：消息开销翻倍；语义冗余

注：决策点 8 与决策点 7 的 turn 整体失败语义相邻——区别在 8 强调"流到一半被打断"的视觉收尾标记，7 强调"独立 error message 的载体"。两者并存：8 的 `[interrupted]` 标记在最后流式片段位置，7 的 error reply 独立承载错误说明。

### 决策点 9：interrupt UX 入口

`--print` 模式下用户无法主动打断（issue #54）。流式落地后 interrupt 真正变得可达，必须定 UX 入口。

#### Option 9A：`/stop` slash command

- **是什么**：注册 Discord application command `/stop`，用户在输入框输入 `/` 时自动补全；agent-nexus daemon 收到 slash interaction → 触发对应 session 的 `interrupt()`；命令注册按现有 testGuildId 瞬时注册路径（见决策点 4 PR #51）
- **优点**：Discord 原生 UX 入口；不污染 channel 文本流；issue #54 推进方向已经是这个
- **缺点**：要走 Discord application command 注册流程；权限模型要对齐 allowedUserIds（防止任意人 interrupt 别人 session）

#### Option 9B：纯文本 `/stop` 或 `stop`

- **是什么**：daemon 入站解析层识别字符串作为 interrupt 信号
- **优点**：实现最简
- **缺点**：无补全提示用户得记；与正常聊天文本边界模糊（"我想 stop 一下这个想法" 会误触）

#### Option 9C：emoji react ⛔ 在 agent 流的 message 上

- **是什么**：用户对 agent 流的某条 message react 特定 emoji 触发 interrupt
- **优点**：UX 直观、不发新消息
- **缺点**：Discord adapter 当前不监听 reaction event；多用户 channel 下任意人都能 react 触发；无显式权限检查

#### Option 9D：A + C 双路并存

- **是什么**：slash command + emoji react 都接受
- **优点**：覆盖命令习惯用户和鼠标用户
- **缺点**：实现面翻倍；语义入口分裂

### 决策点 10：切片之间的时序锚定

决策点 3 锁了"超 2000 chars 走 message-protocol §文本切片"；多用户 channel 下切片 N 和 N+1 之间可能被插话打散，需要让用户视觉上能识别切片连续性。

#### Option 10A：切片 N+1 用 Discord reply 锚定切片 N（链式）

- **是什么**：切片 2 reply 切片 1，切片 3 reply 切片 2，依此类推；Discord UI 显示 "↪ replying to ..." 链条
- **优点**：用户在被插话打散的 channel 时间线里点一下就能跳到上一片；语义最贴"连续输出"
- **缺点**：Discord reply 链路在客户端 UI 上跳转体验受客户端实现影响；长链（5+ 片）反复 ↪ 视觉上略冗余

#### Option 10B：所有切片都 reply 用户原 inbound（扇出）

- **是什么**：切片 1/2/3/.../N 都 reply 用户的原始 inbound 消息
- **优点**：每片直接锚回用户问题；Discord UI 显示同一来源
- **缺点**：切片之间无直接前后续关系；用户得自己识别"5 条 reply 同一问题哪条接哪条"

#### Option 10C：不锚定，依赖 Discord 默认时间线

- **是什么**：切片只 send 不 reply
- **优点**：实现最简
- **缺点**：被插话打散后用户得滚屏对照"哪几条是 agent 的"；UX 退化明显

## Decision

十个决策点综合选：

- **决策点 1**：选 **Option 1A**（protocol 一次性对齐 spec；runtime 本期 PR 只 emit `text_delta` / `tool_call_started` / `tool_call_finished`）
- **决策点 1 子问题**：选 **Option 1-tr-A**（CC `user.tool_result` 合入 `tool_call_finished.payload.resultSummary`），但**附前提**——本 ADR 实施 PR 必须先落 fixture 验证 CC 对每个 `tool_use_id` 恰好回一条终态 tool_result；若 fixture 暴露多变体场景（多块 / 结构化 / 空 + error），escalate 到 Option 1-tr-B（新增独立 `tool_result` 事件），escalate 路径走 spec 修订 + 本 ADR Amendment，不再发新 ADR
- **决策点 2**：选 **Option 2A**（暂保持 SIGINT 主路径；runtime 实现 stdin control 路径但默认关闭，由 `AgentCapabilitySet.supportsStdinInterrupt` flag 控制；待补齐 stdin 延迟 / SIGINT reachability 两类证据后再决定是否反转 spec，反转走独立 ADR）
- **决策点 3**：选 **Option 3A**（默认 inline 嵌入；流式 edit 在 capability + 长度预算允许时开启；超长退化到 message-protocol §文本切片定义的切片机制；高工具密度场景的折叠 thread 留作后续可选优化，不在本 ADR 范围内）
- **决策点 4**：选 **Option 4A**（本 ADR 吸收 #45 root cause；#45 关闭条件绑实施 PR 而非 ADR 发布）
- **决策点 5**：选 **Option 5B**（agent 进 Busy 状态即持续 typing 直到 `turn_finished`；流式 edit 与 typing 并存；切片路径下 typing 仍持续；Discord adapter 翻 `supportsTypingIndicator: true` 并实现 `setTyping(channelId)` / `clearTyping(channelId)`；心跳节奏由 PR-D 内部决定，约束区间为 `[7s, 9s]`，不写入本 ADR 数值）。**用户产品判断覆盖 codex argue 的"5A 首条前停"建议**——argue 的"Discord 官方说 generally bots should not use this route"是给非交互场景的告诫，不适用 agent-nexus 这个交互式 IM agent；用户实测视角下"持续 typing"比"首条后停"更能传达"agent 还在做事"，工具调用之间的思考阶段有 typing 兜底避免误判卡死
- **决策点 6**：选 **Option 6A**（三层 watchdog——`firstEventTimeoutMs` / `streamIdleTimeoutMs` / `perTurnWallclockMs`，三类有不同恢复策略：firstEvent 超时仅 interrupt 不 Errored；streamIdle / perTurnWallclock 超时 interrupt + session Errored）。**强约束**：超时触发 interrupt → 5s 内未产出 `turn_finished` → SIGKILL 子进程 + session Errored + 投递 `error` + `session_stopped{error}`。单 turn 超时本身**不**杀子进程。本决策点**只定义 runtime/backend watchdog**，daemon 视角的 UX 通知 SLA 不在本 ADR 范围。三层默认阈值留 spec/cost-and-limits.md 修订（PR-B/PR-C 落实），本 ADR 不锁数值。
- **决策点 7**：选 **Option 7A**（工具单次失败 inline `❌` + 错误摘要截断；turn 整体失败 reply 用户原 inbound 发独立 error message，不覆盖已有流式内容）
- **决策点 8**：选 **Option 8A**（mid-stream 失败 → edit 最后流式片段末尾追加 `\n⚠️ [interrupted: <reason>]`，reason 截断到 ~100 chars）。与决策点 7 关系：8A 的 `[interrupted]` 标记在最后流式片段，7A 的 error reply 独立承载错误说明，两者并存。
- **决策点 9**：选 **Option 9A**（`/stop` slash command 作为 interrupt UX 入口；按现有 testGuildId 瞬时注册路径注册 application command；权限对齐 allowedUserIds 防越权 interrupt）
- **决策点 10**：选 **Option 10A**（切片 N+1 用 Discord reply 锚定切片 N，链式连接；切片 1 用 reply 锚定用户原 inbound）

## Consequences

### 正向

- protocol 一次性对齐 spec，下游 exhaustive switch 一次配齐，未来增 emit 不触发 breaking wave
- runtime 切持续子进程后，IM 看到工具调用过程（解决 #45）；token 级 emit 让 partial output 自然不丢（自然消解 #28）
- interrupt 路径设施位齐备（双轨），未来切主备只需翻 capability flag，不需要新 ADR
- Discord 流式 edit + inline 渲染对接 message-protocol §模式 B，本 ADR 同时担任"独立 ADR 评审"角色，message-protocol 不需要额外 ADR
- 持续 typing 让用户在长 turn（多工具循环 / 长思考 / 工具静默运行）期间持续感知 agent 在做事，工具调用之间的思考阶段不会让用户误判卡死
- 三层 watchdog + 三类不同恢复策略让"队列拥堵 / 流中卡死 / runaway"区分到 timeout 层而非只在观测层；session 级子进程仅在 SIGKILL 路径或 session idle 时被杀，多 turn 续话能力在单 turn 超时时不被打断
- 工具单次失败 inline `❌` + turn 整体失败独立 reply 让用户在 IM 视角能区分两类失败，不被混淆；mid-stream 失败的 `[interrupted]` 标记让用户在原位识别流被打断
- `/stop` slash command 让用户在 Discord 原生 UX 下可达 interrupt（解决 #54 用户视角空白），且权限通过 allowedUserIds 收敛
- 切片之间 reply 锚定让多用户 channel 下被插话打散后切片连续性在 UI 上仍可识别

### 负向

- protocol 上会出现"暂无 runtime 来源"的事件类型（`thinking` / `tool_call_progress`），需要 spec/protocol 文档显式标注"声明位 vs 实际产出"
- interrupt 决策留尾巴——本 ADR 不锁死最终主路径，需要后续证据收集与可能的反转 ADR
- Discord adapter 需要先扩 `supportsEdit` capability 并实现 `edit()`，PR-D 体量增大
- `tool_call_finished.resultSummary` 收口依赖 fixture 验证；CC 升级若引入 tool_result 多变体，需要 Amendment + spec 修订
- 长 TTFB（首个 LLM 事件 30s+）期间用户只看到 typing 没有别的反馈——本 ADR 不在 daemon 层补"等多久该提示用户"的 SLA，需要后续 daemon 层 spec / ADR 跟进
- 三层 timeout 增加运维负担（三个旋钮 + 阈值耦合关系约束），spec/cost-and-limits.md 修订需要写清三层默认值与互相关系（如 `streamIdleTimeoutMs < perTurnWallclockMs`）
- 持续 typing + 流式 edit + 切片 send 是 Discord rate limit 的**新累计维度**，单 turn 长任务可能撑爆 channel rate——不在本 ADR 收敛，独立 issue 跟踪 cost-and-limits.md 修订
- `/stop` slash command 注册需要 Discord application commands 流程，PR-D 体量再增；emoji react 入口本 ADR 未采纳，未来可作为补充入口（独立 issue / 后续 ADR）

### 需要后续跟进的事

后续 PR / spec 落实清单（这是 Consequences 的工作面，非 ADR 决策本身）：

- **PR-A（协议层）**：`packages/protocol/src/agent.ts` 把 union 补齐到 spec 全集；扩 `AgentCapabilitySet` 加 `supportsStdinInterrupt` flag；删 `:34-39` 注释；新增/修改测试覆盖新事件类型的判别
- **PR-B（claudecode runtime）**：`packages/agent/claudecode/src/index.ts` 切持续子进程，stdin 持续 write `{type:user,...}`，stdout `for-await` 解析 stream-json 并 emit 三类事件（`text_delta` / `tool_call_started` / `tool_call_finished`）；`interrupt()` 实现 SIGINT 路径（默认）+ stdin control 路径（capability flag 控制）；`stopSession()` 关 stdin EOF + 等清理；落 fixture 验证 CC tool_result 单条假设
- **PR-C（daemon engine）**：`packages/daemon/src/engine.ts` 改流式消费——`text_delta` 累积 / 转发；`tool_call_started/finished` 路由到 platform；`turn_finished` 收尾不变
- **PR-D（Discord adapter）**：`packages/platform/discord/src/index.ts` 翻 `supportsEdit: true` 与 `supportsTypingIndicator: true`，实现 `edit()` 与 `setTyping()` / `clearTyping()`；落实 inline 工具调用片段格式 + 折叠 + 截断；超长走 message-protocol §文本切片，**切片 N+1 用 reply 锚定切片 N**（决策点 10）；turn 期间持续 typing 心跳直到 turn_finished（决策点 5）；工具失败 inline `❌` + 错误摘要（决策点 7）；mid-stream 失败 edit 末尾追加 `[interrupted]`（决策点 8）；turn 整体失败 reply 用户原 inbound 发独立 error message（决策点 7）；注册 `/stop` slash command 走现有 testGuildId 瞬时注册路径（决策点 9）
- **PR-C 同时**：daemon engine 在 `sendInput` 后向 platform 发 typing 触发信号 + 工具事件路由 + 错误事件路由；`turn_finished` 时向 platform 发 typing 停止信号 + 必要的收尾消息（独立 error reply / `[interrupted]` 标记）；platform-adapter spec 加 `setTyping(channelId)` / `clearTyping(channelId)` 接口
- **spec 修订**：
  - `docs/dev/spec/agent-runtime.md` 在 union 表前补"声明位 vs 实际产出"说明
  - `docs/dev/spec/agent-backends/claude-code-cli.md` §中断 段补 capability flag；§超时 段把"超时 → SIGINT → 5s → SIGKILL"改写为本 ADR 决策点 6 的三层 watchdog 语义（含强约束兜底链）
  - `docs/dev/spec/message-protocol.md` §流式语义 标记"模式 B 已由 ADR-0012 评审通过"
  - `docs/dev/spec/platform-adapter.md` 加 `setTyping` / `clearTyping` 接口与 `supportsTypingIndicator` capability
  - `docs/dev/spec/infra/cost-and-limits.md` §Wall-clock 硬限 把 `perInputTimeoutMs` 拆成 `firstEventTimeoutMs` / `streamIdleTimeoutMs` / `perTurnWallclockMs` 三层，写清默认值与互相关系约束
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
- **不决定** typing 心跳节奏的精确数值——区间 `[7s, 9s]` 写 ADR，具体数值由 PR-D 内部决定
- **不决定**三层 watchdog 的默认阈值——留 spec/cost-and-limits.md 修订
- **不决定** daemon 视角的"等多久该告知用户超时"UX SLA——本 ADR 只定义 runtime/backend watchdog；daemon 层 SLA 归 daemon 层 spec / 后续独立 ADR
- **不决定**长 TTFB 期间的 daemon 心跳通知策略（如"agent 还在思考"提示消息）——同上，归 daemon 层
- **不决定** Discord rate limit 累计预算——typing / edit / 切片 send 三个累加维度的硬限阈值与降级策略由独立 issue 跟踪 cost-and-limits.md 修订
- **不决定**工具结果脱敏边界——独立 issue 跟踪 security spec
- **不决定**多用户 channel 并发 UX（reply 锚定 vs thread 隔离）——独立 issue 跟踪
- **不决定** turn 收尾摘要消息（"📝 Turn complete (N tools, M chars)"）——独立 issue 跟踪
- **不决定** firstEvent 超时仅 interrupt 后的"重试可见性"（daemon 是否主动发"⏳ 队列拥堵，请稍后重发"）——独立 issue 跟踪
- **不决定** emoji react interrupt 入口——9A 已选 `/stop`；emoji react 作为补充入口由独立 issue / 后续 ADR 跟踪
- **不决定**错误摘要 / `[interrupted]` reason 的具体截断阈值——PR-D 内部决定

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

第二轮 argue（决策点 5/6 补充）：

- **异议 6（决策点 5）**：草案最初写"agent Busy 即持续 typing 直到 turn_finished"——与 Discord 官方对该接口的定位（"短暂提示，generally bots should not use this route"）冲突；且依赖"edit 自动结束 typing"这个无官方保证的假设；首条消息后 typing 与流式 edit 形成两个并列"在做事"信号易打架。
  **回应**：采纳。Decision 改为 5A——typing 仅在"首条可见输出之前"触发，首个 `text_delta` / `tool_call_started` 落到 channel 后立即停止；切片路径不触发；外部参考 [Discord Channels API §Trigger Typing Indicator](https://docs.discord.com/developers/resources/channel)。

- **异议 7（决策点 6 阈值）**：草案最初给 30s/60s/300s 默认值偏激进——`streamIdleTimeoutMs=60s` 在工具静默运行 / 长思考 / 长 LLM 回复中可能误杀健康 turn；且"事件"定义不清（spawn/pipe `system/init` 算不算首事件？）。
  **回应**：采纳。Decision 不锁数值，只锁三层架构 + 三类不同恢复策略 + 兜底链；阈值留 spec 修订（PR-B/PR-C 落实，spec 写清"`firstEventTimeoutMs` 计 sendInput 到首个**业务事件**——`text_delta` / `tool_call_started`，**不**含 `system/init`，后者归 spawn probe"）。

- **异议 8（决策点 6A vs 6B）**：若三层超时最后动作都一样（interrupt → 5s → kill），6B 单一 wallclock + 观测层区分会更简；6A 必须证明"三层有不同动作"否则是过设计。
  **回应**：采纳并强化论证。Decision 明确三层有**不同恢复策略**：firstEvent 超时 → 仅 interrupt 不 Errored（视为"队列拥堵 / 网络问题，允许下一 turn 重试"）；streamIdle / perTurnWallclock 超时 → interrupt + session Errored（视为不可恢复）。这是"动作差异"而非只换观测维度，6B 被排除。

- **异议 9（决策点 6 兜底链）**：interrupt → 5s → kill + session Errored 必须升格为强约束，否则会出现"daemon 认为 turn 已超时但 backend 仍卡活着"的不可恢复中间态。
  **回应**：采纳。Decision 把兜底链写成强约束（粗体"强约束"），单 turn 超时本身不杀子进程，但 interrupt 失败 5s 内必升级到 SIGKILL + session Errored。

- **异议 10（决策点 6 与 ADR-0011 分层）**：本 ADR 三层 watchdog 不该顺手定义 daemon UX SLA，否则又把 ADR-0011 已分的两层打穿。
  **回应**：采纳。Decision 明确"本决策点只定义 runtime/backend watchdog"；Out of scope 加"daemon UX 通知 SLA / 长 TTFB 心跳通知策略"两条留给后续 daemon 层 spec / 独立 ADR。

第三轮（用户产品视角覆盖 + 新增决策点 7-10）：

- **用户覆盖（决策点 5）**：codex argue 推荐 5A "首条前停 typing"，本 ADR 第二轮 Decision 采纳。用户从产品 UX 实际感受出发判断 typing 应该是持久状态——长 turn（多工具循环 / 长思考 / 工具静默运行）期间持续 typing 比"首条后停"更能传达"agent 还在做事"，工具调用之间的思考阶段没 typing 容易让用户误判 agent 卡死；agent-nexus 是交互式 IM agent，Discord 官方"generally bots should not use this route"是给非交互场景的告诫，不适用本场景。
  **回应**：采纳用户覆盖。Decision 改为 5B 持续 typing 直到 turn_finished。argue 反方意见保留在异议 6 记录，作为"我们知道这个边界但产品判断覆盖了它"的留痕。

- **产品视角补全（决策点 7-10）**：流式协议落地后存在 4 个用户视角空白——错误的可见性 / mid-stream 失败收尾 / interrupt 用户入口 / 多用户 channel 切片时序。用户在第三轮明确这 4 项必须进本 ADR（其余 5 项产品维度待办——脱敏 / 多用户 channel / turn 收尾摘要 / 重试可见性 / Discord rate 累计预算——单开 issue 跟踪）。
  **回应**：决策点 7（错误呈现选 7A 工具 inline ❌ + turn 失败独立 reply）/ 8（mid-stream 收尾选 8A edit 末尾 [interrupted]）/ 9（interrupt UX 选 9A `/stop` slash command）/ 10（切片时序选 10A reply 链式锚定）落 Decision；其余 5 项进 Out of scope 并由后续 issue 跟踪。

## 参考

- 相关 issue：[#56](https://github.com/moesin-lab/agent-nexus/issues/56)（本 epic 来源）、[#45](https://github.com/moesin-lab/agent-nexus/issues/45)（root cause 分析被吸收）、#28、#54、#30、#55
- 相关 spec：
  - `docs/dev/spec/agent-runtime.md` §AgentEvent / §UsageRecord / §顺序保证
  - `docs/dev/spec/agent-backends/claude-code-cli.md` §交互式 session / §stdin 输入格式 / §stdout 事件格式 / §中断
  - `docs/dev/spec/message-protocol.md` §文本切片 / §流式语义
  - `docs/dev/spec/platform-adapter.md` §edit
- 相关 ADR：ADR-0002（CC CLI 选型）、ADR-0011（turn 分层）
- 当前实现：`packages/protocol/src/agent.ts:34-98`（裁剪版 union + TODO）、`packages/agent/claudecode/src/index.ts:120-333`（`--print` 单次调用 / interrupt no-op / 解析层）、`packages/platform/discord/src/index.ts:193-206`（capability set）
