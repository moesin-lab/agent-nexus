---
title: 常见问题（FAQ）
type: product
status: active
summary: 使用 agent-nexus 时最常见的安装、配置、权限和运行问题
tags: [product, faq]
related:
  - product/README
  - product/user-guide
  - dev/adr/0003-deployment-local-desktop
---

# 常见问题

## 关机后 bot 还会响应吗？

不会。agent-nexus 是本机进程，不是云服务。电脑关机、进程退出或网络断开后，Discord bot 不会继续处理消息。

## 为什么 bot 不响应我的消息？

按顺序检查：

1. Discord Developer Portal 是否开启 `MESSAGE CONTENT INTENT`。
2. 你是否在 `discord.allowedUserIds` 里。
3. 默认 `mention` 模式下，消息是否显式 @ 了 bot。
4. 启动日志是否出现 `discord_ready` 和 `engine_started`。
5. bot 是否在目标 server / channel 有读写消息权限。

## 多个用户能共用一个 bot 吗？

可以把多个 Discord user id 写进 `discord.allowedUserIds`。会话按 `(channelId, userId)` 隔离，不同用户不会共享同一个 Claude Code session。

## 为什么 `allowedUserIds` 必填？

agent-nexus 能驱动本机 Claude Code 读写文件。漏配用户白名单时直接拒绝启动，比“默认所有人都能用”安全。

## 为什么 `Bash` 默认禁用？

`Bash` 可以执行任意 shell 命令，风险比读文件和编辑文件更高。需要时可以显式加入 `claudeCode.allowedTools`，启动日志会提醒这个风险。

## `/reply-mode all` 会让所有人都能用吗？

不会。`all` 只表示“不必 @bot 也触发”，仍然先检查 `allowedUserIds`。

## 数据和密钥放在哪里？

- 配置：`~/.agent-nexus/config.json`
- Discord token：`~/.agent-nexus/secrets/DISCORD_BOT_TOKEN`
- Discord 运行状态：默认 `~/.agent-nexus/state/discord.json`

不要把 token 写进仓库、Issue、PR 或聊天截图。

## 支持 Slack / Feishu / Telegram 吗？

不支持。当前唯一平台是 Discord。

## 长回复怎么显示？

Discord 单条消息有长度限制。agent-nexus 会尽量通过 edit 更新当前回复；超过平台限制时会按切片发送或编辑多条消息。
