---
title: Pre-Decision Analysis 子流程：任务拆解
type: process
status: active
summary: 大任务拆解场景的 WBS 三段脚手架、候选拆法要求、trade-off 维度与收敛动作
tags: [process, review]
related:
  - dev/process/pre-decision-analysis/README
  - dev/standards/pre-decision-analysis/README
---

> 本文件是 `docs/dev/process/pre-decision-analysis/README.md` 的组件，agent-agnostic。
> 各 harness 通过 `skills/pre-decision-analysis/` 下自身执行器引用。

# 子流程 C：对象是大任务拆解

**何时用**：用户给了一个大目标、要决定"拆成什么子任务 / 按什么粒度拆"。

## WBS 三段脚手架

1. **目标 + 验收标准**：一段写清做什么算完。模糊目标先澄清，不要硬拆。
2. **候选拆法**：给 2–3 种不同粒度的拆分方案。例如：
   - 按层拆（数据层 → 服务层 → 接口层）
   - 按用例拆（先跑通 happy path，再补边界）
   - 先垂直打通再水平扩展
   每种一段，给 trade-off：迭代速度 / 并行度 / 回滚面 / 首个可用 milestone 何时出现。
3. **推荐优先级**：基于"改动面 × 价值"排序，给 top 3 子任务。

## 本子流程专属标准

产物标准见 [`../../standards/pre-decision-analysis/README.md`](../../standards/pre-decision-analysis/README.md)。

## 收敛后的动作

用户挑中某种拆法后：

- 若第一个子任务 agent 有把握 → 直接走路径 A 开分支落地
- 若仍需讨论 → 起 `plan` scratch 或向用户推选项进一步收敛
- 长期 track 用 issue

本子流程 scratch 本身归档，不再追加实施细节。
