# 常见问题（占位）

> **状态**：占位。等积累到一定用户反馈后填写。

## 预计会包含的问题（从 `dev/` 推测）

- **关机后 bot 还响应吗？** 不，见 [`../../dev/adr/0003-deployment-local-desktop.md`](../../dev/adr/0003-deployment-local-desktop.md)。
- **多个用户能共用一个 bot 吗？** 按 allowlist 可以让多人使用，但每人是独立 session；不支持共享同一个 CC 会话。
- **为什么不支持 Feishu / Slack？** MVP 只支持 Discord，见 [`../../dev/adr/0001-im-platform-discord.md`](../../dev/adr/0001-im-platform-discord.md)。未来可能增加。
- **为什么 Bash 默认禁用？** 安全考量，见 [`../../dev/spec/security.md`](../../dev/spec/security.md)。
- **费用怎么算？** 预算机制见 [`../../dev/spec/cost-and-limits.md`](../../dev/spec/cost-and-limits.md)。
- **数据在哪？能备份吗？** 本地 `~/.agent-nexus/`，见 [`../../dev/spec/persistence.md`](../../dev/spec/persistence.md)。

## 为什么现在不写

FAQ 的价值来自真实用户问题聚合。凭空猜的 FAQ 多半命中不了用户的疑惑。

## 填写流程

- 每次用户报问题 → 开 Issue
- 同类问题出现 ≥3 次 → 本 FAQ 添加条目
- 条目过时 → 删除或标注 outdated
