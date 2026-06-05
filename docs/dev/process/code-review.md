---
title: Code Review 流程编排
type: process
status: active
summary: 独立 agent review 触发时机、深度 review 触发条件、反馈未回应如何阻断流程；产物合格条件见 standards/code-review.md
tags: [code-review, process, subagent]
related:
  - root/AGENTS
  - dev/process/workflow
  - dev/process/subagent-usage
  - dev/standards/code-review
  - dev/standards/review
---

# Code Review 流程编排

本项目所有 PR 必须经过至少一次 review。单人仓库时的"review"由**作者自查 + 独立 agent review**组成；有协作者时追加人类 review。

自查清单 / 反馈响应 / 禁入条件 / 反模式见 [`../standards/code-review.md`](../standards/code-review.md)；review 反馈优先级判据见 [`../standards/review.md`](../standards/review.md)。本文件只编排"何时跑、谁触发、未回应如何阻断流程"。

## PR 必答三问

作者在 PR 描述里自答，reviewer 照此验收：

1. **对应哪条 ADR？**（无需 ADR 时说明理由）
2. **对应哪个 spec？**（纯实现细节可注明 N/A）
3. **对应哪些测试？**（列出新增/修改的测试文件与断言）

三问缺一，reviewer 有义务要求补齐或直接拒绝。

PR 描述模板见 [`../standards/code-review.md` §PR 描述合格条件](../standards/code-review.md#pr-描述合格条件)。

## PR metadata 同步校验

GitHub ruleset + `pr-metadata` workflow 是 merge 门禁；它们不能保证 agent 在创建 PR 的那一刻同步感知失败，因为 GitHub Actions 是异步的。支持 PreToolUse hook 的 harness 应在 MCP 创建 PR 前运行仓库脚本：

```bash
node scripts/validate-pr-metadata.mjs --hook
```

脚本从 stdin 读取 hook JSON；仅命中 GitHub MCP `create_pull_request` / `update_pull_request` 类工具时校验 `tool_input.title` / `tool_input.body`，其他工具直接放行。校验失败时 exit 2 并在 stderr 输出缺失项，agent 不应继续创建或改坏 PR。

本地 hook 配置不入库。Claude Code 示例：

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "mcp__codex_apps__github._create_pull_request",
        "hooks": [
          { "type": "command", "command": "node scripts/validate-pr-metadata.mjs --hook" }
        ]
      },
      {
        "matcher": "mcp__github__create_pull_request",
        "hooks": [
          { "type": "command", "command": "node scripts/validate-pr-metadata.mjs --hook" }
        ]
      },
      {
        "matcher": "mcp__codex_apps__github._update_pull_request",
        "hooks": [
          { "type": "command", "command": "node scripts/validate-pr-metadata.mjs --hook" }
        ]
      },
      {
        "matcher": "mcp__github__update_pull_request",
        "hooks": [
          { "type": "command", "command": "node scripts/validate-pr-metadata.mjs --hook" }
        ]
      }
    ]
  }
}
```

若 harness 的 matcher 不能精确匹配 MCP tool name，可以把该脚本挂到所有 PreToolUse；脚本会自行判断非 PR metadata 写入工具并放行。

## PR checks 异步感知

PreToolUse 只能在创建 / 更新 PR 前拦截 metadata 错误；GitHub Actions 仍是异步的。支持 PostToolUse hook 的 harness 应在 MCP 创建 / 更新 PR 后运行：

```bash
scripts/posttool-pr-check-guard.mjs
```

脚本从 tool result 里提取 PR number / head SHA，轮询 required checks。默认 required checks 为 `check,pr-metadata`，默认总超时 10 分钟，轮询间隔为 `5s, 10s, 15s, 20s, 30s, 45s, 60s...`。任一 required check 失败、取消、超时，或总超时后仍 pending / expected，脚本都 exit 2，并在 stderr 明确写出失败 / pending check。agent 不得把这类 PR 汇报为 ready。

Claude Code 示例：

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "mcp__codex_apps__github._create_pull_request",
        "hooks": [
          { "type": "command", "command": "scripts/posttool-pr-check-guard.mjs" }
        ]
      },
      {
        "matcher": "mcp__codex_apps__github._update_pull_request",
        "hooks": [
          { "type": "command", "command": "scripts/posttool-pr-check-guard.mjs" }
        ]
      }
    ]
  }
}
```

