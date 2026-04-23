---
title: 任务追踪
type: task
status: active
summary: 当前主线进度与待完成项，按全局 AGENTS.md 第 4 条约定维护
tags: [task]
related:
  - root/AGENTS
---

# 任务追踪

> 按全局 `~/.claude/CLAUDE.md` 第 4 条约定：非平凡任务在需要持续跟踪时写入本文件。不追踪一次性小任务。

## 当前主线

**阶段**：文档与规范骨架（进行中，接近收尾）

### 已完成

- [x] 仓库 `git init` + `.gitignore` + `CHANGELOG.md`
- [x] 仓库根文件（`README`/`AGENTS`/`CONTRIBUTING`）+ `docs/README.md`
- [x] `docs/dev/process/`：workflow / tdd / code-review / subagent-usage / commit-and-branch / release
- [x] `docs/dev/standards/`：coding / logging / errors / docs-style
- [x] `docs/dev/adr/`：README / template / 0001–0003 Accepted / 0004 Proposed
- [x] `docs/dev/architecture/`：overview / session-model / dependencies
- [x] `docs/dev/spec/` 核心三件套：platform-adapter / agent-runtime / message-protocol
- [x] `docs/dev/spec/` 横切四件套：persistence / observability / security / cost-and-limits
- [x] `docs/dev/testing/`：strategy / fixtures / eval
- [x] `docs/product/` + `docs/ops/` 占位
- [x] `.tasks/todo.md` 初始化

### 待完成（本阶段收尾）

- [x] ADR 0004 语言选型的二次评审（含 Go/TS/Python 对比矩阵），仍 `Proposed`，待用户最终决策
- [x] 一次性 commit：`docs: bootstrap dev docs and ADRs`（d2fd1ab）
- [x] 加 YAML frontmatter：`docs: add YAML frontmatter for progressive agent reading`（da7ac3d）
- [x] ADR-0005 订阅一等路径 + 重构 cost-and-limits + 同步相关文档
- [ ] 整份 `docs/dev/` 丢给 `codex-review` skill 独立 review（推迟）
- [ ] ADR-0004 语言最终决策（用户拍板）
- [ ] 可选：PreToolUse hook 硬性拦截对 `docs/**/*.md` 的 `Read`（将 AGENTS.md 约定升级为 harness 级强制）
- [ ] 可选：`scripts/docs-lint`（提交前校验 frontmatter 完整性与枚举值）

## 下一阶段（预留）

- [ ] ADR 0004 决定后：建立代码目录骨架（`core/`、`agent/claudecode/`、`platform/discord/`、`cmd/`）
- [ ] TDD 起步：第一个模块的 spec 合约测试
- [ ] 基础工具链搭建（测试 runner、lint、CI）

## 暂搁待议

- 是否单独文件写"CC transcript 录制脚本规范"
- 是否为每条 ADR 引用建跳转索引（md 内链够不够用）
- `docs/product/` 是否应在第一版时提供英文 stub
