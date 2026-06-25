---
title: Spec：Limits & Cost Control（限流、熔断、可选配额）
type: spec
status: active
summary: 机制分层——失控保护+使用量观测为一等（默认启用）；$ 预算与订阅配额跟踪为二等（按用户路径可选）
tags: [spec, cost, budget, rate-limit, circuit-breaker]
related:
  - dev/adr/0006-limits-layering-defense-first
  - dev/spec/infra/observability
  - dev/spec/infra/persistence
  - dev/architecture/session-model
---

# Spec：Limits & Cost Control

本 spec 按**机制类别**分层。一等机制（默认启用、不可关闭）：失控保护 + 使用量观测；二等机制（默认关闭、按需开启）：$ 预算 / 订阅配额跟踪。决策依据见 [ADR-0006](../../adr/0006-limits-layering-defense-first.md)——本 spec 不复述论证。

## 威胁模型

| 威胁 | 机制 |
|---|---|
| 用户不在场的失控（本机桌面 + IM 远程） | turn 硬限 + wall-clock 超时 + 熔断 |
| 流中卡死（stream 停止产事件但 turn 未结束） | 三层 watchdog L2 流中停滞 + interrupt 投递契约 |
| 订阅配额窗口被一次失控吃光（Claude Pro/Max 5h 滚动窗口） | turn / tool-call 硬限（默认值按保守配额估算） |
| Prompt injection 导致无限工具调用循环 | maxToolCallsPerTurn + 熔断 |
| Discord 429 被滥刷封禁 | 出站 rate limit 退避 + jitter |
| Anthropic 429 / 5xx | 入站 LLM 调用退避 + 有限重试 |
| 一个坏 session 把整进程拖死 | 并发上限 + 单 session 熔断 + 全局 degraded |
| 本机磁盘被幂等表/transcript 灌满 | 幂等 TTL GC + transcript 轮转 |
| API 用户预算失控（次要） | 可选 $ 预算层 |

## 一等 limits（默认启用，计费模型无关）

### Session 级串行

- 同 `sessionKey` 串行（见 `../architecture/session-model.md`）
- 防 CC 子进程被并发输入搞乱状态
- 不可关闭

### Turn 与工具调用硬限

- `limits.maxTurnsPerSession`（默认 `50`）：单 session 活跃期内最大 turn 数；超限 → session 自动 Archived + 用户通知
- `limits.maxToolCallsPerTurn`（默认 `30`）：单 turn 内最大工具调用数；超限 → 触发 `turn_finished { reason: "tool_limit" }`
- `limits.maxConsecutiveToolErrors`（默认 `5`）：单 turn 内连续工具失败数；超限 → 触发 `turn_finished { reason: "error" }`

### sendInput 失控保护（三层 watchdog）

stream-json 主路径下单次 `sendInput` 的失控保护分三层，对应三类失败模式（ADR-0012 决策点 4 + Consequences）。**注意 L1 是流开始之前的入队阶段保护，L2 / L3 才是流中保护**——三层覆盖 sendInput 的完整生命周期，不全是"流中"监控：

| 层 | 失败模式 | 阈值（默认） | 触发 |
|---|---|---|---|
| L1 入队等待（**流开始前**） | 队列拥堵：sendInput 排队迟迟未开始流 | `sessionQueueMaxWaitMs` = `30000` | 拒绝 + 用户可见提示（见 §并发上限，归此层） |
| L2 流中停滞 | 流中卡死：turn 活跃、**不处于 in-flight 工具等待态**、却长时间无任何 agent 事件 | `limits.streamStallTimeoutMs`（默认 `60000`） | 视为停滞 → 进入 interrupt 投递契约 |
| L3 墙钟总时长 | runaway：单 turn 总时长超限（含 in-flight 工具执行） | `limits.perInputTimeoutMs`（默认 `300000` = 5 分钟；可由 `agents[].timeoutMs` 覆盖） | 进入 interrupt 投递契约 |

