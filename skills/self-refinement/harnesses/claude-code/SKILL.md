---
name: self-refinement
description: 当用户显式说"沉淀 / 反思 / refine / 复盘 / 记下来 / reflect / /reflect"时触发；被纠正后 agent 可隐式自检是否值得沉淀。本文件是该 skill 在 Claude Code 下的执行器；通用入口在 `../../SKILL.md`，规则权威源在 `docs/dev/process/self-refinement/README.md`。关键词：经验沉淀、反馈闭环、rule promotion、分流矩阵、跨层判据、auto-memory、MEMORY.md。
---

# self-refinement（Claude Code 执行器）

> ⚠️ **规则权威源**：`docs/dev/process/self-refinement/README.md`。规则冲突时以 docs 为准。
>
> ⚠️ **通用入口**：`../../SKILL.md`（harness-neutral 触发 / 先读 / 能力映射）。本文件只负责 Claude Code 下的具体执行细节。

## 1. 先读

同通用入口 §1：加载 `docs/dev/process/self-refinement/README.md`。

## 2. Claude Code 执行细节

> ⚠️ **硬性要求**：本节列的工具是本 skill 在 Claude Code 下的必走路径——`Read` / `Write` / `Edit` / `Bash`(git) / `AskUserQuestion` 等。agent **不得静默降级**为普通对话文本代替具体工具调用。若某工具当前不可用（权限 / 配额），**在 PR 里显式声明并与用户确认兜底方案**，不装作走了特色路径。

### 显式触发识别

用户消息含"沉淀 / 反思 / refine / 复盘 / 记下来 / reflect"等关键词或 `/reflect` slash 调用 → 强制走自检 4 步。

### 隐式触发自检（stay quiet by default）

被纠正后 agent 完成当前纠正再私下自检：命中"模式复发风险"阈值才启动 4 步；否则 stay quiet——**不在回复末尾追加沉淀建议**。

### 同主题检索

- **auto-memory 层**：`Read ~/.claude/projects/<project-slug>/memory/MEMORY.md`（索引），命中时按需 `Read` 对应 `<type>_<slug>.md` 全文
- **docs / skills 层**：`Bash` 跑 `grep -rn "<keyword>" docs/dev/process/ docs/dev/standards/ skills/`；或派 `Explore` subagent 做深度检索

### 用户确认（沉淀到有 PR 必要的层）

走 `AskUserQuestion` 一题（最多 4 选项，建议 2-3 选项）确认**沉淀目标层 + 文件名/编号 + 新开还是补改**，不要自作主张开分支。

### auto-memory 写入（无需分支）

- `Write ~/.claude/projects/<project-slug>/memory/<type>_<slug>.md`
- 同步 `Edit ~/.claude/projects/<project-slug>/memory/MEMORY.md` 追加一行指针
- 遵守全局 `~/.claude/CLAUDE.md` "记忆"节约束——去溯源化、自洽、三段式（feedback 类型用 Rule + **Why** + **How to apply**）

### 仓库内沉淀（必须起分支）

- `Bash`：`git checkout -b <type>/<slug>`（type 选 `docs` / `feat` / `chore`，按 conventional commit）
- `Write` / `Edit` 目标文件（`docs/dev/process/*` / `docs/dev/standards/*` / `docs/dev/adr/NNNN-*.md` / `docs/dev/spec/**` / `skills/<name>/**`）
- `Bash`：`git add <file> && git commit -m "<type>(<scope>): ..."` → `git push -u origin HEAD` → `gh pr create`
- PR body 答 AGENTS.md 三问

### 分支先行兜底

在 `main` 上直接 Edit 任何仓库内文件 → 中止操作并起分支后重做。违反核心原则 1。

## 3. 触发词典（description 之外的补充信号）

同通用入口 §3。

## 4. 与其他 skill 的协作

- 显式触发后若判定属"架构级决策"层 → 派生 `pre-decision-analysis` 流程起 ADR；必要时调 `codex-review` 做反方分析
- 跨 session 未决沉淀可用 `handoff` 带到下次
- 沉淀到 `skills/` 新协作性 skill → 按 [`docs/dev/process/skill-setup.md`](../../../../docs/dev/process/skill-setup.md) 6 步清单

## 5. 反模式（Claude Code 特定）

- 用 `Edit` 直接改 `main` 上的 `docs/dev/process/*.md`（跳过分支）
- 写 memory 时把 jsonl 路径 / session id 写进正文
- 隐式触发后在回复末尾追加"💡 沉淀建议"摘要（这是原外部 skill 的默认行为，本项目明确拒绝）
- 用 `Bash cat >>` 或 `Bash echo >>` 写 memory 文件（应用 `Write`）
