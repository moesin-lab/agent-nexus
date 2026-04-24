> 本文件是 `docs/dev/process/pre-decision-analysis/README.md` 的组件，agent-agnostic。
> Claude Code 通过 `skills/pre-decision-analysis/` 引用；其他 harness 可同样引用。

# 子流程 B：对象是内部 ADR / 多方案对比

**何时用**：要决策的是内部架构问题、有 ≥ 2 候选方案、最终预计会产出 ADR。通常走路径 B 的 AskUserQuestion；若讨论复杂要跨会话则起 scratch。

## 三段开场模板（无论 AskUserQuestion 还是 scratch 都适用）

1. **待决问题**：一句话写清要回答什么。问题必须可判真假或可选 A/B/C。
2. **约束与不变量**：列出硬约束（兼容性、合规、已有契约）和软约束（团队习惯、历史包袱）。
3. **候选方案**：至少 2 个。每个一行定位，不展开细节。

三段开场写完后：

- **可并行做**（多方案执行便宜，用户 diff 选）→ 走路径 A 的"多方案并行" mode
- **不适合并行**（方案差异太大 / 涉及外部副作用）→ AskUserQuestion 推"选哪个方案"

## 本子流程专属硬规则

- 候选方案 < 2 → 不适用本子流程，改走"单路径论证 + 反对点"即可。
- "约束与不变量"段不得省略；若写不出约束说明问题没想清，回去先澄清问题。
- 最终收敛动作若是"起 ADR"，scratch / AskUserQuestion 不替代 ADR，只做 ADR 前置讨论材料。

## 与主轴的衔接

三段开场后的分析仍然套主轴：argue 自检 → 识别任务类型 → 路径 A/B。不重复造格式。
