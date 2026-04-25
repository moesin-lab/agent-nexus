---
title: 文档分类判定
type: process
status: active
summary: docs/dev 下事实归属 owner、process 编排边界、跨目录冲突裁决与既有错位迁移指引
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

先按**内容约束的对象**判定 owner，不按内容出现的场景判定。文档内部章节结构、标题、篇幅、frontmatter 见 [`../standards/docs-style.md#结构约定`](../standards/docs-style.md#结构约定)，不在本文件定义。

| 目录 | owner 的事实类型 | 禁入清单 |
|---|---|---|
| **ADR**（`docs/dev/adr/`） | 决策依据：**为什么**选 X 不选 Y | 接口签名、数据结构定义、字段表、默认值字面量、操作流程、规则清单本体 |
| **spec**（`docs/dev/spec/`） | 契约事实：系统 / 模块对外承诺**是什么** | 决策权衡论述（"因为 ... 所以选这个"）、模块拓扑图、跨模块组合关系、执行流程 |
| **architecture**（`docs/dev/architecture/`） | 组合事实：模块、依赖、数据流**怎么组合** | 接口签名、字段表、默认值字面量、决策权衡论述、PR / 测试 / 写作流程 |
| **testing**（`docs/dev/testing/`） | 验证证据模型：用什么测试、fixture、eval、CI 证据证明行为正确 | 系统接口契约、代码 / 文档写法规范、PR 执行顺序 |
| **standards**（`docs/dev/standards/`） | 静态产物形态：代码、文档、日志、错误处理等产物应如何书写 | 执行顺序、门禁编排、系统接口契约、测试层级策略 |
| **process**（`docs/dev/process/`） | 编排事实：人 / agent 在什么时候做什么、谁负责、门禁怎么触发、失败后怎么处理 | 被编排规则的本体：字段表、格式规范、测试分层、代码写法、文档结构 |

`process/` 可以列 checklist，但 checklist 项只能写"检查 X 是否符合 owner 文档"，不能复述 X 的规则本体。

## 判定流程

写一段内容前，按顺序问自己：

1. **它在解释为什么选 X 吗？**——落 ADR
2. **它在定义系统 / 模块承诺的接口、字段、状态、错误码、默认值吗？**——落 spec
3. **它在说明模块、依赖、数据流、状态机如何组合吗？**——落 architecture
4. **它在定义验证证据模型、测试层级、fixture、eval、CI 证据吗？**——落 testing
5. **它在定义静态产物的写法、格式、命名、文风、日志 / 错误处理写法吗？**——落 standards
6. **它在编排什么时候做、谁来做、门禁何时触发、失败后如何处理吗？**——落 process

**强制单选**：一段内容只能命中一个问题。如果同时像两层（例如"为什么 + 是什么"），把它**拆成两段**分别落到两层，互相 link，**不要在同一层里写两段**。

## 冲突裁决

| 冲突 | 裁决 |
|---|---|
| `process` vs `standards` | 标准本体归 `standards`；`process` 只写何时检查、谁检查、失败后怎么处理 |
| `process` vs `testing` | 测试先后顺序、门禁触发归 `process`；测试层级、mock 边界、fixture / eval 归 `testing` |
| `standards` vs `testing` | 只服务测试资产的格式、命名、fixture 规则归 `testing`；跨产物通用写法归 `standards` |
| `standards` vs `spec` | 字段契约、错误码、事件类型归 `spec`；代码中如何记录、传播、呈现归 `standards` |
| `architecture` vs `spec` | 依赖关系、数据流归 `architecture`；接口签名、字段表、默认值归 `spec` |
| `ADR` vs 任意目录 | 决策理由归 ADR；被决策后的规则本体归对应 owner |

## 引用规则

跨目录引用统一遵守：**只 link，不复述**。

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
- `process/` 文件展开 frontmatter、标题层级、代码写法、测试分层等规则本体 → 拒，要求改成 link 到 owner 文档
- `standards/` 文件编排 PR 流程、执行顺序、门禁触发 → 拒，要求拆到 process
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

- **代码与文档的 SSOT**——代码层通过语言机制（单一 export）和 import 约束实现，详见 [ADR-0008](../adr/0008-doc-layering-ssot.md) Consequences §"代码与设计维度"
- **机械工具**（lint、hook、一致性测试、owns frontmatter 字段）——本规则**不引入**这些机制；如果未来事实归属判定仍不足以挡住所有 drift，再单独开 ADR 引入工具，不在本文件演进
- **placeholder 文档**——只承载信息架构占位，不属于本判定范围
