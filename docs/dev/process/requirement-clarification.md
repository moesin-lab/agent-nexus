---
title: 需求澄清（requirement clarification）
type: process
status: active
summary: 接到需求后、起 ADR / spec 前的反问环节——主动 surface 用户原始框架之外的邻接维度
tags: [process, requirement-clarification, framing, design]
related:
  - root/AGENTS
  - dev/process/workflow
  - dev/process/pre-decision-analysis
  - dev/process/self-refinement
---

# 需求澄清（requirement clarification）

定义：从用户提出需求 → 起 ADR / spec / 写代码之前的反问环节。**目标是 surface 用户原始框架之外的邻接维度**——不是确认需求是什么，是确认**不在用户主动表述里、但实施了会立刻暴露**的设计盲区。

本节是 [`workflow.md`](workflow.md) 主路径里 step 1（开 issue）和 step 2（切分支）之间隐含但必须完成的步骤。在 step 1 issue 描述阶段就要把澄清结果写进 issue body 的 `## Scope` / `## Out of scope` / `## Acceptance`（前两段必填，`## Acceptance` 当存在可验证的"做完即合格"判据时填，否则可省）。

## 触发条件（必走澄清）

需求里命中下列任一条 → **必须**走澄清，不允许"看起来简单就跳过"：

1. **多用户 / 公开面**：feature 暴露给非作者本人的用户（IM bot 频道、HTTP endpoint、CLI 公网部署等）
2. **授权 / 访问控制**：含"谁能 X"、"权限"、"允许 / 拒绝"、"管理员"、"白名单"、"黑名单"等措辞
3. **跨模块 / 跨边界**：feature **新增**跨 package 接口、改动**已有**跨 package 契约、或新增对外 API（"两个 package 协作"在本 monorepo 几乎覆盖所有改动，不作触发条件——只有"接口 / 契约新增或改动"才必走澄清）
4. **数据持久化**：会写文件 / DB / 远端 KV 等持久状态
5. **状态切换 / 模式开关**：含 mode / state / on/off 等多档行为切换
6. **重构 / 改名**：动既有 spec 字段名、API 签名、配置 schema

可以跳过澄清的需求：纯文档错别字、纯局部 refactor 不动 API、纯日志措辞调整。

## 必反问的邻接维度清单

接到需求后，**先在心里**对照下列清单，把用户**没主动说**的维度逐一过一遍。命中即必须 surface 给用户拍板：

### 1. Control plane vs data plane

用户提的是控制（admin / 配置 / 切换）还是数据（用户实际触发 / 调用）？两层往往同时存在，但用户常只说一层。

- 例：用户说"加 `/admin-mode` slash command"——这是 control plane；data plane 是"非 admin 怎么用 bot"，独立维度
- 反问形式：「你说的 X 管理面已经清楚了——data plane 那边（普通用户 / 实际触发场景）你想怎么样？」

### 2. 触发机制 vs 身份门禁

什么条件下 trigger（机制）vs 谁有资格被响应（身份）。两者正交，常被合并讨论而埋下漏洞。

- 例：`replyMode='all'` 是触发机制（任何非 bot 消息都触发），但**没有身份层 allowlist**——频道里的所有人都能驱动 bot
- 反问形式：「`all` 模式开了，bot 在频道里就对所有人开放了——你需要 user 层的 allowlist 吗？」

### 3. fail-open vs fail-closed

新增配置字段 / 列表 / 开关时，**缺省 / 空值 / 未配的语义**是默认通过还是默认拒绝？

- 例：`allowedUserIds: []` 是"任何人都可以"还是"任何人都拒绝"？
- 强默认：**access control 类一律 fail-closed**——空列表 = 拒绝全部。fail-open 只在用户**显式**要求时使用
- 反问形式：「这个列表如果配空 / 缺省，行为应该是 X 还是 Y？我倾向 fail-closed，理由是 …」

