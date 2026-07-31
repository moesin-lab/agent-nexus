---
name: documentation-workflow
description: 当 agent-nexus 的改动需要判定是否新增或更新仓库文档，或用户要求起草、修改 ADR、spec、架构、流程、标准、测试或 docs/product 下的产品文档时触发。负责从 when-to-add-doc 进入 add-doc，并按判定结果路由到 ADR、spec 或其他文档 owner；纯错别字、断链、仓库外公告文案或已确认不改变契约和可观察行为的内部实现不触发。
---

# documentation-workflow

本 skill 只负责文档判定与路由，不定义 ADR、spec 或普通文档的产物规则。

## 触发边界

- 开发主路径进入文档判定节点时触发，即使用户没有主动要求写文档。
- 用户明确要求新增或修改 ADR、spec、架构、流程、标准、测试或产品文档时触发。
- 尚未完成需求维度澄清时，先进入 `requirement-clarification`。
- 存在需要人类拍板的真方案分叉时，先进入 `pre-decision-analysis`，决定后再返回本 skill。
- 纯错别字、断链、注释或术语修复，以及 owner 已判定无需文档的内部实现改动，不触发。

## 先读与路由

依次读取：

1. 文档类型判定：[`docs/dev/standards/when-to-add-doc.md`](../../docs/dev/standards/when-to-add-doc.md)
2. 文档执行流程：[`docs/dev/process/add-doc.md`](../../docs/dev/process/add-doc.md)

只在判定命中后继续加载对应 owner：

- ADR：[`docs/dev/adr/README.md`](../../docs/dev/adr/README.md)、[`docs/dev/adr/template.md`](../../docs/dev/adr/template.md)、[`docs/dev/standards/adr.md`](../../docs/dev/standards/adr.md)
- spec：[`docs/dev/spec/README.md`](../../docs/dev/spec/README.md)、[`docs/dev/standards/spec.md`](../../docs/dev/standards/spec.md)
- 其他文档：[`docs/dev/standards/doc-ownership.md`](../../docs/dev/standards/doc-ownership.md)、[`docs/dev/standards/docs-style.md`](../../docs/dev/standards/docs-style.md)

文档完成后回到 `development-workflow` 的当前节点；进入实现时使用 `tdd-workflow`。
