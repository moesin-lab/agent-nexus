---
title: Pre-Decision Analysis 子流程：现状调研
type: process
status: active
summary: 现状调研报告场景的两轮 scratch 模式、展开 slot、深挖流程与产物标准链接
tags: [process, scratch, review]
related:
  - dev/process/pre-decision-analysis/README
  - dev/standards/pre-decision-analysis/README
---

> 本文件是 `docs/dev/process/pre-decision-analysis/README.md` 的组件，agent-agnostic。
> 各 harness 通过 `skills/pre-decision-analysis/` 下自身执行器引用。

# 子流程 D：对象是现状调研报告

**何时用**：用户问"某子系统现在是什么样 / 有哪些问题 / 历史债是什么"。scratch 场景（材料多、需归档翻阅）。第一轮 scratch **只给摘要**，等用户点中的维度再做第二轮深挖。

## 与主轴的差异

- 维度分解仍然适用，典型维度：模块现状 / 数据流 / 已知问题 / 潜在风险 / 历史债。
- slot 格式换成"是否展开"：

```
<!-- REVIEW 段 N（是否展开？展开 / 跳过 / 改方向）：

-->
```

## 为什么分两轮

一次把所有维度深挖完，多半是浪费——用户真关心的往往只有 1–2 段。第一轮摘要帮用户快速筛选，第二轮针对点中的维度做详细调研。

## 本子流程专属标准

调研产物标准见 [`../../standards/pre-decision-analysis/README.md`](../../standards/pre-decision-analysis/README.md)。
