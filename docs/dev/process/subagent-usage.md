---
title: Subagent 使用编排
type: process
status: active
summary: 子代理派发后的主 session 收敛职责、子代理类型映射、登记新用途；派发判据 / prompt / 反模式见 standards/subagent-usage.md
tags: [subagent, process]
related:
  - root/AGENTS
  - dev/process/code-review
  - dev/standards/subagent-usage
---

# Subagent 使用编排

在多代理 harness 环境里，**何时派发 / prompt 怎么写 / 子任务规模 / 收敛产物**等合格条件见 [`../standards/subagent-usage.md`](../standards/subagent-usage.md)。本文件只编排：派发后主 session 做什么、子代理类型如何映射、新用途如何登记。

## 派发哪个子代理

本文件不绑定具体 harness 的私有 agent 名称。先按任务类型选"能力"，再按当前 harness 映射到具体工具：

| 场景 | 需要的能力 |
|---|---|
| 代码/文件探索 | 独立上下文探索仓库、返回证据路径 |
| 实现方案设计 | 独立上下文设计/拆解方案 |
| 独立 review | 不同模型或不同上下文审 PR / diff / draft |
| 第二意见/盲点检查 | 异构模型反方分析 |
| 简化改进既有代码 | 聚焦删除、合并、减少抽象的 reviewer |

### Per-harness 映射

| Harness | 探索 / 设计 | 独立 review / 第二意见 | 简化改进 |
|---|---|---|---|
| Claude Code | `Explore` / `general-purpose` / `Plan` | `codex-review` skill / `codex:codex-rescue` / `superpowers:code-reviewer` | `code-simplifier` |
| Codex | 可用的 multi-agent 工具或手工独立上下文；没有工具时主 session 自行探索并明确未派发 | `claude-review` / `adversarial-review` skill，或等价外部 reviewer | `claude-review` 给定简化角度，或手工执行并留自查 |
| 其他 harness | 按自身 subagent / external review 机制对等 | 按自身 subagent / external review 机制对等 | 按自身机制对等 |

本项目专属补充：如有需要可新增项目专属子代理（如"spec 合约测试生成器"），届时在本文件登记。

## 主 session 的收敛职责

派发子代理后，主 session 的职责是：

1. **收敛**：把多个子代理的产出整合成一致结论
2. **决策**：基于产出做出选择（子代理不替你决策）
3. **落盘**：把最终产物写入正确位置（代码文件、文档、ADR）
4. **追问**：子代理结论有漏洞，补问或重新派发

收敛阶段必须做完整 verify + sweep（按 [`../standards/subagent-usage.md` §收敛阶段产物](../standards/subagent-usage.md#收敛阶段产物)），不能只 verify。

## 串行不可避免的场景

子任务 B 依赖子任务 A 的产出时严格串行。但先问：A 的产出里**真正**被 B 依赖的是什么？能不能把那部分单独抽出来先跑 A'，然后 A'' 与 B 并行？

## 登记新用途

在项目里发现某种场景下"派发子代理效果特别好"或"特别差"，在本文件追加记录，避免同类经验流失。
