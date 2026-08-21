---
name: skill-setup
description: 当用户通过 Claude Code 要求在 agent-nexus 仓库新增、修改、删除或重命名协作性 skill，调整 skills.manifest，或维护任一 harness 的仓库 skill 执行器与挂接时触发。本文件提供 Claude Code 的工具映射；个人或全局 skill 不走仓库流程。
---

# skill-setup（Claude Code 执行器）

> 通用入口见 [`../../SKILL.md`](../../SKILL.md)。先加载其中链接的仓库 owner，本文件不重复其规则。

## Claude Code 能力映射

- 创建或改进 skill 内容：调用可用的 `skill-creator`
- 读取与修改仓库文件：使用 Claude Code 的文件读写工具
- 执行挂接与仓库校验：使用 `Bash` 运行 owner 文档声明的脚本和命令
- 检查挂接结果：使用 `Bash` 检查目标链接及命令退出状态

具体文件集合、挂接策略和验收命令直接以通用入口链接的 owner 文档为准。
