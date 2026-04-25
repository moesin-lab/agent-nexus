---
title: ADR-0008 文档事实归属判定实现 SSOT
type: adr
status: active
summary: 选择"事实归属判定 + process 编排边界"作为单一信息源（SSOT）的实现路径，拒绝引入 owns 字段、改源反查 hook、一致性测试等机械补丁
tags: [adr, decision, docs, ssot, layering]
related:
  - dev/process/doc-layering
  - dev/adr/README
  - dev/adr/0006-limits-layering-defense-first
adr_status: Proposed
adr_number: "0008"
decision_date: null
supersedes: null
superseded_by: null
---

# ADR-0008：文档事实归属判定实现 SSOT

- **状态**：Proposed
- **日期**：2026-04-25
- **决策者**：mouxinc@gmail.com
- **相关 ADR**：无

## 状态变更日志

- 2026-04-25：Proposed

## Context

近期连续多个 commit（02fb019 / 36bcc3f / 4b7e115 / e6ba862 / 374389e）都在做同一类工作：一次 rename（`core` → `daemon`）和包结构重构后，必须**反复人肉 grep** 收尾散落在 `docs/dev/spec/` / `docs/dev/architecture/` / `docs/dev/adr/` / `AGENTS.md` 多处的术语残留。这不是个例——任何 rename / 接口演进 / 默认值调整都会触发同样的"修一处、漏多处、再修"循环。

诊断 `docs/dev/` 下的具体违反，发现 8 处事实重复表述，其中 3 处已在漂移：

1. **SessionKey** 同时在 `architecture/session-model.md`、`spec/platform-adapter.md`、`spec/agent-runtime.md` 三处出现完整或片段定义
2. **PlatformAdapter / AgentRuntime 接口签名**同时在 `architecture/overview.md`（伪代码）和对应的 `spec/*.md`（权威）出现
3. **限流默认阈值**：ADR-0006 声明"不决定阈值"，但 `spec/infra/cost-and-limits.md` 已写死 `maxTurnsPerSession=50` 等具体数值

进一步追问根因，发现表层的"载体限制"（markdown 无 transclude）和"机制缺失"（没有 owner 声明）都不是真正源头——**真正的根因是文档分类轴混用，导致不同目录都在发布同一事实**：

- `architecture/overview.md` 既画拓扑图，又列接口签名，又复述决策理由
- `spec/cost-and-limits.md` 既写阈值默认值（契约），又复述"分层防御为什么优先"（决策论述）
- `architecture/session-model.md` 给 SessionKey 写完整定义（这本应是契约）

每类文档都在发布事实，只是判定轴不同。ADR / spec / architecture 按知识类型分，process 按协作时序分，testing 按验证活动分，standards 按产物形态分；这些轴天然会交叉。作者写到哪段就按直觉裁决"这段写在这里合不合适"，没有形式化的 owner 判定标准。LLM 协作放大了这一倾向——agent 改某文件时本能地"补全本文件上下文让它自洽"，进一步制造重复。

只要 owner 判定模糊，所有补丁机制（lint、owner 声明、改源反查 hook、一致性测试、关键词扫描）都只是在为模糊分类打补丁，治标不治本。**真正的修复必须先定义事实归属判定和 process 编排边界，让 SSOT 成为分类清晰的自然推论。**

## Options

### Option A：现状 + docs lint

加一个 lint 脚本扫禁用词、断链、孤儿引用。

- **优点**：成本低，挂 pre-commit 即可
- **缺点**：只挡机械级 drift（术语残留、断链）；散文复述、决策论点重复、契约多处定义全部抓不到
- **主要风险**：给团队一种"已经治理"的错觉，实际深层 drift 持续累积

### Option B：换载体（结构化 schema + 渲染）

把会漂移的部分（接口、阈值、字段表）从 markdown 抠到 yaml / TS / json schema，docs 用工具引用或 build-time 注入。

- **优点**：drift 物理上不可能发生
- **缺点**：引入构建管线、IDE 预览友好度下降、对项目当前规模过度工程
- **主要风险**：迁移工作量大；新机制本身也会引入维护成本与新失败模式

### Option C：事实下沉到代码

接口定义只活在 protocol package（TS interface），默认阈值只活在常量文件，docs 改为引用代码符号。

- **优点**：单一定义靠语言机制强制
- **缺点**：违背项目当前的 docs-first 协作方式；docs 失去对外可读的契约表达；要求所有 reviewer 读代码才能审契约
- **主要风险**：项目阶段不匹配——目前还在 spec 阶段，代码大部分尚未实现，事实自然只能先活在 docs

### Option D：owns 字段 + 改源反查 hook + 一致性测试

每条事实显式声明 owner，pre-commit hook 在 owner 修改时反扫所有引用方，docs consistency test 检测重复定义。

