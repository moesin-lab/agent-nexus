---
name: development-workflow
description: 当用户要求在 agent-nexus 仓库实现功能、修复缺陷、修改代码或文档、调整配置或契约时触发。负责在动手前进入项目开发主路径，并按阶段加载需求澄清、文档判定、TDD、分支提交与 code review 的权威流程；不用于纯只读解释、状态查询或 code review。
---

# development-workflow（通用入口）

本 skill 只是开发流程入口，不定义或复述流程规则。规则冲突时以 `docs/dev/` 下的 owner 文档为准。

## 触发边界

- 用户要求对本仓库产生代码、文档、测试、脚本或配置改动时触发。
- 纯只读解释、现状查询、诊断但未要求修改时不触发。
- 用户只要求 code review 时不触发，交给 review 流程。
- 用户提出需要人类拍板的多方案选择时，先交给 `pre-decision-analysis`；决定进入实施后再回到本 skill。

## 先读与路由

先完整读取 [`docs/dev/process/workflow.md`](../../docs/dev/process/workflow.md)，再严格按其当前节点加载对应 owner：

- 进入开发主路径的 issue 节点：`issue-intake`。
- 需求存在澄清触发条件：[`requirement-clarification.md`](../../docs/dev/process/requirement-clarification.md)，并进入 `requirement-clarification` skill。
- 进入文档判定与编写：`documentation-workflow`。
- 修改或审计依赖与跨 package 边界：`dependency-change`。
- 修改仓库协作性 skill、manifest 或 harness 挂接：`skill-setup`。
- 修改 prompt、系统指令、skill 触发 metadata、工具集或模型行为：`eval-workflow` 与 `tdd-workflow` 并行提供证据。
- 进入 Red-Green-Refactor：[`tdd.md`](../../docs/dev/process/tdd.md)。
- 创建或管理分支、commit、同步与合并：[`commit-and-branch.md`](../../docs/dev/process/commit-and-branch.md)。
- 开 PR、独立 review 或合并前验收：[`code-review.md`](../../docs/dev/process/code-review.md)。

只加载当前节点需要的 owner，不在本入口复制其规则。

## 邻接 skill 边界

- `issue-intake`：把开发目标、范围和验收落到 GitHub Issue。
- `requirement-clarification`：实施前补齐未被用户主动提出的邻接维度。
- `pre-decision-analysis`：维度明确后仍存在需要人类拍板的真方案分叉。
- `documentation-workflow`：判定并路由 ADR、spec 或普通文档。
- `dependency-change`：依赖准入与 package 边界。
- `skill-setup`：协作性 skill 准入、挂接和校验。
- `eval-workflow`：概率性 agent 行为回归；不替代确定性测试。
- `release-workflow`：PR 合并后的候选制品与发布阶段。
- `self-refinement`：纠正或返工后判断是否需要沉淀长期规则，不承担当前开发主路径。
