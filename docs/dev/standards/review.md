---
title: Code Review 反馈质量判据
type: standards
status: active
summary: review 反馈优先级分级与各级别 must-fix / can-defer 合格条件
tags: [review, standards]
related:
  - dev/process/code-review
  - dev/standards/coding
---

# Code Review 反馈质量判据

定义 review 反馈"什么级别的问题算 must-fix / 可 defer"，是产物合格条件。流程编排（何时跑 codex review / ultrareview、谁触发、未回应如何处理）见 [`../process/code-review.md`](../process/code-review.md)。

## 优先级分级

当 review 反馈超出可一次处理量时，按下表优先级判定：

1. **正确性**：bug、错误处理缺失、边界条件
2. **安全**：权限、脱敏、注入风险、密钥泄露
3. **契约一致性**：代码与 spec 是否一致
4. **可维护性**：命名、模块边界、复杂度
5. **风格**：格式、注释

## must-fix vs can-defer

- **正确性 / 安全 / 契约一致性**（1-3 级）：must-fix——未修则产物不合格
- **可维护性 / 风格**（4-5 级）：can-defer——开 issue 追踪即合格，不构成产物缺陷

合并门禁如何触发、未回应反馈如何阻断流程，见 [`../process/code-review.md`](../process/code-review.md)。
