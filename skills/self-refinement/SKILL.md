---
name: self-refinement
description: 当用户显式说"沉淀 / 反思 / refine / 复盘 / 记下来 / reflect / /reflect"时触发；被纠正后 agent 可隐式自检是否值得沉淀。本文件是 harness-neutral 通用入口；规则权威源在 `docs/dev/process/self-refinement/README.md`。关键词：经验沉淀、反馈闭环、rule promotion、分流矩阵、跨层判据、auto-memory。
---

# self-refinement（通用入口）

> ⚠️ **规则权威源**：`docs/dev/process/self-refinement/README.md`。规则冲突时以 docs 为准。
>
> ⚠️ **本文件是 harness-neutral 通用入口**，只描述跨 harness 通用的触发 / 先读 / 协作关系。harness 特定执行细节（具体工具映射、memory 路径、分支操作）见 `harnesses/<harness>/SKILL.md`。

## 1. 先读

触发时加载 `docs/dev/process/self-refinement/README.md`：核心前提 + 原则 + 触发场景 + 自检 4 步 + 分流矩阵（含跨层判据和误归位红线）+ 反模式 + 与其他 skill 的边界。

## 2. 通用流程映射

各 harness 在自己的执行器里实现下面的能力；本节只声明能力存在，不点名具体工具。

- **显式触发识别**：匹配"沉淀 / 反思 / refine / 复盘 / 记下来"等关键词后强制走 4 步
- **隐式触发自检**：被纠正后 agent 完成纠正再决定是否启动自检；stay quiet by default，不自动附建议
- **同主题检索**：执行前检索 auto-memory 和 `docs/` 是否有同主题条目（方法 harness 特定）
- **三选一判断**：命中时判补充修订 / 覆盖 / 新开
- **分支操作**：沉淀到有 PR 必要的层必须起新分支，不在 `main` 上直接改 docs
- **用户确认**：沉淀到有 PR 必要的层必须先与用户确认再开分支动手
- **auto-memory 写入**：遵守全局 `~/.claude/CLAUDE.md` 记忆节约束；具体路径与命名按各 harness

## 3. 触发词典（description 之外的补充信号）

- "这条记下来" / "把 X 写进规则" / "以后默认这样"
- "复盘一下" / "做一次 refinement" / "reflect 一下"
- "下次别再 X" / "我之前提过 X"（隐式触发候选，由 agent 判断是否达到"模式复发"阈值）

## 4. 与其他 skill 的协作

- **与 `pre-decision-analysis`**：后者是决策前结构化分析，本 skill 是决策错误后的二阶反思。触发次序上 self-refinement 可能识别出"应该先起 ADR"，此时派生出一次 pre-decision-analysis 流程
- **与 `handoff`**：当前 session 临时进展走 handoff；抽出来的持久规则走 self-refinement 落地
- **与 `check-pr-comments`**：后者响应具体 PR 反馈；跨多 PR 的共性反馈走 self-refinement 沉淀
- **与 `daily-report`**：日报是输出态不改规则；self-refinement 改规则

## 5. per-harness 执行器

各 harness 挂接时优先读自己的执行器：

- Claude Code：`harnesses/claude-code/SKILL.md`

未来其他 harness（Codex / Cursor / ...）按此模式在 `harnesses/<harness>/` 下新增。

**禁止静默降级**：

- 本节列的是**能力声明**，不是可执行指令。若当前 harness 有对应执行器（见上表），agent **必须**按执行器列出的具体工具执行（如 Claude Code 下的 `AskUserQuestion` / `Write` / `Bash`），不得停在本通用入口的抽象描述上，用普通对话文本代替 harness 特色路径
- 若无对应执行器（`scripts/sync-claude-skills.sh` 宽容 fallback 挂本文件作为触发器），应按 `docs/dev/process/self-refinement/README.md` agent-agnostic 权威源 + 本 harness 自身能力兜底；某能力本 harness 做不到时**在 PR 里显式声明缺口**，不装作走了特色路径

任一场景下，"用更弱的做法冒充原路径"都视为违反 skill 契约。