- L2 计时锚点：最近一条 agent 事件（`text_delta` / `tool_call_*` / `tool_result`）到达时刻，每条事件重置 L2 计时
- **L2 不适用于 in-flight 工具等待态**：已 `tool_call_started` 但未配对 `tool_call_finished` 的工具，其执行期可合法长时间无事件（如长 build / 慢网络），不计入 L2 停滞；该期间仅由 L3 墙钟总时长 + `maxToolCallsPerTurn` 兜底——避免误杀正常长工具
  - **计时语义**：in-flight 期间 L2 计时**冻结**（不推进、不触发）；`tool_call_finished` 本身是 agent 事件，到达即按上一条规则重置 L2 锚点并从该时刻恢复计时
  - **多工具并发**：只要**存在任一** in-flight 工具（有 `tool_call_started` 未配对 `tool_call_finished`）即处于豁免态；必须**所有** in-flight 工具都 finished 后 L2 才恢复检测
- L2 / L3 任一命中 → 不直接 SIGKILL，而走 [ADR-0012 §interrupt 投递契约](../../adr/0012-claudecode-stream-json-mainline.md)：runtime 立即向 daemon 投递 synthetic `turn_finished` + 并行启动进程 cleanup state machine
- **L2 vs L3 的日志判别**依赖 agent-runtime 后续协议变更落地 ADR-0012 决策点 4 的 timeout layer 区分机制（payload 字段或 TurnEndReason 枚举二选一，protocol owner 定形态）；**该机制落地前 observability 不得宣称可区分 L2 与 L3**，本 spec 不定义字段名
- `perInputTimeoutMs` 与 `SessionConfig.timeoutMs`（见 `agent-runtime.md`）对齐；后者由 `agents[].timeoutMs` 生成，是每 agent / session 可覆盖值

### interrupt 投递 + cleanup 阶段阈值

机制状态机本体见 [ADR-0012 §interrupt 投递契约](../../adr/0012-claudecode-stream-json-mainline.md)；本 spec 仅定义其中下放的数值。**两类阈值语义不同，分表列出**——投递 SLA 超时只告警、不改变行为；cleanup 窗口超时则升级到下一阶段。

**第 1 层：投递 SLA（仅告警，不升级）**

| 阈值 | 默认 | 语义 |
|---|---|---|
| `limits.syntheticTurnFinishedDeliveryMs` | `250` | runtime 投递 synthetic `turn_finished` 的延迟目标上界。**超此值不改变投递语义**——runtime 仍继续投递并记 `warn`，daemon 入口屏障解锁以**实际投递完成**为准，不以本阈值为准 |

**第 2 层：cleanup 升级窗口（超时则升级）**

| 阈值 | 默认 | 语义 |
|---|---|---|
| `limits.gracefulInterruptMs` | `5000` | (2.1)：发出 interrupt 后等待 turn cleanup ack 或 process exit 的窗口；未达成才升级到 soft-kill |
| `limits.sigtermGraceMs` | `5000` | (2.2)：soft-kill（POSIX 映射 SIGTERM）后等待窗口；仍未达成则升级到 hard-kill |

hard-kill（2.3，POSIX 映射 SIGKILL）为终态，无后续等待；进入 hard-kill → session Errored（见 ADR §进程 cleanup 层 session 终态）。

### 流式集成数值（PR-C 最小集成契约配套）

ADR-0012 §PR-C 最小集成契约 的节流 edit / typing 周期数值：

| 阈值 | 默认 | 语义 |
|---|---|---|
| `limits.streaming.streamEditThrottleMs` | `1500` | daemon 缓冲 `text_delta` 后调 `edit()` 的最小间隔；**coalesce 下限**，降低高频 edit 触发 Discord 429 的概率 |
| `limits.streaming.typingRefreshMs` | `8000` | `supportsTypingIndicator=true` 时 daemon 重复调 `setTyping()` 的周期 |

