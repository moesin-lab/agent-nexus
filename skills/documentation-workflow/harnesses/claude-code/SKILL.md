---
name: documentation-workflow
description: 当 agent-nexus 的改动需要判定是否新增或更新仓库文档，或用户要求起草、修改 ADR、spec、架构、流程、标准、测试或 docs/product 下的产品文档时触发。这是 documentation-workflow 的 Claude Code 薄入口；纯错别字、断链、仓库外公告文案或已确认不改变契约和可观察行为的内部实现不触发。
---

# documentation-workflow（Claude Code 入口）

本文件只接入仓库文档流程。通用触发和路由边界见 [`../../SKILL.md`](../../SKILL.md)。

## 先读与路由

依次读取：

1. [`docs/dev/standards/when-to-add-doc.md`](../../../../docs/dev/standards/when-to-add-doc.md)
2. [`docs/dev/process/add-doc.md`](../../../../docs/dev/process/add-doc.md)

根据判定结果，再读取：

- ADR：[`docs/dev/adr/README.md`](../../../../docs/dev/adr/README.md)、[`docs/dev/adr/template.md`](../../../../docs/dev/adr/template.md)、[`docs/dev/standards/adr.md`](../../../../docs/dev/standards/adr.md)
- spec：[`docs/dev/spec/README.md`](../../../../docs/dev/spec/README.md)、[`docs/dev/standards/spec.md`](../../../../docs/dev/standards/spec.md)
- 其他文档：[`docs/dev/standards/doc-ownership.md`](../../../../docs/dev/standards/doc-ownership.md)、[`docs/dev/standards/docs-style.md`](../../../../docs/dev/standards/docs-style.md)

需要澄清时进入 `requirement-clarification`；存在真方案分叉时进入 `pre-decision-analysis`；完成文档后回到开发主路径。
