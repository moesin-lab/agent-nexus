---
title: Self-Refinement（经验沉淀与规则分流协作约定）
type: process
status: active
summary: 被纠正后或用户显式要求沉淀经验时的 agent-agnostic 协作约定——stay quiet by default、显式触发必走 4 步、分流矩阵保证沉淀到正确层级、本地记忆遵守 harness 全局规则
tags: [process, memory, workflow, review]
related:
  - dev/adr/0007-collaborative-skill-promotion
  - root/AGENTS
---

# Self-Refinement

> 本文件是 `self-refinement` 协作约定的**权威源**（agent-agnostic）。各 harness 通过自身薄执行器引用本 docs（实现见仓库 `skills/self-refinement/` 下各 harness 子目录）。
> 文中 **本地记忆** 指 agent 在用户机器上保存、跨 session 持续、不入仓库的 memory / rules 条目；各 harness 的具体路径与命名见 §Harness 实现注记。

## 核心前提

1. **LLM 无跨 session 持久记忆**——会话 A 中被纠正的错误在会话 B 中会以相同概率复发，除非经验被外化为持久化上下文
2. **持久化上下文分层**：不同性质的经验要住不同层（本地记忆 / `docs/process/` / ADR / spec / skills），错层会污染协作或沉在本地无法共享
3. **手动沉淀一直在发生**：本仓库现有协作者的本地记忆条目证明这个机制本身 work；本 skill 不替代手动沉淀，只在"经验已决定要沉淀"时提供**结构化流程**确保落位正确

## 核心原则

- **Stay quiet by default**：不在每次回复末尾自动附"沉淀建议"；自动触发是反模式（边界不可控 + 死循环风险 + 误报噪音）
- **显式触发必走 4 步**：用户主动要求沉淀时 agent 有明确 SOP，不即兴发挥
- **分层优先**：沉淀前先判"个人 scope 还是项目 scope"，再定具体落点
- **本地记忆是最窄 scope**：没把握时走项目 scope（让 reviewer 兜底），不私藏到本地

## 触发场景

- **显式触发（强制走 4 步）**：用户说"沉淀 / 反思 / refine / 复盘 / 记下来 / reflect / /reflect"等关键词——不论是否在"被纠正"语境
- **隐式触发（agent 自决）**：被用户纠正后，agent 完成当前纠正之后**可以自检一次**是否值得沉淀。自检结果"值得"时应向用户确认再执行；"不值得"时直接 stay quiet，**不要在回复末尾追加"沉淀建议"摘要**

**反模式**：在所有纠正后强制附 ≤3 条沉淀建议——这是原外部 skill 的默认行为，本项目明确拒绝。

## 自检 4 步

### 步骤 1：真问题吗

- **问**：这是一次性的当下错误，还是有跨 session 复发风险的模式？
- **只有后者值得沉淀**。单次的手误、上下文缺失造成的歧义、用户刚改了要求等情况都不值得。
- 判据：**想象另一个 session 的 agent 在读完相关 docs + memory 后，会不会再犯同样的错**。会 → 值得沉淀；不会 → 不值得。

### 步骤 2：沉淀到哪层

查**分流矩阵**（见下）。分不清时走**跨层判据**。

### 步骤 3：走对应执行约束

- **仓库内任何文件改动**：遵守 AGENTS.md 核心原则 1（分支先行）——`git checkout -b` 起新分支后再 Edit；`main` 上禁止直接改
- **本地记忆**：遵守 harness 全局规则文件中"记忆"节（去溯源化、自洽、不对抗 harness 注入的 session 标识字段）
- **具体路径与文件命名**按各 harness 约定（见 §Harness 实现注记）

### 步骤 4：复核与落位

执行前检索同主题条目：

- **本地记忆层**：按 harness 提供的检索方式（见 §Harness 实现注记）
- **docs / skills 层**：`grep -r` 关键词 + 读命中文件全文

**命中时判断三选一**：

- **补充修订**（已有条目接近主题）：加 bullet、更新 Why、扩展适用范围
- **覆盖**（已有条目明显错或过时）：重写或标注作废
- **新开**（主题独立、现有条目无法容纳）：新建文件 / 新建 ADR 条

**拒绝盲目新建造成重复**——同主题两条会引发未来 agent 读到哪条就照哪条的漂移。

## 分流矩阵

### 跨层判据

区分个人 scope 和项目 scope 时，问自己：

> **"其他协作者 clone 仓库后也该遵守这条吗？"**
>
> - 是 → 项目 scope（走 PR 落到 `docs/` / ADR / spec / skills）
> - 否，仅对本用户与本 agent 的协作偏好适用 → 个人 scope（本地记忆）

同一条经验可能两义皆可——此时走"是"。本地记忆是**最窄 scope**，没把握就不私藏。

### 矩阵

