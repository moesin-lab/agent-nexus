---
title: AGENTS.md（agent-nexus 项目规则）
type: root
status: active
summary: 项目特有协作规则入口，叠加在全局 ~/.claude/CLAUDE.md 之上，定义七条不可违反的核心原则与 PR 三问
tags: [workflow, tdd, code-review, subagent, commit]
related:
  - root/CONTRIBUTING
  - dev/process/workflow
  - dev/process/tdd
  - dev/process/code-review
  - dev/process/subagent-usage
---

# AGENTS.md（agent-nexus 项目规则）

> 本文件是协作规则的**入口索引**，叠加在全局 `~/.claude/CLAUDE.md` 之上。具体规则展开在 `docs/dev/process/` 下对应文件。规则冲突时，本文件和 `docs/dev/` 下的项目文档优先。

## 核心原则（不可违反）

1. **文档先行**：新模块没进 `docs/dev/spec/` 不接受 PR；架构级改动没进 `docs/dev/adr/` 不接受 PR。
2. **TDD 强制**：先 spec → 先 failing test → 再 impl。细节见 [`docs/dev/process/tdd.md`](docs/dev/process/tdd.md)。
3. **契约先行**：跨层交互必须走 `docs/dev/spec/` 定义的接口。新增能力先改 spec，再改代码。
4. **Code review 不走过场**：每个 PR 必须过 codex review（大变更走 ultrareview）。流程见 [`docs/dev/process/code-review.md`](docs/dev/process/code-review.md)。
5. **Subagent 优先**：探索类、长研究类任务优先派发子代理，主 session 只做收敛与决策。细节见 [`docs/dev/process/subagent-usage.md`](docs/dev/process/subagent-usage.md)。
6. **范围收敛**：每个 PR 只做一件事，禁止"顺手重构"无关代码。
7. **Conventional Commits**：所有提交遵循 [`docs/dev/process/commit-and-branch.md`](docs/dev/process/commit-and-branch.md)。
8. **过时文档物化到归档目录**：Superseded / Deprecated / placeholder 的文档必须住在 `docs/dev/adr/superseded/` 或 `docs/_archive/`——路径本身就是"别当事实"的信号。active 路径下的文档可直接 `Read`；归档路径的文档由 hook 拦截，必须走 `scripts/docs-read --force`。详见下文"读文档的防污染规则"。

## 读文档的防污染规则

### 核心机制：状态物化到目录

文档的权威性**长在路径里**，不依赖读者看 frontmatter 自觉过滤：

| 状态 | 住在哪 | Read 工具行为 |
|---|---|---|
| `active`（权威事实） | `docs/**`（默认路径） | **放行**：可直接 `Read` |
| Superseded ADR | `docs/dev/adr/superseded/**` | **hook 拦截**：必须走 `scripts/docs-read --force` |
| Deprecated / placeholder | `docs/_archive/**` | **hook 拦截**：必须走 `scripts/docs-read --force` |

路径本身就是"别当事实来源"的信号。GitHub web、grep、curl、任何入口打开归档文档都能立刻识别——不依赖任何基础设施。

### 状态变更工作流

一份文档状态变为 Superseded / Deprecated / placeholder 时：

1. `git mv <path> docs/dev/adr/superseded/<name>.md`（ADR）或 `docs/_archive/<name>.md`（其他）
2. frontmatter 同步更新 `status:` 字段（例：`active` → `superseded`）
3. 正文顶部建议加 banner：`> **已被 [ADR-XXXX](../XXXX-...md) 取代，仅供审计追溯**`
4. 更新所有引用该文档的相对链接到新路径

state 与 location 必须**同一个 commit 内改**，避免漂移。

### docs-read 的三种模式

`scripts/docs-read` 不再是读文档的**强制入口**，但仍服务三个场景：

| 命令 | 场景 | 返回 |
|---|---|---|
| `scripts/docs-read --head <path>` | 泛读：只看 frontmatter 判断是否相关 | 仅 frontmatter |
| `scripts/docs-read --force <path>` | 读归档文档：hook 拦 Read 后的唯一合法入口 | 全文 + stderr 告警 |
| `scripts/docs-read <path>` | 兜底：active 路径下若 frontmatter 状态漂移（未 `git mv` 归档），降级为 frontmatter + 提示应归档 | active 全文 / 漂移则 frontmatter |

