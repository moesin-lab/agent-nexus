---
name: ci-recovery
description: 当 agent-nexus PR 的 GitHub Actions 或 GitHub 展示的 required check 已失败、取消或报红，用户要求查看日志、定位根因或修复 CI 门禁时触发。Checks 仍 pending、只需整体 readiness 判断，或本地测试失败但没有 PR check 时不触发。
---

# ci-recovery（通用入口）

本 skill 只负责失败 PR check 的恢复入口与路由，不定义 CI 诊断、代码修复或 GitHub Actions 操作规则。

## 触发边界

- PR 的 GitHub Actions 或 required check 已明确失败、取消或报红，并需要调查或修复时触发。
- Checks 仍 pending 或只需判断 PR 是否 ready 时不触发，留在 `pr-readiness`。
- 没有对应 PR check 的本地测试失败不触发，按开发与 TDD 流程处理。
- GitHub 展示的外部 required check 也属于本入口；若当前能力无法读取外部系统日志，应明确报告证据缺口。

## 先读

- PR checks 异步感知与失败门禁：[`docs/dev/process/code-review.md`](../../docs/dev/process/code-review.md)
- 修复需要仓库改动时的开发主路径：[`docs/dev/process/workflow.md`](../../docs/dev/process/workflow.md)
- 行为修复的测试迭代：[`docs/dev/process/tdd.md`](../../docs/dev/process/tdd.md)

## 路由

- 获取 GitHub Actions checks 与日志、归纳失败根因时，使用当前 harness 可用的 `gh-fix-ci` 专项能力。
- 根因需要修改代码、测试、脚本、配置或文档时进入 `development-workflow`；涉及行为变化时同时进入 `tdd-workflow`。
- 修复与相关验证完成后返回 `pr-readiness` 复查整体门禁。
