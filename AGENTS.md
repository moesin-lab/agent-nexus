---
title: AGENTS.md（agent-nexus 项目规则入口）
type: root
status: active
summary: 项目协作规则入口索引；规则本体在 docs/dev/ 按 doc-ownership 矩阵分布，本文件只承载十条核心原则的陈述与文件定位速查
tags: [workflow, navigation, ssot]
related:
  - root/CONTRIBUTING
  - dev/standards/doc-ownership
  - dev/process/workflow
---

# AGENTS.md

> 本文件是协作规则的**入口索引**，叠加在各 harness 自身的全局规则之上。规则本体在 [`docs/dev/`](docs/dev/) 下按 [doc-ownership 矩阵](docs/dev/standards/doc-ownership.md) 分布；本文件只承载十条核心原则的陈述与文件定位速查。

## 核心原则（不可违反）

每条原则的本体（理由、做 / 不做对照、reviewer 拒稿条件）由 owner 文档承载，本文件只列陈述 + 单链接。

1. **分支先行**：所有改动从 `main` checkout 新分支再动手 → [`workflow.md` §分支先行](docs/dev/process/workflow.md#分支先行不可跳过)
2. **文档先行**：新模块 / 架构改动须先有 spec / ADR → [`spec/README.md` §什么情况写 spec](docs/dev/spec/README.md#什么情况写-spec) + [`adr/README.md` §什么情况写 ADR](docs/dev/adr/README.md#什么情况写-adr)
3. **TDD 强制**：先 spec → 先 failing test → 再 impl → [`tdd.md`](docs/dev/process/tdd.md)
4. **契约先行**：跨模块交互走 spec 接口，新增能力先改 spec → [`spec/README.md` §核心原则](docs/dev/spec/README.md#核心原则)
5. **Code review 不走过场**：每 PR 过 codex review，大变更走 ultrareview；PR 必答三问 → [`code-review.md`](docs/dev/process/code-review.md) + [`code-review.md` §PR 必答三问](docs/dev/process/code-review.md#pr-必答三问)
6. **Subagent 优先**：探索 / 研究类派子代理，主 session 只做收敛 → [`subagent-usage.md`](docs/dev/process/subagent-usage.md)
7. **范围收敛**：每 PR 只做一件事 → [`code-review.md` §自查清单](docs/dev/standards/code-review.md#自查清单合格条件)
8. **Conventional Commits** → [`commit-style.md`](docs/dev/standards/commit-style.md)
9. **作废文档物化到归档目录**：路径本身就是"别当事实"的信号；防污染规则与 hook 集成 → [`docs-read.md`](docs/dev/process/docs-read.md)
10. **SSOT**：每条事实只在唯一 owner 定义，其他只 link 不复述 → [`doc-ownership.md`](docs/dev/standards/doc-ownership.md)

## 文档读取约定（渐进式披露）

为避免无关全文进 context：

- 不确定一份文档是否相关时，先 `scripts/docs-read --head <path>` 看 frontmatter（`summary` / `related`）判断；命中再决定全读
- active 路径的 `docs/**` 可直接 `Read`；归档（`docs/dev/adr/deprecated/**` / `docs/_deprecated/**`）与外部导向（仓库根 `README.md` / `CONTRIBUTING.md`）的 `Read` 由 hook 拦截，需走 `scripts/docs-read --force`
- 完整路径分层、三种模式、`pretool-read-guard` hook 集成、违反后果见 [`docs/dev/process/docs-read.md`](docs/dev/process/docs-read.md)

## 文件定位速查

| 想做什么 | 先看哪里 |
|---|---|
| 看仓库架构总览 / 模块拓扑 | `docs/dev/architecture/overview.md` |
| 开新 package（agent / platform / daemon 子模块） | `docs/dev/process/workflow.md` |
| 改 package import / 依赖方向 | `docs/dev/architecture/dependencies.md` |
| 起 ADR / spec 前 surface 邻接维度 | `docs/dev/process/requirement-clarification.md` |
| 新增 / 修改测试 | `docs/dev/process/tdd.md` + `docs/dev/testing/strategy.md` |
| 判一个测试写法是否合格 | `docs/dev/standards/testing.md` |
| 改 / 跑 eval（对话质量回归） | `docs/dev/testing/eval.md` |
| 写 / 维护 fixture | `docs/dev/testing/fixtures.md` |
| 开 PR / codex review 触发 | `docs/dev/process/code-review.md` |
| commit 流程编排（合并策略 / stacked PR） | `docs/dev/process/commit-and-branch.md` |
| 写 commit message / 给分支命名 | `docs/dev/standards/commit-style.md` |
| 判命名 / 函数 / 模块边界 / 注释 / 依赖引入是否合格 | `docs/dev/standards/coding.md` |
| 引入 / 升级依赖 | `docs/dev/standards/dependencies.md` |
| 写日志（写法约束） | `docs/dev/standards/logging.md` |
| 改日志 / trace 字段契约 | `docs/dev/spec/infra/observability.md` |
| 处理错误（写法约束） | `docs/dev/standards/errors.md` |
| 改错误对象字段契约 | `docs/dev/spec/infra/errors.md` |
| 写文档（语言 / 格式 / frontmatter / 篇幅 / 中英排） | `docs/dev/standards/docs-style.md` |
| Read 被 hook 拦的文档 / 文档作废流程 | `docs/dev/process/docs-read.md` |
| 起新 ADR | `docs/dev/adr/README.md` + `docs/dev/adr/template.md` |
| 判断要不要加包装 / 拆函数 / 拆文件 | `docs/dev/standards/coding.md` §加抽象前的 Deletion test |
| 决定一段内容该住到哪份 owner 文档 | `docs/dev/standards/doc-ownership.md` |
| 做需要人类拍板的结构化分析 | `docs/dev/process/pre-decision-analysis/README.md` + `docs/dev/standards/pre-decision-analysis/README.md` |
| 派 subagent / 收敛子代理产出 | `docs/dev/process/subagent-usage.md` |
| 评估子任务是否适合派发 / 写 prompt | `docs/dev/standards/subagent-usage.md` |
| 增 / 删协作性 skill | `docs/dev/process/skill-setup.md` + `skills.manifest` |
| 被纠正后该不该沉淀 | `docs/dev/process/self-refinement/README.md` |
| 接入新 IM 平台 | `docs/dev/spec/platform-adapter.md` |
| 集成新 agent 后端 | `docs/dev/spec/agent-runtime.md`（接口契约；参考现有实现见 `docs/dev/spec/agent-backends/claude-code-cli.md`） |
| 改归一化消息格式 / 事件字段 | `docs/dev/spec/message-protocol.md` |
| 查 dispatch pipeline 全链路 | `docs/dev/spec/message-flow.md` |
| 改身份 allowlist / 会话绑定规则 | `docs/dev/spec/security/auth.md` |
| 改工具边界 | `docs/dev/spec/security/tool-boundary.md` |
| 改密钥存储 / 加载策略 | `docs/dev/spec/security/secrets.md` |
| 改脱敏规则 | `docs/dev/spec/security/redaction.md` |
| 改幂等 / 去重 | `docs/dev/spec/infra/idempotency.md` |
| 改 limits / 预算 | `docs/dev/spec/infra/cost-and-limits.md` |
| 改 SessionKey / 会话状态机 / 顺序与恢复 | `docs/dev/architecture/session-model.md` |
| 改存储 schema | `docs/dev/spec/infra/persistence.md` |
| 查威胁模型 / 跨分区安全索引 | `docs/dev/spec/security/README.md` |