### 4. 默认值 / 初始状态归属

新加字段的默认值由谁负责？是 owner 包硬编码，还是 CLI / 调用者注入？是否需要 required？

- 反问形式：「这个字段缺省值是 X，required 还是 optional + 默认 X？环境相关默认（如路径）你想由 CLI 算好传进来还是 owner 包自己拍？」

### 5. 持久化与状态可见性

涉及持久化时：状态在哪、谁能改、谁能看、过期 / 损坏怎么办？

- 反问形式：「这个状态写在 X，损坏 / 缺失时是回退默认还是启动失败？谁能改？」

### 6. 兼容性边界

涉及现有 API / spec / 配置改动时：现存调用方 / 用户配置是否会断？需要 migration 吗？

- 反问形式：「这个改动会让现存的 X 不再工作——你想加 migration / deprecate 期，还是直接断（你是唯一用户，断了你自己改）？」

### 7. 攻击面与误用

公开面 feature 时：恶意用户能怎么滥用？误配（typo / 漏字段）的人会看到什么？

- 反问形式：「最常见的 misconfig 是 X，那时用户体验是 Y——你接受 Y 吗？」
- 反例（**本规则的来源**）：discord `/reply-mode` 早期设计 unauthorized 走"不 ack"路径，导致漏配 `ownerUserIds` 的合法 owner 看到"应用程序未响应"，无从定位。澄清环节本应反问"误配场景下用户看到什么"——见 PR #51

## 澄清的形式

**不要做的反模式**：

- 在心里 evaluate 维度后**直接做实施假设**而不告知用户（被自己 simulate 的"用户大概想要"骗）
- 反问列得太多（>4 条）让用户烦
- 反问太抽象（"你考虑过 control plane 吗"）让用户答不上来

**该做的形式**：

- 用具体场景表述维度（"`all` 模式开了 bot 在频道公开"），不用术语堆砌
- 一次最多 surface 2-3 条最关键的，其余作为隐含约束在实施时再核
- 给**推荐方向 + 理由**，让用户做"是否同意"判断而不是从零选
- 凡是"我倾向 X，因为 Y"——必须把 Y 写出来

**集成到 issue / PR**：

- step 1 开 issue 时，把澄清结果写进 issue body 的 `## Scope` / `## Out of scope` / `## Acceptance` 三段
- 反问的过程不必落库（在 PR 讨论 / chat 历史里），但**结论**必须落到 issue / spec / ADR 任一层

## 与其他流程的关系

| 流程 | 与本节关系 |
|---|---|
| [`workflow.md`](workflow.md) | 本节是 step 1 → step 2 之间的隐含步骤；workflow 主路径不再单独画框，但缺则违反 |
| [`pre-decision-analysis/README.md`](pre-decision-analysis/README.md) | 决策分析是**多方案对比已经清楚后**做选择；澄清是更早一层，**先把维度看全**才轮到对比 |
| [`self-refinement/README.md`](self-refinement/README.md) | 澄清失败导致返工是 self-refinement 的典型触发场景——返工后回头看哪条邻接维度漏了，沉淀进本节清单 |
| [`tdd.md`](tdd.md) | 澄清后才能写出**穷尽边界**的 failing test；澄清漏了，test 也漏 |

## 反例案例库

记录因澄清不到位导致返工的真实案例。新增案例时附最简一句话：原始需求 / 漏的维度 / 实施后暴露的症状。

- **discord `replyMode='all'` 公开面失守**：用户提"非 mention 模式 = bot 回每条消息" → 实施时只考虑触发机制（mention vs all）和管理面（`ownerUserIds` 切 mode）→ 漏了 data plane 身份门禁 → 上线后发现 `all` 档下任意 channel user 都能驱动 bot，需要二次返工加 `allowedUserIds`。漏的维度：**§1 control plane vs data plane** + **§2 触发机制 vs 身份门禁**。
