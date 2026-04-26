---
title: Pre-Decision Analysis 产物合格条件
type: standards
status: active
summary: pre-decision-analysis 触发判据、核心原则、Checkpoint 与 Scratch 硬触发条件、反模式、scratch 质量标准、argue 与子流程产物合格条件
tags: [standards, review, scratch]
related:
  - dev/process/pre-decision-analysis/README
  - dev/adr/0010-pre-decision-agent-first
---

# Pre-Decision Analysis 产物合格条件

本文件定义 pre-decision-analysis 产物"什么算合格 / 不合格"，含触发判据、核心原则、scratch / checkpoint 触发条件与反模式。形态决策依据见 [ADR-0010](../adr/0010-pre-decision-agent-first.md)；流程编排（主轴 6 步、子流程索引、per-harness 实现）见 [`../process/pre-decision-analysis/README.md`](../process/pre-decision-analysis/README.md)。

## 核心原则

形态推论的合格条件（依据见 ADR-0010）：

- **Agent-first 执行**：agent 有把握就直接开分支落地；错了 git reset / close PR，不让用户提前 review 抽象方案
- **Review = 选择，不批改**：用户看 PR diff 点 merge / close / inline comment，不在 scratch 里打字批改抽象 trade-off
- **真分叉才问**：判据是"agent 有没有把握"，不是"回滚成本"（回滚免费）。agent 自决的东西不占 review 带宽
- **能自验的问题不进 review**：有 test / lint / typecheck / 脚本能自证的，agent 自验过就不问
- **多方案并行 > 抽象选择**：agent 没把握时同时起 2 个分支做出结果，用户 diff 两个 PR 选 merge 一个——比在文本 trade-off 里选强
- **Argue 作 pre-flight self-check**：argue 要点 + agent 回应贴 PR body（透明化，给 reviewer 背景）
- **Scratch 默认不起**：仅在跨会话 / 复杂归档时起

## 触发判据

### 该触发

动词或结构任一命中，且问题开放：

- 动词：评估 / 对比 / 审视 / 值不值得 / 该不该 / 拆不拆 / 利弊 / trade-off
- 结构：问题开放无单一答案；候选 ≥ 2；改动跨多位置；涉及跨多文件的架构级变更

### 不该触发

- 用户已给明确执行指令
- 单一事实查询
- 紧急修复
- 用户已说"直接做 / 别问了"
- 前文已讨论过只是待执行

### 触发前三问（agent 自问，不落盘）

1. 要决策什么？一句话写清。
2. 决策者是谁？几乎总是人类。
3. agent 自己能不能带着推荐直接干、错了 git reset？能 → 走路径 A，不问用户。不能 → 走路径 B。

## 路径 B 的禁入条件

向用户推选项时**禁止**：

- 把 agent 能自决的细节（命名 / 格式 / 文件数量合并）塞进推送给用户的选项里
- 一次推超过 3 个真分叉——超 3 说明没砍到真分叉
- 选项是"你觉得怎么样"——必须具体 + 带 2-3 个候选 + 有倾向时写默认建议

## Checkpoint 触发条件（可选）

Git reset 零成本后，Checkpoint 不强制。只在以下场景用：

- **用户明确**说"做到一半看一眼"
- **agent 对方向没把握**但又不够"真分叉"级别——主动 push 骨架 commit 让用户 diff 确认再继续
- **极大改动**（20+ 文件）：建议拆成 2 个 commit，骨架在前、细节在后，方便 reviewer 分段审

## Scratch 硬触发条件

默认不起。仅在以下**至少一条成立**时起：

- 向用户推选项连续 2 轮都没定方向（讨论复杂到要归档）
- 用户明确要跨会话继续讨论
- 涉及 ≥ 2 个 ADR 需跨决策协调（PR 描述塞不下）
- 用户显式说"起 scratch"

路径固定 `.tasks/<topic>-<purpose>.scratch.md`（`.tasks/*.scratch.md` 已 gitignore）。scratch 骨架与 slot 格式见 [`pre-decision-analysis-scratch.md`](pre-decision-analysis-scratch.md)。

## 反模式表

