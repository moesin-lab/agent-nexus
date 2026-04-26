---
title: Code Review
type: process
status: active
summary: 自查清单、codex review 流程、ultrareview 触发条件、review 优先级
tags: [code-review, process, subagent]
related:
  - root/AGENTS
  - dev/process/workflow
  - dev/process/subagent-usage
---

# Code Review

本项目所有 PR 必须经过至少一次 review。单人仓库时的"review"由**作者自查 + codex review**组成；有协作者时追加人类 review。

## 作者自查清单（PR 描述中勾选）

作者开 PR 前先走一遍：

- [ ] 改动范围是否单一？没有"顺手改了别的"
- [ ] 对应哪条 ADR？（`AGENTS.md` 三问之一）
- [ ] 对应哪个 spec？spec 是否同 PR 更新？
- [ ] 对应哪些测试？新增/修改的测试列出
- [ ] 新增 public 接口是否在 spec 中定义？
- [ ] 代码是否遵循 [`../standards/coding.md`](../standards/coding.md)？
- [ ] 日志字段是否符合 [`../standards/logging.md`](../standards/logging.md) 与 [`../spec/observability.md`](../spec/infra/observability.md)？
- [ ] 错误处理是否符合 [`../standards/errors.md`](../standards/errors.md)？
- [ ] 敏感信息（路径、token、env）是否经过脱敏层？
- [ ] 是否跳过或注释了任何测试？（禁止）
- [ ] CHANGELOG 是否更新？（影响用户时）
- [ ] Commit 是否符合 Conventional Commits？
- [ ] 改动涉及的 Markdown 文档 frontmatter 是否完整？（按 [`../standards/docs-style.md`](../standards/docs-style.md) 与 [`../standards/metadata.md`](../standards/metadata.md) 检查）
- [ ] 代码改动对应的文档是否同 PR 改？没改清楚理由（见下方"禁止"）
- [ ] CI 是否全绿？

## Codex review 流程

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

### 如何响应反馈

对 codex 的每条反馈，必须有明确响应之一：

- **采纳**：修改代码并说明怎么改的
- **部分采纳**：说明采纳哪一部分，拒绝哪一部分的理由
- **拒绝**：说明技术理由（"性能考虑"、"spec 就是这么定义的"、"这不是本 PR 范围"）

**不允许沉默跳过**。即使拒绝也要留痕，便于未来复盘。

## Ultrareview

对大变更使用 `/ultrareview`。这是由用户触发的多 agent 云 review，不能由 Claude 自动启动。

**作者职责**：在 PR 描述里标注"建议触发 ultrareview"并说明理由。**用户决定是否触发**。

Ultrareview 的反馈响应规则同上。

## Review 反馈处理优先级

合格条件本体见 [`../standards/coding.md` §Review 反馈处理优先级](../standards/coding.md#review-反馈处理优先级)。

本节只编排：reviewer 与作者按 standards 给的优先级处理反馈；上一级问题修掉前不可合并；下一级问题开 Issue 追踪后可合并。

## 人类 review（如有协作者）

- 作者和 reviewer 不是同一人
- Reviewer 先读 PR 描述、ADR、spec 再读代码
- Reviewer 的三问：这个改动对应哪条 ADR/spec/测试？（作者没写就打回）
- Reviewer 的默认态度：**质疑**。接受需要理由。

## 禁止

- 把 codex review 当橡皮图章（"它说 OK 就 OK"）
- PR 作者自己审自己（除非单人仓库且已跑过 codex）
- 合并有未回应反馈的 PR
- 跳过 review 直接合并（不存在"太小就不 review"的例外）
- 在 `main` 上直接 commit，绕过分支 / PR / review（见 `commit-and-branch.md`"分支先行"）
- 合入存在缺 frontmatter 的 Markdown 文件——reviewer 看到即拒，按 [`../standards/docs-style.md`](../standards/docs-style.md) 的合格条件验收
- 合入代码改动而对应文档没同 PR 更新——文档与代码必须同 PR 改；未来发现文档与代码不一致，按 bug 处理（开 issue 追踪 + 优先级同正确性问题）

## 反模式速查

| 反模式 | 正确做法 |
|---|---|
| "改动简单不用 review" | 仍跑 codex review，成本很低 |
| "codex 说没问题就合并" | 不自我放松，作者还要自查一遍 |
| "反馈太多，捡容易的做" | 按优先级做，正确性与安全必须全做 |
| "ultrareview 太贵，不做" | 架构级改动强制；不做则改动不能合并 |
| "reviewer 只看代码不看 spec" | 必须先看 PR 描述和 spec 再看代码 |
