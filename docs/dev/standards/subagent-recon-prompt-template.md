---
title: Subagent 探索任务回报格式模板
type: standards
status: active
summary: 派发探索 / 侦察类子代理时在 prompt 末尾贴的硬约束片段，用于压制叙述化回报、防止主 session 上下文腐烂
tags: [subagent, template, recon]
related:
  - dev/process/subagent-usage
  - dev/standards/subagent-usage
---

# Subagent 探索任务回报格式模板

**适用**：探索 / 侦察 / 研究类子代理（Explore / general-purpose / codex 研究类），目标是把仓库事实、代码位置、文档片段抓回主 session。

**不适用**：Plan（设计类）/ code review（判断类）/ code-simplifier（修改类）——产出结构不同，需要各自的模板。

## 为什么要硬约束

探索类 agent 默认产出叙述化长报告。主 session 吞下后会有三类腐烂：

1. **上下文被占满**——后续任务的压缩率下降
2. **真事实埋在叙述里**——主 session 还要二次提炼才能用
3. **二手信息污染决策**——主 session 误把 agent 摘要当一手事实，实施时才发现要再 Read 原文

解法是在 prompt 里硬化回报格式——让 agent 产出"可直接剪进 plan 的事实条目"，而不是"读完后的报告"。

## 硬约束片段（复制粘贴用）

把下面整段贴进 Agent prompt 末尾（根据任务调整 `{N}`）：

```
回报格式（硬约束）：
- 每条必答：绝对路径 + 一行事实 + ≤3 行原文引用（frontmatter 允许完整引用）
- 禁止叙述化展开："让我先看看" / "我注意到" / "接下来探索" 类元评论
- 禁止在事实条目之间插过渡段、归纳小标题、章节性总结
- 不确定的事实单独放 §推测 段，前缀 [推测]；不混进事实段
- 结尾可选 ≤10 行的共性概览；更长说明任务该拆成多个 agent

总长 ≤ {N} 行（默认 200；跨目录大范围调 400；逐文件审计调 600）。
```

## 调用端最小示例

```
派发 Explore agent 调查仓库 skills/ 结构：

目标：搞清现有协作性 skill 的目录分层与文件约定

锚点：
- /workspace/agent-nexus/skills/
- /workspace/agent-nexus/skills.manifest
- /workspace/agent-nexus/docs/dev/process/skill-setup.md

产出：现有所有 skill 的路径 + frontmatter 原文 + 目录结构；manifest schema；挂接流程要点。

<此处贴"硬约束片段">
```

## 反模式

### 只说"简洁回答"

"请简洁回答"不是硬约束——agent 会按自己理解的"简洁"继续叙述化。必须具体到"每条必答 X + Y + Z"。

### 贴了模板但不给示例

agent 可能误解"一行事实"的颗粒。必要时在 prompt 里给 1 条示范条目，对齐颗粒感。

### 把硬约束写成建议

"尽量" / "最好" / "如果可以" → agent 会降级执行。用祈使语气："禁止" / "必须" / "每条必答"。

### 在报告回来后自己重做一遍

这与 [`subagent-usage.md`](subagent-usage.md) 的反模式重复。模板压缩了 agent 回报体积，不代表要失去对 agent 的信任——报告回来后只做收敛，不做复查式重搜。

## 维护

本模板**只**覆盖探索类 agent。其他类型（review / plan / research）若沉淀出稳定的 prompt 骨架，新开 sibling 文件（如 `subagent-review-prompt-template.md`），不混进本文件。
