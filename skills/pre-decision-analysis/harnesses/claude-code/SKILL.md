---
name: pre-decision-analysis
description: 当用户提出需要人类拍板但必须先做结构化分析的问题（评估、对比、讨论、值不值得、该不该、拆不拆、要不要起 ADR）时触发。本文件是该 skill 在 Claude Code 下的执行器；通用入口在 `../../SKILL.md`，规则权威源在 `docs/dev/process/pre-decision-analysis/README.md`。关键词：决策分析、多方案对比、argue subagent、codex review、PR diff review、AskUserQuestion、scratch 协作。
---

# pre-decision-analysis（Claude Code 执行器）

> ⚠️ **规则权威源**：`docs/dev/process/pre-decision-analysis/README.md` 及同目录 subflow / 模板 / 反模式。规则冲突时以 docs 为准。
>
> ⚠️ **通用入口**：`../../SKILL.md`（harness-neutral 触发 / 先读 / 能力映射）。本文件只负责 Claude Code 下的具体执行细节。

## 1. 先读

同通用入口 §1：加载 `docs/dev/process/pre-decision-analysis/` 下 `README.md` + 按需 subflow + `output-template.md` + `anti-patterns.md`。

## 2. Claude Code 执行细节

### argue 派发

- **首选**：`codex-review` skill（传 prompt 文件路径作 args）或 Agent 工具派 `general-purpose` subagent 内部跑 `codex exec`
- **备选**：Agent 工具派 `general-purpose` subagent 做代码库交叉
- **并行**：同一 turn 里开多个 Agent 块并行派

### 结构化提问（路径 B）

用 `AskUserQuestion` 原生工具推真分叉——一轮最多 4 题；若超 4 说明没砍到真分叉。

### Scratch

`.tasks/<topic>-<purpose>.scratch.md`；`.tasks/*.scratch.md` 已在本仓库 `.gitignore` 命中。

### PR 载体

开分支遵循 AGENTS.md 分支先行约定；PR body 贴 "异议 & 回应" 小节（argue 要点 + agent 回应）。

## 3. 触发词典（description 之外的补充信号）

同通用入口 §3。

## 4. 与其他 skill 的协作

- 触发后先跑 **argue**（`codex-review`）做 pre-flight self-check
- 外部仓库评估偶尔调用 `chrome-devtools-mcp:*` 系列
- Scratch 跨会话可用 `handoff` skill 把未决点带进下次