- `turn_finished` 到达时立即触发一次 final `edit()`（不受 `streamEditThrottleMs` 节流约束），确保末尾内容不被节流吞掉
- typing 在 turn 结束 / interrupt / 错误时由 daemon 调 `clearTyping()` 停止
- **`streamEditThrottleMs` 是应用层 coalesce 下限，不是 Discord rate-limit 的替代**：HTTP 层仍以 §出站 Rate Limit（Discord）的响应头 / `Retry-After` 为准退避；本阈值只减少触发概率

### 阈值耦合关系

**(a) 启动校验硬不变量**（配置覆盖默认值时校验，违反则启动报错——可测试谓词）：

1. `typingRefreshMs < 10000`：Discord typing 指示约 10s 自动失效，续期必须早于过期，否则 typing 闪断（默认 `8000` 留 2s 余量）
2. `streamStallTimeoutMs < perInputTimeoutMs`：流中停滞检测必须早于总墙钟 runaway 上限，否则 L2 永不先于 L3 触发、失去区分意义

**(b) 设计建议**（推荐满足以保持各层语义清晰，**非启动校验**——避免把可调默认值钉成硬约束）：

3. `syntheticTurnFinishedDeliveryMs <= gracefulInterruptMs / 10`：synthetic 投递（第 1 层）应远早于 cleanup 升级（第 2 层），保证 ADR "两层互不阻塞"——UI 即时反馈不被进程清理阻塞
4. `gracefulInterruptMs + sigtermGraceMs <= perInputTimeoutMs / 10`：cleanup 全程预算应远小于单 turn 总时长，避免 cleanup 自身成为新的卡死源

`streamEditThrottleMs` 不在耦合不变量内——它是应用层 coalesce 下限，HTTP 层退避以 Discord 响应头为准（见 §流式集成数值），不与上述阈值构成可校验关系。

### 并发上限

- `limits.maxConcurrentSessions`（默认 `3`）：全局活跃 CC 子进程数
- `limits.maxConcurrentLlmCalls`（默认 `3`）：全局 in-flight LLM 调用数
- `limits.globalMessagesPerSec`（默认 `5`）：全局入站消息限速
- `limits.sessionQueueMaxPending`（当前实现默认 `20`）：单 SessionKey 内 pending message / queued command / daemon state command 数量上限；running item 不计入 pending
- 超限行为：排队（最多 `limits.sessionQueueMaxWaitMs` = 30s）→ 仍超则拒绝 + 用户可见提示

当前 daemon queue v1 强制 `sessionQueueMaxPending`；全局 running cap 属于 limits 目标约束，尚未由 in-memory queue 层强制。

### Session 生命周期 timeout

session 在状态机里的空闲与中断超时，状态机本体见 [`../../architecture/session-model.md`](../../architecture/session-model.md)。

- `limits.session.idleTimeoutMs`（默认 `1800000` = 30 分钟）：Active → Idle，距离最近一条消息/事件超过该值
- `limits.session.idleToArchiveMs`（默认 `7200000` = 2 小时）：Idle → Archived
- `limits.session.interruptedToArchiveMs`（默认 `86400000` = 24 小时）：进程重启后 Interrupted 实例若未被 `/resume` 或 `/end`，到期后自动 Archived

### 出站 Rate Limit（Discord）

- 监听响应头 `X-RateLimit-Remaining`、`X-RateLimit-Reset-After`
- 命中 429：按 `Retry-After` 退避
- 全局 `X-RateLimit-Global: true`：停 `Retry-After` 后重试
- 发送队列：每 channel 一个 FIFO，保持同 channel 顺序

### 入站 Rate Limit（Anthropic via CC）

- Anthropic 429：指数退避 + jitter（1s → 2s → 4s → 8s，cap 30s）
- 最大重试：5
- Anthropic 5xx：base 1s、cap 60s、最多 3 次
- 其他云错误：base 1s、cap 10s、最多 2 次

