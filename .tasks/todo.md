---
title: 任务追踪
type: task
status: active
summary: 当前主线待完成项；已完成事实归档在 git log / CHANGELOG.md
tags: [task]
related:
  - root/AGENTS
---

# 任务追踪

> 按全局 `~/.claude/CLAUDE.md` 第 4 条约定：非平凡任务在需要持续跟踪时写入本文件。不追踪一次性小任务。
>
> 已完成项不在本文件留痕，历史事实源为 `CHANGELOG.md` + `git log`。

## 当前主线

**阶段**：文档与规范骨架（接近收尾，等待语言决策后进入代码阶段）

### 待完成

- [ ] ADR-0004 语言最终决策（用户拍板；当前 Proposed，倾向 Go）
- [ ] 可选：`scripts/docs-lint`（提交前校验 frontmatter 完整性与枚举值）

## 下一阶段（预留）

- [ ] ADR-0004 决定后：建立代码目录骨架（`core/`、`agent/claudecode/`、`platform/discord/`、`cmd/`）
- [ ] TDD 起步：第一个模块的 spec 合约测试
- [ ] 基础工具链搭建（测试 runner、lint、CI）

## 暂搁待议

- 是否单独文件写"CC transcript 录制脚本规范"
- 是否为每条 ADR 引用建跳转索引（md 内链够不够用）
- `docs/product/` 是否应在第一版时提供英文 stub
