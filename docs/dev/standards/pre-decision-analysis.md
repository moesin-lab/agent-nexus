---
title: Pre-Decision Analysis 产物合格条件
type: standards
status: active
summary: pre-decision-analysis 产物的反模式、scratch 质量标准与可 review 性要求
tags: [standards, review, scratch]
related:
  - dev/process/pre-decision-analysis/README
---

# Pre-Decision Analysis 产物合格条件

本文件定义 pre-decision-analysis 产物"什么算合格 / 不合格"。流程触发、路径选择、角色分工和失败处理见 [`../process/pre-decision-analysis/README.md`](../process/pre-decision-analysis/README.md)。

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