### pretool-read-guard（hook）

项目不假定协作者使用哪种 agent，`.claude/` / `.codex/` 等本地配置不入库（见 `.gitignore`）。但我们提供通用守卫 `scripts/pretool-read-guard`，任何支持 PreToolUse hook 的 harness 都能接入：

- 命中 `docs/dev/adr/superseded/**` 或 `docs/_archive/**` 的 `Read` → block，stderr 指引走 `docs-read --force`
- 其他一切 Read → 放行

#### Claude Code 集成示例

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

#### 不配 hook 的后果

AGENTS.md 的路径约定仍然生效；少了 harness 兜底，依赖 agent 纪律与 reviewer 把关。

### 违反的后果

reviewer 在 PR 里看到基于归档文档做的决策（而作者没显式声明是在研究历史），应要求重做——过时内容进决策链后整条链条都要重新验证。

## 每个 PR 必答三问

作者在 PR 描述里自答，reviewer 照此验收：

1. **对应哪条 ADR？**（无需 ADR 时说明理由）
2. **对应哪个 spec？**（纯实现细节可注明 N/A）
3. **对应哪些测试？**（列出新增/修改的测试文件与断言）

三问缺一，reviewer 有义务要求补齐或直接拒绝。

## 沟通与输出

遵循全局 `~/.claude/CLAUDE.md` 约定：

- 全程使用中文
- 表达直接、克制、无废话
- 长输出分段 check in，不为凑长度被截断

## 本项目特有的反模式（来自 cc-connect 教训）

以下行为在本项目**明确禁止**：

- 没有 ADR 就做架构级改动（例如新增一个 IM 平台、换 agent 后端、改 session 模型）
- 没有 spec 就开始写模块代码
- 把观测性、幂等、限流"留到以后做"——这些在 `core` 层强制，第一版就必须有
- 适配器（platform、agent）自己实现日志格式、错误处理、重试策略——必须复用 `core` 提供的基础设施
- 在 IM 里回显绝对路径、env、token、内部错误栈——必须经过 `core` 的脱敏层
- PR 里混多件事（"顺便改了下 X"）——单一关注点原则
- 为了赶时间跳过 codex review——大变更必须 review
- 派发 subagent 后主 session 又把同样的探索做一遍——相信子代理的产出，主 session 只做收敛

## 文件定位速查

| 想做什么 | 先看哪里 |
|---|---|
| 开新模块 | `docs/dev/process/workflow.md` |
| 写测试 | `docs/dev/process/tdd.md` + `docs/dev/testing/strategy.md` |
| 发 PR | `docs/dev/process/code-review.md` + 本文件"三问" |
| 写日志 | `docs/dev/standards/logging.md` + `docs/dev/spec/infra/observability.md` |
| 处理错误 | `docs/dev/standards/errors.md` |
| 做架构决策 | `docs/dev/adr/README.md` + `docs/dev/adr/template.md` |
| 接入新 IM 平台 | `docs/dev/spec/platform-adapter.md` |
| 集成新 agent 后端 | `docs/dev/spec/agent-runtime.md` + `docs/dev/spec/agent-backends/claude-code-cli.md` |
| 改权限/身份 | `docs/dev/spec/security/auth.md` |
| 改工具边界 | `docs/dev/spec/security/tool-boundary.md` |
| 改密钥处理 | `docs/dev/spec/security/secrets.md` |
| 改脱敏规则 | `docs/dev/spec/security/redaction.md` |
| 改幂等/去重 | `docs/dev/spec/infra/idempotency.md` |
| 改 limits / 预算 | `docs/dev/spec/infra/cost-and-limits.md` |
| 改存储 schema | `docs/dev/spec/infra/persistence.md` |
| 威胁模型与跨分区安全索引 | `docs/dev/spec/security/README.md` |

## 本文件不做的事

- 不展开具体规则——展开在 `docs/dev/` 下
- 不替代全局 `~/.claude/CLAUDE.md`——只在项目内追加与覆盖
- 不对使用者做说明——使用者文档在 `docs/product/`
