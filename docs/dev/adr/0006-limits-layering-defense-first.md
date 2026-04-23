---
title: ADR-0006：Limits 分层——失控保护为一等，配额控制按用户路径可选
type: adr
status: active
summary: 一等 limits 是"防御失控"（resilience）与"使用量观测"；$ 预算与订阅配额跟踪是二等可选机制，两类用户对称看待
tags: [adr, decision, cost, budget, rate-limit, circuit-breaker]
related:
  - dev/adr/0005-subscription-as-first-class-path
  - dev/spec/cost-and-limits
  - dev/spec/observability
  - dev/architecture/session-model
adr_status: Accepted
adr_number: "0006"
decision_date: 2026-04-22
supersedes: "0005"
superseded_by: null
---

# ADR-0006：Limits 分层——失控保护为一等，配额控制按用户路径可选

## 状态变更日志

- 2026-04-22：Proposed
- 2026-04-22：Accepted（取代 0005；同日收敛）

## Context

本 ADR 取代 ADR-0005。两次迭代的认知轨迹：

1. **起点（commit `d2fd1ab`）**：`spec/cost-and-limits.md` 把 `$ 预算`（USD 硬限）当主轴，熔断/退避/限流都围绕 $ 编组
2. **第一次纠偏（ADR-0005, commit `3a849cd`）**：review 意见指出"订阅用户多"——我把 ADR 写成"订阅计费为一等用户路径"，$ 预算降为 opt-in
3. **第二次纠偏（本 ADR）**：把"订阅作为一等**用户路径**"同样错位——相当于把 API 用户降为二等公民。两次迭代都把**用户类型**与**机制类别**混为一谈

真正的一等公民**不是某类用户，而是某类机制**：

- **失控保护（resilience）**：无论订阅还是 API 用户，本机桌面 + IM 远程的形态（ADR-0003）都意味着用户常不在场；失控一次的代价对谁都惨
- **使用量观测**：记什么、记多少、是否归因 $，是所有用户都需要的"黑匣子"

把上述两类作为一等（默认启用），把具体的**配额控制机制**降为二等（按用户路径可选），可以同时避免两种偏见：
- 不因 `$ 预算` 把订阅用户当二等
- 不因 `订阅配额` 把 API 用户当二等

## Options

### Option A：$ 预算为主轴（commit `d2fd1ab` 原形态）

- **是什么**：所有限流/熔断/阈值围绕 USD 预算编组
- **优点**：对 API 用户直观
- **缺点**：订阅用户没有 $ 反馈信号；订阅模式 `costUsd` 可能为 null 让整个主轴失效
- **已在 ADR-0005 中拒绝**

### Option B：订阅为一等用户路径（ADR-0005）

- **是什么**：把"订阅是主流"作为决策前提，$ 预算降为 opt-in
- **优点**：对订阅用户直接有效
- **缺点**：把 API 用户降为二等；命名与立论都把**用户类型**当成一等公民
- **本 ADR 取代**

### Option C：Limits 分层——失控保护为一等，配额控制按用户路径可选（Recommended）

- **是什么**：
  - **一等（默认启用，两类用户无差别）**：
    - 失控保护：turn / wall-clock / tool-call 硬限；并发上限；熔断；Discord / Anthropic rate limit 退避
    - 使用量观测：每次 LLM 调用记 turn / tool / wallClock / tokens / cost（cost 允许 null）
  - **二等（opt-in，按用户路径可选）**：
    - `$ 预算`（适合 API 用户；订阅模式下 `costUsd` 不可靠，不应启用）
    - `订阅配额跟踪`（适合订阅用户；MVP 未实现，待 Anthropic 暴露配额剩余接口）
    - 可以都开、都不开、任选其一
- **优点**：用户类型对称；机制分层清晰；两类用户都在核心路径上
- **缺点**：配置项略多；需要用户理解"我属于哪类"

## Decision

选 **Option C**。

理由（一句话）：**一等公民是机制类别（防御失控 / 使用量观测），不是用户类型**；配额控制在用户类型维度上对称分叉，两条路径都不强制。

## Consequences

### 正向

- 订阅与 API 用户在失控保护上获得**完全一致**的默认保护
- `usage` 事件的语义从"计费依据"改为"观测底座"——`costUsd` 允许 null 被合法化
- 未来新增用户路径（如 Bedrock / Vertex 第三方计费）时，只需在"二等"新增一个可选机制，不需要改一等层
- 命名与立论消除用户类型偏见

### 负向

- 连续两轮纠偏造成 ADR 历史有两条记录（0005 Superseded、0006 Accepted）——**这是我们自己 ADR 规则的第一次实战**，保留历史比清洗历史更符合规则精神
- 用户文档（product/）需要解释两种配额机制，略增说明成本

### 需要后续跟进的事

- `spec/cost-and-limits.md` 把"订阅配额跟踪"从"未来占位"提升为与 `$ 预算`并列的二等机制（即使 MVP 未实现）
- `cost-and-limits.md` 开头重述重心："机制分层"而非"用户分层"
- 更新所有引用 ADR-0005 的链接到 ADR-0006

## Out of scope

- **不决定**具体阈值默认值（spec 细节，可独立调整）
- **不决定**`订阅配额跟踪`的具体实现（MVP 未实现，待 Anthropic 接口支持）
- **不决定**第三方计费后端（Bedrock/Vertex）的介入方式（将来发新 ADR）
- **不决定**用户路径自动识别（可以让用户显式配置"我是订阅用户 / API 用户 / 混合"）

## 参考

- 被取代的 ADR：[`0005-subscription-as-first-class-path.md`](0005-subscription-as-first-class-path.md)
- 受影响 spec：[`../spec/cost-and-limits.md`](../spec/cost-and-limits.md)
- 触发本 ADR 的 review 二次意见：主 session 对话中
