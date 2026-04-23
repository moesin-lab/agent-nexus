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

### Tooling

- 新增 `scripts/docs-read`（bash，零外部依赖）：按 YAML frontmatter 状态控制性读取项目文档，防止 agent 读取过时文档后正文污染上下文。三种模式：默认（active 全文，过时只 frontmatter + 告警）/ `--head`（仅 frontmatter，泛读用）/ `--force`（强制全文，过时告警）。
- `AGENTS.md` 追加"读文档的防污染规则"作为核心原则第 8 条，强制所有 `docs/` 与规则文档通过脚本读取。
- 新增 `scripts/pretool-read-guard`（从 `.claude/hooks/` 搬出）：通用 PreToolUse 守卫脚本，拦截对 `docs/**/*.md` 与根规则文档的裸 `Read`，stderr 指引三种 docs-read 模式。支持 PreToolUse hook 的 agent harness（Claude Code / Codex 等）皆可接入；AGENTS.md 附 Claude Code 配置示例。
- 新增 `CLAUDE.md` 符号链接指向 `AGENTS.md`，方便 Claude Code 自动识别项目规则；规范化入口仍是 `AGENTS.md`。
- `.gitignore` 调整：不假定协作者使用哪种 agent，`.claude/` / `.codex/` / `.gemini/` / `.continue/` / `.cursor/` 全部忽略（不再把 settings.json / hooks 入库）；新增 `eval-runs/`、`HANDOFF.md`、`HANDOFF-*.md`、`*.scratch.*` 条目。
