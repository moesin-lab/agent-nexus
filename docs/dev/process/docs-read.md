---
title: 读文档的防污染机制
type: process
status: active
summary: 防止 agent 把非权威源（归档文档 / 外部导向文档）当事实用的完整机制——路径分层、作废工作流、scripts/docs-read 三种模式、pretool-read-guard hook 集成、违反后果
tags: [docs, hook, pollution, archive]
related:
  - root/AGENTS
  - dev/standards/metadata
  - dev/standards/docs-style
---

# 读文档的防污染机制

防止 agent 把非权威源（归档 / 外部导向文档）当事实使用——靠路径分层 + `scripts/docs-read` 三模式 + 可选的 `pretool-read-guard` hook 三层兜住。

## 路径分层与放行/拦截规则

| 路径 | Read 行为 |
|---|---|
| `AGENTS.md` / `CHANGELOG.md` / active 的 `docs/**` | 放行 |
| `docs/**` 下 `status: placeholder` 骨架 | 放行（不归档；占位用） |
| `docs/dev/adr/deprecated/**` / `docs/_deprecated/**` | 拦截 → `scripts/docs-read --force` |
| 仓库根 `README.md` / `CONTRIBUTING.md` | 拦截 → `scripts/docs-read --force` |

**违反后果**：reviewer 在 PR 里看到基于归档文档做的决策（作者未显式声明研究历史），应要求重做——过时内容进决策链后整条链条都要重新验证。

## 防污染的真正靶子

防污染的真正靶子是"让 agent 把非事实内容当事实用"。两类非权威源需要拦：

1. **归档文档**：作废的历史内容（Superseded ADR、Deprecated 规范）。
2. **外部导向文档**：`README.md` / `CONTRIBUTING.md`——语气偏向产品介绍与贡献指南，不是内部决策事实源。

`placeholder`（骨架文档）刻意不归档：这些文档承担"信息架构占位"作用（章节存在感、导航表），搬去归档会让读者以为相关主题废弃了。它的污染风险靠两道兜住：① 骨架正文通常极短，看一眼就知道是占位；② `docs-read` 默认模式对 `status: placeholder` 返回 frontmatter + 告警。

## 作废工作流

一份文档状态变为 Superseded / Deprecated 时，**同一个 commit 内**完成三步：

1. `git mv <path> docs/dev/adr/deprecated/<name>.md`（ADR）或 `docs/_deprecated/<name>.md`（其他）
2. frontmatter：ADR 设 `adr_status: Superseded` 或 `Deprecated`；`status` 字段保持 `active`（归档路径下 `status` 冗余；详见 [`../standards/metadata.md`](../standards/metadata.md)）
3. 更新所有引用该文档的相对链接到新路径

> **可选**：正文顶部加 banner（`> **已被 [ADR-XXXX](../XXXX-...md) 取代，仅供审计追溯**`）供人类读者快速识别。这是**纯 UX 提示，不是流程步骤**——路径已承担主责，banner 只是额外双保险，不作强制。

## `scripts/docs-read` 三种模式

`scripts/docs-read` 不是读文档的强制入口（项目已把主责交给路径），但仍服务三个场景：

| 命令 | 场景 | 返回 |
|---|---|---|
| `scripts/docs-read --head <path>` | 泛读：只看 frontmatter 判断是否相关 | 仅 frontmatter |
| `scripts/docs-read --force <path>` | 读被 hook 拦截的文档（归档 / 外部导向）：hook 拦 Read 后的唯一合法入口 | 全文 + stderr 告警（两类场景都有） |
| `scripts/docs-read <path>` | placeholder 兜底 / 状态漂移兜底：`status: placeholder` 或 `deprecated` 文档位于 active 路径时，降级为 frontmatter + 提示 | active 全文 / 漂移则 frontmatter |

## `pretool-read-guard` hook

项目不假定协作者使用哪种 agent，`.claude/` / `.codex/` 等本地配置不入库（见 `.gitignore`）。但提供通用守卫 `scripts/pretool-read-guard`，任何支持 PreToolUse hook 的 harness 都能接入：

- 命中 `docs/dev/adr/deprecated/**` 或 `docs/_deprecated/**` 的 `Read` → block（归档，stderr 指引走 `docs-read --force`）
- 命中仓库根 `README.md` / `CONTRIBUTING.md` 的 `Read` → block（外部导向，stderr 指引走 `docs-read --force`）
- 其他一切 Read → 放行（含 `AGENTS.md` / `CHANGELOG.md` / active 的 `docs/**/*.md`）

### Claude Code 集成示例（其他 harness 按自身 hook 机制对等挂接）

本地创建 `.claude/settings.json`（不会被提交）：

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Read",
        "hooks": [
          { "type": "command", "command": "scripts/pretool-read-guard" }
        ]
      }
    ]
  }
}
```

其他 harness 按自身文档在 PreToolUse 挂 `scripts/pretool-read-guard`，脚本读 stdin JSON 判断，通用。

### 不配 hook 的后果

本文件 §路径分层与放行/拦截规则 仍然生效；少了 harness 兜底，依赖 agent 纪律与 reviewer 把关。`pretool-read-guard` 是协作约束，不是强一致安全边界——它只拦支持 PreToolUse hook 的 harness 的 `Read` 工具，拦不住 shell（`cat`、`curl`、`grep` 全文）。所以这套机制的最终防线仍然是：路径本身就是"已作废"的信号 + reviewer 在 PR 里发现基于归档内容做决策时要求重做。
