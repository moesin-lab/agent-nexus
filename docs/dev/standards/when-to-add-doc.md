---
title: 何时加文档（spec / ADR / 普通 doc）
type: standards
status: active
summary: 代码改动 → 该写哪类文档（spec / ADR / 普通 doc / 不写）的判定清单与何时可跳过；元规则在 doc-ownership.md，整体流程在 process/add-doc.md
tags: [docs, doc-trigger, standards]
related:
  - dev/standards/doc-ownership
  - dev/standards/spec
  - dev/standards/adr
  - dev/process/add-doc
---

# 何时加文档

本文件是**判定入口**：从代码改动角度反推该写哪类文档。元规则（owner 矩阵 / 内容性质判定 / 冲突裁决）见 [`doc-ownership.md`](doc-ownership.md)；判完之后的执行流程见 [`../process/add-doc.md`](../process/add-doc.md)。

## 需要新增 / 修改 spec

满足任一：

- 新增模块或新增模块间交互
- 改变已有接口的字段、语义、错误码
- 新增横切约束（observability 字段、限流策略、session 存储）

只改单一模块内部实现、不影响外部契约的，不需要改 spec。spec 产物写法标准见 [`spec.md`](spec.md)。

## 需要新增 ADR

满足任一：

- 引入 / 替换一个外部依赖的大类（IM 平台、agent 后端、数据库、框架）
- 改变模块依赖方向（见 [`../architecture/dependencies.md`](../architecture/dependencies.md)）
- 改变对外契约（`spec/` 下任意文件的接口签名或字段）
- 改变部署形态（单机 → 多机、桌面 → 服务端）
- 改变安全模型（权限边界、密钥存储、脱敏规则）
- 选定实现语言、运行时、核心库

ADR 产物写法标准见 [`adr.md`](adr.md)。

## 需要其他 owner 文档

按 [`doc-ownership.md` §Owner 矩阵](doc-ownership.md#owner-矩阵) 与 §判定流程 选 owner：

- 组合事实（模块 / 依赖 / 数据流 怎么组合）→ `architecture/`
- 验证证据模型（用什么测试 / fixture / eval / CI 证据）→ `testing/`
- 价值标准（命名 / 形态 / 反模式 / 准入禁入）→ `standards/`
- 流程编排（什么时候做、谁、按哪份 standards 检查）→ `process/`

## 何时可跳过

以下改动允许在主路径"判定要不要加文档"那一步直接跳过：

- 文档错别字、链接修复、注释调整、术语统一
- 单一模块内部实现细节（无对外接口字段 / 错误码 / 语义变化）
- 测试代码新增 / 重构（spec 契约未变）
- 性能优化但接口与可观测行为未变
- 依赖的补丁版本升级（无 breaking change）
- 本地开发脚本的小调整（不影响 CI）
- spec / standards / process 内部措辞调整（决策语义未变）

跳过加文档 ≠ 跳过流程——**分支、PR、review、squash merge 不可跳过**，见 [`../process/workflow.md` §分支先行](../process/workflow.md#分支先行不可跳过)。是否同 PR 改测试，按 [`testing.md` §何时可跳过新增/修改测试](testing.md#何时可跳过新增修改测试) 判定。
