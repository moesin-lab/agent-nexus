---
name: issue-intake
description: 当用户要求在 agent-nexus 仓库起草、创建或更新 GitHub Issue，把 bug、观察、想法、设计讨论或 review 发现转成 issue，或把 can-defer 项加入长期跟踪时触发。仅讨论、诊断或实现但未要求落 issue，以及关闭、重开、删除等 issue 生命周期操作不触发。
---

# issue-intake（通用入口）

本 skill 只负责 issue 落盘入口与 owner 导航，不定义 issue 写作或 GitHub 操作规则。

## 触发边界

- 用户明确要求起草、创建或更新 issue，或把现有发现转成长期跟踪项时触发。
- `development-workflow` 进入开发主路径的开 issue 节点时触发。
- `pr-feedback` 判定反馈可以 defer 并需要 issue 追踪时触发。
- 仅做设计讨论、事实调查、缺陷诊断或直接实现且未进入开 issue 节点时不触发。
- 关闭、重开、删除、迁移或批量管理 issue 不属于本入口。

## 先读

按当前来源读取对应 owner：

- 开发主路径中的 issue 节点：[`docs/dev/process/workflow.md`](../../docs/dev/process/workflow.md)
- 需求命中澄清条件时的 issue 结论承载：[`docs/dev/process/requirement-clarification.md`](../../docs/dev/process/requirement-clarification.md)
- Review 反馈的 must-fix / can-defer 判定：[`docs/dev/standards/review.md`](../../docs/dev/standards/review.md)
- 大任务拆解后的长期跟踪：[`docs/dev/process/pre-decision-analysis/subflow-task-breakdown.md`](../../docs/dev/process/pre-decision-analysis/subflow-task-breakdown.md)

## 路由

- 需要具体起草、review 或创建 GitHub Issue 时，使用当前 harness 可用的 `open-issue` 专项能力；仓库 owner 与专项能力冲突时以仓库 owner 为准。
- 设计仍处于方案分析阶段时留在 `pre-decision-analysis`；只有明确决定落 issue 后才进入本入口。
- Issue 创建完成且继续实施时返回 `development-workflow`。

