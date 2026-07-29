---
name: pr-readiness
description: 当本仓库改动准备创建或更新 PR、声明 ready、交付、合并，或需要检查 PR 描述、review 证据、反馈闭环与整体门禁时触发；即使用户只说“提 PR”“可以交了”“看看能不能合”也应触发。不负责实现阶段 TDD，也不替代针对具体 unresolved review comments 或明确 CI failure 的专用 skill。
---

# PR readiness

本 skill 是 PR 就绪流程的薄入口，不定义或复述项目规则。

## 触发边界

- 在准备创建或更新 PR、交付、声明 ready 或判断可合并性时触发。
- 实现与测试迭代阶段使用 `tdd-workflow`。
- 已明确要求处理具体 unresolved review comments 时，使用可用的 `check-pr-comments` 或 `gh-address-comments`。
- 已明确定位为 GitHub Actions / CI failure 时，使用可用的 `gh-fix-ci`；修复后仍回到本 skill 做整体 readiness 检查。

## 先读

读取以下 owner：

- Review 流程与触发时机：[`docs/dev/process/code-review.md`](../../docs/dev/process/code-review.md)
- Review 产物合格条件：[`docs/dev/standards/code-review.md`](../../docs/dev/standards/code-review.md)
- Review 反馈优先级：[`docs/dev/standards/review.md`](../../docs/dev/standards/review.md)
- 分支、提交与合并编排：[`docs/dev/process/commit-and-branch.md`](../../docs/dev/process/commit-and-branch.md)

规则冲突或细节不一致时，以对应 owner 文档为准。
