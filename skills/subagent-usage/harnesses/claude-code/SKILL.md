---
name: subagent-usage
description: 当用户明确要求派发多个、若干或并行 subagent，或任务涉及跨文件探索、长日志/长输出分析、独立可验证子任务、独立 review / 第二意见、批量同质操作或研究类问题时触发。本文件是 subagent-usage 在 Claude Code 下的薄执行器，仅提供 Agent 能力映射。
---

# subagent-usage（Claude Code 执行器）

> 通用入口见 [`../../SKILL.md`](../../SKILL.md)。先按通用入口加载 owner 文档，本文件只补充 Claude Code 的具体能力映射。

## Claude Code 能力映射

- 仓库探索：通过 `Agent` 派发 `Explore`
- 通用实现或独立上下文分析：通过 `Agent` 派发 `general-purpose`
- 方案设计：通过 `Agent` 派发 `Plan`
- 独立 review / 第二意见：使用 `codex-review` skill、`codex:codex-rescue` 或 `superpowers:code-reviewer`
- 简化改进：使用 `code-simplifier`
- 相互独立的任务：在同一轮并行发出多个 `Agent` 调用

派发 prompt、任务拆分、回报格式与主 session 收敛要求均直接遵循通用入口链接的 owner 文档，不在本执行器重复定义。
