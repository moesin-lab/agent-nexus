---
title: AGENTS.md（agent-nexus 项目规则）
type: root
status: active
summary: 项目特有协作规则入口，叠加在全局 md 之上，定义十条不可违反的核心原则与 PR 三问
tags: [workflow, tdd, code-review, subagent, commit, ssot]
related:
  - root/CONTRIBUTING
  - dev/process/workflow
  - dev/process/tdd
  - dev/process/code-review
  - dev/process/subagent-usage
  - dev/process/doc-layering
  - dev/adr/0008-doc-layering-ssot
---

# AGENTS.md

> 本文件是协作规则的**入口索引**，叠加在各 harness 自身的全局规则之上。具体规则展开在 `docs/dev/process/` 下对应文件。规则冲突时，本文件和 `docs/dev/` 下的项目文档优先。

## 核心原则（不可违反）

1. **分支先行**：所有改动（含文档、错别字、依赖补丁）必须先从 `main` checkout 新分支再动手；禁止在 `main` 上直接编辑或 commit 未合入的改动。理由：
  a. PR 是 codex review / ultrareview 反馈与作者回应的承载窗口（review 本身手动触发，但 diff、评论、决策记录都挂在 PR 上）；
  b. 分支隔离让每次改动独立可回滚、强制范围收敛；
  c. 为未来分支保护、自动化 CI/review hook、required reviewers 留出落点。细节见 [`docs/dev/process/commit-and-branch.md`](docs/dev/process/commit-and-branch.md)。
2. **文档先行**：新模块没进 `docs/dev/spec/` 不接受 PR；架构级改动没进 `docs/dev/adr/` 不接受 PR。
3. **TDD 强制**：先 spec → 先 failing test → 再 impl。细节见 [`docs/dev/process/tdd.md`](docs/dev/process/tdd.md)。
4. **契约先行**：跨模块交互必须走 `docs/dev/spec/` 定义的接口。新增能力先改 spec，再改代码。
5. **Code review 不走过场**：每个 PR 必须过 codex review（大变更走 ultrareview）。流程见 [`docs/dev/process/code-review.md`](docs/dev/process/code-review.md)。
6. **Subagent 优先**：探索类、长研究类任务优先派发子代理，主 session 只做收敛与决策。细节见 [`docs/dev/process/subagent-usage.md`](docs/dev/process/subagent-usage.md)。
7. **范围收敛**：每个 PR 只做一件事，禁止"顺手重构"无关代码。
8. **Conventional Commits**：所有提交遵循 [`docs/dev/process/commit-and-branch.md`](docs/dev/process/commit-and-branch.md)。
9. **作废文档物化到归档目录**：Superseded ADR 和明确 Deprecated 的文档必须住在 `docs/dev/adr/deprecated/` 或 `docs/_deprecated/`——路径本身就是"别当事实"的信号。active 路径下的文档（含 placeholder）可直接 `Read`；归档路径的文档由 hook 拦截，必须走 `scripts/docs-read --force`。详见下文"读文档的防污染规则"。
10. **SSOT（单一信息源）**：每条事实只在唯一合适的层定义一次，其他层只 link 不复述。文档维度通过三层职责互斥实现——ADR 回答"为什么"、spec 回答"是什么 / 长什么样"、architecture 回答"怎么组合"，每层有禁入清单（如 ADR 不得含接口签名、spec 不得含决策论述）。代码与设计同理：跨模块契约只在 spec 维护，代码 import 而非重声明。决策依据见 [ADR-0008](docs/dev/adr/0008-doc-layering-ssot.md)，规则本体见 [`docs/dev/process/doc-layering.md`](docs/dev/process/doc-layering.md)。

## 读文档的防污染规则

| 路径 | Read 行为 |
|---|---|
| `AGENTS.md` / `CHANGELOG.md` / active 的 `docs/**` | **放行** |
| `docs/**` 下 `status: placeholder` 骨架 | **放行**（不归档；`placeholder` 承担信息架构占位作用，搬去归档会误读为主题废弃） |
| `docs/dev/adr/deprecated/**` / `docs/_deprecated/**`（归档） | **拦截** → `scripts/docs-read --force` |
| 仓库根 `README.md` / `CONTRIBUTING.md`（外部导向） | **拦截** → `scripts/docs-read --force` |

`scripts/docs-read --force` 是被 hook 拦后的**唯一合法入口**——为"研究历史 / 核对外部文案"等正当用途留的兜底，不是常规读法。

**违反后果**：reviewer 在 PR 里看到基于归档文档做的决策（作者未显式声明研究历史），应要求重做——过时内容进决策链后整条链条都要重新验证。

更多入口：

