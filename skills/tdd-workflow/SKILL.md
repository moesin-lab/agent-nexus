---
name: tdd-workflow
description: 当本仓库任务将新增功能、修复 bug、修改契约或改变可观察行为，并准备编写或修改实现与测试时触发；即使用户只说“实现”“修一下”或“补代码”也应触发。仅做测试流程路由，不用于纯探索、只读 review、无行为变化的文案修改或已经进入 PR readiness 的门禁检查。
---

# TDD workflow

本 skill 是 TDD 权威流程的薄入口，不定义或复述项目规则。

## 触发边界

- 在实现开始前触发，并覆盖测试与实现迭代阶段。
- 纯探索、只读分析、只改文案且无行为变化时不触发。
- 准备交付或检查 PR 门禁时改用 `pr-readiness`。

## 先读

按任务需要读取以下 owner：

- 流程节奏：[`docs/dev/process/tdd.md`](../../docs/dev/process/tdd.md)
- 测试分层与 mock 边界：[`docs/dev/testing/strategy.md`](../../docs/dev/testing/strategy.md)
- 测试产物合格条件：[`docs/dev/standards/testing.md`](../../docs/dev/standards/testing.md)
- 涉及 fixture 时：[`docs/dev/testing/fixtures.md`](../../docs/dev/testing/fixtures.md)
- 影响 agent prompt、系统指令、skill 触发 metadata、工具集或模型行为时：进入 `eval-workflow`。

规则冲突或细节不一致时，以对应 owner 文档为准。
