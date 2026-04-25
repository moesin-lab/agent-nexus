---
title: Pre-Decision Analysis（决策前结构化分析协作约定）
type: process
status: active
summary: 当用户提出需要人类拍板但必须先做结构化分析的问题时的 agent-agnostic 协作约定；agent-first 执行、review 做"选择"不做"批改"、真分叉才向用户推选项、PR diff 作为后审载体
tags: [process, review, scratch, argue, ask-user]
related:
  - dev/adr/0007-collaborative-skill-promotion
  - root/AGENTS
---

# Pre-Decision Analysis

> 本文件是 `pre-decision-analysis` 协作约定的**权威源**（agent-agnostic）。各 harness 通过自身薄执行器引用本 docs（实现见仓库 `skills/pre-decision-analysis/` 下各 harness 子目录）。
> 子流程 / 模板 / 完整反模式住在同目录下的 `pre-decision-analysis/` 子目录。

## 核心前提

1. **版本管理很方便**（git 回滚接近零成本）
2. **agent 执行很廉价**（token + 时间便宜）
3. **人类 reviewer 的 review 很昂贵**（注意力 + 认知）

这三条决定了协作形态：**agent 多做、人少看、review 做"选择"不做"批改"**。传统"先摊方案拿 approval 再动手"对多数场景是过度工程——agent 有把握就直接干，错了 git reset。

## 核心原则

- **Agent-first 执行**：agent 有把握就直接开分支落地；**错了 git reset / close PR**，不让用户提前 review 抽象方案
- **Review = 选择，不批改**：用户看 PR diff 点 merge / close / inline comment，不在 scratch 里打字批改抽象 trade-off
- **真分叉才问**：判据是"**agent 有没有把握**"，不是"回滚成本"（回滚免费）。agent 自决的东西不占 review 带宽
- **能自验的问题不进 review**：有 test / lint / typecheck / 脚本能自证的，agent 自验过就不问
- **多方案并行 > 抽象选择**：agent 没把握时可同时起 2 个分支做出结果，用户 diff 两个 PR 选 merge 一个——比在文本 trade-off 里选强
- **Argue 作 pre-flight self-check**：先自检，argue 要点 + agent 回应贴 PR body（透明化，给 reviewer 背景）
- **Scratch 默认不起**；仅在跨会话 / 复杂归档时起

## 何时触发

**该触发**（动词 + 结构任一命中，且问题开放）：

- 动词：评估 / 对比 / 审视 / 值不值得 / 该不该 / 拆不拆 / 利弊 / trade-off
- 结构：问题开放无单一答案；候选 ≥ 2；改动跨多位置；涉及跨多文件的架构级变更

**不该触发**：用户已给明确执行指令；单一事实查询；紧急修复；用户已说"直接做 / 别问了"；前文已讨论过只是待执行。

**触发前三问**（agent 自问，不落盘）：

1. 要决策什么？一句话写清。
2. 决策者是谁？几乎总是人类。
3. agent 自己能不能带着推荐直接干、错了 git reset？能 → 走路径 A，不问用户。不能 → 走路径 B。

## 主轴 6 步

### 步骤 1：收集上下文 + 起 draft

读相关代码 / docs / ADR / 已有讨论；在脑子里（或私有草稿）成形推荐方案。

### 步骤 2：argue 自检

有推荐 / 倾向的决策必派 argue subagent（异构视角反方分析）——防止 agent 照镜子看不到盲点。首选**异构模型反方分析**（不同训练数据 + 不同 reasoning style），备选**独立 context 同模型交叉验证**（无当前对话包袱）。多段并行派。具体调度方式与 per-harness 工具映射见 `subflow-argue.md`。

触发条件：跨多文件 OR 架构级 OR agent 对方向拿不准。单文件 + 已有先例 + agent 有把握可跳。

argue 要点 + agent 回应**贴 PR body** 的"异议 & 回应"小节。见 `pre-decision-analysis/subflow-argue.md`。

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

方案级分叉拿不准时：**多方案并行**——agent 同时起 2-3 个分支做出不同方案的完整产物，开 2-3 个 PR。用户 diff 比较，merge 一个、close 其他。代价是 agent 时间，便宜。

### 步骤 4B：路径 B（真不确定才问）

当 agent 有多个方案都无把握、或需要用户业务 / 历史知识时：

