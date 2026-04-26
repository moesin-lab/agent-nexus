---
title: ADR-0009 强制 TDD（先 spec → 先 failing test → 再 impl）
type: adr
status: active
summary: 把"测试驱动开发"作为项目硬性流程而非可选风格——给 LLM 协作场景下的代码漂移一道稳定防线
tags: [adr, decision, tdd, testing, process]
related:
  - root/AGENTS
  - dev/process/tdd
  - dev/standards/testing
  - dev/testing/strategy
adr_status: Proposed
adr_number: "0009"
decision_date: null
supersedes: null
superseded_by: null
---

# ADR-0009：强制 TDD

- **状态**：Proposed
- **日期**：2026-04-26
- **决策者**：senticx@foxmail.com
- **相关 ADR**：无

## 状态变更日志

- 2026-04-26：Proposed

## Context

本项目自 AGENTS.md §3 起就把 "TDD 强制：先 spec → 先 failing test → 再 impl" 列为核心原则之一，但这条决策始终没有独立 ADR 锚定它的论证——理由散落在 `process/tdd.md` 的导言段（"缺测试时每次改动都是赌博 / LLM 生成代码速度快但易漂移 / 先写测试逼想清楚接口"）。

这种把决策依据塞进 process 导言的做法在 ADR-0008 owner 矩阵下不合规：process 容纳流程编排，决策论述归 ADR。SSOT 阶段 2 清理时把这一处违反暴露出来，需要补一个迟到的 ADR。

更深的触发：项目主开发者是 LLM agent（Claude Code / Codex / Cursor 等）。LLM 生成代码速度快但易漂移——比"对 spec 复述"略偏一两步的实现都可能产生连锁兼容性问题。事先写好 failing test 让"实现是否符合预期"成为 binary 判据，而不是事后人类逐字 review 实现细节。这条理由对 LLM 协作场景比对纯人类协作更紧——本 ADR 把这个权衡显式化。

## Options

### Option A：TDD 推荐但不强制

由作者自由决定何时先写测试。

- **优点**：减少认知负担；探索性场景更自由
- **缺点**：缺测试的代码会持续累积；review 时回头补测试质量明显下降（按现有实现写断言 → 循环论证）；LLM 生成的代码缺测试时漂移信号最弱
- **主要风险**：项目长期"重要功能没测试 / 测试只覆盖 happy path"的代码债务

### Option B：TDD 强制（Recommended）

所有功能性改动按 Red-Green-Refactor 顺序：先 failing test → 实现 → refactor。允许探针例外（spike），但探针不合并到主干，跑通后丢弃重写。

- **优点**：测试与实现同 PR、按设计动机写而非按现有实现写；新增代码自带回归网；LLM 漂移有 binary 信号；对外接口先想清楚再实现
- **缺点**：先期成本（写测试 + 跑 fail + 跑 green）比直接写实现略长；探索期被迫拆成"探针 + 重写"两步
- **主要风险**：作者把"事后补测试"包装成"先写实现"绕过流程；缓解：reviewer 强制查 commit 历史是否先有 failing test commit

### Option C：TDD 仅对 critical path 强制

只对消息流、错误处理、脱敏、限流等核心路径强制 TDD，其他区域允许 test-after。

- **优点**：抓核心、放宽边缘
- **缺点**：边界划分本身需要持续争论；project 在 spec 阶段还没区分 critical / non-critical 的稳定标准；"边缘"区会在不知不觉中扩大，最终回到 Option A 的状态
- **主要风险**：边界判据缺失导致规则形同虚设

## Decision

选 **Option B：TDD 强制**。

具体节奏（Red-Green-Refactor）+ 探针例外条款 + 自查 checklist 的**流程编排**住 [`../process/tdd.md`](../process/tdd.md)；测试合格条件、反模式、断言写法、覆盖率政策等**价值标准**住 [`../standards/testing.md`](../standards/testing.md)；测试分层与 mock 边界等**验证证据模型**住 [`../testing/strategy.md`](../testing/strategy.md)。

本 ADR 只承载"为什么强制 TDD 而非推荐 / 仅 critical path"的决策依据，不复述节奏或合格条件。

## Consequences

### 正向

- AGENTS.md §3 的 "TDD 强制" 有了独立决策锚点，未来争议（"为什么必须先写测试"）有 ADR 可指
- 决策依据从 process/tdd.md 导言迁出，符合 ADR-0008 standards/process 边界
- 给后续可能的"放宽 TDD"决策（开 ADR-NNNN supersede 0009）提供清晰反对者
- 对 LLM 协作场景的特殊价值显式化——其他 agent / 项目复用本规则时能看到论证

### 负向

- 写功能时先期成本略增加（写 failing test → 跑确认 fail → 实现 → 跑 green）
- 探索性工作被迫显式走"探针 + 重写"两步（探针 ≤ 半天，详见 process/tdd.md）
- 反模式（事后补测试 / 过度 mock / 测实现细节）需要 reviewer 持续把关；规则本身不能机械执行

### 需要后续跟进的事

- 阶段 2 清理后，process/tdd.md 与 standards/testing.md 拆分完成时，确认理由段已迁入本 ADR
- 如未来出现"某类工作 TDD 成本过高"的具体证据，开新 ADR supersede 而非偷偷绕过本规则

## Out of scope

- **不决定**测试分层（Unit / Integration / E2E / Eval）的具体职责——见 testing/strategy.md
- **不决定**测试代码风格、断言写法、命名等产物形态——见 standards/testing.md
- **不决定**测试触发时机、CI 门禁、失败处理——见 process/tdd.md 与 process/code-review.md
- **不决定**覆盖率数字目标——见 standards/testing.md §覆盖率
- **不决定**特定语言的测试框架选型——待 ADR-0004 落地后由实施 PR 决定

## 参考

- 触发本 ADR 的清理工作：PR #19（SSOT phase 2 cleanup）
- 相关 process：[`../process/tdd.md`](../process/tdd.md)
- 相关 standards：[`../standards/testing.md`](../standards/testing.md)
- 相关 testing：[`../testing/strategy.md`](../testing/strategy.md)
