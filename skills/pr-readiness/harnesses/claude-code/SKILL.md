---
name: pr-readiness
description: 当本仓库改动准备在 Claude Code 中创建或更新 PR、声明 ready、交付、合并，或检查 PR 描述、review 证据、反馈闭环与整体门禁时触发；即使用户只说“提 PR”“可以交了”“看看能不能合”也应触发。不负责实现阶段 TDD，也不替代处理具体 unresolved comments 或明确 CI failure 的专用 skill。
---

# PR readiness（Claude Code 入口）

这是 Claude Code 的薄入口。先读取通用入口 [`../../SKILL.md`](../../SKILL.md)，再按其中“先读”部分加载对应 owner 文档。

具体 unresolved review comments 进入 `pr-feedback`；明确的 GitHub Actions / required check failure 进入 `ci-recovery`。专项处理完成后，仍按本入口链接的 owner 检查整体 PR readiness。

不要在本文件复制 PR、review、分支或合并规则；以通用入口链接的 owner 为准。
