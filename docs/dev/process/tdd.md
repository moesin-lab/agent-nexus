---
title: TDD（流程编排）
type: process
status: active
summary: Red-Green-Refactor 流程节奏、测试层级触发条件、自查 checklist；决策依据见 ADR-0009，合格条件见 standards/testing.md
tags: [tdd, testing, process]
related:
  - dev/adr/0009-tdd-mandatory
  - dev/standards/testing
  - dev/process/workflow
  - dev/testing/strategy
  - dev/testing/fixtures
---

# TDD（流程编排）

本项目**强制 TDD**。决策依据（为什么强制而非推荐 / 仅 critical path）见 [ADR-0009](../adr/0009-tdd-mandatory.md)；测试合格条件（探针、反模式、断言写法、覆盖率等）见 [`../standards/testing.md`](../standards/testing.md)；测试分层与 mock 边界见 [`../testing/strategy.md`](../testing/strategy.md)。本文件只编排流程节奏。

## Red-Green-Refactor

```
Red      → 写一个会失败的测试，确认它确实失败
Green    → 写最小实现让它通过，不做多余事
Refactor → 在测试保持绿的前提下，整理代码与命名
```

循环粒度要小：每一轮 5–20 分钟。如果一轮超过 30 分钟，多半是粒度过大，拆。

## 何时写哪一层的测试

按 [`../testing/strategy.md`](../testing/strategy.md) 的四层模型选择：

- **新增函数 / 类** → 单元测试先行
- **模块间交互** → 集成测试先行（例如 adapter ↔ daemon）
- **端到端流程** → e2e 用真实 CC CLI + mock Discord；不是每个功能都要 e2e
- **对话质量** → eval；当且仅当改动影响 agent 提示或工具集

## 何时可跳过新增/修改测试

以下改动允许在主路径"是否新增/修改测试"那一步直接跳过：

- 文档错别字、链接修复、注释调整
- 依赖的补丁版本升级（无 breaking change，且既有测试套通过）
- 本地开发脚本的小调整（不影响 CI 与产品代码）
- 纯重命名 / 纯格式化（被测行为未变，依赖既有测试套保护）

跳过新增/修改测试不等于跳过流程；分支、PR、review、合并门禁仍按 [`workflow.md`](workflow.md) 执行。是否同 PR 改 ADR / spec，分别按 [`../adr/README.md`](../adr/README.md) 与 [`../spec/README.md`](../spec/README.md) 判定。

## 触发与失败处理

- **触发**：每次新增功能、修 bug、改契约——按 `workflow.md` 主路径第 5 步进入 Red 阶段
- **门禁**：CI 不绿不可合入；任何被 skip / 注释的测试由 reviewer 按 [`../standards/testing.md` §反模式](../standards/testing.md#反模式) 拒绝
- **失败**：
  - Red 阶段测试本应 fail 却跑成 green（断言写错了）→ 修测试再走
  - Green 阶段实现没让测试过 → 缩小实现粒度或拆测试
  - Refactor 阶段测试从绿变红 → 立刻回滚到上一个绿状态再重做

## 运行节奏与 CI 门槛

按 [`../testing/strategy.md`](../testing/strategy.md) 的四层模型执行：

| 层 | 本地开发 | PR CI | main CI | 定时 |
|---|---|---|---|---|
| Unit | 每次 save 跑受影响的 | 全跑 | 全跑 | — |
| Integration | 相关模块变更时 | 全跑 | 全跑 | — |
| E2E | 可选 | 改核心时触发 | 全跑 | — |
| Eval | 改 prompt/工具集时 | 选择性跑（标签触发） | — | 每晚 |

- Unit + Integration 必须全绿才能合并。
- E2E 在核心路径变更或 PR 标记要求时跑；main CI 默认跑。
- Eval 定时跑；回归自动开 issue，不阻塞普通合并。

## Reviewer 验收

reviewer 按 [`../standards/testing.md`](../standards/testing.md) 检查测试产物形态：

- 发现不合格模式时要求作者按 standards 修正后再合入。
- 作者声明无需测试时，必须在 PR 中解释原因。
- spec 改动涉及契约行为时，确认同 PR 是否包含合约测试更新；例外必须写明理由。

## 反复出错的 checklist

每个功能完成前作者自查：

- [ ] 是否先跑了一次确认测试确实失败？
- [ ] 是否写了**最小**实现通过测试？（不做多余的事）
- [ ] refactor 后测试还绿吗？
- [ ] 是否 mock 了不该 mock 的东西？（按 `../standards/testing.md` §反模式 自检）
- [ ] 测试名是否清楚表达了"在什么条件下期望什么行为"？
- [ ] 合并前整个测试套是否都绿？