| 反模式 | 正确做法 |
|---|---|
| **默认起 scratch 而非直接执行** | git 回滚便宜 + agent 执行便宜 + review 昂贵——默认走路径 A 直接落地开 PR；scratch 只在硬触发条件满足时起 |
| **Review 塞给用户批改**（打字在 HTML comment 里回"Q1=a"） | review 做"选择"不做"批改"——用户 PR diff 点 merge / close / inline comment |
| **把 agent 能自决的细节塞进选项推送** | 命名 / 格式 / 文件数 / 这种 agent 有把握的不问；真分叉 = agent 自己没把握 OR 违反 ADR OR 用户反对过 |
| **一次问超过 3 个真分叉** | 砍到 3 个或分批；问多了就是 agent 自己该想清楚 |
| **能自验的问题占 review 带宽** | 有 test / lint / typecheck / 脚本能自证的 agent 自验过就不问 |
| **Argue 结果 agent 吸收但不贴 PR body** | 用户看 diff 时看不到考量背景——argue 要点 + agent 回应必须贴 PR body 透明化 |
| **多方案要选时问抽象文本而不并行做出来** | 能并行执行就并行起 2-3 个分支做完整产物，用户 diff 选 merge 一个；比让用户读 trade-off 文本选强 |
| **把 skill 当成"外部仓库评估专用"** | 本质是"需要人类拍板的结构化分析"，外部仓库只是子流程 A |
| **问题单一 / 明确时还强行走分段 + slot** | 触发前先过三问；能直接做就直接做，流程不是目的 |
| 多个维度堆在一段里 | 一维度一段，每段独立 slot（scratch 场景） |
| 段里含糊陈述不给结论也不给定向问题 | 要么给明确结论让用户 yes/no，要么埋"想问你"让用户定向选择 |
| 有推荐 / 倾向却缺少反方自检记录 | 关键分叉要留下异议与回应，供 PR 后审理解 |
| argue 串行派 | 并行派，同 turn 开多个 subagent |
| argue 返回 "looks good" 就收下 | 要求反方 / 挑错；夸赞说明 prompt 太松，重派 |
| 定向问题问"你觉得怎么样" | 具体 + 带选项 + 带默认建议；一段最多 1-2 个 |
| "不采纳 / 不借鉴"清单只列条目不给理由 | 每条一句"为什么不"，否则被追问 |
| REVIEW slot 紧贴正文没有空行 | slot 前后各一空行；slot 内部标签行与 `-->` 之间留空行 |
| 主 session 替用户决定转 ADR / issue（scratch 场景） | 停在 scratch，等 slot 反馈再决定 |
| 外部仓库评估时逐个文件 fetch | 先拿 tree，挑代表性文件（见子流程 A） |
| scratch 里放主 session 报告性的收尾语 | scratch 只放分析 + slot；收尾语走主 session 对话 |
| review 还没回就追加新维度 | 停手等；需要补维度也等用户先回 |
| 用户已说"直接做"还强行走 slot | 用户让渡决策权时，skill 退出，直接执行 |
| 第二轮深挖塞进第一轮 scratch | 开新 scratch，purpose 改 `deep-dive`（见子流程 D） |
| 段内硬套四件套凑字数 | 段结构自由；按段的实际需要取舍 |

## Scratch 质量标准

- 每段必须能独立被 review：要么有明确结论，要么有定向问题。
- 定向问题必须具体、带 2-3 个候选；有倾向时写默认建议。
- "不采纳 / 不借鉴"类清单每条必须带理由。
- 每个 REVIEW slot 前后各留一个空行；slot 内部标签行与 `-->` 之间留空行。
- 段与段之间用 `---` 分隔。
- scratch 末尾追加总体意见 slot。

## Argue 自检产物标准

给 argue subagent 的 prompt 必须包含：

- 方案正文全文，而不是只给摘要。
- 周边上下文，包括已锁定约束、相关 ADR、用户已表明的偏好。
- 明确任务：事实性错误、推荐 / 倾向的反例、被忽视的风险 / 成本、定向问题设计缺陷。
- 禁止要求：不得让 argue agent 写新方案、给实施代码或输出夸赞式结论。

argue 结果必须可追溯到 PR body 或 scratch 的整合后反对点；只在主 session 内部吸收而不留痕不合格。

## 子流程产物标准

- 外部仓库：第一段必须是 Layer 定位；"明确不借鉴"每条必给理由。
- 外部仓库：未拉全 tree 就逐文件 fetch 不合格。
- ADR 多方案：候选方案不少于 2 个；"约束与不变量"段不得省略；scratch / 选项推送不替代 ADR。
- 任务拆解：候选拆法不少于 2 个；trade-off 至少覆盖速度 / 并行 / 回滚 / milestone 中的 2 维。
- 调研：第一轮每段不超过 10 行；第二轮深挖启动前必须有用户"展开"的明确 slot 回复；深挖必须另起新 scratch。
