---
title: ADR-0007：协作性 skill 入库规范
type: adr
status: active
summary: 协作性 skill（影响产出格式 / 要他人理解 / 多人共用）入库到仓库根 `skills/`；个人偏好 skill 留 harness-local；挂接机制由 process/scripts 层定义，ADR 不锁死
tags: [adr, decision, skills, collaboration]
related:
  - dev/process/pre-decision-analysis/README
  - root/AGENTS
adr_status: Proposed
adr_number: "0007"
decision_date: null
supersedes: null
superseded_by: null
---

# ADR-0007：协作性 skill 入库规范

- **状态**：Proposed
- **日期**：2026-04-24
- **决策者**：senticx@foxmail.com
- **相关 ADR**：`docs/dev/adr/deprecated/0005-subscription-as-first-class-path.md`（已归档，仅作编号背景）

## 状态变更日志

- 2026-04-24：Proposed

## Context

AI coding agent 的 skill 文件（如 Claude Code 的 `~/.claude/skills/<name>/SKILL.md`）按 `AGENTS.md` 约定住在 harness-local 目录，不入库——"项目不假定协作者使用哪种 agent，`.claude/` / `.codex/` 等本地配置不入库"。

这对**纯个人偏好**类 skill（提示语风格、输出 verbosity、个人习惯）是对的——它们只影响"我自己与 agent 互动的方式"，不影响他人。

但**协作性 skill**不同——它们影响 **agent 产出的格式 / 协作产物（PR / scratch / 决议记录）/ 需要其他协作者或未来协作者能读懂**。比如 `pre-decision-analysis` 定义了"决策前结构化分析"的协作约定——scratch 格式、PR body 的"异议 & 回应"、review 以"选择不批改"为原则——这些是**协作约定**，不是个人偏好。

当前机制缺口：

1. 协作性 skill 锁在 `.claude/skills/` 里 → 不入库 → 无 review / 无版本历史 / 其他协作者 clone 后拿不到
2. 使用其他 harness（Codex / Cursor）的协作者完全看不到协作约定的存在——即使他们也想遵守也没法
3. 即使只有一个协作者使用 Claude Code，skill 规则的变更无 review 就是本地 drift——和 `AGENTS.md` 核心原则"文档先行 / 契约先行"原则矛盾

本 ADR 为这类 skill 立入库规范。范围**外推**——适用于当前及未来所有协作性 skill，不只是 `pre-decision-analysis`。

## Options

### Option A：维持现状（所有 skill 皆 harness-local）

- **是什么**：不建立协作性 skill 的入库机制；所有 skill 继续 local
- **优点**：零改动；保持"harness 配置不入库"的统一语义
- **缺点**：协作性 skill 的规则永远出不了 harness；违反文档先行原则
- **主要风险**：随协作人数增加，协作性 skill 的 drift 不可管理

### Option B：单点特批每次一议

- **是什么**：不立通用规矩；每次有 skill 要升格，起独立 ADR 专门为那个 skill 开路
- **优点**：保守，不预设未来
- **缺点**：每次议一轮结构相同的决策——"入库判据 / 挂接机制 / docs 边界"反复讨论；未来的协作性 skill 被"每次特批"的成本压住不敢出生
- **主要风险**：规则空心化——看起来有规则但人在每次 case 里拍板

### Option C：立"协作性 skill 入库"通用规矩（Recommended）

- **是什么**：一次定义分层判据，未来协作性 skill 自然归位
- **优点**：决策成本前置；规则明确；`AGENTS.md` 文档先行原则统一贯彻
- **缺点**：判据写不好会扩张到不必要的 skill；首次规则化本身需要一轮认真讨论
- **主要风险**：范围蔓延——判据过宽会把本该 local 的 skill 拉入库

## Decision

选 **Option C**。

### 核心决定

1. **引入仓库根 `skills/` 目录**作为协作性 skill 入库住处
2. **入库判据**：skill 规则满足**至少一条**就入库
   - 影响**协作产出的格式**（PR body 约定 / scratch 模板 / issue 描述格式）
   - 要求**他人（人类或其他 agent）理解产物**才能继续协作
   - **多人共用**（不只是"我自己"的偏好）
3. 纯个人偏好 skill 留 harness-local（`.claude/skills/` / `.codex/skills/` / ...）
4. **挂接机制由 process / scripts 层定义，ADR 不锁死具体实现**（symlink / copy / manifest / hook 等将来都可能合适）
5. **Skill 目录分层**：
   - `skills/<name>/SKILL.md` 是 **harness-neutral 通用入口**（触发描述、跨 harness 通用流程、与其他 skill 的协作关系），不点名特定 harness 的工具或 skill
   - harness 特定执行细节放 `skills/<name>/harnesses/<harness>/SKILL.md`（如 `harnesses/claude-code/SKILL.md`），承载该 harness 下的具体派发方式、工具调用、路径约定
   - 规则权威源仍在 `docs/dev/process/<name>.md`，agent-agnostic
