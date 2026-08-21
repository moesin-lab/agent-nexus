---
name: pr-feedback
description: 当用户要求检查、分类、处理或回复 agent-nexus PR 的 review comments、unresolved threads、requested changes、inline comments 或 reviewer 反馈时触发。独立 code review、创建或更新 PR、整体 readiness 检查、明确的 CI failure，以及只汇总已 resolved 评论时不触发。
---

# pr-feedback（通用入口）

本 skill 只负责具体 PR review 反馈的入口与路由，不定义反馈优先级、实现流程或 GitHub 回复格式。

## 触发边界

- 用户要求读取、判断、修复或回复具体 PR review feedback 时触发。
- 仅要求独立 review、深度 review、创建 PR、检查整体可合并性或处理 CI failure 时不触发。
- 已 resolved 评论的状态汇总不触发；存在需重新判断的 outdated 或 unresolved 反馈时触发。

## 先读

- Review 流程与反馈闭环：[`docs/dev/process/code-review.md`](../../docs/dev/process/code-review.md)
- Review 产物与反馈响应条件：[`docs/dev/standards/code-review.md`](../../docs/dev/standards/code-review.md)
- 反馈优先级与 must-fix / can-defer：[`docs/dev/standards/review.md`](../../docs/dev/standards/review.md)

## 路由

- 获取 thread 状态、实施选定修改或回复评论时，使用当前 harness 可用的 `check-pr-comments` 或 `gh-address-comments` 专项能力。
- 反馈要求修改代码、测试、文档或契约时进入 `development-workflow`，行为变化同时进入 `tdd-workflow`。
- 反馈形成需要人类拍板的真方案分叉时进入 `pre-decision-analysis`。
- can-defer 反馈需要长期跟踪时进入 `issue-intake`。
- 反馈处理结束后返回 `pr-readiness` 做整体门禁检查。

