---
title: 文档事实归属
type: standards
status: active
summary: docs/dev 下各 owner 类型的事实容纳标准、跨 owner 冲突裁决与 reviewer 拒绝条件
tags: [docs, layering, ssot, standards]
related:
  - dev/adr/0008-doc-layering-ssot
  - dev/standards/docs-style
  - dev/adr/README
---

# 文档事实归属

本文件是**价值标准**：定义 `docs/dev/` 下各 owner 类型应该容纳什么事实、不应该容纳什么事实，以及当一段内容看起来落在两个 owner 之间时如何裁决。文档形态规则（篇幅、章节模板、frontmatter、代码块、链接）见 [`docs-style.md`](docs-style.md)。

> **决策依据**见 [ADR-0008](../adr/0008-doc-layering-ssot.md)：之所以采用"事实归属判定 + 跨 owner link 不复述"作为单一信息源（SSOT）的实现路径，而非引入 owns 字段、改源反查 hook、一致性测试等机械补丁，理由在 ADR 里论证。本文件只承载标准本体。

## Owner 矩阵

按**内容约束的对象**判定 owner，不按内容出现的场景判定。

| 目录 | owner 容纳的事实类型 | 禁入类型 |
|---|---|---|
| **ADR**（`docs/dev/adr/`） | 决策依据：**为什么**选 X 不选 Y | 契约定义、组合关系、验证证据模型、产物形态规范、流程编排、规则本体 |
| **spec**（`docs/dev/spec/`） | 契约事实：系统 / 模块对外承诺**是什么** | 决策论述、组合关系、验证证据模型、产物形态规范、流程编排 |
| **architecture**（`docs/dev/architecture/`） | 组合事实：模块、依赖、数据流**怎么组合** | 契约定义、决策论述、验证证据模型、产物形态规范、流程编排 |
| **testing**（`docs/dev/testing/`） | 验证证据模型：用什么测试、fixture、eval、CI 证据证明行为正确 | 契约定义、决策论述、组合关系、产物形态规范、流程编排 |
| **standards**（`docs/dev/standards/`） | 价值标准：好与不好、准入与禁入、产物形态、命名规范、规则本体 | 决策论述、流程编排（"何时检查 / 谁来检查 / 失败如何处理"） |
| **process**（`docs/dev/process/`） | 流程编排：人 / agent 在什么时候做什么、谁负责、按哪份 standards 检查、门禁如何触发、失败后如何处理 | 价值标准本体（如"做 / 不做对照"、禁入清单、owner 准入条件） |

`process/` 可以列 checklist，但 checklist 项只能写"按 standards/X.md 检查 Y"，不能复述 X 的标准本体。

## 判定流程

写一段内容前，按顺序问自己：

1. **它在解释为什么选 X 吗？**——落 ADR
2. **它在定义系统 / 模块承诺吗？**——落 spec
3. **它在说明模块如何组合吗？**——落 architecture
4. **它在定义验证证据模型吗？**——落 testing
5. **它在定义"什么算合格 / 不合格"吗？**——落 standards
6. **它在编排"什么时候做、谁来做、按哪份 standards 检查、失败如何处理"吗？**——落 process

**强制单选**：一段内容只能命中一个问题。同时像两层（例如"为什么 + 是什么"），把它**拆成两段**分别落到两层，互相 link，**不要在同一层里写两段**。

## 冲突裁决

