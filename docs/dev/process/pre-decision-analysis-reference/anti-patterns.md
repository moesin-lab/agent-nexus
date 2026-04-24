> 本文件是 `docs/dev/process/pre-decision-analysis.md` 的组件，agent-agnostic。
> Claude Code 通过 `skills/slotted-deliberation/` 引用；其他 harness 可同样引用。

# 反模式 + 完整强制规则

**何时用**：产出方案 / PR / scratch 后自 review 时对照；或遇到 reviewer 指出流程问题想定位根因。`pre-decision-analysis.md` 主体只保留最关键的几条，完整清单在此。

## 完整反模式表

| 反模式 | 正确做法 |
|---|---|
| **默认起 scratch 而非直接执行** | git 回滚便宜 + agent 执行便宜 + review 昂贵——默认走路径 A 直接落地开 PR；scratch 只在硬触发条件满足时起 |
| **Review 塞给用户批改**（打字在 HTML comment 里回"Q1=a"） | review 做"选择"不做"批改"——用户 PR diff 点 merge / close / inline comment |
| **把 agent 能自决的细节塞 AskUserQuestion** | 命名 / 格式 / 文件数 / 这种 agent 有把握的不问；真分叉 = agent 自己没把握 OR 违反 ADR OR 用户反对过 |
| **一次问超过 3 个真分叉** | 砍到 3 个或分批；问多了就是 agent 自己该想清楚 |
| **能自验的问题占 review 带宽** | 有 test / lint / typecheck / 脚本能自证的 agent 自验过就不问 |
| **Argue 结果 agent 吸收但不贴 PR body** | 用户看 diff 时看不到考量背景——argue 要点 + agent 回应必须贴 PR body 透明化 |
| **多方案要选时问抽象文本而不并行做出来** | 能并行执行就并行起 2-3 个分支做完整产物，用户 diff 选 merge 一个；比让用户读 trade-off 文本选强 |
| **把 skill 当成"外部仓库评估专用"** | 本质是"需要人类拍板的结构化分析"，外部仓库只是子流程 A |
| **问题单一 / 明确时还强行走分段 + slot** | 触发前先过三问；能直接做就直接做，流程不是目的 |
| 多个维度堆在一段里 | 一维度一段，每段独立 slot（scratch 场景） |
| 段里含糊陈述不给结论也不给定向问题 | 要么给明确结论让用户 yes/no，要么埋"想问你"让用户定向选择 |
| 有推荐 / 倾向却跳过 argue | 跨多文件 / 架构级决策必派 argue；单文件 + 有先例可跳 |
| argue 串行派 | 并行派，同 turn 开多个 subagent |
| argue 返回 "looks good" 就收下 | 要求反方 / 挑错；夸赞说明 prompt 太松，重派 |
| 定向问题问"你觉得怎么样" | 具体 + 带选项 + 带默认建议；一段最多 1-2 个 |
| "不采纳 / 不借鉴"清单只列条目不给理由 | 每条一句"为什么不"，否则被追问 |
| REVIEW slot 紧贴正文没有空行 | slot 前后各一空行；slot 内部标签行与 `-->` 之间留空行 |
| 主 session 替用户决定转 ADR / issue（路径 B scratch 场景） | 停在 scratch，等 slot 反馈再决定 |
| 外部仓库评估时逐个文件 fetch | 先拿 tree，挑代表性文件（见子流程 A） |
| scratch 里放主 session 报告性的收尾语 | scratch 只放分析 + slot；收尾语走主 session 对话 |
| review 还没回就追加新维度 | 停手等；需要补维度也等用户先回 |
| 用户已说"直接做"还强行走 slot | 用户让渡决策权时，skill 退出，直接执行 |
| 第二轮深挖塞进第一轮 scratch | 开新 scratch，purpose 改 `deep-dive`（见子流程 D） |
| 段内硬套四件套凑字数 | 段结构自由；按段的实际需要取舍 |

## 完整强制规则

### 路径 A（执行优先）

1. argue 要点 + agent 回应贴 PR body 的 "异议 & 回应" 小节。
2. 关键决策的分叉可并行起 2-3 个分支做出产物，不在抽象文本层让用户选。
3. 能自验的（test / lint / 文件断言）自验过再 push；自验通不过不开 PR。
4. PR 被 close 或有 comment 反馈 → agent 读 comment 修，新 commit push；不争辩。

### 路径 B（AskUserQuestion）

5. 只问"真分叉"（≤ 3 个）：agent 自己拿不准 OR 违反已有 ADR OR 用户反对过相关方向。
6. 把 agent 能自决的细节（命名 / 格式 / 文件数）塞 AskUserQuestion → 返工。
7. AskUserQuestion 答完走路径 A。

### Scratch（仅硬触发时）

8. scratch 路径固定：`.tasks/<topic>-<purpose>.scratch.md`；`.tasks/*.scratch.md` 必须 gitignore。
9. 起 scratch 的条件至少满足一条：AskUserQuestion 连续 2 轮没定 OR 明确跨会话 OR 涉及 ≥ 2 个 ADR OR 用户显式要 scratch。
10. 每段必须能独立被 review——明确结论或"想问你"定向问题。
11. "不采纳 / 不借鉴"类清单每条必须带理由。
12. 每个 REVIEW slot 前后各留一个空行；slot 内部标签行与 `-->` 之间留空行。
13. 段与段之间用 `---` 分隔。
14. scratch 末尾追加总体意见 slot。
15. review 未回前禁止追加新维度、禁止落地任何一条建议。

### 子流程专属

16. 子流程 A（外部仓库）：第一段必须是 Layer 定位；"明确不借鉴"每条必给理由。
17. 子流程 B（ADR 多方案）：候选方案 ≥ 2；"约束与不变量"段不得省略。
18. 子流程 C（任务拆解）：候选拆法 ≥ 2；trade-off 四维（速度 / 并行 / 回滚 / milestone）至少给 2 维。
19. 子流程 D（调研）：第一轮每段 ≤ 10 行；第二轮深挖必须开新 scratch。

## 违反后怎么办

- 自检发现违反 → 当场重做 PR / scratch，不是"下次注意"。
- reviewer 指出违反 → 优先修正产物结构，不是在对话里辩解。
- 反复违反同一条 → 回看 description / docs 是否把该条写成了"选做"，该改成"必做"。
