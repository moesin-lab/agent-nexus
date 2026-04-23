# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 规范，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

变更条目按语义分组：`Added` / `Changed` / `Deprecated` / `Removed` / `Fixed` / `Security`。

## [Unreleased]

### Added

- 项目初始化，建立开发文档体系骨架（架构 / ADR / spec / 流程 / 测试 / 规范）。
- 所有文档添加 YAML frontmatter 元信息（支持 agent 渐进式读取）；schema 规范见 `docs/dev/standards/metadata.md`。
- ADR-0005：订阅计费为一等用户路径（已被 ADR-0006 取代）。
- ADR-0006：Limits 分层——失控保护为一等，配额控制按用户路径可选。重新表述 0005 的决策精神；一等公民是"机制类别（防御失控 / 使用量观测）"而非"用户类型"；`$ 预算`与`订阅配额跟踪`并列为二等可选机制。

### Changed

- 重构 `spec/cost-and-limits.md`：一等 limits 为 turn/wall-clock/tool-call/并发/退避/熔断，$ 预算降为 opt-in；对应同步 `spec/observability.md`（新增 `turn_limit_hit` / `tool_limit_hit` / `wallclock_timeout` 事件与 `toolCallsThisTurn` / `wallClockMs` 字段）、`architecture/session-model.md`（Session 元数据结构）、`spec/persistence.md`（sessions 表字段；`budget_events` 重命名为 `usage_events`）、`testing/eval.md`（case 05 扩为 `resource-limit-hit`）。
- `spec/cost-and-limits.md` 二次修订（配合 ADR-0006）：开头重心从"订阅用户"改为"机制分层"；把"订阅配额跟踪"从"未来占位"提升为与 `$ 预算`并列的二等可选机制；合约测试增加"用户路径对称"case。
- 按 Codex review P0 反馈修订一轮（见 `reviews/2026-04-23-dev-docs-codex.md`）：
  - **幂等职责统一**：`architecture/overview.md` + `architecture/session-model.md` + `spec/message-protocol.md` 一致化为"adapter 只归一化投递；core 在 auth 之后、session 入队之前执行 `checkAndSet`"
  - **Allowlist 四元组**：`spec/security.md` 从"仅 userIds/roleIds"扩为 `(guildId, channelId, userId, roleIds)`；新增 `allowedGuildIds / allowedChannelIds / allowDM / requireMentionOrSlash`，fail-closed
  - **砍 shared_channel_mode**：`spec/security.md` MVP 移除（prompt injection 入口）；未来引入需新 ADR + untrusted 标注
  - **Discord 账号盗升格为核心威胁**：`spec/security.md` §威胁模型重写置顶；新增 `publicChannelMode` 默认 `thread`（公开 channel 自动转私有 thread）

### Added

- 新增 `spec/claude-code-cli-contract.md`：锁定 CC CLI 版本、启动命令模板、stream-json 协议、stdout 事件到 `AgentEvent` 的映射表、stop_reason 映射、`UsageCompleteness` 三档、中断/超时/崩溃处理链、兼容性自检（probe）、合约测试清单、兼容矩阵占位。`spec/README.md` 索引新增一类"Agent 后端专属契约"；`spec/agent-runtime.md` §CC CLI 专属说明瘦身为引用。

### Refactored

- 按职责单一原则（SRP）拆分 spec（由自审 + Codex review 驱动）：
  - **Security 分区**：`spec/security.md` 瘦身为"威胁模型 + 跨分区索引"，原聚合内容按独立职责拆出 `spec/auth.md`（身份 allowlist / 会话绑定 / publicChannelMode）、`spec/tool-boundary.md`（工具白名单 / 工作目录）、`spec/secrets.md`（密钥层级 / 禁写清单 / 轮换）、`spec/redaction.md`（Redactor 必过滤项 / 合约测试）。
  - **幂等独立**：`spec/idempotency.md` 新建，吸收原 `spec/message-protocol.md` §幂等 + `spec/cost-and-limits.md` §幂等表清理；原位置替换为指针。
  - **命名对齐 `architecture/overview.md` §横切关注点表**：`core.budget` 拆为 `core.counters`（一等 usage 记账）+ `core.quota-enforcer`（二等 $ 预算 opt-in），与 ADR-0006 一致；新增 `core.toolguard` / `core.secrets` 对齐新 spec。
  - **交叉引用统一**：`spec/README.md` 索引重排为"核心接口 / Agent 后端专属 / Security 分区 / 其他横切"四类；`AGENTS.md` 文件定位速查表新增 auth / tool-boundary / secrets / redaction / idempotency 五行；`architecture/session-model.md` §幂等机制收缩为指向 `idempotency.md` 的要点摘录。

本次拆分只动文件结构与命名，不引入新抽象（`MiddlewareChain` / `Session` aggregate 留待实现阶段前独立 PR）。

