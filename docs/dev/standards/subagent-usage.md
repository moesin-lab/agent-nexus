---
title: Subagent 产物与 Prompt 合格条件
type: standards
status: active
summary: 子代理 prompt、探索回报与主 session 收敛产物的合格条件和反模式
tags: [subagent, standards, prompt]
related:
  - dev/process/subagent-usage
---

# Subagent 产物与 Prompt 合格条件

本文件定义子代理协作产物"什么算合格 / 不合格"。何时派发、派发后谁负责收敛、失败后如何处理见 [`../process/subagent-usage.md`](../process/subagent-usage.md)。

## Prompt 合格条件

子代理没有主 session 的完整上下文。合格 prompt 必须包含：

- **目标**：一句话说清想要什么产物
- **背景**：只给与本任务相关的约束
- **锚点**：相关文件路径、关键函数名、已有设计文档
- **产出格式**：列表 / diff / 报告 / 代码；必要时给篇幅上限
- **范围外**：明确不要做什么

## Prompt 模板

```text
目标：<一句话>

背景：
- <已知约束 1>
- <已知约束 2>

锚点：
- <文件路径 1>
- <文件路径 2>
- <相关 spec 或 ADR>

请产出：
- <具体产物 1>
- <具体产物 2>
格式：<markdown / json / diff / 代码块>
篇幅上限：<例如 300 字 / 50 行>

不要做：
- <范围外的事>
```

## 探索类回报

探索类 agent 的回报必须可被主 session 快速收敛：结论先行、列出证据路径、避免长篇叙述。具体硬约束片段见 [`subagent-recon-prompt-template.md`](subagent-recon-prompt-template.md)。

## 子任务规模

单个子代理任务合格的尺（经验参考，非硬规则——对具体任务可按需放宽）：

- **预期运行时间 ~5 分钟内**：明显更久通常意味着还能继续拆
- **产出 ~200 行内**：明显更多说明子代理在替你做本该主 session 做的收敛
- **结论自洽**：子报告能独立阅读，不依赖其他子报告

判定方向：用上面三条判断是不是 over-coarse；不是"必须满足才派发"。派发时机与拆分维度见 [`../process/subagent-usage.md`](../process/subagent-usage.md)。

## 审计类派发 prompt

审计 / 全量扫描类任务的 prompt 必须满足以下硬约束，否则即使并行派发也会漏报：

1. **要求逐文件 enumerate + 三态判定**（违反 / 合规 / 不适用）：不允许"找够显著的就停"——产出必须能让主 session 看出子代理是不是漏看了
2. **不在 prompt 里替子代理预设范围豁免**（"不要审计 X / 跳过 Y"）：除非能指向具体 ADR / docs 章节解释豁免依据；脑补豁免会让子代理永远看不到那块

## 收敛阶段产物

主 session 收敛子代理产出时必须做两个动作，缺一不合格：

- **verify**：核对子代理报告的内容对不对（事实是否成立、定位是否准确）
- **sweep**：核对子代理没说的部分有没有问题（漏报检测）

只 verify 不 sweep 等于把"漏报"风险全压给子代理；收敛是主 session 的职责。

## 反模式

- 命令式短 prompt，例如只写"查一下 xxx"
- 把整个项目背景塞给子代理，淹没本任务锚点
- 子代理报告回来后主 session 重做同一轮探索
- 派发巨型单 agent 扫全部、审全部、比对全部
- 用子代理做需要用户持续互动的任务
- 派发时不说明是否允许修改文件
- 收敛阶段只 verify 不 sweep
