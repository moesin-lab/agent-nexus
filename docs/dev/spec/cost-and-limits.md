# Spec：Cost & Limits（预算、限流、熔断）

LLM 可烧钱、IM 平台会限流、长会话可失控。本 spec 定义三道防护：**预算**、**限流**、**熔断**。

## 预算

### 层级

| 层级 | 默认 | 可配置 |
|---|---|---|
| 单次 turn | 无硬限，只记账 | 否 |
| 单 session | `config.budget.perSession.limitUsd`（默认 $2.00） | 是 |
| 全局（每日） | `config.budget.daily.limitUsd`（默认 $20.00） | 是 |
| 全局（每月） | `config.budget.monthly.limitUsd`（默认 $200.00） | 是 |

### 记账

- 每个 `llm_call_finished` 事件触发记账（见 `spec/observability.md` 的字段）
- 从 `inputTokens / outputTokens / cacheReadTokens / cacheWriteTokens` 计算 `costUsd`
- 定价表在 `config.pricing.<model>.{input,output,cacheRead,cacheWrite}`（$/MTok）
- 缺定价表的模型：按**最贵已知模型**估算 + 打 `warn`

### 预算检查

在每次 agent 输入前检查：

```
if session.budget.used >= session.budget.limit:
    拒绝本次输入
    发用户通知：超出单会话预算，建议 /reset
    session.state → Errored（或保留 Active 等待用户 /reset）

if day_budget.used >= day_budget.limit:
    拒绝所有 session 的新 turn
    全局状态标为 BudgetHalted
    用户通知：今日预算已用尽
```

### 阈值通知

- 单 session 使用到 50% / 80% / 100%：发 `info` 通知
- 全局每日 80% / 100%：发 `warn` 通知（可配置渠道，MVP 仅日志）

### 预算重置

- 单 session：随 session archive 自动归零
- 每日/每月：按 UTC 自然边界
- `/reset-budget` slash command（需 owner 权限）：立即重置单 session 或全局

## 限流

### 入站（IM → core）

- 同 sessionKey：串行处理（见 session-model）
- 跨 sessionKey：全局并发上限 `config.limits.maxConcurrentSessions`（默认 3）
- 每秒消息数上限 `config.limits.globalMessagesPerSec`（默认 5）
- 超限行为：排队（最长 30 秒）→ 仍超则拒绝并提示"系统忙，稍后重试"

### 出站（core → IM）

Discord Rate Limit：

- 监听响应头 `X-RateLimit-Remaining`, `X-RateLimit-Reset-After`
- 命中 429：按 `Retry-After` 退避
- 全局 `X-RateLimit-Global: true`：停 `Retry-After` 后重试
- 发送队列：每 channel 一个 FIFO，保证同 channel 顺序

### LLM 调用

- 每 session 最大 in-flight 调用数：1（保证同 session 串行）
- 全局最大 in-flight LLM 调用数：`config.limits.maxConcurrentLlmCalls`（默认 3）
- Anthropic rate limit 429：指数退避（1s → 2s → 4s → 8s → 上限 30s）+ jitter（±20%）
- 最大重试次数：5

### 退避 + Jitter

通用退避公式：

```
delay = min(base * 2^attempt, cap) * (1 + random(-jitter, +jitter))
base = 1000ms, cap = 30000ms, jitter = 0.2
```

具体参数：

| 场景 | base | cap | maxAttempts |
|---|---|---|---|
| Discord 429 | 取 `Retry-After` | 30s | 5 |
| Discord 5xx | 1s | 30s | 3 |
| Anthropic 429 | 1s | 30s | 5 |
| Anthropic 5xx | 1s | 60s | 3 |
| Anthropic 云错误（非 rate limit） | 1s | 10s | 2 |

## 熔断

### 触发条件

同 session 连续 N 次可重试错误（`platform` 或 `agent`）后仍失败：

- `N = config.circuit.consecutiveFailureThreshold`（默认 3）
- 触发后：session 状态 → `Errored`
- CC 子进程 → stopSession
- 用户通知："本会话出错过多，已暂停。输入 /resume 重试或 /end 结束。"

### 重置

- 用户显式 `/resume`：重新 spawn，从 Errored → Active
- 用户 `/end`：归档 session
- 超过冷却期（默认 10 分钟）后下一条消息会自动尝试恢复

### 全局熔断

所有 session 在短时间（5 分钟）内出现大量 agent 错误（>10 次）：

- 全局状态 → `Degraded`
- 停止接受新 session，已有 session 正常
- 发 `warn` 日志；用户可见："系统检测到异常，暂停接受新会话"
- 10 分钟无新错误后自动解除

## 幂等表清理

- 后台 GC：每 5 分钟扫一次 `expires_at < now()` 的条目删除
- 批量上限：每轮最多删 10000 条，避免长事务
- 见 [`persistence.md`](persistence.md)

## 配置示例

```toml
[budget]
[budget.perSession]
limitUsd = 2.00

[budget.daily]
limitUsd = 20.00

[budget.monthly]
limitUsd = 200.00

[limits]
maxConcurrentSessions = 3
maxConcurrentLlmCalls = 3
globalMessagesPerSec = 5
sessionQueueMaxWaitMs = 30000

[circuit]
consecutiveFailureThreshold = 3
cooldownMs = 600000
globalDegradedWindowMs = 300000
globalDegradedThreshold = 10

[pricing.claude-opus-4-7]
input = 15.00
output = 75.00
cacheRead = 1.50
cacheWrite = 18.75
```

（定价单位：$/MTok。数字仅示例，实际值以 Anthropic 官方为准。）

## 合约测试

- **预算超限**：构造已用 $1.99/$2.00 的 session，再发触发 $0.10 的输入 → 拒绝 + 通知
- **Discord 429**：mock 429 响应 → 按 `Retry-After` 退避 + 重试
- **熔断**：连续 3 次 agent error → session → Errored + 通知
- **幂等 GC**：插入 10000 条过期条目 → GC 后表为空
- **全局并发**：4 个 session 同时启动，第 4 个排队

## 观测

所有相关事件走 [`observability.md`](observability.md)：

- `budget_threshold_crossed`
- `rate_limit_hit`
- `circuit_opened` / `circuit_reset`
- `llm_call_finished`（含 costUsd）

## 反模式

- 把预算硬编码在代码里（必须配置）
- 无退避地重试（打爆平台）
- 熔断触发后永远不恢复（需要冷却 + 用户可恢复）
- 用指数退避但不加 jitter（雷鸣群效应）
- 幂等表不 GC（SQLite 无限增长）
- 预算超限时静默跳过（必须显式拒绝 + 通知用户）

## Out of spec

- 按模型区分不同预算（MVP 统一预算）
- 按时段的动态预算（工作日 vs 周末）
- 预算报表 UI（product 阶段）