### 退避 + Jitter 公式

```
delay = min(base * 2^attempt, cap) * (1 + random(-jitter, +jitter))
base = 1000ms, cap 见上表, jitter = 0.2
```

### 熔断

- `circuit.consecutiveFailureThreshold`（默认 `3`）：同 session 连续可重试错误数
- 触发：session → `Errored`、CC 子进程 stopSession、用户通知
- 重置：用户 `/resume`、或冷却 `circuit.cooldownMs`（默认 10 分钟）后自动尝试
- 全局降级：5 分钟窗口内全局 agent 错误 > `circuit.globalDegradedThreshold`（默认 10）→ 停止接新 session，已有 session 正常，10 分钟无新错误自动解除

## 二等 limits（opt-in，按用户路径可选）

两个**并列**的配额控制机制。用户可以都开、都不开、任选其一；两者都**默认关闭**。

### $ 预算（适合 API 计费路径）

配置：

- `budget.perSession.limitUsd`
- `budget.daily.limitUsd`
- `budget.monthly.limitUsd`

启用时：

- 仅当 `llm_call_finished` 事件满足 `completeness === 'complete' && costUsd > 0` 时，把 `costUsd` 累加到对应层级（见下文 §`UsageRecord.completeness` 语义 的消费方硬不变量）
- 软阈值（50%/80%/100%）发 `info/warn`
- 硬阈值（100%）拒绝新 turn，session → Errored（单 session）或全局 BudgetHalted（每日/每月）

订阅路径下默认保持关闭；机制选择依据见 [ADR-0006](../../adr/0006-limits-layering-defense-first.md)。

### 订阅配额跟踪（适合订阅路径，MVP 未实现）

配置（占位）：

- `quota.subscriptionTracking.enabled`
- `quota.subscriptionTracking.warningRatio`（默认 0.8）
- `quota.subscriptionTracking.rollingWindowHours`（默认 5）

启用时（未来）：

- 订阅配额窗口内消耗（messages/turns）由 Anthropic 接口（如未来开放）或本机估算获取
- 接近窗口满时发 `warn`、禁止新 turn 直到窗口滚动

**当前 MVP 阶段未实现**；一等层的 turn / tool-call 硬限提供近似保护。待 Anthropic 暴露订阅配额剩余接口后补实现（届时更新本段并可能发新 ADR）。

### 选择指南

| 用户路径 | 推荐启用 |
|---|---|
| 纯订阅（Claude Pro/Max） | 仅订阅配额跟踪（待实现）；$ 预算保持关闭 |
| 纯 API（按 token 付费） | $ 预算；订阅跟踪保持关闭 |
| 混合（两类 key 都配了） | 两个都开；按调用时用的 key 类型归类

## Usage 记账（一等，强制，不可关闭）

每个 `llm_call_finished` 事件必须落日志（见 `observability.md` §"LLM 调用事件必含字段"），**无论启用哪个二等机制、也无论用户路径**：

- token（input / output / cache read / cache write）
- `costUsd`（若 CC 返回；订阅模式可能为 0 或 null，**不视为错误**）
- `turnSequence`
- `toolCallsThisTurn`
- `wallClockMs`
- `completeness`：见下节定义

这份记账是 spec 的强制契约。语义定位见 [ADR-0006](../../adr/0006-limits-layering-defense-first.md)。

### `UsageRecord.completeness` 语义

`completeness` 表达**该 turn 的 `costUsd` 字段是否可信用于 `$`-based 决策**——不是"字段全填了没"。决策依据见 [ADR-0013](../../adr/0013-usage-completeness-cost-confidence.md)，本 spec 不复述论证。

**归一化契约**：`UsageRecord.costUsd` 只能是**有限非负数**或 `null`。backend 原始负数、非数字、`NaN`、`Infinity` 由 backend 适配层折叠为 `null`，不会出现在 `UsageRecord` 表面。

