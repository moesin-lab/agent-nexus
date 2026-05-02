---
title: AGENTS.md（agent-nexus 项目规则入口）
type: root
status: active
summary: 项目协作规则入口索引；规则本体在 docs/dev/ 按 doc-ownership 矩阵分布，本文件只承载 owner 在自身的三段（PR 三问 / Deletion test / 读文档防污染）与文件定位速查
tags: [workflow, navigation, ssot]
related:
  - root/CONTRIBUTING
  - dev/standards/doc-ownership
  - dev/process/workflow
---

# AGENTS.md

> 本文件是协作规则的**入口索引**，叠加在各 harness 自身的全局规则之上。规则本体在 [`docs/dev/`](docs/dev/) 下按 [doc-ownership 矩阵](docs/dev/standards/doc-ownership.md) 分布；本文件只承载 owner 在自身的三段（PR 三问 / Deletion test / 读文档防污染规则）与文件定位速查。

## 核心原则（不可违反）

每条原则的本体（理由、做 / 不做对照、reviewer 拒稿条件）由 owner 文档承载，本文件只列陈述 + 单链接。

1. **分支先行**：所有改动从 `main` checkout 新分支再动手 → [`workflow.md` §分支先行](docs/dev/process/workflow.md#分支先行不可跳过)
2. **文档先行**：新模块 / 架构改动须先有 spec / ADR → [`spec/README.md` §什么情况写 spec](docs/dev/spec/README.md#什么情况写-spec) + [`adr/README.md` §什么情况写 ADR](docs/dev/adr/README.md#什么情况写-adr)
3. **TDD 强制**：先 spec → 先 failing test → 再 impl → [`tdd.md`](docs/dev/process/tdd.md)
4. **契约先行**：跨模块交互走 spec 接口，新增能力先改 spec → [`spec/README.md` §核心原则](docs/dev/spec/README.md#核心原则)
5. **Code review 不走过场**：每 PR 过 codex review，大变更走 ultrareview → [`code-review.md`](docs/dev/process/code-review.md)
6. **Subagent 优先**：探索 / 研究类派子代理，主 session 只做收敛 → [`subagent-usage.md`](docs/dev/process/subagent-usage.md)
7. **范围收敛**：每 PR 只做一件事 → [`code-review.md` §自查清单](docs/dev/standards/code-review.md#自查清单合格条件)
8. **Conventional Commits** → [`commit-style.md`](docs/dev/standards/commit-style.md)
9. **作废文档物化到归档目录**：路径本身就是"别当事实"的信号 → [`docs-read.md` §作废工作流](docs/dev/process/docs-read.md#作废工作流)
10. **SSOT**：每条事实只在唯一 owner 定义，其他只 link 不复述 → [`doc-ownership.md`](docs/dev/standards/doc-ownership.md)

## 读文档的防污染规则

| 路径 | Read 行为 |
|---|---|
| `AGENTS.md` / `CHANGELOG.md` / active 的 `docs/**` | 放行 |
| `docs/**` 下 `status: placeholder` 骨架 | 放行（不归档；占位用） |
| `docs/dev/adr/deprecated/**` / `docs/_deprecated/**` | 拦截 → `scripts/docs-read --force` |
| 仓库根 `README.md` / `CONTRIBUTING.md` | 拦截 → `scripts/docs-read --force` |

**违反后果**：reviewer 在 PR 里看到基于归档文档做的决策（作者未显式声明研究历史），应要求重做——过时内容进决策链后整条链条都要重新验证。

机制细节（作废工作流 / `scripts/docs-read` 三模式 / `pretool-read-guard` hook 集成 / 不配 hook 的后果）见 [`docs/dev/process/docs-read.md`](docs/dev/process/docs-read.md)。

## 每个 PR 必答三问

作者在 PR 描述里自答，reviewer 照此验收：

1. **对应哪条 ADR？**（无需 ADR 时说明理由）
2. **对应哪个 spec？**（纯实现细节可注明 N/A）
3. **对应哪些测试？**（列出新增/修改的测试文件与断言）

三问缺一，reviewer 有义务要求补齐或直接拒绝。

## 加抽象前的 Deletion test

新增任何包装层、小函数抽出、文件拆分、facade 前，问自己：**假想删掉它，复杂度消散还是扇出到 N 个 caller？** 消散 = pass-through，别加；扇出 = 真在收复杂度，加。

特别警惕"为测试性抽出的纯函数"：单测漂亮，bug 却躲在 caller 怎么把参数喂进来，抽完反而要跨文件追 bug。这种情况下测真实接线（integration test through the seam），而不是抽纯函数。

例外：契约先行的 spec 接口（`PlatformAdapter` / `AgentRuntime` 等）由 ADR 决定形状，不走此判据。

reviewer 可据此直接拒稿——"过不了 deletion test"是合法的 review 理由。

## 文件定位速查

| 想做什么 | 先看哪里 |
|---|---|
| 开新模块 | `docs/dev/process/workflow.md` |
| 接到需求后该问哪些反问问题（澄清环节） | `docs/dev/process/requirement-clarification.md` |
| 写测试 | `docs/dev/process/tdd.md` + `docs/dev/testing/strategy.md` |
| 发 PR | `docs/dev/process/code-review.md` + 本文件 §"每个 PR 必答三问" |
| 写代码（命名 / 函数长度 / 注释 / 模块深度） | `docs/dev/standards/coding.md` |
| 写日志 | `docs/dev/standards/logging.md` + `docs/dev/spec/infra/observability.md` |
| 处理错误 | `docs/dev/standards/errors.md` |
| 写文档（结构 / 风格 / 中英排 / harness-neutral 约定） | `docs/dev/standards/docs-style.md` |
| 做架构决策 | `docs/dev/adr/README.md` + `docs/dev/adr/template.md` |
| 判断是否应该加抽象（包装层、小函数、facade、文件拆分） | 本文件 §"加抽象前的 Deletion test" + `docs/dev/standards/coding.md` §模块深度评估 |
| 判断某段内容该写在哪个事实 owner | `docs/dev/standards/doc-ownership.md` |
| 做需要人类拍板的结构化分析（评估 / 对比 / 拆解） | `docs/dev/process/pre-decision-analysis/README.md` |
| 增 / 删协作性 skill | `docs/dev/process/skill-setup.md` + `docs/dev/adr/0007-collaborative-skill-promotion.md` + `skills.manifest` |
| 沉淀经验 / 被纠正后该不该记 | `docs/dev/process/self-refinement/README.md` |
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
