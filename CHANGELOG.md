# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 规范，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

变更条目按语义分组：`Added` / `Changed` / `Deprecated` / `Removed` / `Fixed` / `Security`。

## [Unreleased]

### Added

- 项目初始化，建立开发文档体系骨架（架构 / ADR / spec / 流程 / 测试 / 规范）。
- 所有文档添加 YAML frontmatter 元信息（支持 agent 渐进式读取）；schema 规范见 `docs/dev/standards/metadata.md`。
- ADR-0005：订阅计费为一等用户路径。

### Changed

- 重构 `spec/cost-and-limits.md`：一等 limits 为 turn/wall-clock/tool-call/并发/退避/熔断，$ 预算降为 opt-in；对应同步 `spec/observability.md`（新增 `turn_limit_hit` / `tool_limit_hit` / `wallclock_timeout` 事件与 `toolCallsThisTurn` / `wallClockMs` 字段）、`architecture/session-model.md`（Session 元数据结构）、`spec/persistence.md`（sessions 表字段；`budget_events` 重命名为 `usage_events`）、`testing/eval.md`（case 05 扩为 `resource-limit-hit`）。
