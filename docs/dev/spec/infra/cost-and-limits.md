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

### Wall-clock 硬限

- `limits.perInputTimeoutMs`（默认 `300000` = 5 分钟）：单次 `sendInput` 到 `turn_finished` 的墙钟超时
- 与 `SessionConfig.timeoutMs`（见 `agent-runtime.md`）对齐；后者是每 session 可覆盖值
- 超时处理链：先发 `interrupt`（SIGINT）→ 等 5 秒 → 仍未 `turn_finished` 则 SIGKILL 并投递 `error` + `session_stopped`

### 并发上限

- `limits.maxConcurrentSessions`（默认 `3`）：全局活跃 CC 子进程数
- `limits.maxConcurrentLlmCalls`（默认 `3`）：全局 in-flight LLM 调用数
- `limits.globalMessagesPerSec`（默认 `5`）：全局入站消息限速
- 超限行为：排队（最多 `limits.sessionQueueMaxWaitMs` = 30s）→ 仍超则拒绝 + 用户可见提示

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

- 每个 `llm_call_finished` 事件的 `costUsd` 累加到对应层级
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

这份记账是 spec 的强制契约。语义定位见 [ADR-0006](../../adr/0006-limits-layering-defense-first.md)。

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
- **Wall-clock 超时**：构造长任务 > 5 分钟 → SIGINT → SIGKILL 路径 + session 标 Errored
- **并发排队**：4 个 session 同时 spawn，第 4 个排队；超时后拒绝
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
- `wallclock_timeout`（session, elapsedMs）
- `rate_limit_hit`
- `circuit_opened` / `circuit_reset`
- `budget_threshold_crossed`（仅 opt-in 启用时）
- `llm_call_finished`（含 usage 字段）

## 反模式

- 把`$ 预算`作为默认保护（对订阅用户无效 + 误导）
- 把"订阅配额跟踪"作为默认保护（对 API 用户无意义；两类机制都必须 opt-in）
- 把**用户类型**当一等公民；机制分层依据见 [ADR-0006](../../adr/0006-limits-layering-defense-first.md)
- 把"最贵已知模型"作为缺失定价的兜底估算（订阅模式会产生虚假报警）
- 缺 turn 硬限只靠 $ 预算（订阅用户撞配额墙前得不到任何保护）
- 无退避地重试（打爆平台）
- 熔断后永不恢复（必须有冷却 + 用户可恢复）
- 指数退避不加 jitter（雷鸣群）
- 在本 spec 维护幂等相关规则（已迁移至 `idempotency.md`）
- 预算/限流超限时静默跳过（必须显式拒绝 + 通知）

## Out of spec

- 按模型区分不同预算（MVP 统一）
- 按时段的动态限额
- 订阅配额跟踪的**具体实现**（接口还未开放；本 spec 仅占位 + 规划配置项）
- 多 agent 后端时的抽象计费层（届时发新 ADR）
- 第三方计费后端（Bedrock / Vertex）的二等机制（将来如需再加）