- 筛 ≤ 3 个**真分叉**（判据：agent 自己没把握 / 违反已有 ADR 需特批 / 用户之前反对过相关方向）
- 向用户推送选项让其点选（单轮；harness 有按钮式工具时优先用，否则普通对话列选项）
- 用户答完 → 走路径 A

**禁止**：把 agent 能自决的细节（命名 / 格式 / 文件数量合并）塞进推送给用户的选项里。

### 步骤 5：PR diff 后审

用户在 GitHub 原生 UI 操作：

- approve / merge：采纳
- close：方向错 / 不要了（git reset 成本为零）
- inline comment / request changes：要求修改 → agent 按 comment 改（新 commit push 上去）

### 步骤 6：异议 / 错误处理

- PR 被 close → agent 接受；必要时回步骤 1 重想
- PR 有 comment → agent 读 comment 修，新 commit push
- PR merge → 完成

## Checkpoint（可选）

Git reset 零成本后，Checkpoint 不强制。只在以下场景用：

- **用户明确**说"做到一半看一眼"
- **agent 对方向没把握**但又不够"真分叉"级别——主动 push 骨架 commit 让用户 diff 确认再继续
- **极大改动**（20+ 文件）：建议拆成 2 个 commit，骨架在前、细节在后，方便 reviewer 分段审

## Scratch 硬触发（何时落盘）

默认不起。仅在以下**至少一条成立**时起：

- 向用户推选项连续 2 轮都没定方向（讨论复杂到要归档）
- 用户明确要跨会话继续讨论
- 涉及 ≥ 2 个 ADR 需跨决策协调（PR 描述塞不下）
- 用户显式说"起 scratch"

路径固定 `.tasks/<topic>-<purpose>.scratch.md`（`.tasks/*.scratch.md` 已 gitignore）。

起了 scratch 后按 `pre-decision-analysis/output-template.md` 的格式。段结构自由但每段独立可 review，段末可埋"想问你"作定向引导。

## 段内内容原则（scratch 场景）

段结构放开，但每段**必须让人类能一次看明白**。常见元素（按需选用）：

- **结论**：推荐 / 不推荐 / 取决于 X
- **理由**：基于什么事实或约束
- **落地要点**：采纳后具体动作；plan 类段可列关键文件 / 验证
- **反对点 / 风险**：自己先想到的反驳角度
- **想问你**：对本段拿不准的 1-2 个定向问题

不要求每段四件套齐全——按段实际需要取舍。段里**只有一句含糊陈述**就是反模式。

## 核心反模式

完整清单见 `pre-decision-analysis/anti-patterns.md`。最要命的几条：

- **Default scratch 而非直接执行**：git 便宜 + agent 便宜 + review 贵——默认直接干
- **Review 塞给用户批改**：让用户打字在 HTML comment 里回"Q1=a"就是 review 成本转嫁
- **把 agent 能自决的细节塞进选项推送**：命名 / 格式 / 文件数这种 agent 有把握的不问
- **一次问超过 3 个真分叉**：砍到 3 个或分批；问多了就是 agent 自己该想清楚
- **Argue 结果不贴 PR body**：用户看 diff 时看不到 agent 考虑过哪些反对点，追溯困难
- **多方案要选时问抽象文本而非做出来**：能并行做就并行做让用户 diff 选

## 子流程索引

按对象类型按需读 `pre-decision-analysis/` 下对应文件：

| 对象类型 | 读哪个 reference | 何时读 |
|---|---|---|
| 有推荐 / 倾向，要跑 argue | `subflow-argue.md` | 步骤 2（几乎所有情况） |
| 外部仓库 / 框架评估 | `subflow-external-repo.md` | 步骤 1 之前插入 Layer 定位 + 高效 fetch |
| 内部 ADR / 多方案对比 | `subflow-adr-options.md` | 路径 B 填候选方案结构 |
| 大任务拆解 | `subflow-task-breakdown.md` | 路径 B 的 WBS 分析 |
| 现状调研报告 | `subflow-survey.md` | scratch 场景，分两轮"摘要 → 深挖" |
| **起 scratch 时** | `output-template.md` | scratch 骨架 + slot 格式 |
| **调试自己的产物 / 自 review** | `anti-patterns.md` | 产出后回检 |

## Per-harness 实现

- **Claude Code**：`skills/pre-decision-analysis/` skill 是本 docs 的薄执行器；skill 的 description 让触发时加载本 docs
- **其他 harness**（Codex / Cursor / ...）：按本 docs 手工遵守，或自行实现对等 skill / rule 指向本 docs

无论 harness，**规则以本 docs 为准**。
