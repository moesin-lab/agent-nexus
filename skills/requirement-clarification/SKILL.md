---
name: requirement-clarification
description: 当 agent-nexus 需求涉及多用户或公开面、授权访问控制、跨 package 契约、新增对外 API、修改既有 API 签名或 spec 字段、持久化、状态开关、配置 schema、改名或兼容性边界时，在 ADR、spec、测试或实现之前触发；用于发现用户原始表述之外的设计维度，不用于已明确方案之间的选型。
---

# requirement-clarification（通用入口）

本 skill 只是需求澄清入口，不定义或复述澄清规则。规则冲突时以 owner 文档为准。

## 触发边界

- 命中 frontmatter 所列风险面时，在 ADR、spec、测试和实现之前触发。
- 纯文档错别字、纯局部且不改变 API 的重构、纯日志措辞调整不触发。
- 目标是 surface 用户未主动提出但实施后会暴露的邻接维度，不是重新确认用户已经说清的内容。
- 若维度已经明确，只剩多个可行方案需要人类选择，则停止本流程并转交 `pre-decision-analysis`。

## 先读

完整读取 [`docs/dev/process/requirement-clarification.md`](../../docs/dev/process/requirement-clarification.md)，以其中当前的触发条件、邻接维度和产物去向为准。

澄清完成后返回 `development-workflow`，继续文档判定、TDD 与后续实现节点。

## 邻接 skill 边界

- `development-workflow`：承载从需求到合并的主路径，本 skill 只负责其中实施前的澄清节点。
- `pre-decision-analysis`：承载维度明确后的结构化方案比较与人类拍板。
- `self-refinement`：承载澄清遗漏导致返工后的长期经验沉淀。