- **契约内部对齐（Codex review 方向 A）**：
  - `architecture/session-model.md` 状态机图补齐 `Interrupted` / `Errored` 及其转换；新增 sessionId / generation 概念（路由 key vs 持久化主键双层）
  - `spec/infra/persistence.md` `sessions` 表改主键为 `session_id`，新增 `generation` 列与 `UNIQUE (session_key, generation)` 约束；`usage_events` / `messages` 表归属改为 `session_id`；transcript 路径按 `sessionId` 归档
  - `spec/agent-runtime.md` AgentEvent 新增 `TurnEndReason` 枚举（含 core 注入的 `tool_limit` / `wallclock_timeout` / `budget_exceeded`）与 `UsageRecord` 类型；`SessionConfig` 去掉必填 `totalBudgetUsd`，改为可选 `budget: BudgetConfig?`（与 ADR-0006 一致）；新增 `sessionId` 字段
  - `spec/infra/observability.md` §"LLM 调用事件必含字段"显式声明 `llm_call_finished` 即 `UsageRecord` 原样转写，消除"两套字段名"的歧义；新增 `completeness` 字段
  - `spec/agent-backends/claude-code-cli.md` stop_reason 映射段指向 `agent-runtime.md` §TurnEndReason
  - `spec/infra/idempotency.md` 显式说明幂等键用 `session_key` 而非 `sessionId`（路由层概念）

- **spec/ 目录按领域重组**：扁平的 13 文件改为子目录结构：
  - 根下：`platform-adapter.md` / `agent-runtime.md` / `message-protocol.md`（通用主契约）+ `README.md`
  - `spec/agent-backends/`：`claude-code-cli.md`（原 `claude-code-cli-contract.md`）
  - `spec/security/`：`README.md`（原 `security.md` 伞文件）+ `auth.md` / `tool-boundary.md` / `secrets.md` / `redaction.md`
  - `spec/infra/`：`idempotency.md` / `persistence.md` / `observability.md` / `cost-and-limits.md`
  - 所有 frontmatter `related` 字段按新路径批量更新；所有 Markdown 链接按文件新位置重算相对路径（跨 20 份文件）
  - `AGENTS.md` 文件定位速查表新增 limits / persistence 行，并对齐路径
  - 0 broken link（校验通过）

### Tooling

- 新增 `scripts/docs-read`（bash，零外部依赖）：按 YAML frontmatter 状态控制性读取项目文档，防止 agent 读取过时文档后正文污染上下文。三种模式：默认（active 全文，过时只 frontmatter + 告警）/ `--head`（仅 frontmatter，泛读用）/ `--force`（强制全文，过时告警）。
- `AGENTS.md` 追加"读文档的防污染规则"作为核心原则第 8 条，强制所有 `docs/` 与规则文档通过脚本读取。
- 新增 `scripts/pretool-read-guard`（从 `.claude/hooks/` 搬出）：通用 PreToolUse 守卫脚本，拦截对 `docs/**/*.md` 与根规则文档的裸 `Read`，stderr 指引三种 docs-read 模式。支持 PreToolUse hook 的 agent harness（Claude Code / Codex 等）皆可接入；AGENTS.md 附 Claude Code 配置示例。
- **防污染机制重构——作废文档物化到归档目录**（Edit 工具链工作流冲突驱动）：原机制下所有 `docs/**/*.md` 的 Read 均被 hook 拦，而 Edit 工具要求必须先 Read，导致文档维护无法用标准 Read+Edit 流程。改由"路径即状态信号"承担防污染责任。经 codex review（`reviews/2026-04-23-pr4-codex.md`）后做两轮修订：
  - **首轮**（commit `ce4c71a`）：初步把 Superseded ADR 迁到专属目录；但隐含"所有过时都归档"的定性错位 placeholder 类文档。
  - **二轮修订**（响应 codex P0/P1）：
    - **归档目录统一命名为 `deprecated`**（用户指出 superseded 是 deprecated 的子集）：`docs/dev/adr/superseded/` → `docs/dev/adr/deprecated/`；新建 `docs/_deprecated/`（含 `.gitkeep`）作为非 ADR 作废文档的归档位置
    - **方案适用面收窄**：只处理 Superseded ADR + 明确 Deprecated 文档；`placeholder` 仍在 active 路径（承担信息架构占位作用），防污染靠 `docs-read` 默认模式兜底 + 未来 lint
    - **修 `status: superseded` 破坏 schema**：回滚 ADR-0005 `status` 为 `active`（`status` 允许值稳定为 `active|draft|placeholder|deprecated`，ADR 的 Superseded 语义由 `adr_status` + 归档路径共同表达）；`docs/dev/standards/metadata.md` 追加"归档路径下 `status` 冗余，保持 active 无害"说明
    - **双重真相清理**：`docs/dev/README.md` §读取方式、`docs/dev/standards/metadata.md` §读取规则 从"必须走 docs-read"更新为路径层机制
    - **banner 降级**：`AGENTS.md` §作废工作流 和 `adr/README.md` §Superseded 工作流 把"建议加 banner"从步骤里移出，明确为可选 UX 建议（路径已承担主责）
    - **subagent 拆分规则软化**：`docs/dev/process/subagent-usage.md` §任务拆分 "能拆就必须拆"改为"默认倾向拆分"，新增 §反向信号（倾向不拆）收录耦合/短任务/澄清场景，规模目标改为经验参考而非硬规则
- 新增 `CLAUDE.md` 符号链接指向 `AGENTS.md`，方便 Claude Code 自动识别项目规则；规范化入口仍是 `AGENTS.md`。
- `.gitignore` 调整：不假定协作者使用哪种 agent，`.claude/` / `.codex/` / `.gemini/` / `.continue/` / `.cursor/` 全部忽略（不再把 settings.json / hooks 入库）；新增 `eval-runs/`、`HANDOFF.md`、`HANDOFF-*.md`、`*.scratch.*` 条目。
