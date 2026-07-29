---
name: dependency-change
description: 当 agent-nexus 任务要求在 Claude Code 中新增、升级、降级或移除外部依赖，修改或审计 workspace package 依赖关系、跨 package import / API 边界时触发；即使用户只说“装个库”“升级 SDK”“把这个包引进 daemon”或“检查跨包依赖是否违规”也应触发。不用于仅安装现有 lockfile、同 package 内普通 import 整理或未授权的顺手升级。
---

# Dependency change（Claude Code 入口）

这是 Claude Code 的薄入口。先读取通用入口 [`../../SKILL.md`](../../SKILL.md)，再按其中“先读”部分加载与当前变更相关的 owner 文档。

不要在本文件推导、复制或替代依赖准入、package 边界与开发流程规则；以通用入口链接的 owner 为准。
