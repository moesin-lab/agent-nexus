---
name: pre-decision-analysis
description: 当用户提出需要人类拍板但必须先做结构化分析的问题（评估、对比、讨论、值不值得、该不该、拆不拆、要不要起 ADR）时触发。本文件是 harness-neutral 通用入口；规则权威源在 `docs/dev/process/pre-decision-analysis/README.md`。关键词：决策分析、多方案对比、异构视角反方分析、结构化提问、PR diff review、scratch 协作。
---

# pre-decision-analysis（通用入口）

> ⚠️ **规则权威源**：`docs/dev/process/pre-decision-analysis/README.md` 及同目录 subflow / 模板 / 反模式。规则冲突时以 docs 为准。
>
> ⚠️ **本文件是 harness-neutral 通用入口**，只描述跨 harness 通用的触发 / 先读 / 协作关系。harness 特定执行细节（派发工具、结构化提问工具、文件路径约定）见 `harnesses/<harness>/SKILL.md`。

## 1. 先读

触发时加载 `docs/dev/process/pre-decision-analysis/` 下：

- `README.md` — 主规则（核心前提 / 原则 / 主轴 6 步 / 触发条件）
- 按需加载子流程：`subflow-argue.md`（几乎必跑）/ `subflow-external-repo.md` / `subflow-adr-options.md` / `subflow-task-breakdown.md` / `subflow-survey.md`
- `output-template.md` — scratch 骨架（仅 scratch 硬触发时）
- `anti-patterns.md` — 完整反模式 + 强制规则

## 2. 通用流程映射

各 harness 在自己的执行器里实现下面的能力；本节只声明能力存在，不点名具体工具。

- **argue 派发**：对"有推荐 / 倾向"的决策派发独立审视 agent 做反方分析（异构模型优先、代码库交叉备选）。具体派发方式由各 harness 执行器定义
- **结构化提问（路径 B）**：真分叉时用 harness 提供的结构化提问机制向用户收敛；一轮最多 4 题，超 4 说明没砍到真分叉
- **Scratch 协作**：讨论复杂 / 跨会话时起 scratch（路径 C），遵循 `output-template.md` 骨架
- **PR 载体**：分支遵循 AGENTS.md 分支先行约定；PR body 贴 "异议 & 回应" 小节（argue 要点 + agent 回应）

## 3. 触发词典（description 之外的补充信号）

- "你帮我看看" + URL / 仓库
- "这事该怎么办" + 多候选
- "我不确定选 A 还是 B"

## 4. 与其他 skill 的协作

- 触发后先跑 **argue**（独立审视 agent）做 pre-flight self-check
- 外部仓库评估偶尔需要浏览器/调试类工具（各 harness 按自身生态选）
- Scratch 跨会话可用 `handoff` skill 把未决点带进下次

## 5. per-harness 执行器

各 harness 挂接时优先读自己的执行器：

- Claude Code：`harnesses/claude-code/SKILL.md`

未来其他 harness（Codex / Cursor / ...）按此模式在 `harnesses/<harness>/` 下新增。

**禁止静默降级**：

- 本节列的是**能力声明**，不是可执行指令。若当前 harness 有对应执行器（见上表），agent **必须**按执行器（`harnesses/<harness>/SKILL.md`）列出的具体工具执行，不得停在本通用入口的抽象描述上，用普通对话文本 / 手工模拟提问 / 自问自答假 argue 等通用做法代替 harness 特色路径
- 若无对应执行器（挂接脚本宽容 fallback 把本文件挂为触发器时），应按 `docs/dev/process/pre-decision-analysis/` agent-agnostic 权威源 + 本 harness 自身能力兜底；某能力本 harness 做不到时**在 PR 里显式声明缺口**，不装作走了特色路径

任一场景下，"用更弱的做法冒充原路径"都视为违反 skill 契约。
