---
title: Discord 使用手册
type: product
status: placeholder
summary: Discord 侧的注册、权限、slash command、错误提示手册；等 MVP 后填写
tags: [product, discord, user-guide]
related:
  - product/user-guide
  - dev/spec/platform-adapter
  - dev/spec/message-protocol
  - dev/spec/security/README
---

# Discord 使用手册（占位）

> **状态**：占位。等 MVP 可运行后填写。

## 将包含的章节（规划）

- **注册 Discord Application**：创建 app、拿 client id、bot token
- **配置 scope 与权限**：`bot` / `applications.commands` / `message_content` / 具体 permissions 数值
- **把 bot 加入 server**：OAuth2 URL
- **在 channel 里使用**：at mention、DM、thread
- **Slash command 列表**：MVP 预计包含
  - `/start` — 启动新会话（绑定当前 channel）
  - `/end` — 结束当前会话
  - `/reset` — 重置会话（保留历史）
  - `/budget` — 查看预算使用
  - `/resume` — 熔断后恢复
- **消息切片提示**：遇到长输出的提示文本
- **常见错误提示**：用户侧会看到的错误消息解释

## 为什么现在不写

Slash command 集合、消息格式、错误模板都还没确定（见 `dev/spec/platform-adapter.md` §"发送映射"）。过早写会误导用户。

## 参考规范

本手册在填写时必须与以下开发 spec 对齐：

- [`../../dev/spec/platform-adapter.md`](../../dev/spec/platform-adapter.md)
- [`../../dev/spec/message-protocol.md`](../../dev/spec/message-protocol.md)
- [`../../dev/spec/security.md`](../../dev/spec/security/README.md)（allowlist 的使用面）
