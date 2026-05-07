---
title: Code Review 流程编排
type: process
status: active
summary: codex review 触发时机、ultrareview 触发条件、反馈未回应如何阻断流程；产物合格条件见 standards/code-review.md
tags: [code-review, process, subagent]
related:
  - root/AGENTS
  - dev/process/workflow
  - dev/process/subagent-usage
  - dev/standards/code-review
  - dev/standards/review
---

# Code Review 流程编排

本项目所有 PR 必须经过至少一次 review。单人仓库时的"review"由**作者自查 + codex review**组成；有协作者时追加人类 review。

自查清单 / 反馈响应 / 禁入条件 / 反模式见 [`../standards/code-review.md`](../standards/code-review.md)；review 反馈优先级判据见 [`../standards/review.md`](../standards/review.md)。本文件只编排"何时跑、谁触发、未回应如何阻断流程"。

## PR 必答三问

作者在 PR 描述里自答，reviewer 照此验收：

1. **对应哪条 ADR？**（无需 ADR 时说明理由）
2. **对应哪个 spec？**（纯实现细节可注明 N/A）
3. **对应哪些测试？**（列出新增/修改的测试文件与断言）

三问缺一，reviewer 有义务要求补齐或直接拒绝。

## 作者自查时机

开 PR 前按 [`../standards/code-review.md` §自查清单合格条件](../standards/code-review.md#自查清单合格条件) 走一遍，每项打勾。任一项未达合格不开 PR。

## Codex review 触发时机

所有 PR 必须跑一次 codex review。用途：获取一个**独立视角**，补足作者与主 agent 的盲区。

### 何时跑

- 每个 PR 合并前至少一次
- 改动超过 200 行或跨 3+ 文件：跑完后再跑一次 ultrareview
- 架构级改动（新增模块、改依赖方向、改 spec 契约）：强制 ultrareview

### 如何跑

使用 skill `codex-review`：

1. 准备一个 prompt 文件（Markdown），内容包括：
   - 变更目标与动机（1 段）
   - 对应的 ADR / spec 路径
   - 关键改动点（3–5 个）
   - 想让 codex 重点看的问题（例如"有没有更简单的做法"、"有没有边界条件漏掉"）
   - 变更的 diff 或关键文件列表
2. 调用 `codex-review` skill，传入 prompt 文件路径
3. 把 codex 原始输出完整保留在 PR 评论或 `reviews/` 目录（按 PR 编号命名）

反馈响应合格条件见 [`../standards/code-review.md` §Codex review 反馈响应合格条件](../standards/code-review.md#codex-review-反馈响应合格条件)。

## Ultrareview 触发

对大变更使用 `/ultrareview`。这是由用户触发的多 agent 云 review，不能由 Claude 自动启动。

**作者职责**：在 PR 描述里标注"建议触发 ultrareview"并说明理由。**用户决定是否触发**。

## 反馈处理与合并门禁

reviewer 与作者按 [`../standards/review.md`](../standards/review.md) 给的优先级处理反馈：

- 上一级（must-fix：正确性 / 安全 / 契约一致性）问题修掉前不可合并
- 下一级（can-defer：可维护性 / 风格）问题开 Issue 追踪后可合并
- 任一未回应的反馈阻断合并（不论级别）

## 人类 review（如有协作者）

- 作者和 reviewer 不是同一人
- Reviewer 先读 PR 描述、ADR、spec 再读代码
- Reviewer 的三问：这个改动对应哪条 ADR/spec/测试？（作者没写就打回）
