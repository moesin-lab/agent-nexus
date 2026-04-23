# 发版流程（占位）

> **状态**：占位。本阶段（文档与规范骨架）尚无可发版的产物。本文件在 MVP 具备可运行工件、且 ADR 0004 语言选型完成后填写。

## 本阶段等同发版的事

在没有代码发版概念之前，以下事件需要在 `CHANGELOG.md` 的 `[Unreleased]` 下记录：

- 新增 / 修改 / 删除 ADR
- 新增 / 修改 / 删除 spec
- 新增 / 修改重大流程规范（process/）

## MVP 后需要补齐的内容

下列条目在第一次发版前至少需要有草案：

- 版本号策略（语义化版本 / 日期版本）
- 发布 artifact 形态（二进制 / 包 / Docker 镜像 / 桌面安装包）
- 发布渠道（GitHub Release / npm / crate / PyPI / Homebrew / 其他）
- 发版检查清单（CHANGELOG 完整、ADR/spec 同步、测试全绿、security review、license 核对）
- 版本回滚策略
- 发版公告模板

## 目前的约束

- 任何对"发版"的讨论必须先进 ADR（例如"采用什么版本号策略"是 ADR 题目）。
- 禁止在本文件完善前打任何 git tag。
