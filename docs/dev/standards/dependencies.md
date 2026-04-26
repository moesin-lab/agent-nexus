---
title: 依赖准入标准
type: standards
status: active
summary: daemon、platform、agent 与测试代码引入外部依赖的准入与禁入标准
tags: [dependencies, standards]
related:
  - dev/architecture/dependencies
  - dev/process/workflow
---

# 依赖准入标准

本文件定义引入依赖"什么算合格 / 不合格"。模块 import 方向见 [`../architecture/dependencies.md`](../architecture/dependencies.md)；新增模块流程见 [`../process/workflow.md`](../process/workflow.md)。

## daemon 外部依赖

daemon 允许使用的非标准库必须满足：通用、成熟、无业务耦合。

当前准入类别：

- 日志库
- 结构化编码（JSON/TOML 等）
- SQLite 或等效嵌入式 KV
- OTel client（可选，观测导出）
- UUID 生成

不在准入类别内的库要引入 daemon，必须先发 ADR。

## platform / agent 依赖

`platform-*` / `agent-*` package 可引入自身 SDK 与工具库，但业务边界必须保持在 protocol 契约上：

- 对外接口只使用 `@agent-nexus/protocol` 定义的归一化类型。
- platform/agent 特有类型不得暴露到 daemon 或 protocol 边界。

## 测试依赖

测试代码额外允许测试工具库、fixture、mock 生成器与合约测试所需组合依赖；不得借测试依赖打破生产代码 import 方向。
