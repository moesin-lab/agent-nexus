---
title: ADR 模板
type: adr
status: active
summary: 新 ADR 的起点；定义 Context / Options / Decision / Consequences / Out of scope 结构
tags: [adr, decision]
related:
  - dev/adr/README
adr_status: Proposed
adr_number: "XXXX"
decision_date: null
supersedes: null
superseded_by: null
---

# ADR-XXXX：<标题，祈使句或名词短语>

- **状态**：Proposed | Accepted | Deprecated | Superseded by XXXX | Rejected
- **日期**：YYYY-MM-DD（最近一次状态变更的日期）
- **决策者**：<姓名或 handle>
- **相关 ADR**：无 / ADR-NNNN

## 状态变更日志

> 新增状态头追加在此段顶部，原有记录保留。

- YYYY-MM-DD：Proposed
- YYYY-MM-DD：Accepted（评审通过，见 PR #N）
- （后续变更追加）

## Context

为什么现在要做这个决定？背景、约束、触发事件。
目标读者：半年后的自己或新协作者。
3–8 段，每段 3–5 行。

## Options

列出至少两个认真比较过的候选。每个候选一个小节。

### Option A：<名字>

- **是什么**：1 句话
- **优点**：要点列表
- **缺点**：要点列表
- **主要风险**：1–2 点

### Option B：<名字>

同上结构。

### Option C：<名字>（可选）

同上。

## Decision

选 Option X。一句话。

## Consequences

### 正向

- <影响 1>
- <影响 2>

### 负向

- <代价 1>
- <代价 2>

### 需要后续跟进的事

- <后续要做的约束或检查>
- <例如：某指标达到阈值时需要复审本决策>

## Out of scope

这个 ADR **不决定**什么。避免误读。

例：

- 不决定具体接口字段（那是 spec 的事）
- 不决定部署细节（那是另一个 ADR）
- 不决定未来是否扩展到其他平台（留给后续 ADR）

## 参考

- 相关 spec：<路径>
- 相关 issue / PR：<链接>
- 外部参考：<链接>
