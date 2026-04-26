---
title: Code Review 产物合格条件
type: standards
status: active
summary: PR 作者自查清单本体、code review 过程的禁入条件、反模式、Codex review 反馈响应合格条件
tags: [code-review, standards]
related:
  - dev/process/code-review
  - dev/standards/review
  - dev/standards/coding
---

# Code Review 产物合格条件

定义 PR / review 过程的产物合格条件——什么样的 PR 描述、自查、反馈响应算合格。流程编排（何时跑、谁触发、未回应怎么办）见 [`../process/code-review.md`](../process/code-review.md)；review 反馈优先级判据见 [`review.md`](review.md)。

## 自查清单合格条件

作者开 PR 前必须勾完一遍。每条都是产物形态判据，按对应 owner 检查：

- [ ] 改动范围单一，无"顺手改了别的"（[`../process/workflow.md` §范围收敛](../process/workflow.md#范围收敛)）
- [ ] PR 描述回答 [`AGENTS.md` 三问](../../../AGENTS.md#每个-pr-必答三问)（ADR / spec / 测试）
- [ ] spec 同 PR 更新（按 [`../spec/README.md`](../spec/README.md) 判定何时需要）
- [ ] 新增 public 接口在 spec 中定义
- [ ] 代码符合 [`coding.md`](coding.md)
- [ ] 日志符合 [`logging.md`](logging.md) 与 [`../spec/infra/observability.md`](../spec/infra/observability.md)
- [ ] 错误处理符合 [`errors.md`](errors.md)
- [ ] 敏感信息（路径、token、env）经过脱敏层（[`../spec/security/redaction.md`](../spec/security/redaction.md)）
- [ ] 无 skip / 注释的测试（[`testing.md` §不合格模式](testing.md#不合格模式)）
- [ ] CHANGELOG 更新（影响用户时）
- [ ] Commit 符合 Conventional Commits（[`commit-style.md`](commit-style.md)）
- [ ] Markdown frontmatter 完整（[`docs-style.md`](docs-style.md) + [`metadata.md`](metadata.md)）
- [ ] 代码改动对应文档同 PR 改

## Codex review 反馈响应合格条件

对 codex 的每条反馈必须有以下之一明确响应：

- **采纳**：修改代码并说明怎么改的
- **部分采纳**：说明采纳哪一部分，拒绝哪一部分的理由
- **拒绝**：说明技术理由（"性能考虑"、"spec 就是这么定义的"、"这不是本 PR 范围"）

**沉默跳过不合格**——即使拒绝也要留痕，便于未来复盘。Ultrareview 的反馈响应规则相同。

## 禁入条件

PR 满足以下任一即不合格：

- 把 codex review 当橡皮图章（"它说 OK 就 OK"）
- PR 作者自己审自己（除非单人仓库且已跑过 codex）
- 合并有未回应反馈的 PR
- 跳过 review 直接合并（不存在"太小就不 review"的例外）
- 在 `main` 上直接 commit，绕过分支 / PR / review（见 [`commit-and-branch.md`](../process/commit-and-branch.md) 分支先行）
- 合入存在缺 frontmatter 的 Markdown 文件
- 合入代码改动而对应文档没同 PR 更新——文档与代码必须同 PR 改

## 反模式

| 反模式 | 正确做法 |
|---|---|
| "改动简单不用 review" | 仍跑 codex review，成本很低 |
| "codex 说没问题就合并" | 不自我放松，作者还要自查一遍 |
| "反馈太多，捡容易的做" | 按 [`review.md`](review.md) 优先级做，正确性与安全必须全做 |
| "ultrareview 太贵，不做" | 架构级改动强制；不做则改动不能合并 |
| "reviewer 只看代码不看 spec" | 必须先看 PR 描述和 spec 再看代码 |
| "Reviewer 默认 LGTM" | Reviewer 默认态度是**质疑**，接受需要理由 |