| 取值 | 条件（归一化后） |
|---|---|
| `complete` | `costUsd > 0` 的有限正数 |
| `partial`  | `costUsd === null` 或 `costUsd === 0`。覆盖订阅 / Max plan 没回真实金额、`total_cost_usd` 字段未上报、backend 原始非法值被折叠等情况 |
| `missing`  | 协议保留位：未来表示"usage 事件本身就没产生"的 daemon-side audit 信号。**MVP 下 backend `AgentEvent{type:"usage"}` producer 不会产生此值；只可能由未来 daemon-generated audit record 携带**。当前代码恒不产生 |

**消费方硬不变量**（spec 强制契约）：

- `$` 预算 gate、美元 metrics 累加、定价校验**唯一**允许的判定条件是 `completeness === 'complete' && costUsd > 0`
- 消费方**不得**用 `costUsd != null` 或 `costUsd ?? 0` 推断"可计费金额"——`partial` 下 `costUsd` 仅是 backend 原始信号回显，不代表美元
- 想观察"数据有没有丢"：观察 `usage` 事件本身的出现频率（缺事件 = 异常），不靠 `completeness`

锚点：issue #27、PR #24 review、ADR-0013。

## 定价表（供 opt-in $ 预算使用）

- 由 daemon 维护，配置 `pricing.<model>.<key>`（$/MTok）
- 缺定价表的模型：跳过 $ 记账 + 打一次 `warn`（不中断业务）
- 不再把"最贵已知模型"估算作为默认行为（订阅场景下会产生误导性报警）

## 幂等表清理

见独立 spec：[`idempotency.md`](idempotency.md) §"后台 GC"。此处不再重复。

## 配置示例

```toml
# 一等 limits：默认即启用，下面是默认值示例
[limits]
maxTurnsPerSession = 50
maxToolCallsPerTurn = 30
maxConsecutiveToolErrors = 5
perInputTimeoutMs = 300000
maxConcurrentSessions = 3
maxConcurrentLlmCalls = 3
globalMessagesPerSec = 5
sessionQueueMaxWaitMs = 30000
sessionQueueMaxPending = 20
streamStallTimeoutMs = 60000            # L2 流中停滞
syntheticTurnFinishedDeliveryMs = 250   # synthetic turn_finished 投递 SLA / warn 阈值
gracefulInterruptMs = 5000              # cleanup (2.1)
sigtermGraceMs = 5000                   # cleanup (2.2) soft-kill grace

[limits.streaming]
streamEditThrottleMs = 1500
typingRefreshMs = 8000

[limits.session]
idleTimeoutMs = 1800000          # 30 分钟
idleToArchiveMs = 7200000        # 2 小时
interruptedToArchiveMs = 86400000 # 24 小时

[circuit]
consecutiveFailureThreshold = 3
cooldownMs = 600000
globalDegradedWindowMs = 300000
globalDegradedThreshold = 10

# 二等 limits：配额控制（两个机制并列，均默认关闭）
# [budget.perSession]       # 适合 API 路径
# limitUsd = 2.00
#
# [budget.daily]
# limitUsd = 20.00
#
# [budget.monthly]
# limitUsd = 200.00
#
# [quota.subscriptionTracking]   # 适合订阅路径（MVP 未实现）
# enabled = false
# warningRatio = 0.8
# rollingWindowHours = 5

# 定价表（仅 $ 预算启用时生效）
[pricing.claude-opus-4-7]
input = 15.00
output = 75.00
cacheRead = 1.50
cacheWrite = 18.75
```

## 合约测试