6. 首个实例化：`pre-decision-analysis`（`docs/dev/process/pre-decision-analysis/README.md` 定义约定；`skills/pre-decision-analysis/SKILL.md` 通用入口；`skills/pre-decision-analysis/harnesses/claude-code/SKILL.md` Claude Code 执行器）

### 范围（**外推**）

本决策适用于当前及未来所有协作性 skill；不是"特批 pre-decision-analysis 一个"。未来新协作性 skill 按本 ADR 的判据直接归位 `skills/`，不需要重起 ADR。

纯个人偏好 skill 不适用本 ADR——它们依然留 local，不用 review。

### 不在本 ADR 内锁死的（交给下级）

- **具体挂接机制**（symlink / copy / manifest）→ `docs/dev/process/skill-setup.md` + `scripts/sync-claude-skills.sh`
- **各 harness 的 skill 格式要求** → 各 harness 自己定；harness 特定执行器住 `skills/<name>/harnesses/<harness>/`
- **协作约定的规则内容** → 进 `docs/dev/process/<name>.md` 权威源；skill 文件退成薄执行器指向 docs

## Consequences

### 正向

- 协作性 skill 有了入库、可 review、可版本化的家
- 规则与实现分层：`docs/dev/process/` 沉规则（agent-agnostic），`skills/` 是执行器（harness 特定）——不走双写，换 harness 时换执行器不换规则
- 未来添协作性 skill 不用每次走 ADR——按本 ADR 判据直接落位

### 负向

- 范围蔓延风险：判据"影响产出格式 / 多人共用"较宽，可能把本应 local 的 skill 也拉入库。**缓解**：reviewer 在 PR 里质疑入库必要性即可；错了 `git mv` 回 local 便宜
- 首次落地要同步改多处：`skills/` 目录建立 + `AGENTS.md` onboarding + `scripts/sync-claude-skills.sh` + `skills.manifest`
- 跨 harness 挂接是 MVP 里的开放点——当前只实现 Claude Code 的 symlink 挂接

### 中性

- `.claude/skills/<name>` 仍 gitignored（仍是本地挂载点）；只是真实住处从 `.claude/` 迁到 `skills/`
- 入库判据依赖人判断（"影响协作产出格式"有软性），不是纯机械规则——但 reviewer 环节能兜住

## Amendments

- **2026-04-26：skill 内 docs 通过 symlink 聚合呈现** —— 第 5 条原文要求"规则权威源仍在 `docs/dev/process/<name>.md`，agent-agnostic"。SSOT 清理后实践发现：协作性 skill 的内容按 owner 矩阵被切到多个 owner 后（process 流程编排 / standards 反模式 / scratch 模板），skill 视角下不再是一个完整 unit——agent 触发后要跨 4 个目录读，人类浏览也分散。本次修订引入"两个视图共存"机制：物理位置仍按 owner 矩阵治理（`docs/dev/<owner>/<skill>/` 子目录），但在 `skills/<name>/` 下用 symlink 把各 owner 子目录聚合呈现（`skills/<name>/process` → `docs/dev/process/<name>/`，`skills/<name>/standards` → `docs/dev/standards/<name>/`）。SKILL.md 内的 link 改用 skill 内相对路径（`./process/README.md` / `./standards/scratch-template.md`），让 agent 触发链路 + 人类浏览都看到完整 unit；docs/dev 视图保持 owner 治理纯洁性，path 判据 + reviewer 习惯不破。具体 symlink 约定与 frontmatter 处理见 `docs/dev/standards/doc-ownership.md` §"协作性 skill docs 子目录约定"。

## Out of scope

- **具体的 symlink 命令 / `sync-claude-skills.sh` 脚本实现**：见 `docs/dev/process/skill-setup.md` 和 `scripts/` 层，ADR 不锁死
- **其他 harness（Codex / Cursor / ...）的挂接**：本 ADR 只要求"规则 agent-agnostic 放 docs"；各 harness 如何落地交给自身约定。当前 MVP 只实现 Claude Code，未来扩展无需改本 ADR
- **skill 的 description 调优 / 触发准确率**：属 skill 质量工程，与入库规范无关
- **单次 skill 落地的 PR 结构**：是否单 PR 合并、是否拆多 PR 取决于具体 skill；本 ADR 不规定
