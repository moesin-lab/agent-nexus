---
title: ADR-0005：订阅计费为一等用户路径（已被 0006 取代）
type: adr
status: active
summary: 原议把订阅作为一等用户路径；已被 ADR-0006 取代——正确的一等公民是"机制类别"（防御失控）而非"用户类型"
tags: [adr, decision, cost, budget, rate-limit, circuit-breaker, superseded]
related:
  - dev/adr/0006-limits-layering-defense-first
  - dev/adr/0002-agent-backend-claude-code-cli
  - dev/adr/0003-deployment-local-desktop
  - dev/spec/infra/cost-and-limits
  - dev/spec/infra/observability
adr_status: Superseded
adr_number: "0005"
decision_date: 2026-04-22
supersedes: null
superseded_by: "0006"
---

# ADR-0005：订阅计费为一等用户路径

> **状态**：已被 [ADR-0006](0006-limits-layering-defense-first.md) 取代。本 ADR 把订阅作为"一等用户路径"的立论错位——等同于把 API 用户降为二等公民；真正的一等公民是"机制类别（防御失控 / 使用量观测）"而非"用户类型"。ADR-0006 保留同一决策精神但以正确框架表述。原文以下保留供审计追溯。

## 状态变更日志

- 2026-04-22：Proposed（由用户 review 意见触发）
- 2026-04-22：Accepted（同日收敛）
- 2026-04-22：Superseded by ADR-0006（命名与立论角度错误；用户在第二轮 review 中指出"订阅也不是一等公民，不能不考虑 API 用户"；由 0006 以"机制分层"框架重新表述同一决策精神）

## Context

前置：ADR-0002（Agent 后端是 Claude Code CLI）+ ADR-0003（本机桌面）。CC CLI 的主流使用方式是 **Claude Pro / Max 订阅**，而非按 token 计费的 Anthropic API。

最初的 `spec/cost-and-limits.md`（commit `d2fd1ab`）把 `$ 预算`（per-session / daily / monthly 的 USD 硬限）作为限流体系的**主轴**，所有阈值、熔断、用户通知都挂在 $ 上。

但订阅用户没有 $ 这个反馈信号：

- Claude Pro / Max 按**5 小时滚动窗口的 messages/token 配额**计量
- 撞到配额的代价不是"账单多一点"，而是**接下来几小时全家不能用**（硬断）
- 订阅用户在 agent-nexus 里的"失控"代价 = 自废 IDE 几小时

而 agent-nexus 的形态（本机桌面 + IM 远程遥控，ADR-0003）**放大了失控风险**：用户可能不在电脑前，一个 prompt-injection 带偏的 agent 或无限循环的工具调用，可以在几小时里烧光窗口配额、占满并发、灌满磁盘。

用户在 review 中指出："成本控制不是一等公民，因为很多人都使用 subscription"。该观察成立，但推论错在把多维度的 limits 简化成了 `$ 预算`一件事——session 级限流、并发上限、rate limit 退避、熔断这些都与计费模型无关，对订阅用户**同样甚至更加必要**。

本 ADR 把"订阅是一等用户路径"作为显式前提写入仓库，影响后续 limits 设计。

## Options

### Option A：保持原 spec，$ 预算为主轴

- 沿用 commit `d2fd1ab` 的 `cost-and-limits.md`
- 优点：无需改文档
- 缺点：对订阅用户几乎无效；默认值（$2/session、$20/day、$200/month）对订阅用户无意义；撞订阅配额窗口时没有有效保护
- 风险：上线后订阅用户发现"bot 把我今天的订阅配额烧光了"

### Option B：完全删除 `$ 预算`，只保留非计费型 limits

- 移除所有 `costUsd` / 预算相关条目
- 优点：简单
- 缺点：丢了对 API 用户的保护；usage 记账（token/cost）仍有调试/审计价值，一刀切砍掉太粗

### Option C：承认订阅为一等，limits 主轴改为"配额消耗代理指标"；`$ 预算`降为 opt-in（Recommended）

- `cost-and-limits.md` 的**主轴**改为：turn 数、工具调用次数、wall-clock 时长、并发、rate limit 退避、熔断
- `$ 预算`作为**可选层**，默认关闭，配置开启后对 API 用户生效
- `usage` 事件仍强制记录，包含 token / cost / turn / tool_count / wall-clock
- 在 spec 开头加"订阅配额窗口"作为显式威胁模型

## Decision

选 **Option C**。

理由（一句话）：订阅是主流路径，limits 必须对订阅用户直接有保护力；`$ 预算`对 API 少数派仍有价值但不再作默认。

## Consequences

### 正向

- 订阅用户在默认配置下也能获得失控保护（turn/时长/工具调用数硬限）
- API 用户仍可选择开 $ 预算（向下兼容）
- `usage` 归因仍完整（记 token + cost + turn + tool_count），出问题能复盘
- 威胁模型显式化：订阅配额窗口被点名

### 负向

- spec 结构变化需要同步 `session-model.md` / `persistence.md` / `observability.md` / `eval.md` 几处引用
- 用户文档（product/）将来要讲清楚"订阅 vs API"两种配额解释
- 当 usage 事件里 `costUsd` 未知（订阅模式下 CC 可能不返回价格）时要有降级

### 需要后续跟进的事

- `spec/cost-and-limits.md` 按本 ADR 重构
- 未来若接入非 Anthropic agent 后端（ADR-0002 的 Out of scope），重新评估"配额模型"假设
- 若 Anthropic 推出按订阅级别暴露配额剩余的 API，本项目应对接（发新 ADR）

## Out of scope

- **不决定**具体的 turn / 时长 / 工具调用次数默认阈值（属于 spec 细节，可独立调整）
- **不决定**订阅配额窗口的具体检测方式（依赖 Anthropic 是否暴露数据）
- **不决定**是否对所有用户默认开启 wall-clock 限制（属于 spec 细节）
- **不决定**未来支持多个 agent 后端时的计费抽象（届时发新 ADR）

## 参考

- 触发本 ADR 的 review 意见：主 session 对话中
- 受影响的 spec：`docs/dev/spec/cost-and-limits.md`
- 受影响的相邻文档：`observability.md` / `session-model.md` / `persistence.md` / `testing/eval.md`
- Claude Pro / Max 订阅配额政策（外部）：以 Anthropic 官方文档为准
