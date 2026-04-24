---
name: pre-decision-analysis
description: 当用户提出需要人类拍板但必须先做结构化分析的问题（评估、对比、讨论、值不值得、该不该、拆不拆、要不要起 ADR）时触发。本 skill 是 `docs/dev/process/pre-decision-analysis/README.md` 在 Claude Code 的薄执行器；规则本身读 docs。关键词：决策分析、多方案对比、argue subagent、codex review、PR diff review、AskUserQuestion、scratch 协作。
---

# pre-decision-analysis（薄执行器）

> ⚠️ **规则权威源**：`docs/dev/process/pre-decision-analysis/README.md` 及同目录 subflow / 模板 / 反模式。
> 本文件只负责 Claude Code 特定的执行细节，规则冲突以 docs 为准。

## 1. 先读

触发时加载 `docs/dev/process/pre-decision-analysis/` 下：

- `README.md` — 主规则（核心前提 / 原则 / 主轴 6 步 / 触发条件）
- 按需加载子流程：`subflow-argue.md`（几乎必跑）/ `subflow-external-repo.md` / `subflow-adr-options.md` / `subflow-task-breakdown.md` / `subflow-survey.md`
- `output-template.md` — scratch 骨架（仅 scratch 硬触发时）
- `anti-patterns.md` — 完整反模式 + 强制规则

## 2. Claude Code 执行细节

### argue 派发

- **首选**：`codex-review` skill（传 prompt 文件路径作 args）或 Agent 工具派 `general-purpose` subagent 内部跑 `codex exec`
- **备选**：Agent 工具派 `general-purpose` subagent 做代码库交叉
- **并行**：同一 turn 里开多个 Agent 块并行派

### AskUserQuestion

Claude Code 原生工具。路径 B 推真分叉——一轮最多 4 题；若超 4 说明没砍到真分叉。

### Scratch

`.tasks/<topic>-<purpose>.scratch.md`；`.tasks/*.scratch.md` 已在本仓库 `.gitignore` 命中。

### PR 载体

开分支遵循 AGENTS.md 分支先行约定；PR body 贴 "异议 & 回应" 小节（argue 要点 + agent 回应）。

## 3. 触发词典（description 之外的补充信号）

- "你帮我看看" + URL / 仓库
- "这事该怎么办" + 多候选
- "我不确定选 A 还是 B"

## 4. 与其他 skill 的协作

- 触发后先跑 **argue**（`codex-review`）做 pre-flight self-check
- 外部仓库评估偶尔调用 `chrome-devtools-mcp:*` 系列
- Scratch 跨会话可用 `handoff` skill 把未决点带进下次
