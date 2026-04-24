---
title: AGENTS.md（agent-nexus 项目规则）
type: root
status: active
summary: 项目特有协作规则入口，叠加在全局 md 之上，定义九条不可违反的核心原则与 PR 三问
tags: [workflow, tdd, code-review, subagent, commit]
related:
  - root/CONTRIBUTING
  - dev/process/workflow
  - dev/process/tdd
  - dev/process/code-review
  - dev/process/subagent-usage
---

# AGENTS.md

> 本文件是协作规则的**入口索引**，叠加在全局 `~/.claude/CLAUDE.md` 之上。具体规则展开在 `docs/dev/process/` 下对应文件。规则冲突时，本文件和 `docs/dev/` 下的项目文档优先。

## 核心原则（不可违反）

1. **分支先行**：所有改动（含文档、错别字、依赖补丁）必须先从 `main` checkout 新分支再动手；禁止在 `main` 上直接编辑或 commit 未合入的改动。理由：
  a. PR 是 codex review / ultrareview 反馈与作者回应的承载窗口（review 本身手动触发，但 diff、评论、决策记录都挂在 PR 上）；
  b. 分支隔离让每次改动独立可回滚、强制范围收敛；
  c. 为未来分支保护、自动化 CI/review hook、required reviewers 留出落点。细节见 [`docs/dev/process/commit-and-branch.md`](docs/dev/process/commit-and-branch.md)。
2. **文档先行**：新模块没进 `docs/dev/spec/` 不接受 PR；架构级改动没进 `docs/dev/adr/` 不接受 PR。
3. **TDD 强制**：先 spec → 先 failing test → 再 impl。细节见 [`docs/dev/process/tdd.md`](docs/dev/process/tdd.md)。
4. **契约先行**：跨层交互必须走 `docs/dev/spec/` 定义的接口。新增能力先改 spec，再改代码。
5. **Code review 不走过场**：每个 PR 必须过 codex review（大变更走 ultrareview）。流程见 [`docs/dev/process/code-review.md`](docs/dev/process/code-review.md)。
6. **Subagent 优先**：探索类、长研究类任务优先派发子代理，主 session 只做收敛与决策。细节见 [`docs/dev/process/subagent-usage.md`](docs/dev/process/subagent-usage.md)。
7. **范围收敛**：每个 PR 只做一件事，禁止"顺手重构"无关代码。
8. **Conventional Commits**：所有提交遵循 [`docs/dev/process/commit-and-branch.md`](docs/dev/process/commit-and-branch.md)。
9. **作废文档物化到归档目录**：Superseded ADR 和明确 Deprecated 的文档必须住在 `docs/dev/adr/deprecated/` 或 `docs/_deprecated/`——路径本身就是"别当事实"的信号。active 路径下的文档（含 placeholder）可直接 `Read`；归档路径的文档由 hook 拦截，必须走 `scripts/docs-read --force`。详见下文"读文档的防污染规则"。

## 读文档的防污染规则

### 核心机制：非权威源的 Read 由 hook 拦截

防污染的真正靶子是"让 agent 把非事实内容当事实用"。两类非权威源需要拦：① 归档文档（作废的历史内容）；② 面向外部的文档（`README.md` / `CONTRIBUTING.md`——语气偏向产品介绍与贡献指南，不是内部决策事实源）。

| 文档类别 | 住在哪 | Read 工具行为 |
|---|---|---|
| 内部权威规则 | `AGENTS.md` / `CLAUDE.md`（symlink → `AGENTS.md`） | **放行**：可直接 `Read` |
| 变更日志 | `CHANGELOG.md` | **放行**：事实类 |
| active 架构/spec/ADR | `docs/**` | **放行**：可直接 `Read` |
| `placeholder`（未完成骨架） | `docs/**`（默认路径，**不归档**） | **放行**：Read 可读全文（骨架通常极短；frontmatter `status: placeholder` 已是软告警）|
| **外部导向文档** | `README.md` / `CONTRIBUTING.md`（仓库根） | **hook 拦截**：必须走 `scripts/docs-read --force` |
| Superseded ADR | `docs/dev/adr/deprecated/**` | **hook 拦截**：必须走 `scripts/docs-read --force` |
| 其他明确作废的 active 文档 | `docs/_deprecated/**` | **hook 拦截**：必须走 `scripts/docs-read --force` |

对归档：路径本身就是"已作废"的信号；GitHub web / grep / curl 任何入口打开都能识别。

对外部导向文档：它们是写给仓库外部读者看的（潜在用户、贡献者），语气偏产品化与友好化；内部开发任务从中推断架构/契约会引入失真——agent 应读 `AGENTS.md`（内部协作规则）、`docs/dev/**`（架构/spec/ADR）或代码本身。只有"帮用户改 README/CONTRIBUTING 文案 / 核对外部描述与内部 spec 一致"这类正当用途才走 `--force`。