- **Turn 超限**：session 跑到第 51 个 turn → 自动归档 + 通知
- **工具调用循环**：单 turn 内 31 次工具调用 → `turn_finished { reason: "tool_limit" }`
- **L3 墙钟超时**：构造长任务 > `perInputTimeoutMs` → 走 interrupt 投递契约（synthetic `turn_finished` + cleanup 升级至 hard-kill）→ session 标 Errored
- **L2 流中停滞**：turn 活跃、无 in-flight 工具、`streamStallTimeoutMs` 内无 agent 事件 → 触发 interrupt 投递契约
- **L2 不误杀 in-flight 工具**：`tool_call_started` 后工具执行 > `streamStallTimeoutMs` 但 < L3 且未 finished → 不触发 L2（仅 L3 / `maxToolCallsPerTurn` 兜底）
- **阈值耦合校验**：配置 `typingRefreshMs ≥ 10000` 或 `streamStallTimeoutMs ≥ perInputTimeoutMs` → 启动校验报错
- **并发排队**：4 个 session 同时 spawn，第 4 个排队；超时后拒绝

> 阈值消费方的**行为合约测试**不在本 spec：节流 edit / final-edit flush / typing 周期与清除等集成行为归 daemon engine（ADR-0012 §PR-C 最小集成契约，PR-C owner）；synthetic 投递 SLA 与 cleanup 两段升级（graceful → soft-kill → hard-kill）等状态机行为归 runtime（ADR-0012 §interrupt 投递契约，PR-B owner）。本 spec §合约测试 仅覆盖阈值本身的启动校验与 L2/L3 触发判定。
- **Discord 429**：mock 429 响应 → 按 `Retry-After` 退避 + 重试
- **Anthropic 429**：指数退避 + jitter 观察
- **熔断**：连续 3 次 agent error → Errored + 通知
- **幂等 GC**：见 [`idempotency.md`](idempotency.md) §合约测试
- **$ 预算（opt-in）**：启用后，预算耗尽 → 拒绝 + 通知
- **订阅配额跟踪（opt-in，未来）**：接入 Anthropic 接口后补合约测试
- **Usage 字段完整**：订阅模式下 `costUsd` 可为 null，但 token/turnSequence/wallClockMs 必有
- **用户路径对称**：构造"纯 API 配置"与"纯订阅配置"两种基线，断言一等 limits 行为完全一致（无视用户路径）

## 观测

所有相关事件走 `observability.md`：

- `turn_limit_hit`（session, turn 序号）
- `tool_limit_hit`（session, turn 序号, toolCalls）
- `wallclock_timeout`（session, elapsedMs）——L2 流中停滞 / L3 墙钟均可触发；**`elapsedMs` 两种触发下统一为该 turn 从 sendInput 起的总墙钟时长**（不是 L2 的停滞时长），保证字段含义单一。L2 vs L3 的判别依赖 agent-runtime 后续落地 ADR-0012 决策点 4 的 timeout layer 区分机制，该机制落地前不得宣称可区分
- `rate_limit_hit`
- `circuit_opened` / `circuit_reset`
- `budget_threshold_crossed`（仅 opt-in 启用时）
- `llm_call_finished`（含 usage 字段）

## 反模式

机制分层依据（为何 $ 预算 / 订阅配额都默认关闭、为何按机制类别而非用户类型分一等二等）见 [ADR-0006](../../adr/0006-limits-layering-defense-first.md)。本 spec 不复述论证。

- 把 `$ 预算` 作为默认保护
- 把"订阅配额跟踪"作为默认保护
- 把**用户类型**当一等公民
- 把"最贵已知模型"作为缺失定价的兜底估算
- 缺 turn 硬限只靠 $ 预算
- 无退避地重试
- 熔断后永不恢复
- 指数退避不加 jitter
- 在本 spec 维护幂等相关规则（已迁移至 `idempotency.md`）
- 预算/限流超限时静默跳过

## Out of spec

- 按模型区分不同预算（MVP 统一）
- 按时段的动态限额
- 订阅配额跟踪的**具体实现**（接口还未开放；本 spec 仅占位 + 规划配置项）
- 多 agent 后端时的抽象计费层（届时发新 ADR）
- 第三方计费后端（Bedrock / Vertex）的二等机制（将来如需再加）