| 经验性质 | 沉淀层 | 是否需 PR |
|---|---|---|
| 用户个人偏好 / 身份锚点 / **对本 agent 的**协作反馈（如"回复长度"、"用中文还是英文"、"是否追问"）/ 当前项目状态 / 外部系统指针 | 本地记忆 | 否 |
| 项目流程规则 / 编码与错误标准 / 对项目协作流程的反馈（"本项目 PR 必走 codex review"、"issue 不套模板"等） | `docs/dev/process/` 或 `docs/dev/standards/` | 是 |
| 架构级决策（新模块、选型、跨层影响、数据流变更） | `docs/dev/adr/NNNN-*.md`（新 ADR） | 是 |
| 接口契约（模块边界、API 签名、数据结构） | `docs/dev/spec/**/*.md` | 是 |
| 协作性 skill 新增 / 修改 | `skills/**` + `skills.manifest`（按 [ADR-0007](../../adr/0007-collaborative-skill-promotion.md)） | 是 |

### 误归位红线

- **个人偏好写进 `docs/`** → 污染 reviewer / 其他协作者（读到一条强制规则其实只是某个作者偏好）
- **项目规则写进本地记忆** → 只活在本地、他人 clone 后无感、协作漂移
- **架构级决策只进 `process/` 不起 ADR** → 决策无锚点、未来无法审计
- **接口契约变更只改实现不改 spec** → 违反核心原则 4（契约先行）

## 反模式

| 反模式 | 正确做法 |
|---|---|
| 自动在回复末尾追加沉淀建议（原外部 skill 默认行为） | Stay quiet by default；仅显式触发或明确判定值得时再动 |
| 自动越权改文件（跨层写 docs / ADR 不征求确认） | 沉淀到有 PR 必要的层，必须先和用户确认再开分支动手 |
| 在 `main` 上直接改 docs | 任何仓库内文件改动都遵守核心原则 1（分支先行） |
| 写本地记忆时保留会话级溯源（session id / jsonl 路径 / "本 session" 措辞） | harness 全局规则文件记忆节明禁——记忆正文必须自洽，溯源走 handoff 或日报 |
| 一个 PR 打包多个沉淀 | 违反核心原则 7（范围收敛）——每个 PR 只沉淀一个主题 |
| 把 agent 能自决的细节塞本地记忆（命名风格、输出格式细节） | 只沉淀"跨 session 复发风险"级别的模式；琐碎细节的沉淀是噪音 |
| 盲目新建条目忽略已有同主题 | 步骤 4 的三选一判断必走——补充 / 覆盖 / 新开 |
| 沉淀成"A/B 选项让用户挑" | 沉淀是作者自己的判断沉淀，不是把选择题推回用户；有把握就直接落，没把握就不落 |

## Harness 实现注记

各 harness 的本地记忆机制不同，但层级定义（个人 scope vs 项目 scope）和分流矩阵以本 docs 为准，不因 harness 差异而漂移。各 harness 在本节追加自己的实现细节。

### Claude Code（auto-memory）

- **位置**：`~/.claude/projects/<project-slug>/memory/`
- **索引文件**：同目录下的 `MEMORY.md`（每条 memory 一行指针）
- **单条文件命名惯例**：`<type>_<slug>.md`（type ∈ {user, feedback, project, reference}）
- **frontmatter 与三段式**：全局规则文件 `~/.claude/CLAUDE.md` 有 feedback 类型的 "Rule + **Why** + **How to apply**" 三段式惯例；本 skill 沉淀时遵循
- **检索方式**：Read `MEMORY.md` 索引 + 按需读 `<type>_<slug>.md` 全文

### 无本地记忆机制的 harness

若某 harness 无任何本地持久化机制 → 第一行矩阵对该 harness 降级为"在 harness 本地 rules 文件追加"；若连本地 rules 也无 → 该 harness 用户需要把个人偏好口头重复给 agent，是该 harness 的能力缺口不是本 skill 的缺陷

## 与其他 skill 的边界

| skill | 处理时态 | 与 self-refinement 的界线 |
|---|---|---|
| `handoff` | 当前 session → 下次冷启（临时态） | 不做持久规则，只做状态传递 |
| `daily-report` | 每日活动总结（输出态） | 不改规则；只输出内容 |
| `pre-decision-analysis` | 决策前结构化分析（决策态） | 决策用；self-refinement 是决策错误后的二阶反思 |
| `check-pr-comments` | 单 PR 响应（执行态） | 响应具体 PR 反馈；self-refinement 从跨 PR 反馈中抽规律 |
| `open-issue` | 现场想法 → issue 草稿（捕获态） | 捕获但不持久化规则；self-refinement 将已决定的规则外化 |

## 违反后怎么办

- 自检发现违反 → 当场重做 PR / memory 条目，不是"下次注意"
- reviewer 指出违反 → 优先修正产物结构（如把误放 docs 的个人偏好 git mv 回 memory，或反之）
- 反复违反同一条 → 回看 description / docs 是否把该条写成了"选做"，该改成"必做"