- 把文档作废 / 改 status → 见 [`docs/dev/process/docs-read.md` §"作废工作流"](docs/dev/process/docs-read.md#作废工作流)
- `docs-read` 三模式 / `pretool-read-guard` hook 集成 → 见 [`docs/dev/process/docs-read.md`](docs/dev/process/docs-read.md)

## 每个 PR 必答三问

作者在 PR 描述里自答，reviewer 照此验收：

1. **对应哪条 ADR？**（无需 ADR 时说明理由）
2. **对应哪个 spec？**（纯实现细节可注明 N/A）
3. **对应哪些测试？**（列出新增/修改的测试文件与断言）

三问缺一，reviewer 有义务要求补齐或直接拒绝。

## 本项目特有的反模式

以下行为在本项目**明确禁止**：

- 没有 ADR 就做架构级改动（例如新增一个 IM 平台、换 agent 后端、改 session 模型）
- 没有 spec 就开始写模块代码
- 把观测性、幂等、限流"留到以后做"——这些由 daemon 强制提供，第一版就必须有
- 适配器（platform、agent）自己实现日志格式、错误处理、重试策略——必须复用 daemon 提供的基础设施
- 在 IM 里回显绝对路径、env、token、内部错误栈——必须经过 daemon 的脱敏层
- PR 里混多件事（"顺便改了下 X"）——单一关注点原则
- 为了赶时间跳过 codex review——大变更必须 review
- 派发 subagent 后主 session 又把同样的探索做一遍——相信子代理的产出，主 session 只做收敛

## 协作性 skill 挂接

协作性 skill（见 [ADR-0007](docs/dev/adr/0007-collaborative-skill-promotion.md)）入库在仓库根 `skills/`，由 [`skills.manifest`](skills.manifest) 声明；各 harness 的 skill 目录 gitignored，**首次 clone 或 skill 结构变更后必须挂接**，否则静默不触发。挂接方式与新增清单见 [`docs/dev/process/skill-setup.md`](docs/dev/process/skill-setup.md)。

## harness-neutral 文档约定

仓库的协作文档（`AGENTS.md` / `docs/dev/**` / `skills/<name>/SKILL.md`）默认面向**任意 harness 的读者**，不预设某个具体 harness 是参考实现。即使用 `<harness>: <X>` 这样的限定语把 harness 名写进正文，也会让读者把"参考实现"读成"标准做法"，造成隐性偏差。

判定矩阵：

| 类别 | 处理 |
|---|---|
| 通用协作概念（跨 harness 共通词，如 `subagent` / `session` / `本地记忆` / `harness 全局规则文件`） | **直接用** |
| harness 特有具体物（执行器名、API、路径、脚本、harness 专属术语） | **下沉到 per-harness 子节**——正文只用泛化措辞，具体细节放文档末 §"Harness 实现注记"或 §"Per-harness 实现"等显式 per-harness 区域 |
| 项目事实陈述（ADR / spec 决策本身就锁定具体 harness） | 直陈即可——这是项目事实，不是把读者默认成某个 harness |

**per-harness 区域不受本约定**（可直接用具体 harness 工具名、路径、脚本）：

- 各 harness 私有配置目录（`.claude/` / `.codex/` / `.cursor/` 等）
- `skills/<name>/harnesses/<harness>/SKILL.md`（per-harness 执行器）
- harness-neutral 文档内的显式 per-harness 子节（如 §"Harness 实现注记 / Claude Code"）

本约定**仅约束协作文档**（前述三类：`AGENTS.md` / `docs/dev/**` / `skills/<name>/SKILL.md`）；运行时草稿（`.tasks/` / `handoff/`）不属于协作文档，自然不在管辖范围。

**违反后果**：reviewer 看到 harness-neutral 文档正文把读者默认成某个 harness，应要求修正——其他 harness 的读者会误判自己该用什么工具，"参考实现"被误读成"标准做法"。

## 文件定位速查

| 想做什么 | 先看哪里 |
|---|---|
| 开新模块 | `docs/dev/process/workflow.md` |
| 写测试 | `docs/dev/process/tdd.md` + `docs/dev/testing/strategy.md` |
| 发 PR | `docs/dev/process/code-review.md` + 本文件"三问" |
| 写日志 | `docs/dev/standards/logging.md` + `docs/dev/spec/infra/observability.md` |
| 处理错误 | `docs/dev/standards/errors.md` |
| 做架构决策 | `docs/dev/adr/README.md` + `docs/dev/adr/template.md` |
| 判断某段内容该写在哪一层（ADR / spec / architecture） | `docs/dev/process/doc-layering.md` |
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

## 本文件不做的事

- 不展开具体规则——展开在 `docs/dev/` 下
- 不替代全局 `AGENTS.md` 文件——只在项目内追加与覆盖
- 不对使用者做说明——使用者文档在 `docs/product/`
