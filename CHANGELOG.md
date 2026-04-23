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

### Tooling

- 新增 `scripts/docs-read`（bash，零外部依赖）：按 YAML frontmatter 状态控制性读取项目文档，防止 agent 读取过时文档后正文污染上下文。三种模式：默认（active 全文，过时只 frontmatter + 告警）/ `--head`（仅 frontmatter，泛读用）/ `--force`（强制全文，过时告警）。
- `AGENTS.md` 追加"读文档的防污染规则"作为核心原则第 8 条，强制所有 `docs/` 与规则文档通过脚本读取。
- 新增 `scripts/pretool-read-guard`（从 `.claude/hooks/` 搬出）：通用 PreToolUse 守卫脚本，拦截对 `docs/**/*.md` 与根规则文档的裸 `Read`，stderr 指引三种 docs-read 模式。支持 PreToolUse hook 的 agent harness（Claude Code / Codex 等）皆可接入；AGENTS.md 附 Claude Code 配置示例。
- 新增 `CLAUDE.md` 符号链接指向 `AGENTS.md`，方便 Claude Code 自动识别项目规则；规范化入口仍是 `AGENTS.md`。
- `.gitignore` 调整：不假定协作者使用哪种 agent，`.claude/` / `.codex/` / `.gemini/` / `.continue/` / `.cursor/` 全部忽略（不再把 settings.json / hooks 入库）；新增 `eval-runs/`、`HANDOFF.md`、`HANDOFF-*.md`、`*.scratch.*` 条目。
