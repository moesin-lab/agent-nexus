---
name: dependency-change
description: 当 agent-nexus 任务要求新增、升级、降级或移除外部依赖，修改或审计 workspace package 依赖关系、跨 package import / API 边界时触发；即使用户只说“装个库”“升级 SDK”“把这个包引进 daemon”或“检查跨包依赖是否违规”也应触发。不用于仅安装现有 lockfile、同 package 内普通 import 整理或未授权的顺手升级。
---

# Dependency change

本 skill 是依赖变更规则的薄入口，不定义或复述项目规则。

## 触发边界

- 在修改 package manifest、lockfile、workspace 依赖或跨 package 边界之前触发。
- 仅按现有 lockfile 安装依赖、同 package 内普通 import 整理时不触发。
- 只读审计依赖准入、package 角色或 import 方向时也触发，但不得据此实施修改。
- 不因当前任务需要某个库而顺手升级其他依赖。

## 先读

按变更范围读取以下 owner：

- 外部依赖准入：[`docs/dev/standards/dependencies.md`](../../docs/dev/standards/dependencies.md)
- Package 角色与 import 方向：[`docs/dev/architecture/dependencies.md`](../../docs/dev/architecture/dependencies.md)
- 新增模块、ADR / spec 与开发主路径：[`docs/dev/process/workflow.md`](../../docs/dev/process/workflow.md)

如果准入或架构方向需要人类拍板，转入 `pre-decision-analysis`；进入实现后使用 `tdd-workflow`，交付前使用 `pr-readiness`。

规则冲突或细节不一致时，以对应 owner 文档为准。
