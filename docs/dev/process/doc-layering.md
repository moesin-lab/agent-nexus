---
title: 文档分类判定
type: process
status: active
summary: docs/dev 下事实归属 owner、process 编排边界与跨目录冲突裁决
tags: [docs, layering, ssot, process]
related:
  - dev/adr/0008-doc-layering-ssot
  - dev/adr/README
  - dev/process/workflow
---

# 文档分类判定

本文件定义 `docs/dev/` 下事实归属 owner、`process/` 的编排边界、跨目录冲突裁决，以及任何一段内容应该落在哪一类文档的判定流程。

> **决策依据**见 [ADR-0008](../adr/0008-doc-layering-ssot.md)：之所以采用"职责判定 + link 不复述"作为单一信息源（SSOT）的实现路径，而非引入 owns 字段、改源反查 hook、一致性测试等机械补丁，理由在 ADR 里论证。本文件只承载规则本体。

## 判定轴

先按**内容约束的对象**判定 owner，不按内容出现的场景判定。文档形态规则见 [`../standards/docs-style.md`](../standards/docs-style.md)，不在本文件定义。

| 目录 | owner 的事实类型 | 禁入类型 |
|---|---|---|
| **ADR**（`docs/dev/adr/`） | 决策依据：**为什么**选 X 不选 Y | 契约定义、静态产物规范、执行流程、规则清单本体 |
| **spec**（`docs/dev/spec/`） | 契约事实：系统 / 模块对外承诺**是什么** | 决策论述、组合关系、执行流程、静态产物规范 |
| **architecture**（`docs/dev/architecture/`） | 组合事实：模块、依赖、数据流**怎么组合** | 契约定义、决策论述、协作流程、静态产物规范 |
| **testing**（`docs/dev/testing/`） | 验证证据模型：用什么测试、fixture、eval、CI 证据证明行为正确 | 契约定义、静态产物规范、协作流程 |
| **standards**（`docs/dev/standards/`） | 静态产物形态：代码、文档、日志、错误处理等产物应如何书写 | 协作流程、契约定义、测试策略 |
| **process**（`docs/dev/process/`） | 编排事实：人 / agent 在什么时候做什么、谁负责、门禁怎么触发、失败后怎么处理 | 被编排规则的本体 |

`process/` 可以列 checklist，但 checklist 项只能写"检查 X 是否符合 owner 文档"，不能复述 X 的规则本体。

## 判定流程

写一段内容前，按顺序问自己：

1. **它在解释为什么选 X 吗？**——落 ADR
2. **它在定义系统 / 模块承诺吗？**——落 spec
3. **它在说明模块如何组合吗？**——落 architecture
4. **它在定义验证证据模型吗？**——落 testing
5. **它在定义静态产物形态吗？**——落 standards
6. **它在编排什么时候做、谁来做、门禁何时触发、失败后如何处理吗？**——落 process

**强制单选**：一段内容只能命中一个问题。如果同时像两层（例如"为什么 + 是什么"），把它**拆成两段**分别落到两层，互相 link，**不要在同一层里写两段**。

## 冲突裁决

| 冲突 | 裁决 |
|---|---|
| `process` vs `standards` | 标准本体归 `standards`；`process` 只写何时检查、谁检查、失败后怎么处理 |
| `process` vs `testing` | 测试活动的触发与门禁归 `process`；验证证据模型归 `testing` |
| `standards` vs `testing` | 测试资产专属规则归 `testing`；跨产物通用写法归 `standards` |
| `standards` vs `spec` | 系统承诺归 `spec`；产物写法归 `standards` |
| `architecture` vs `spec` | 组合事实归 `architecture`；契约事实归 `spec` |
| `ADR` vs 任意目录 | 决策理由归 ADR；被决策后的规则本体归对应 owner |

## 引用规则

跨目录引用统一遵守：**只 link，不复述**。

允许形式：
- 指向 owner 文档或章节的链接
- 单词级术语提及，且读者不能仅凭该句还原完整事实

禁止形式：
- 在非 owner 文档展开定义、论点、结构或字面量
- 在非 owner 文档用改写后的自然语言复述同一事实

**例外**：标题、章节锚点、单词级术语提及（不构成定义）不算复述。判定标准：读者从这一句能不能独立得出该事实的完整内容；能 → 复述；不能 → 提及。

## Reviewer 判据

Reviewer 在 PR 里看到下列模式，应直接要求修正或拒绝：

- 非 owner 文档出现可独立还原的事实定义 → 拒，要求改成 owner 链接
- `process/` 文件展开被编排规则本体 → 拒，要求改成 owner 链接
- `standards/` 文件编排执行时序或门禁触发 → 拒，要求拆到 process
- 同一事实在两个文件中可独立成立 → 拒，保留 owner 定义，其他改 link

## 既有违反处理

本文件不维护具体迁移清单；否则规则文档会反过来复述被治理的事实。初始问题诊断见 [ADR-0008](../adr/0008-doc-layering-ssot.md#context)，具体清理按后续 PR 逐项处理。

## 不属于本规则

- **代码与文档的 SSOT**——代码层通过语言机制（单一 export）和 import 约束实现，详见 [ADR-0008](../adr/0008-doc-layering-ssot.md) Consequences §"代码与设计维度"
- **机械工具**（lint、hook、一致性测试、owns frontmatter 字段）——本规则**不引入**这些机制；如果未来事实归属判定仍不足以挡住所有 drift，再单独开 ADR 引入工具，不在本文件演进
- **placeholder 文档**——只承载信息架构占位，不属于本判定范围
