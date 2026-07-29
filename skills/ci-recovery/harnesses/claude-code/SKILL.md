---
name: ci-recovery
description: 当 agent-nexus PR 的 GitHub Actions 或 GitHub 展示的 required check 已失败、取消或报红，用户要求在 Claude Code 中查看日志、定位根因或修复 CI 门禁时触发。Checks 仍 pending、只需整体 readiness 判断，或本地测试失败但没有 PR check 时不触发。
---

# ci-recovery（Claude Code 入口）

先完整读取通用入口 [`../../SKILL.md`](../../SKILL.md)，再按其中“先读”部分加载当前修复所需的仓库 owner。

需要读取 GitHub Actions checks、日志并归纳失败根因时，使用 Claude Code 当前可用的 `gh-fix-ci` 专项能力；GitHub 展示的外部 check 使用当前可用连接读取。具体检查工具、批准边界与修复步骤服从对应专项能力。

不要在本文件复制 CI 诊断或修复流程。修复完成后按通用入口返回 `pr-readiness`。
