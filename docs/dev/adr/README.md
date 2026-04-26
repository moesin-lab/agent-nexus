---
title: ADR 索引
type: index
status: active
summary: ADR 编号规则、状态机、评审流程与当前索引
tags: [adr, decision, navigation]
related:
  - dev/adr/template
  - dev/process/workflow
---

# ADR（Architecture Decision Records）

本目录存放所有架构级决策的记录。每个决策一个文件，编号连续。

## 为什么要 ADR

架构决策若散落在 Issue 与 commit message 里，新人（或半年后的自己）读不懂"为什么是这样"。ADR 解决这个问题——**每个决策有固定位置、固定结构、固定状态机**。

## 编号规则

- 四位数字，从 `0001` 开始
- 编号连续，不跳号，不复用
- 被废弃的 ADR **保留编号与文件**，只追加状态变更，不删除内容
- 文件名：`<编号>-<kebab-case-标题>.md`（例 `0001-im-platform-discord.md`）

## 状态机

```
Proposed ──(评审通过)──> Accepted
   │                       │
   │                       ├──(被新决策取代)──> Superseded by XXXX
   │                       │
   │                       └──(问题已不存在)──> Deprecated
   │
   └──(评审拒绝)──> Rejected（罕见，一般会修 ADR 而非拒绝）
```

**状态变更只追加，不覆盖**：

- 原状态段保留
- 在文件顶部追加新状态头与变更日期、理由
- 方便未来审计"当时为什么这么决定"

**两类变更日志，分两节存：**

- §状态变更日志：只接受离散状态跳变（Proposed / Accepted / Deprecated / Superseded / Rejected）
- §Amendments：Accepted 之后对决策**内容 / 范围 / 命名**的非反转修订

两节都**只记意图，不记内容**——具体改了什么字段 / 路径 / 数量 / 命名活在 body 当前状态与 git diff 里，不在变更日志里复述。详见 [`template.md`](template.md)。

## 什么情况写 ADR

满足任一条件就需要 ADR：

- 引入 / 替换一个外部依赖的大类（IM 平台、agent 后端、数据库、框架）
- 改变模块依赖方向（见 [`../architecture/dependencies.md`](../architecture/dependencies.md)）
- 改变对外契约（`spec/` 下任意文件的接口签名或字段）
- 改变部署形态（单机 → 多机、桌面 → 服务端）
- 改变安全模型（权限边界、密钥存储、脱敏规则）
- 选定实现语言、运行时、核心库

## 何时可跳过 ADR

以下改动允许在主路径"判断是否需要 ADR"那一步直接跳过：

- 文档错别字、链接修复、术语统一
- 依赖的补丁版本升级（无 breaking change）
- 代码注释修改
- 本地开发脚本的小调整（不影响 CI）
- spec / standards / process 内部措辞调整（决策语义未变）

跳过 ADR ≠ 跳过流程——**分支、PR、review、squash merge 不可跳过**，见 [`../process/workflow.md` §分支先行](../process/workflow.md#分支先行不可跳过)。同 PR 是否还要写 spec / 测试，分别按 [`../spec/README.md` §何时可跳过 spec](../spec/README.md#何时可跳过-spec) 与 [`../testing/strategy.md` §何时可跳过测试](../testing/strategy.md#何时可跳过测试) 判定。

## 评审流程

1. 作者基于 [`template.md`](template.md) 写 ADR，状态设为 `Proposed`
2. PR 发起 review，至少跑一次 codex review
3. Review 反馈逐条响应
4. 讨论收敛后改状态为 `Accepted`（或 `Rejected`）
5. 合并

**禁止**：未经评审直接提交 `Accepted` 状态的 ADR。

## 书写要点

- 用中文，标题与 filename 尽量信息密度高
- Context 段回答：我们为什么现在要决定这件事？
- Options 段列出至少 2 个认真比较过的候选
- Decision 段一句话说选哪个
- Consequences 段同时列**正向**与**负向**后果
- Out of scope 段说明**这个 ADR 不决定什么**，避免 scope 蔓延

详见 [`template.md`](template.md)。

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

## 引用规则

- 其他文档引用 ADR 用编号：`ADR 0001` 或直接链接
- ADR 之间互相引用也用编号
- 代码注释里引用用 `# see ADR-0001`

## Superseded 工作流

一条 ADR 被取代时，必须**同一个 commit 内**完成：

1. `git mv docs/dev/adr/NNNN-*.md docs/dev/adr/deprecated/NNNN-*.md`
2. 被取代 ADR 的 frontmatter：`adr_status: Superseded`、`superseded_by: "MMMM"`；`status` 字段保持 `active`（归档路径下 `status` 冗余无害，详见 `docs/dev/standards/metadata.md`）
3. 取代 ADR 的 frontmatter：`supersedes: "NNNN"`，`related:` 字段路径指向 `dev/adr/deprecated/NNNN-...`
4. 本 README 索引表里被取代 ADR 的路径改为 `deprecated/NNNN-...`
5. 正文里对被取代 ADR 的相对链接按新深度调整（例：`deprecated/0005-*.md` 或从 deprecated 内部出去用 `../`）

这样 `docs/dev/adr/` 根目录下只会有**当前有效**的 ADR；pretool-read-guard 会拦截对 `deprecated/**` 的直接 `Read`，保护后续决策不被已作废的论述污染。

> **可选的 UX 增强**：被取代 ADR 正文顶部可加 banner（例：`> **已被 [ADR-MMMM](../MMMM-...md) 取代，仅供审计追溯**`）帮助人类读者快速识别。不强制，不作工作流步骤——路径已承担防污染主责。

## 职责边界

ADR 这一层只回答 **"为什么选 X 不选 Y"**。ADR 的禁入清单与跨目录冲突裁决统一住 [`../standards/doc-ownership.md`](../standards/doc-ownership.md)（ADR 行 + Reviewer 判据），本 README 不复述；ADR 文档内部结构见 [`../standards/docs-style.md#结构约定`](../standards/docs-style.md#结构约定)。

ADR 引用 spec / architecture / process / testing / standards 内容时**只 link，不复述**——读者跳到目标文件读细节。

## 不做的事

- 不把 ADR 当长篇论文写；60–200 行为宜
- 不在 ADR 里写实现细节（实现细节放 spec）
- 不在 ADR 里写规则清单本体（规则本体放 process / spec / standards，ADR 只承载"为什么这样定规则"）
- 不把还没做的决策写成 ADR（没决策就没 ADR）
- 不删除任何已合入的 ADR 文件（被取代的 ADR 移到 `deprecated/` 保留）
