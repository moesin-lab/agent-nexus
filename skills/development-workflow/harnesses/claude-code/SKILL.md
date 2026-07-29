---
name: development-workflow
description: 当用户要求在 agent-nexus 仓库实现功能、修复缺陷、修改代码或文档、调整配置或契约时触发。这是 development-workflow 在 Claude Code 下的薄入口，负责加载项目开发主路径并按节点进入需求澄清、文档判定、TDD、分支提交与 code review；不用于纯只读解释、状态查询或 code review。
---

# development-workflow（Claude Code 入口）

本文件不增加 Claude Code 专属流程，只把该 harness 接入仓库权威流程。通用触发边界见 [`../../SKILL.md`](../../SKILL.md)。

## 先读

先完整读取 [`docs/dev/process/workflow.md`](../../../../docs/dev/process/workflow.md)，再按当前节点读取：

- [`requirement-clarification.md`](../../../../docs/dev/process/requirement-clarification.md)
- [`when-to-add-doc.md`](../../../../docs/dev/standards/when-to-add-doc.md)
- [`tdd.md`](../../../../docs/dev/process/tdd.md)
- [`commit-and-branch.md`](../../../../docs/dev/process/commit-and-branch.md)
- [`code-review.md`](../../../../docs/dev/process/code-review.md)

只读当前节点需要的 owner；具体工具调用服从 Claude Code 当前可用能力和 owner 文档，不在本入口另建规则。

## 邻接 skill

- 澄清触发条件命中时进入 `requirement-clarification`。
- 真方案分叉进入 `pre-decision-analysis`。
- 纠正后的长期规则沉淀进入 `self-refinement`。

