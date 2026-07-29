---
name: pr-feedback
description: 当用户要求在 Claude Code 中检查、分类、处理或回复 agent-nexus PR 的 review comments、unresolved threads、requested changes、inline comments 或 reviewer 反馈时触发。独立 code review、创建或更新 PR、整体 readiness 检查、明确的 CI failure，以及只汇总已 resolved 评论时不触发。
---

# pr-feedback（Claude Code 入口）

先完整读取通用入口 [`../../SKILL.md`](../../SKILL.md)，再按其中“先读”部分加载 review owner。

需要读取 thread 状态、实施选定修改或回复评论时，使用 Claude Code 当前可用的 `check-pr-comments` 或 `gh-address-comments` 专项能力；具体工具、评论锚点和写入授权服从所选专项能力。

不要在本文件复制 review 优先级、反馈响应条件或 GitHub 回复格式。处理结束后按通用入口返回 `pr-readiness`。

