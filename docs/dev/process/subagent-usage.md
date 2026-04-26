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

按 `~/.claude/CLAUDE.md` 的全局约定，常用：

| 场景 | 子代理类型 |
|---|---|
| 代码/文件探索 | `Explore`（快速）或 `general-purpose`（深度） |
| 实现方案设计 | `Plan` |
| 独立 review | `superpowers:code-reviewer` 或 codex-review skill |
| 第二意见/盲点检查 | `codex:codex-rescue` 或 codex-review skill |
| 简化改进既有代码 | `code-simplifier` |

本项目专属补充：待 ADR 0004 语言定后，如有需要可新增项目专属子代理（如"spec 合约测试生成器"），届时在本文件登记。

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
