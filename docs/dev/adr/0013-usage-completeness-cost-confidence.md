---
title: ADR-0013 UsageRecord.completeness 语义——$ 视图可信度
type: adr
status: active
summary: completeness 字段表达 costUsd 是否可信用于 $-based 决策，不是数据完整性；订阅模式 costUsd=0 标 partial 防误用
tags: [adr, cost, usage, protocol]
related:
  - dev/spec/infra/cost-and-limits
  - dev/spec/agent-runtime
  - dev/adr/0006-limits-layering-defense-first
adr_status: Proposed
adr_number: "0013"
decision_date: 2026-05-21
supersedes: null
superseded_by: null
---

# ADR-0013：UsageRecord.completeness 语义——$ 视图可信度

- **状态**：Proposed
- **日期**：2026-05-21
- **决策者**：mouxinc@gmail.com
- **相关 ADR**：ADR-0006（Limits 分层——决定 `$` 预算为二等 opt-in 机制）

## 状态变更日志

- 2026-05-21：Proposed

## Context

issue #27 暴露：旧实现 `completeness = costUsd === null ? 'partial' : 'complete'` 让订阅 / Max plan 下 `costUsd === 0` 走 `complete` 分支，下游若启用 `$` 预算会把零值当真实美元累加。

`UsageRecord.completeness` 在 `packages/protocol/src/agent.ts` 与 `docs/dev/spec/agent-runtime.md` 已经存在但语义模糊：注释只指向 backend contract 的 `UsageCompleteness` 表，那张表混合了"字段完整性"（token 齐不齐）与"costUsd 可信度"两条独立维度。本 ADR 钉死这条字段在协议层只表达一条维度，并锁定取值条件。

约束：
- `$` 预算是二等 opt-in 机制（ADR-0006），但 spec 已规定**所有 `llm_call_finished` 必带 `completeness` 字段**——它必须是有真信号的协议位，不能是"摆设"。
- MVP 阶段 daemon 还未实现 usage 落盘 / `$` 累加 / budget gate；本 ADR 只钉协议契约，不绑定到当前不存在的消费方实现。
- 字段是 union `'complete' | 'partial' | 'missing'`，protocol breaking change 成本高，本次不重构枚举形状。

## Options

### Option A：$ 视图可信度

- **是什么**：`completeness` 表达"该 turn 的 `costUsd` 是否可信用于 `$`-based 决策"。具体取值条件（complete / partial / missing）由 spec 承载，本 ADR 不复述——见 [`cost-and-limits.md` §`UsageRecord.completeness` 语义](../spec/infra/cost-and-limits.md#usagerecordcompleteness-语义)。
- **优点**：
  - 字段是真信号——订阅 / Max plan 路径下 `costUsd === 0` 不会被下游误用
  - 与 `$` 预算 opt-in 机制配套，下游过滤规则简单（具体不变量见 spec）
  - 不依赖 backend 之外的事实（token / wallClockMs 是否齐由 backend 自行保证）
- **缺点**：
  - "数据有没有丢"的诉求要走另一条路（观察 `usage` 事件本身的频率），不能用本字段
  - `partial` 下 `costUsd` 仍可能为 `0`，消费方必须显式判 `completeness` 而非 `costUsd != null`
- **主要风险**：未来若真出现"API 路径下合法 `total_cost_usd: 0`"（如全 cache 命中场景），会被误标 partial；缓解办法是 fixture 实证 + 必要时收紧 backend 解析层。

### Option B：数据完整性

- **是什么**：`completeness` 表达"usage payload 字段全填了没"。token / `turnSequence` / `wallClockMs` 任一缺失 → `partial`；事件不产生 → `missing`。
- **优点**：
  - 语义直观，字段名与含义对齐
- **缺点**：
  - MVP 实现里 token / `turnSequence` / `wallClockMs` always 填齐（缺失就走 `error` 路径不发 usage），`completeness` 恒为 `complete`，字段冗余
  - 没解决 issue #27 的下游误用问题——下游仍需另一个字段判断 `costUsd` 是否可信
- **主要风险**：协议位无真信号，等同摆设。

## Decision

选 Option A：`$` 视图可信度。

具体取值条件、归一化契约、消费方硬不变量均由 [`cost-and-limits.md` §`UsageRecord.completeness` 语义](../spec/infra/cost-and-limits.md#usagerecordcompleteness-语义) 承载，本 ADR 不复述（doc-ownership：ADR 不承载契约公式）。

## Consequences

### 正向

- issue #27 闭环：订阅 / Max plan `costUsd === 0` 走 `partial`，未来 `$` 预算 gate 不会误用
- 三个 spec 文档（`cost-and-limits.md` / `agent-runtime.md` / `agent-backends/claude-code-cli.md`）的 `completeness` 描述收敛到 SSOT，doc-ownership 不再撕裂
- protocol JSDoc / spec / 实现三处统一表述，消除 drift

### 负向

- 旧实现产生过 `costUsd: 0 + completeness: complete` 的记录（仅运行时事件流，未落盘），新实现产生 `costUsd: 0 + completeness: partial`——如果未来引入 usage 落盘 + 跨版本聚合，需要按 schema 版本或 recorded_at 分段解释
- 消费方契约更严：不能用 `costUsd != null` 推断"可计费"，必须显式判 `completeness === 'complete'`

### 需要后续跟进的事

- daemon 实现 usage handler / `llm_call_finished` 落盘 / `$` 预算 gate 时，必须遵守 spec 的消费方硬不变量（见 `cost-and-limits.md` §`UsageRecord.completeness` 语义）
- `missing` 保留位：6 个月后若仍无 producer，单开 PR 删枚举值（避免协议腐烂）
- CC CLI 订阅 / API / 字段缺失三类 transcript fixture 实证（issue 待开）

## Out of scope

本 ADR **不决定**：

- daemon usage handler / `llm_call_finished` / `$` 预算 gate 的具体实现（归 `$` 预算 opt-in 启用 PR）
- `missing` 是否删除（保留位，待 producer 设计或 6 个月后复审）
- 订阅配额跟踪机制（ADR-0006 已分轨）
- CC CLI transcript fixture infra 建设

## 参考

- 相关 spec：`docs/dev/spec/infra/cost-and-limits.md` §`UsageRecord.completeness` 语义
- 相关 issue / PR：issue #27、PR #24、PR #82
