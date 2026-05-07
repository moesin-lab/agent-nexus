---
title: ADR 产物写法标准
type: standards
status: active
summary: ADR 这个产物的编号规则、产物合格条件 DoD、书写要点、引用规则、Superseded 形态变更约束、评审约束、反模式
tags: [adr, standards]
related:
  - dev/adr/README
  - dev/adr/template
  - dev/standards/doc-ownership
  - dev/process/code-review
---

# ADR 产物写法标准

本文件是 ADR 这个产物的**价值标准**：ADR 文件应包含什么、不应包含什么、什么算合格、被取代时怎么变形。**ADR 触发条件**（什么改动需要新增 ADR）见 [`when-to-add-doc.md`](when-to-add-doc.md)；ADR 状态机与索引见 [`../adr/README.md`](../adr/README.md)。

## 编号规则

- 四位数字，从 `0001` 开始
- 编号连续，不跳号，不复用
- 被废弃的 ADR **保留编号与文件**，只追加状态变更，不删除内容
- 文件名：`<编号>-<kebab-case-标题>.md`（例 `0001-im-platform-discord.md`）

## 产物合格条件（DoD）

ADR 合格的判据：

- frontmatter 字段齐（`adr_status` / `adr_number` / `decision_date` / `supersedes` / `superseded_by`），按 [`../adr/template.md`](../adr/template.md)
- body 含 Context / Options / Decision / Consequences / Out of scope 五段，按 [`../adr/template.md`](../adr/template.md) 结构
- Options 段列出至少 2 个认真比较过的候选
- Decision 段一句话说选哪个；不模糊措辞
- 状态至少推到 `Proposed`（合入 main 后即视为入库可执行）；合入前已通过 codex review 并逐条回应

## 书写要点

- 用中文，标题与 filename 尽量信息密度高
- Context 段回答：我们为什么现在要决定这件事？
- Options 段列出至少 2 个认真比较过的候选
- Decision 段一句话说选哪个
- Consequences 段同时列**正向**与**负向**后果
- Out of scope 段说明**这个 ADR 不决定什么**，避免 scope 蔓延

详见 [`../adr/template.md`](../adr/template.md)。

## 评审约束

ADR PR 评审走标准 code review，见 [`../process/code-review.md`](../process/code-review.md)；以下两条作为 ADR 这个产物特有的合格条件：

- **禁止**：未经 review 直接合并任何 ADR PR
- **禁止**：在未经 review 的情况下把 `Proposed` 改 `Accepted`

## 引用规则

- 其他文档引用 ADR 用编号：`ADR 0001` 或直接链接
- ADR 之间互相引用也用编号
- 代码注释里引用用 `# see ADR-0001`

## Superseded 形态变更

一条 ADR 被取代时，必须**同一个 commit 内**完成下列形态变更（"何时启动"由 [`../adr/README.md` §状态机](../adr/README.md#状态机) 涵盖，不在本节）：

1. `git mv docs/dev/adr/NNNN-*.md docs/dev/adr/deprecated/NNNN-*.md`
2. 被取代 ADR 的 frontmatter：`adr_status: Superseded`、`superseded_by: "MMMM"`；`status` 字段保持 `active`（归档路径下 `status` 冗余无害，详见 [`metadata.md`](metadata.md)）
3. 取代 ADR 的 frontmatter：`supersedes: "NNNN"`，`related:` 字段路径指向 `dev/adr/deprecated/NNNN-...`
4. `../adr/README.md` 索引表里被取代 ADR 的路径改为 `deprecated/NNNN-...`
5. 正文里对被取代 ADR 的相对链接按新深度调整（例：`deprecated/0005-*.md` 或从 deprecated 内部出去用 `../`）

这样 `docs/dev/adr/` 根目录下只会有**当前有效**的 ADR；`pretool-read-guard` 拦截对 `deprecated/**` 的直接 Read 防止已作废论述污染后续决策——整体作废文档归档与防污染规则见 [`../process/docs-read.md`](../process/docs-read.md)。

> **可选 UX 增强**：被取代 ADR 正文顶部可加 banner（例：`> **已被 [ADR-MMMM](../MMMM-...md) 取代，仅供审计追溯**`）帮助人类读者快速识别。不强制，不作工作流步骤——路径已承担防污染主责。

## 反模式

- 把 ADR 当长篇论文写；60–200 行为宜
- 在 ADR 里写实现细节（实现细节放 spec）
- 在 ADR 里写规则清单本体（规则本体放 process / spec / standards，ADR 只承载"为什么这样定规则"）
- 把还没做的决策写成 ADR（没决策就没 ADR）
- 删除任何已合入的 ADR 文件（被取代的 ADR 移到 `deprecated/` 保留）