| 冲突 | 裁决 |
|---|---|
| `process` vs `standards` | 价值标准本体归 `standards`；`process` 只写何时按该 standards 检查、谁检查、失败如何处理 |
| `process` vs `testing` | 测试活动的触发与门禁归 `process`；验证证据模型本身归 `testing` |
| `standards` vs `testing` | 测试资产专属价值标准归 `testing`（如 fixture 命名）；跨产物通用形态归 `standards` |
| `standards` vs `spec` | 系统对外承诺归 `spec`；产物形态与价值判据归 `standards` |
| `architecture` vs `spec` | 组合事实归 `architecture`；契约事实归 `spec` |
| `ADR` vs 任意目录 | 决策理由归 ADR；被决策后的事实 / 标准 / 编排归对应 owner |

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
- `process/` 文件出现"做 / 不做对照"、禁入清单、准入条件等价值标准本体 → 拒，要求拆到 standards
- `standards/` 文件出现"何时检查 / 谁负责 / 失败处理"等编排条款 → 拒，要求拆到 process
- 接口签名、字段表、默认值字面量出现在 ADR / architecture → 拒，要求拆到 spec
- 决策论述（"因为 ... 所以选 ..."）出现在 spec / architecture / standards → 拒，要求拆到 ADR
- 同一事实在两个文件中可独立成立 → 拒，保留 owner 定义，其他改 link

## 协作性 skill docs 子目录约定

按 [ADR-0007 Amendments](../adr/0007-collaborative-skill-promotion.md#amendments)（2026-04-26）：协作性 skill 的 docs **物理位置仍按 owner 矩阵**（`docs/dev/process/<skill>/` + `docs/dev/standards/<skill>/`），通过 symlink 在 `skills/<skill>/` 下聚合呈现，给 agent 触发链路 + 人类浏览看到完整 unit。

### 物理位置约定

- 协作性 skill 的流程编排住 `docs/dev/process/<skill>/`（子目录形态）
- 协作性 skill 的产物合格条件 / 反模式 / 触发判据 / 模板住 `docs/dev/standards/<skill>/`（子目录形态——单文件 `<skill>.md` 升格为 `<skill>/README.md` + 同目录其他主题文件如 `scratch-template.md`）
- 形态级决策（跨 skill 复用）住 `docs/dev/adr/NNNN-*.md`，不进 skill 目录

### symlink 聚合约定

- `skills/<name>/process` → `../../docs/dev/process/<name>/`
- `skills/<name>/standards` → `../../docs/dev/standards/<name>/`（如该 skill 有 standards 内容）
- symlink 用相对路径，git 跟踪 mode 120000
- SKILL.md 内 link 用 skill 内相对路径（`./process/README.md` / `./standards/scratch-template.md`），不直引 docs/dev 物理路径

### Reviewer 验收口径

- 协作性 skill 的 docs 内部仍按 owner 矩阵治理（process 子目录里只放流程编排，standards 子目录里只放产物合格条件）—— Reviewer 按 path 判 owner 与本文件 §Reviewer 判据 一致
- 跨 owner link 在 GitHub Web 视图下通过 symlink 路径解析可能 broken（已知缺陷）；agent 通过 SKILL.md 触发链路 + IDE follow symlink 不受影响
- 不允许"协作性 skill 例外"——skill 内容仍受所有 owner 矩阵规则（含禁入类型、单选判定、跨 owner 不复述）约束

## 既有违反处理

本文件不维护具体迁移清单；否则标准文档会反过来复述被治理的事实。初始问题诊断见 [ADR-0008](../adr/0008-doc-layering-ssot.md#context)，具体清理按后续 PR 逐项处理。

## 不属于本规则

- **代码与文档的 SSOT**——代码层通过语言机制（单一 export）和 import 约束实现，详见 [ADR-0008](../adr/0008-doc-layering-ssot.md) Consequences §"代码与设计维度"
- **机械工具**（lint、hook、一致性测试、owns frontmatter 字段）——本规则**不引入**这些机制；如果未来事实归属判定仍不足以挡住所有 drift，再单独开 ADR 引入工具，不在本文件演进
- **placeholder 文档**——只承载信息架构占位，不属于本判定范围
- **元层文档**——目录索引（`README.md`）、ADR / 模板（`template.md`）、归档说明（`deprecated/README.md`）、状态汇总等约束**文档体系自身**而非系统行为的脚手架文档，不受 owner 矩阵约束。它们的内容性质是"导航 / 模板 / 引用聚合"，不是事实定义；禁入清单不适用，但仍遵守"只 link 不复述"——元层文档不能复述被它索引的内容
