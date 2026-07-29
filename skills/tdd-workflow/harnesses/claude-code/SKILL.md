---
name: tdd-workflow
description: 当本仓库任务将新增功能、修复 bug、修改契约或改变可观察行为，并准备在 Claude Code 中编写或修改实现与测试时触发；即使用户只说“实现”“修一下”或“补代码”也应触发。仅做 TDD owner 路由，不用于纯探索、只读 review、无行为变化的文案修改或 PR readiness 门禁检查。
---

# TDD workflow（Claude Code 入口）

这是 Claude Code 的薄入口。先读取通用入口 [`../../SKILL.md`](../../SKILL.md)，再按其中“先读”部分加载对应 owner 文档。

不要在本文件推导、复制或替代 TDD 规则；执行节奏、测试层级、合格条件以及 fixtures / eval 的按需触发均以通用入口链接的 owner 为准。