**范围刻意收窄**：方案只处理"曾是权威但已作废"的文档（Superseded ADR / 明确 Deprecated）+ 外部导向文档（README / CONTRIBUTING）。`placeholder`（骨架文档，未来会填）仍留在 active 路径——这些文档承担"信息架构占位"作用（章节存在感、导航表），搬去归档会让读者以为相关主题废弃了。placeholder 的污染风险靠两道兜住：① 骨架正文通常极短，看一眼就知道是占位；② `docs-read` 默认模式会对 `status: placeholder` 返回 frontmatter + 告警（见下文）。

### 作废工作流

一份文档状态变为 Superseded / Deprecated 时，**同一个 commit 内**完成：

1. `git mv <path> docs/dev/adr/deprecated/<name>.md`（ADR）或 `docs/_deprecated/<name>.md`（其他）
2. frontmatter：ADR 设 `adr_status: Superseded` 或 `Deprecated`；`status` 字段保持 `active`（归档路径下 `status` 冗余；详见 `docs/dev/standards/metadata.md`）
3. 更新所有引用该文档的相对链接到新路径

> **可选**：正文顶部加 banner（`> **已被 [ADR-XXXX](../XXXX-...md) 取代，仅供审计追溯**`）供人类读者快速识别。这是**纯 UX 提示，不是流程步骤**——路径已承担主责，banner 只是额外双保险，不作强制。

### docs-read 的三种模式

`scripts/docs-read` 不是读文档的**强制入口**（本项目已把主责交给路径），但仍服务三个场景：

| 命令 | 场景 | 返回 |
|---|---|---|
| `scripts/docs-read --head <path>` | 泛读：只看 frontmatter 判断是否相关 | 仅 frontmatter |
| `scripts/docs-read --force <path>` | 读被 hook 拦截的文档（归档 / 外部导向）：hook 拦 Read 后的唯一合法入口 | 全文 + stderr 告警（两类场景都有） |
| `scripts/docs-read <path>` | placeholder 兜底 / 状态漂移兜底：`status: placeholder` 或 `deprecated` 文档位于 active 路径时，降级为 frontmatter + 提示 | active 全文 / 漂移则 frontmatter |

### pretool-read-guard（hook）

项目不假定协作者使用哪种 agent，`.claude/` / `.codex/` 等本地配置不入库（见 `.gitignore`）。但我们提供通用守卫 `scripts/pretool-read-guard`，任何支持 PreToolUse hook 的 harness 都能接入：

- 命中 `docs/dev/adr/deprecated/**` 或 `docs/_deprecated/**` 的 `Read` → block（归档，stderr 指引走 `docs-read --force`）
- 命中仓库根 `README.md` / `CONTRIBUTING.md` 的 `Read` → block（外部导向，stderr 指引走 `docs-read --force`）
- 其他一切 Read → 放行（含 `AGENTS.md` / `CHANGELOG.md` / active 的 `docs/**/*.md`）

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

## 协作性 skill 挂接

协作性 skill（影响协作产出格式 / 需他人理解产物 / 多人共用；见 [ADR-0007](docs/dev/adr/0007-collaborative-skill-promotion.md)）入库在仓库根 `skills/`，由 [`skills.manifest`](skills.manifest) 声明。各 harness 的 skill 目录按"harness 配置不入库"约定 gitignored，**首次 clone 后或 skill 结构变更后必须挂接**，否则 skill 静默不触发。

挂接方式、目录分层、新增 skill 清单详见 [`docs/dev/process/skill-setup.md`](docs/dev/process/skill-setup.md)。纯个人偏好 skill 不在此范围。

## 文件定位速查

| 想做什么 | 先看哪里 |
|---|---|
| 开新模块 | `docs/dev/process/workflow.md` |
| 写测试 | `docs/dev/process/tdd.md` + `docs/dev/testing/strategy.md` |
| 发 PR | `docs/dev/process/code-review.md` + 本文件"三问" |
| 写日志 | `docs/dev/standards/logging.md` + `docs/dev/spec/infra/observability.md` |
| 处理错误 | `docs/dev/standards/errors.md` |
| 做架构决策 | `docs/dev/adr/README.md` + `docs/dev/adr/template.md` |
| 做需要人类拍板的结构化分析（评估 / 对比 / 拆解） | `docs/dev/process/pre-decision-analysis/README.md` |
| 增 / 删协作性 skill | `docs/dev/process/skill-setup.md` + `docs/dev/adr/0007-collaborative-skill-promotion.md` + `skills.manifest` |
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
