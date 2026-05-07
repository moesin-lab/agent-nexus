---
title: ADR 索引
type: index
status: active
summary: ADR 状态机与当前索引；产物写法标准在 standards/adr.md，触发条件在 standards/when-to-add-doc.md
tags: [adr, decision, navigation]
related:
  - dev/adr/template
  - dev/standards/adr
  - dev/standards/doc-ownership
  - dev/process/workflow
---

# ADR（Architecture Decision Records）

本目录存放所有架构级决策的记录。每个决策一个文件，编号连续。

ADR 触发条件（什么改动需要 ADR / 何时可跳过）见 [`../standards/when-to-add-doc.md`](../standards/when-to-add-doc.md)；ADR 产物写法标准（编号规则 / DoD / 书写要点 / 引用规则 / Superseded 形态变更 / 评审约束 / 反模式）见 [`../standards/adr.md`](../standards/adr.md)；评审走标准 code review，见 [`../process/code-review.md`](../process/code-review.md)。

## 为什么要 ADR

架构决策若散落在 Issue 与 commit message 里，新人（或半年后的自己）读不懂"为什么是这样"。ADR 解决这个问题——**每个决策有固定位置、固定结构、固定状态机**。

## 状态机

```
Proposed ──(显式签字盖章)──> Accepted
   │                          │
   │                          ├──(被新决策取代)──> Superseded by XXXX
   │                          │
   │                          └──(问题已不存在)──> Deprecated
   │
   └──(评审拒绝)──> Rejected（罕见，一般会修 ADR 而非拒绝）
```

**状态语义**：

- **Proposed = 入库可执行**——ADR PR 经 review 合入 main 后即视为项目已采纳的事实依据，下游 spec / standards / process 可以引用并按此 ADR 落地。本项目实际约定如此（ADR-0007 / 0008 / 0009 均以 Proposed 状态合入并被引用）。
- **Accepted = 显式签字盖章**——标志该决策经过更正式的人工复盘 / 跨项目周期审视。仅在需要为某条 ADR 提供"额外稳定性背书"时手工推进；不是合入 main 的默认产物。
- **Superseded / Deprecated**——状态语义见此处；对应的形态变更（路径迁移 / frontmatter 字段 / 索引同步）见 [`../standards/adr.md` §Superseded 形态变更](../standards/adr.md#superseded-形态变更)。

如果未来要把 Proposed → Accepted 升级为合入流程的强制环节，需要单独发 ADR 修订本节。

**状态变更只追加，不覆盖**：

- 原状态段保留
- 在文件顶部追加新状态头与变更日期、理由
- 方便未来审计"当时为什么这么决定"

**两类变更日志，分两节存：**

- §状态变更日志：只接受离散状态跳变（Proposed / Accepted / Deprecated / Superseded / Rejected）
- §Amendments：Accepted 之后对决策**内容 / 范围 / 命名**的非反转修订

两节都**只记意图，不记内容**——具体改了什么字段 / 路径 / 数量 / 命名活在 body 当前状态与 git diff 里，不在变更日志里复述。详见 [`template.md`](template.md)。

## 当前索引

| 编号 | 标题 | 状态 |
|---|---|---|
| [0001](0001-im-platform-discord.md) | MVP IM 平台选型：Discord | Accepted |
| [0002](0002-agent-backend-claude-code-cli.md) | Agent 后端选型：Claude Code CLI | Accepted |
| [0003](0003-deployment-local-desktop.md) | 部署形态：本机桌面 | Accepted |
| [0004](0004-language-runtime.md) | 实现语言与运行时选型 | Proposed |
| [0005](deprecated/0005-subscription-as-first-class-path.md) | 订阅计费为一等用户路径 | Superseded by 0006 |
| [0006](0006-limits-layering-defense-first.md) | Limits 分层——失控保护为一等，配额控制按用户路径可选 | Accepted |
| [0007](0007-collaborative-skill-promotion.md) | 协作性 skill 入库与挂接 | Proposed |
| [0008](0008-doc-layering-ssot.md) | 文档事实归属判定实现 SSOT | Proposed |
| [0009](0009-tdd-mandatory.md) | 强制 TDD（先 spec → 先 failing test → 再 impl） | Proposed |
| [0010](0010-pre-decision-agent-first.md) | 决策前结构化分析（pre-decision agent-first） | Proposed |
| [0011](0011-turn-layering.md) | turn 层级——daemon 视角外显两层，agent 内部留给 backend | Proposed |
| [0012](0012-claudecode-stream-json-mainline.md) | claudecode 切到 stream-json 主路径——协议合约 / interrupt / timeout | Proposed |

## 职责边界

ADR 这一层只回答 **"为什么选 X 不选 Y"**。ADR 的禁入清单与跨目录冲突裁决统一住 [`../standards/doc-ownership.md`](../standards/doc-ownership.md)（ADR 行 + Reviewer 判据），本 README 不复述；ADR 文档内部结构见 [`../standards/docs-style.md#结构约定`](../standards/docs-style.md#结构约定)。

ADR 引用 spec / architecture / process / testing / standards 内容时**只 link，不复述**——读者跳到目标文件读细节。
