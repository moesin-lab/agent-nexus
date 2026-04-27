---
title: Discord 使用手册
type: product
status: active
summary: Discord bot 申请、邀请、权限与基础使用步骤
tags: [product, discord, user-guide]
related:
  - product/user-guide
  - dev/spec/platform-adapter
  - dev/spec/message-protocol
  - dev/spec/security/README
---

# Discord 使用手册

这页只写 Discord 侧最先要做的事：申请 bot、拿到 token、邀请进测试 server。

## 申请 Discord Bot

1. 打开 [Discord Developer Portal](https://discord.com/developers/applications)，创建一个新的 Application。
2. 进入应用后，在 `Bot` 页面创建 Bot User，并复制 `Bot Token`。
3. 立刻把 token 记到本机密钥文件里，不要发到频道、Issue 或截图里。
4. 在 `Bot` 页面打开 `MESSAGE CONTENT INTENT`。不打开的话，bot 读不到普通消息内容。
5. 在 `Installation` 或 `OAuth2` 的邀请配置里，至少选择 `bot` 和 `applications.commands` 两个 scope。
6. 按实际部署模式勾选最小权限。MVP 常见是 `Send Messages`、`Read Message History`，如果要在 thread 里工作，再按需要加 thread 相关权限。
7. 复制生成的邀请链接，把 bot 拉进测试 server。
8. 回到本地配置，把 `bot user id` 和 `Bot Token` 填到 agent-nexus 需要的位置。

## 验证是否申请成功

- bot 出现在 server 成员列表里
- portal 里 `Bot Token` 已生成并可用
- `MESSAGE CONTENT INTENT` 已开启
- 用 `@bot ping` 或 slash command 能收到响应

## 参考

本文按下面两类资料整理：

- [Discord 官方：Building your first Discord Bot](https://docs.discord.com/developers/quick-start/getting-started)
- [Discord 官方：OAuth2 and Permissions](https://docs.discord.com/developers/platform/oauth2-and-permissions)
- [知乎参考文章](https://zhuanlan.zhihu.com/p/1999598055972947248)
