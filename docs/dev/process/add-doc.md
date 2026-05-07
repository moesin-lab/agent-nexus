---
title: 加文档流程
type: process
status: active
summary: 从代码改动开始，到判定文档类型、写入产物、走 review、合入的执行流程入口
tags: [docs, doc-process, process]
related:
  - dev/standards/when-to-add-doc
  - dev/standards/doc-ownership
  - dev/process/workflow
  - dev/process/code-review
---

# 加文档流程

每次改动开始时按下列四步走，每步只做编排，规则本体在被 link 的 owner：

1. **判定要不要加文档、加哪类**：按 [`../standards/when-to-add-doc.md`](../standards/when-to-add-doc.md) 决定该写 spec / ADR / 普通 doc / 不写。
2. **按对应产物 standards 写**：
   - spec → 形态见 [`../standards/spec.md`](../standards/spec.md)，目录位置见 [`../spec/README.md`](../spec/README.md)
   - ADR → 形态见 [`../standards/adr.md`](../standards/adr.md)，模板见 [`../adr/template.md`](../adr/template.md)
   - 其他 owner → 文档形态语言见 [`../standards/docs-style.md`](../standards/docs-style.md)，落 owner 见 [`../standards/doc-ownership.md`](../standards/doc-ownership.md)
3. **走 PR review**：分支 / PR / codex review 走 [`workflow.md`](workflow.md) 主路径，review 合格条件见 [`code-review.md`](code-review.md) + [`../standards/code-review.md`](../standards/code-review.md)。ADR PR 特有的禁止条款（未经 review 直接合入 / 改 Accepted）见 [`../standards/adr.md` §评审约束](../standards/adr.md#评审约束)。
4. **合入**：squash merge 后进入下游引用 / 落地。仅 ADR：被取代的形态变更（git mv 到 deprecated/、frontmatter 字段、索引同步）见 [`../standards/adr.md` §Superseded 形态变更](../standards/adr.md#superseded-形态变更)；通用作废文档归档与防污染规则见 [`docs-read.md`](docs-read.md)。

## 跳过判定

第 1 步判为不加文档（按 [`../standards/when-to-add-doc.md` §何时可跳过](../standards/when-to-add-doc.md#何时可跳过)）时，第 2 步省去；分支 / PR / review / merge 不可跳过——见 [`workflow.md` §分支先行](workflow.md#分支先行不可跳过)。