- **优点**：兼容现有 markdown 体系，机械可执行
- **缺点**：所有机制都建立在"分类判定模糊但靠工具治理"的前提上——owner 是索引不是约束，无法阻止另一类文档重写定义；改源反查只挡 rename 类 drift，挡不住"作者顺手在 overview 重写接口签名"；reviewer 判据靠文体约束会被持续侵蚀
- **主要风险**：工具与规则越积越多，作者认知负担上升；根因（分类判定模糊）未解，drift 表层处理换形态继续发生

### Option E：事实归属判定 + process 编排边界

把每段内容按其约束对象判定 owner：ADR 管决策依据，spec 管契约事实，architecture 管组合事实，testing 管验证证据模型，standards 管静态产物形态；process 不抢规则本体，只编排时序、触发、门禁、责任人与失败处理。每条事实只能落在唯一合适的 owner；其他目录只能 link，复述本身就被分类规则拒绝。

- **优点**：根因解——SSOT 成为分类判定清晰的自然推论，不引入新机制；reviewer 判据机器可判（禁入清单就是 lint 规则的语义形式）；既有违反有清晰迁移路径
- **缺点**：作者必须先识别"我在回答哪个问题"才能动笔，习惯转变需要时间；现有 architecture 文档需一次性瘦身（删除复述的接口签名与决策论点，改为 link）
- **主要风险**：分类判定仍可能不够穷尽——出现多轴交叉内容时容易回到凭语感归类；缓解 = 在规则本体里维护冲突裁决表，尤其明确 process 只做编排

## Decision

选 **Option E：事实归属判定 + process 编排边界**。

具体规则本体（事实 owner 矩阵 + process 编排边界 + 冲突裁决）住 [`docs/dev/process/doc-layering.md`](../process/doc-layering.md)——本 ADR 只承载**为什么选这条路**，规则清单本身是"是什么"，按本 ADR 确立的分类规则不属于 ADR。

禁入类型是 reviewer 可判的：非 owner 文档出现可独立还原的事实定义，或 `process/` 展开被编排规则本体，都应直接拒绝并要求改成 owner 链接。

不引入 owns 字段、不引入 pre-commit hook、不引入一致性测试、不引入 lint 工具——**所有机械补丁都被本 ADR 显式拒绝**。如果未来事实归属判定实践证明不足，再单独开 ADR 引入工具，不在本 ADR 演进。

`adr/README.md` 同步补强 ADR 自身的禁入清单，使之与本 ADR 主张的"事实归属判定"自洽——ADR 自己也必须遵守不写规则清单本体的规则（这正是本 ADR 把规则清单分到 process 的原因）。

项目规则入口增加第 10 条核心原则 **SSOT**，链到本 ADR（决策依据）与 process/doc-layering.md（规则本体）。

## Consequences

**正向**

- SSOT 成为分类判定清晰的自然推论，不需要新机制；既有协作工具链（PR / codex review / reviewer）足以承载执行
- Reviewer 判据机器可判——禁入清单就是清晰拒绝条件，不靠语义级判断
- 既有 8 处违反有明确迁移路径，每条对应一个 owner，逐项 PR 处理符合"范围收敛"
- 为后续可能的代码层 SSOT（package 职责互斥 + import 复用）建立同构思路

**负向**

- 作者写文档前必须先识别"在回答哪个问题"，习惯转变期会有摩擦
- `architecture/` 下的文档需一次性瘦身——删除复述的接口签名、决策论点，改为 link；这是迁移成本
- owner 强约束意味着部分原本"上下文自洽"的写法不再允许，读者需跨文件跳转

**代码与设计维度**

代码层 SSOT 通过语言机制（单一 export / 包级唯一定义）+ import 约束实现：跨模块契约只在 protocol / spec 包定义，下游模块 import 而非重声明。设计层 SSOT 是文档层 SSOT 的延伸——spec 是契约 owner，代码侧 import spec 类型，不重新声明同形 interface。本 ADR 不展开代码层机制细节，留给后续 package 层职责 ADR。

**风险与缓解**

- **风险**：分类判定未必穷尽——多轴交叉内容（如 TDD、测试命名、日志字段）容易在 process / testing / standards / spec 之间漂移
- **缓解**：以"内容约束的对象"裁决 owner；process 只编排何时检查，不拥有被检查规则本体

- **风险**：某些场景作者刚需在概览文档里讲清楚某契约（避免读者断裂），owner 规则使复述回流
- **缓解**：依赖良好的 link + 简短摘要（不构成定义）解决可读性；reviewer 判据明确"提及 vs 复述"的区分（读者从单句能否独立得出完整事实——能则复述，不能则仅提及）

## Out of scope

- **既有 8 条违反的实际清理**——本 ADR 给迁移方向，落到后续逐项 PR
- **代码层 SSOT 的具体机制**——package 层职责、import 约束的形式化留给后续 ADR
- **任何机械工具**（lint / pre-commit hook / 一致性测试 / owns frontmatter / 关键词扫描）——本 ADR 显式不引入；如未来事实归属判定不足，再单独开 ADR 决策
- **目录拆分或合并**——本 ADR 不决定是否新增 / 删除顶层目录，只定义现有目录下事实归属与编排边界
