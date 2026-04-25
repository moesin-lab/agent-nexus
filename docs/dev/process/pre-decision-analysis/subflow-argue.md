> 本文件是 `docs/dev/process/pre-decision-analysis/README.md` 的组件，agent-agnostic。
> Claude Code 通过 `skills/pre-decision-analysis/` 引用；其他 harness 可同样引用。

# 子流程：argue 派发

**何时用**：主轴步骤 2——为**有明确推荐 / 倾向 / 待决点的决策**派 argue subagent 跑一次反方分析。作为 pre-flight self-check，防止 agent 照镜子看不到盲点。

触发条件：

- 跨多文件 OR 架构级变更
- agent 对方向有明确推荐但也拿不准
- scratch 场景中有推荐 / 倾向的段

跳过条件：单文件改动 + 已有先例 + agent 有把握；纯事实段 / 锁定约束段。

## 派给谁

| 场景 | 调度方式 | 特征 |
|---|---|---|
| **默认 — 异构模型反方分析** | 调异构模型 review（如 Claude Code 的 `codex-review` skill，内部用 OpenAI Codex / gpt-5 系列；其他 harness 参考自身对等） | 不同训练数据 + 不同 reasoning style，能挑出同模型盲点；尤其对"方法论包装"、"隐含假设"敏感 |
| **代码库交叉验证** | 派独立上下文 agent（如 Claude Code 的 `general-purpose` 独立 context；其他 harness 参考自身对等） | 同模型但无当前对话包袱；适合"这个方案在项目中是否已有先例 / 冲突"类问题 |
| **两者都适合时** | 并行派两路，收两份独立 argue | 成本高但信号最强；留给关键决策 |

## 调度 prompt 样板

给 argue subagent 的 prompt 要包含：

1. **方案正文全文**（不要只给摘要；argue 需要细节）
2. **周边上下文**（已锁定的约束 / 相关 ADR / 用户已表明的偏好）
3. **明确任务**：
   - 找**事实性错误**（命名、路径、编号、命令有没有搞错）
   - 挑战**推荐 / 倾向**（"倾向 A"——A 的反例是什么？B 其实更好的场景？）
   - 列**被忽视的风险 / 成本**（主 agent 没提到的 failure mode）
   - 评估**定向问题设计**（问题是否切中真正 ambiguity？选项是否有遗漏？默认建议是否过于诱导？）
4. **禁止要求**：不要让 argue agent 写新方案 / 给实施代码 / 夸赞 ("looks good" 类输出直接拒收)——只要反方 / 挑错 / 建设性质疑

## 并发策略

多段 / 多决策点并行派 argue，同一 turn 里开多个 subagent，收齐再整合。argue 彼此独立，天然并行——不要串行。

## argue 结果去哪

### 场景 A：路径 A（执行优先，PR 交付）

argue 要点 + agent 回应贴 **PR body 的"异议 & 回应"小节**。这是让用户看 diff 时能追溯背景的关键——用户看到 PR diff 有个实现选择时，能翻 PR 描述看到"argue 指出过 X 风险，agent 选了这个实现因为 Y"。

PR body 格式示例：

```markdown
## 异议 & 回应（来自 argue self-check）

- **异议 1**（类别：推荐质疑）：argue 指出方案 A 在 Y 场景会失败。
  **回应**：确认适用，采纳 argue 建议，改为方案 A'——具体改动见 commit SHA xxx。

- **异议 2**（类别：风险遗漏）：argue 列出被忽视的 Z 风险。
  **回应**：风险真实但发生概率低，采纳 "延后到有迹象再修" 策略，见代码注释 `TODO: monitor Z`。
```

### 场景 B：scratch 场景

argue 要点合入段的反对点列表；必要时标 `(来自 argue)` 来源。完整 argue log 不入 scratch（scratch 展示给用户看的是**整合后的推荐**，不是原始 argue 对话）。

### argue 颠覆原推荐时

重写方案；不要为了保留原文硬辩。

### argue 说"没问题"时

罕见——通常是 prompt 写得太松，或方案本身太浅。先检查 prompt；若确认方案无破绽，PR body 加一句"✓ argue check: no material objections" 让 reviewer 知道已自检过。

### argue subagent 失败

API error / 超时 → 不阻塞推进；PR body 加 `⚠ argue unavailable` 让 reviewer 知道缺外审。

## 反模式

| 反模式 | 正确做法 |
|---|---|
| 有明确推荐却跳过 argue | 跨多文件 / 架构级决策必派；单文件 + 有先例可跳 |
| 串行派 argue 一段接一段 | 并行派，同 turn 开多个 subagent |
| argue 回"looks good" 就收下 | 要求反方、挑错、质疑；夸赞说明 prompt 太松，重派 |
| argue 结果 agent 自己吸收但不贴 PR body | 用户看 diff 时看不到考量背景——必须透明化 |
| argue 颠覆推荐但 agent 硬辩保留原文 | 重写方案；别为了省事保留有破绽的推荐 |
| 传给 argue 的 prompt 只有方案标题没有正文 | 传方案全文 + 上下文；argue 需要细节才能挑错 |
