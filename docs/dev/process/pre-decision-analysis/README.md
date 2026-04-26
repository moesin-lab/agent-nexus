---
title: Pre-Decision Analysis（决策前结构化分析协作约定）
type: process
status: active
summary: agent-first 协作约定的流程编排——主轴 6 步、子流程索引、per-harness 实现；形态决策依据见 ADR-0010，触发与产物合格条件见 standards
tags: [process, review, scratch, argue, ask-user]
related:
  - dev/adr/0010-pre-decision-agent-first
  - dev/adr/0007-collaborative-skill-promotion
  - dev/standards/pre-decision-analysis/README
  - dev/standards/pre-decision-analysis/scratch-template
  - root/AGENTS
---

# Pre-Decision Analysis

> 本文件是 `pre-decision-analysis` 协作约定的**权威源**（agent-agnostic）。各 harness 通过自身薄执行器引用本 docs（实现见仓库 `skills/pre-decision-analysis/` 下各 harness 子目录）。
> 子流程住在同目录下的 `pre-decision-analysis/` 子目录；形态决策依据见 [ADR-0010](../../adr/0010-pre-decision-agent-first.md)；触发判据 / 核心原则 / Scratch 硬触发 / 反模式等产物合格条件见 [`../../standards/pre-decision-analysis/README.md`](../../standards/pre-decision-analysis/README.md)；scratch 模板见 [`../../standards/pre-decision-analysis/scratch-template.md`](../../standards/pre-decision-analysis/scratch-template.md)。

## 何时进入本流程

判据见 [`../../standards/pre-decision-analysis/README.md` §触发判据](../../standards/pre-decision-analysis/README.md#触发判据)。本文件只编排进入后做什么。

## 主轴 6 步

### 步骤 1：收集上下文 + 起 draft

读相关代码 / docs / ADR / 已有讨论；在脑子里（或私有草稿）成形推荐方案。

### 步骤 2：argue 自检

有推荐 / 倾向的决策必派 argue subagent（异构视角反方分析）——防止 agent 照镜子看不到盲点。首选**异构模型反方分析**（不同训练数据 + 不同 reasoning style），备选**独立 context 同模型交叉验证**（无当前对话包袱）。多段并行派。具体调度方式与 per-harness 工具映射见 `subflow-argue.md`。

触发条件：跨多文件 OR 架构级 OR agent 对方向拿不准。单文件 + 已有先例 + agent 有把握可跳。

argue 要点 + agent 回应**贴 PR body** 的"异议 & 回应"小节。argue prompt 合格条件见 [`../../standards/pre-decision-analysis/README.md` §Argue 自检产物标准](../../standards/pre-decision-analysis/README.md#argue-自检产物标准)。

### 步骤 3：识别任务类型

- **可自动验证**（有 test / 可执行产物 / 可 grep / 可 diff 的搬家）→ 路径 A
- **仅主观判断 + agent 拿不准** → 路径 B

### 步骤 4A：路径 A（执行优先）

agent 直接：

- 开分支（遵循项目分支先行约定）
- 落代码 / 文档
- 跑自验（test / lint / 文件断言 / argue 自检通过）
- push + 开 PR；PR body 贴 argue 要点 + 关键决策要点
- 等用户在 PR 做后审

方案级分叉拿不准时：**多方案并行**——agent 同时起 2-3 个分支做出不同方案的完整产物，开 2-3 个 PR。用户 diff 比较，merge 一个、close 其他。

### 步骤 4B：路径 B（真不确定才问）

当 agent 有多个方案都无把握、或需要用户业务 / 历史知识时：

- 筛 ≤ 3 个**真分叉**（判据：agent 自己没把握 / 违反已有 ADR 需特批 / 用户之前反对过相关方向）
- 向用户推送选项让其点选（单轮；harness 有按钮式工具时优先用，否则普通对话列选项）
- 用户答完 → 走路径 A

禁入条件见 [`../../standards/pre-decision-analysis/README.md` §路径 B 的禁入条件](../../standards/pre-decision-analysis/README.md#路径-b-的禁入条件)。

### 步骤 5：PR diff 后审

用户在 GitHub 原生 UI 操作：

- approve / merge：采纳
- close：方向错 / 不要了（git reset 成本为零）
- inline comment / request changes：要求修改 → agent 按 comment 改（新 commit push 上去）

### 步骤 6：异议 / 错误处理

- PR 被 close → agent 接受；必要时回步骤 1 重想
- PR 有 comment → agent 读 comment 修，新 commit push
- PR merge → 完成

## Checkpoint / Scratch 触发

Checkpoint 与 Scratch 默认不起，只在硬触发条件满足时起。条件见 [`../../standards/pre-decision-analysis/README.md` §Checkpoint 触发条件](../../standards/pre-decision-analysis/README.md#checkpoint-触发条件可选) 与 [§Scratch 硬触发条件](../../standards/pre-decision-analysis/README.md#scratch-硬触发条件)。

起 scratch 后按 [`../../standards/pre-decision-analysis/scratch-template.md`](../../standards/pre-decision-analysis/scratch-template.md) 的格式。

## 子流程索引

按对象类型按需读 `pre-decision-analysis/` 下对应文件：

| 对象类型 | 读哪个 reference | 何时读 |
|---|---|---|
| 有推荐 / 倾向，要跑 argue | `subflow-argue.md` | 步骤 2（几乎所有情况） |
| 外部仓库 / 框架评估 | `subflow-external-repo.md` | 步骤 1 之前插入 Layer 定位 + 高效 fetch |
| 内部 ADR / 多方案对比 | `subflow-adr-options.md` | 路径 B 填候选方案结构 |
| 大任务拆解 | `subflow-task-breakdown.md` | 路径 B 的 WBS 分析 |
| 现状调研报告 | `subflow-survey.md` | scratch 场景，分两轮"摘要 → 深挖" |
| **起 scratch 时** | `../../standards/pre-decision-analysis/scratch-template.md` | scratch 骨架 + slot 格式 |
| **调试自己的产物 / 自 review** | `../../standards/pre-decision-analysis/README.md` | 产出后回检 |

## Per-harness 实现

- **Claude Code**：`skills/pre-decision-analysis/` skill 是本 docs 的薄执行器；skill 的 description 让触发时加载本 docs
- **其他 harness**（Codex / Cursor / ...）：按本 docs 手工遵守，或自行实现对等 skill / rule 指向本 docs

无论 harness，**规则以本 docs 为准**。
