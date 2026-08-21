---
name: release-workflow
description: 当用户要求在 Claude Code 中为 agent-nexus 发版、发布 npm 包、创建或推送发布 tag、验证 release candidate / CLI tarball，或修改发布 workflow 与 package 发布元数据后执行发布验证时触发。不用于普通 build/test、PR ready/merge、仅写 GitHub Release 文案，或版本与渠道仍待决策的讨论。
---

# Release workflow（Claude Code 入口）

这是 Claude Code 的薄入口。先读取通用入口 [`../../SKILL.md`](../../SKILL.md)，再按其中“先读”部分加载对应 owner 文档。

不要在本文件复制发布、验证或 git 流程规则；以通用入口链接的 owner 为准。
