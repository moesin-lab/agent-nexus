---
name: requirement-clarification
description: 当 agent-nexus 需求涉及多用户或公开面、授权访问控制、跨 package 契约、新增对外 API、修改既有 API 签名或 spec 字段、持久化、状态开关、配置 schema、改名或兼容性边界时，在 ADR、spec、测试或实现之前触发。这是 requirement-clarification 在 Claude Code 下的薄入口；用于补齐遗漏维度，不用于已明确方案之间的选型。
---

# requirement-clarification（Claude Code 入口）

本文件不增加 Claude Code 专属澄清规则，只把该 harness 接入仓库权威流程。通用触发边界见 [`../../SKILL.md`](../../SKILL.md)。

## 先读

完整读取 [`docs/dev/process/requirement-clarification.md`](../../../../docs/dev/process/requirement-clarification.md)，按 owner 文档要求完成澄清。具体提问工具服从 Claude Code 当前可用能力，本入口不复制问题清单或提问数量约束。

## 流程交接

- 澄清完成后返回 `development-workflow`。
- 维度明确后仍存在真方案分叉时进入 `pre-decision-analysis`。
- 澄清失败导致返工且需要长期沉淀时进入 `self-refinement`。
