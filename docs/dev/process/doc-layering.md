---
title: 文档分层职责
type: process
status: active
summary: ADR / spec / architecture 三层职责互斥定义、判定流程与既有错位的迁移指引
tags: [docs, layering, ssot, process]
related:
  - dev/adr/0008-doc-layering-ssot
  - dev/adr/README
  - dev/process/workflow
---

# 文档分层职责

本文件定义 `docs/dev/` 下三层文档（ADR / spec / architecture）各自的**唯一职责**与**禁入清单**，以及任何一段内容应该落在哪一层的判定流程。

> **决策依据**见 [ADR-0008](../adr/0008-doc-layering-ssot.md)：之所以采用"层职责互斥"作为单一信息源（SSOT）的实现路径，而非引入 owns 字段、改源反查 hook、一致性测试等机械补丁，理由在 ADR 里论证。本文件只承载规则本体。

## 三层职责矩阵

每层只回答一个问题；每条事实只属于回答其类型问题的那一层。
各层文档内部应包含哪些章节，见 [`../standards/docs-style.md#结构约定`](../standards/docs-style.md#结构约定)。

| 层 | 唯一回答的问题 | 禁入清单 |
|---|---|---|
| **ADR**（`docs/dev/adr/`） | **为什么**选 X 不选 Y | 接口签名、数据结构定义、字段表、默认值字面量、操作流程、规则清单本体 |
| **spec**（`docs/dev/spec/`） | X **是什么** / X **长什么样** | 决策权衡论述（"因为 ... 所以选这个"）、模块拓扑图、跨模块组合关系 |
| **architecture**（`docs/dev/architecture/`） | X、Y、Z **怎么组合** | 接口签名、字段表、默认值字面量、决策权衡论述 |

**横切补充**：`docs/dev/process/`（流程）与 `docs/dev/standards/`（规范）独立于上述三层，承载"协作怎么做"和"代码风格 / 日志 / 错误处理规范"，本规则不约束它们之间的关系——但它们引用上述三层时同样遵守"link 不复述"。

## 判定流程

写一段内容前，按顺序问自己：

1. **它在回答"为什么这样选"吗？**——如果是，落 ADR；其他层只能 link 到这条 ADR
2. **它在回答"X 是什么 / 长什么样"吗？**——如果是，落 spec；其他层只能 link
3. **它在回答"X、Y、Z 怎么组合"吗？**——如果是，落 architecture；其他层只能 link
4. **三个都答不出来？**——这段不该写，或属于 process / standards

**强制单选**：一段内容只能命中一个问题。如果同时像两层（例如"为什么 + 是什么"），把它**拆成两段**分别落到两层，互相 link，**不要在同一层里写两段**。

## 引用规则

跨层引用统一遵守：**只 link，不复述**。

允许形式：
- `详见 [ADR-0006](../adr/0006-limits-layering-defense-first.md)`
- `本节涉及 [SessionKey](../spec/identity/session-key.md#sessionkey)，定义见链接`

禁止形式：
- 在非 owner 层用自然语言展开定义（"SessionKey 是 (platform, channelId, userId) 三元组"出现在 architecture 层）
- 在非 owner 层复述决策论点（"我们选分层防御优先，因为失控保护比配额更重要"出现在 spec 层）
- 在非 owner 层列默认值字面量（`maxTurnsPerSession=50` 出现在 ADR 层）

**例外**：标题、章节锚点、单词级术语提及（不构成定义）不算复述。判定标准——读者从这一句能不能独立得出该事实的完整内容；能 → 复述；不能 → 提及。

## Reviewer 判据

Reviewer 在 PR 里看到下列模式，应直接要求修正或拒绝：

- `interface X` / `type X = ...` / 字段表出现在 ADR 文件 → 拒，要求拆到 spec
- `因为 ... 所以选 ...` / 选项对比论述出现在 spec 或 architecture 文件 → 拒，要求拆到 ADR
- 接口签名、字段表、默认值字面量出现在 architecture 文件 → 拒，要求拆到 spec
- 同一份契约 / schema / 接口定义在两个文件出现 → 拒，保留 owner 层定义，其他改 link
- 同一段决策论述在两个文件出现 → 拒，保留 ADR 论述，其他改 link

## 既有违反的迁移决议

下表记录本规则确立时（2026-04-25）`docs/dev/` 下已存在的 SSOT 违反与迁移方向。**本表只指方向，不实施**——具体清理在后续 PR 逐项处理（一个违反一个 PR，符合"范围收敛"）。

| 违反 | 当前位置 | 迁移决议 |
|---|---|---|
| SessionKey 完整定义重复 | `architecture/session-model.md` L19-40（完整）+ `spec/platform-adapter.md` L77（片段）+ `spec/agent-runtime.md` L43/L58 | 抽到 `spec/identity/session-key.md`（新建，因为 SessionKey 是契约）；architecture/session-model.md 改为引用；spec 内的片段改 link |
| PlatformAdapter / AgentRuntime / Engine 接口签名 | `architecture/overview.md` L118-140（伪代码）+ `spec/platform-adapter.md` L37-55 + `spec/agent-runtime.md` L37-55 | spec 是 owner，保留；architecture/overview.md 删除签名，改 link |
| 限流默认阈值 | ADR-0006 L100 声明"不决定阈值"；`spec/infra/cost-and-limits.md` L41-57 已写死默认值 | spec 是 owner，保留；ADR-0006 L100 删去"不决定"措辞改为"默认值见 spec" |
| 横切能力清单 | `architecture/overview.md` L151-167（14 项表）；spec 子目录散落引用 | architecture/overview.md 是 owner（属于"怎么组合"的索引），保留；spec 子目录引用维持 |
| 限流"一等机制 vs 二等机制"论述 | ADR-0006 L72-85 + `spec/infra/cost-and-limits.md` L14-16 | ADR-0006 是 owner，保留；spec 删除论点，只留契约本身 |
| NormalizedEvent 字段表 | `spec/message-protocol.md` L26-74（完整）+ `spec/platform-adapter.md` L69-83（"详见..."但同时列了字段表） | message-protocol.md 是 owner，保留；platform-adapter.md 删除字段表，改 link |
| Session vs AgentSession 状态枚举 | `architecture/session-model.md` L71-115（Session 状态机）+ `spec/agent-runtime.md` L60（AgentSession.state 枚举无转换规则） | 命名混淆而非复述——后续 PR 改名消歧（例：AgentSession → AgentRunSession），状态机定义各居其位 |
| AgentEvent / usage 字段映射 | `spec/agent-runtime.md` 内部组织松散 | 内部章节重组，不跨文件 |

## 不属于本规则

- **process / standards 之间的关系**——`docs/dev/process/` 与 `docs/dev/standards/` 独立于三层文档体系
- **代码与文档的 SSOT**——代码层通过语言机制（单一 export）和 import 约束实现，详见 [ADR-0008](../adr/0008-doc-layering-ssot.md) Consequences §"代码与设计维度"
- **机械工具**（lint、hook、一致性测试、owns frontmatter 字段）——本规则**不引入**这些机制；如果未来层职责互斥实践证明不足以挡住所有 drift，再单独开 ADR 引入工具，不在本文件演进
- **placeholder 文档**——只承载信息架构占位，不属于本三层判定范围
