---
name: slotted-deliberation
description: 当用户提出需要人类拍板但必须先做结构化分析的问题（评估、对比、讨论、值不值得、该不该、拆不拆、怎么拆、要不要起 ADR）时触发。本 skill 是 `docs/dev/process/pre-decision-analysis.md` 在 Claude Code 侧的薄执行器——规则权威源是该 docs 及其 `pre-decision-analysis-reference/` 子目录。核心原则：agent-first 执行（有把握直接开分支落地）、review 做选择不做批改（用户在 PR diff 上 merge / close / comment）、真分叉才走 AskUserQuestion（agent 自己拿不准的 ≤3 个）、argue subagent 作 pre-flight self-check 要点贴 PR body。关键词：决策分析、多方案对比、argue subagent、codex review、PR diff review、AskUserQuestion、scratch 协作。
---

# slotted-deliberation（薄执行器）

> ⚠️ **规则权威源**：`docs/dev/process/pre-decision-analysis.md`（及其 `pre-decision-analysis-reference/` 子目录）。
> 本文件只负责 Claude Code 特定的执行细节，规则冲突一律以 docs 为准。
> 未读 docs 就执行本 skill 的流程 = 违反约定。

## 1. 先读

触发时加载以下 docs：

- **主规则**：`docs/dev/process/pre-decision-analysis.md`（核心前提 / 原则 / 主轴 6 步 / 触发条件）
- **按需加载子流程**（`docs/dev/process/pre-decision-analysis-reference/`）：
  - `subflow-argue.md` — argue 派发（几乎所有情况都要跑）
  - `subflow-external-repo.md` — 外部仓库评估
  - `subflow-adr-options.md` — ADR 多方案对比
  - `subflow-task-breakdown.md` — 大任务拆解
  - `subflow-survey.md` — 现状调研报告
  - `output-template.md` — scratch 骨架（仅 scratch 硬触发时）
  - `anti-patterns.md` — 完整反模式 + 强制规则

## 2. Claude Code 特定执行细节

以下是 docs 未涉及、在 Claude Code 具体怎么做的执行层信息。

### argue 派发

- **首选**：Skill 工具调用 `codex-review`（传 prompt 文件路径作 args）或 Agent 工具派 `general-purpose` subagent 内部跑 `codex exec`
- **备选**：Agent 工具派 `general-purpose` subagent 做代码库交叉验证
- **并行**：同一 turn 里开多个 Agent 块并行派

### AskUserQuestion

Claude Code 原生支持。用于路径 B 的真分叉推送——一轮最多 4 题，每题 2-4 选项。若问题超过 4 个说明没砍到真分叉。

### Scratch 路径（仅硬触发时）

`.tasks/<topic>-<purpose>.scratch.md`；`.tasks/*.scratch.md` 已在本仓库 `.gitignore` 命中。

### PR 载体

开分支命名遵循 AGENTS.md 分支先行约定；PR body 贴 "异议 & 回应" 小节（argue 要点 + agent 回应）。

## 3. 触发词典（description 之外的补充信号）

用户除了 description 里列的显式动词（评估 / 对比 / 拆不拆等），以下隐含语境也应触发：

- "你帮我看看"+ URL / 仓库
- "这事该怎么办"+ 多候选
- "我不确定选 A 还是 B"

## 4. 与其他 skill 的协作

- 触发后先跑 **argue**（`codex-review` skill）做 pre-flight self-check
- 外部仓库评估场景可能触发 `chrome-devtools-mcp:*` 系列做页面分析（罕见）
- Scratch 跨会话归档后可用 `handoff` skill 把未决点带进下一会话
