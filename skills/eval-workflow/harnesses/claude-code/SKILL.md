---
name: eval-workflow
description: 当用户要求在 agent-nexus 中编写、修改或运行 agent 对话质量 eval，或评估 prompt、系统指令、skill name / description、工具集、Claude Code / 模型升级及普通测试无法覆盖的概率性行为回归时触发。本文件仅提供 Claude Code 的工具映射，不用于普通确定性测试。
---

# eval-workflow（Claude Code 执行器）

> 通用入口见 [`../../SKILL.md`](../../SKILL.md)。先加载 testing owner，本文件不重复 eval 契约。

## Claude Code 能力映射

- 定位 eval case、fixture 与运行入口：使用文件搜索和读取工具
- 修改 eval 资产：使用文件编辑工具
- 运行 owner 文档中当前可用的 eval 命令：使用 `Bash`
- 分析运行 transcript 与评分结果：在独立上下文有价值时通过 `Agent` 派发分析任务

若 owner 声明的 runner 尚未实现或命令不可用，应显式报告未运行项，不能用普通测试结果替代 eval 结果。