可用环境变量覆盖默认值：

- `POSTTOOL_PR_CHECK_REQUIRED=check,pr-metadata`
- `POSTTOOL_PR_CHECK_TIMEOUT_MS=600000`
- `POSTTOOL_PR_CHECK_DELAYS_MS=5000,10000,15000,20000,30000,45000`
- `POSTTOOL_PR_CHECK_MAX_DELAY_MS=60000`

## 作者自查时机

开 PR 前按 [`../standards/code-review.md` §自查清单合格条件](../standards/code-review.md#自查清单合格条件) 走一遍，每项打勾。任一项未达合格不开 PR。

## 独立 agent review 触发时机

所有 PR 必须跑一次独立 agent review。用途：获取一个**独立视角**，补足作者与主 agent 的盲区；reviewer 应尽量使用不同模型 / 不同上下文 / 不同 harness，避免作者自己照镜子。

### 何时跑

- 每个 PR 合并前至少一次
- 改动超过 200 行或跨 3+ 文件：跑完后再跑一次深度 review
- 架构级改动（新增模块、改依赖方向、改 spec 契约）：强制深度 review

### 如何跑

1. 准备一个 prompt 文件（Markdown），内容包括：
   - 变更目标与动机（1 段）
   - 对应的 ADR / spec 路径
   - 关键改动点（3–5 个）
   - 想让独立 reviewer 重点看的问题（例如"有没有更简单的做法"、"有没有边界条件漏掉"）
   - 变更的 diff 或关键文件列表
2. 按当前 harness 的可用机制调用独立 reviewer；见下方 §Per-harness 映射
3. 把 reviewer 原始输出完整保留在 PR 评论或 `reviews/` 目录（按 PR 编号命名）

反馈响应合格条件见 [`../standards/code-review.md` §独立 agent review 反馈响应合格条件](../standards/code-review.md#独立-agent-review-反馈响应合格条件)。

### Per-harness 映射

| 作者主 harness | 独立 review | 深度 review |
|---|---|---|
| Claude Code | `codex-review` skill / OpenAI Codex 侧 reviewer | 用户触发 `/ultrareview` 或项目约定的多 agent review |
| Codex | `claude-review` / `adversarial-review` skill，或等价 Claude/外部 reviewer | `adversarial-review` 多轮，或用户触发的云端多 agent review |
| 其他 harness | 使用不同模型 / 独立上下文的外部 reviewer | 项目约定的多 agent review |

本表只定义等价机制，不改变 review 产物要求：prompt、原始输出、逐条回应都要留痕。

## 深度 review 触发

大变更或架构级改动必须跑深度 review。若深度 review 需要用户触发，作者职责是在 PR 描述里标注"建议触发深度 review"并说明理由；用户决定是否触发。

## 反馈处理与合并门禁

reviewer 与作者按 [`../standards/review.md`](../standards/review.md) 给的优先级处理反馈：

- 上一级（must-fix：正确性 / 安全 / 契约一致性）问题修掉前不可合并
- 下一级（can-defer：可维护性 / 风格）问题开 Issue 追踪后可合并
- 任一未回应的反馈阻断合并（不论级别）

## 人类 review（如有协作者）

- 作者和 reviewer 不是同一人
- Reviewer 先读 PR 描述、ADR、spec 再读代码
- Reviewer 的三问：这个改动对应哪条 ADR/spec/测试？（作者没写就打回）
