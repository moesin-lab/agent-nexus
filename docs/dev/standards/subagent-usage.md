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

## 反模式

- 命令式短 prompt，例如只写"查一下 xxx"
- 把整个项目背景塞给子代理，淹没本任务锚点
- 子代理报告回来后主 session 重做同一轮探索
- 派发巨型单 agent 扫全部、审全部、比对全部
- 用子代理做需要用户持续互动的任务
- 派发时不说明是否允许修改文件
