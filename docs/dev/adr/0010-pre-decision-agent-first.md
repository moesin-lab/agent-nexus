---
title: ADR-0010：pre-decision-analysis 采用 agent-first 协作形态
type: adr
status: active
summary: 在多代理 harness 协作场景中，pre-decision-analysis 选 agent-first 形态——基于 git 回滚便宜 + agent 廉价 + reviewer 昂贵三条前提，让 agent 直接落地、人类在 PR diff 上 review，scratch 默认不起
tags: [adr, decision, pre-decision-analysis, collaboration]
related:
  - dev/process/pre-decision-analysis/README
  - dev/standards/pre-decision-analysis/README
  - dev/adr/0007-collaborative-skill-promotion
adr_status: Proposed
adr_number: "0010"
decision_date: null
supersedes: null
superseded_by: null
---

# ADR-0010：pre-decision-analysis 采用 agent-first 协作形态

- **状态**：Proposed
- **日期**：2026-04-26
- **决策者**：senticx@foxmail.com
- **相关 ADR**：[ADR-0007](0007-collaborative-skill-promotion.md)（协作性 skill 入库规范）

## 状态变更日志

- 2026-04-26：Proposed

## Context

多代理 harness 协作场景里，agent 与人类对"决策前结构化分析"的协作可以选不同形态：

- **传统形态**：agent 摊方案 → 人类 review 抽象方案 → approve → 落地
- **agent-first**：agent 直接落地 / 开 PR，人类在 PR diff 上做后审
- **混合**：scratch 协作 + diff 协作按问题复杂度切换

哪个形态最匹配本项目实际成本结构？三个事实决定了答案：

1. **版本管理很方便**——git 回滚接近零成本，错的方案 reset / close PR 即可
2. **agent 执行很廉价**——token 与时间相对人类带宽是数量级低
3. **人类 reviewer 的 review 很昂贵**——注意力与认知是稀缺资源

如果三条任一不成立，agent-first 形态会破产；目前三条都成立。本 ADR 把这个判断显式记下来，避免未来在没意识到前提变化时延续相同形态。

## Options

### Option A：传统形态（先摊方案再落地）

- **是什么**：默认起 scratch / 推选项给用户，等人类 approval 再动手
- **优点**：错的方案在落地前就被拦截，不浪费 agent 时间
- **缺点**：review 抽象方案极度耗费人类带宽——读文字 trade-off 比看 diff 选择难得多
- **主要风险**：人类 reviewer 是稀缺资源，把 review 压在抽象层会迅速饱和

### Option B：agent-first

- **是什么**：agent 有把握就直接开分支落地、开 PR；错了 git reset / close PR
- **优点**：只在真分叉占用人类带宽；自验问题不进 review；review 在 diff 上做"选择"而不是"批改"
- **缺点**：agent 误判方向时浪费 agent 时间（但 token 便宜）；要求 agent 有"自我把握"判断力
- **主要风险**：agent 把握不准会重复返工——靠 argue 自检（pre-flight self-check）+ PR diff 后审兜底

### Option C：混合（按问题复杂度切换）

- **是什么**：简单问题 agent-first；复杂问题默认 scratch 协作
- **优点**：表面灵活
- **缺点**：切换判据本身就是负担；scratch 默认起会演变回 Option A
- **主要风险**：实践中往往退化成"凡是不确定就 scratch"，等于 Option A

## Decision

选 **Option B（agent-first）**。

形态推论（落地为 standards 的合格条件）：

1. **Agent 多做、人少看**——agent 执行成本被允许产生
2. **Review = 选择，不批改**——用户在 PR diff 上点 merge / close / inline comment，不在 scratch 里打字批改抽象 trade-off
3. **真分叉才问**——判据是"agent 有没有把握"，不是"回滚成本"
4. **能自验的问题不进 review**——有 test / lint / typecheck / 脚本能自证的，agent 自验过就不问
5. **多方案并行 > 抽象选择**——能并行做就并行起 2-3 个分支做完整产物，让用户 diff 选
6. **Argue 作 pre-flight self-check**——有推荐 / 倾向的决策必派异构模型反方分析，要点 + agent 回应贴 PR body
7. **Scratch 默认不起**——仅在跨会话 / 复杂归档时起

具体触发判据、产物合格条件、子流程编排住 process / standards：

- 流程编排（主轴、Checkpoint、Scratch 硬触发条件）→ [`docs/dev/process/pre-decision-analysis/README.md`](../process/pre-decision-analysis/README.md)
- 产物形态、反模式、触发判据合格条件 → [`docs/dev/standards/pre-decision-analysis/README.md`](../standards/pre-decision-analysis/README.md)
- per-harness 执行器 → `skills/pre-decision-analysis/` 下各 harness 子目录

## Consequences

### 正向

- review 带宽集中在真分叉，不被抽象方案占满
- agent 执行成本被允许产生（token 便宜，错了 git reset）
- 决策痕迹可追溯（PR diff + argue 留痕在 PR body 的"异议 & 回应"小节）
- 与 ADR-0007 一致：协作性 skill 入库后，本 ADR 给 pre-decision-analysis 这个具体协作约定提供形态决策依据

### 负向

- 错误方向需要 agent 重新落地（git reset 后重做）
- 要求 agent 有"自我把握"判断力——argue 子流程兜底；判断不准会反复返工
- 简单问题也走 PR 流程，对超小改动比直接打补丁慢

### 需要后续跟进

- 三条前提其中任一明显不再成立时（例如 git 回滚成本变高、人类 review 成本下降到忽略级）需要复审本决策
- argue 子流程的实际兜底效果若达不到预期（agent 反复返工），考虑引入更轻量的 mid-flight checkpoint

## Out of scope

- 不决定 scratch 文件的 slot 格式（属 [`docs/dev/standards/pre-decision-analysis/scratch-template.md`](../standards/pre-decision-analysis/scratch-template.md)）
- 不决定具体 subagent 调度方式（per harness，住 `skills/pre-decision-analysis/harnesses/<harness>/SKILL.md`）
- 不决定何时触发 / 不该触发（属 standards 触发判据）
- 不决定其他协作约定的形态（其他协作性 skill 若要采用不同形态，需自行起 ADR）
