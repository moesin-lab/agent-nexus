---
name: issue-intake
description: 当用户要求在 agent-nexus 仓库通过 Claude Code 起草、创建或更新 GitHub Issue，把 bug、观察、想法、设计讨论或 review 发现转成 issue，或把 can-defer 项加入长期跟踪时触发。仅讨论、诊断或实现但未要求落 issue，以及关闭、重开、删除等 issue 生命周期操作不触发。
---

# issue-intake（Claude Code 入口）

先完整读取通用入口 [`../../SKILL.md`](../../SKILL.md)，再按其中“先读”部分加载当前场景对应的仓库 owner。

需要执行具体 GitHub Issue 起草、review 或创建动作时，使用 Claude Code 当前可用的 `open-issue` 专项能力。专项能力只负责具体执行，不覆盖仓库 owner 定义的开发节点、澄清结论或 can-defer 判定。

不要在本文件复制 issue 模板、GitHub 命令或 review 流程。

