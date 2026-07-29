---
name: eval-workflow
description: 当用户要求为 agent 对话行为新增或修改 eval case、运行对话质量回归、评估 prompt、系统指令、skill name / description、工具集或模型升级的概率性质量影响，或补上普通测试无法覆盖的行为回归时触发。确定性代码正确性、普通单元/集成/E2E 测试与一般 TDD 实现不触发。
---

# eval-workflow（通用入口）

本 skill 是对话质量 eval 的薄入口，不定义 case、断言、记分或门槛。

## 先读

完整读取：

- [`docs/dev/testing/eval.md`](../../docs/dev/testing/eval.md)
- [`docs/dev/testing/strategy.md`](../../docs/dev/testing/strategy.md)

涉及 fixture 时再读取 [`docs/dev/testing/fixtures.md`](../../docs/dev/testing/fixtures.md)。eval 资产与执行结果以上述 testing owner 为准。

## 与普通 TDD 的边界

- 被测对象是 agent 的概率性行为质量时，进入本流程。
- 被测对象是确定性代码行为时，转交 `tdd-workflow`。
- 同一改动同时包含确定性实现和对话质量风险时，普通测试走 `tdd-workflow`，对话行为回归走本 skill；两类证据不互相替代。

当前 harness 有专用执行器时，使用 `harnesses/<harness>/SKILL.md` 中的能力映射。
