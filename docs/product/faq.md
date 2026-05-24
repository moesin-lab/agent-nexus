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
2. 你是否在 `platforms[].auth.allowlist.userIds` 里，或是否拥有 `roleIds` 中的角色。
3. 默认 `mention` 模式下，消息是否显式 @ 了 bot。
4. 启动日志是否出现 `discord_ready` 和 `engine_started`。
5. bot 是否在目标 server / channel 有读写消息权限。

## 多个用户能共用一个 bot 吗？

可以把多个 Discord user id 写进 `platforms[].auth.allowlist.userIds`，也可以用 `roleIds` 授权一组用户。会话按 `(platformName, channelId, userId)` 隔离，不同用户不会共享同一个 agent session。

## 为什么 `allowedUserIds` 必填？

agent-nexus 能驱动本机 Claude Code 读写文件。漏配用户白名单时直接拒绝启动，比“默认所有人都能用”安全。

## 为什么 `Bash` 默认禁用？

`Bash` 可以执行任意 shell 命令，风险比读文件和编辑文件更高。需要时可以显式加入 `agents[].claudeCode.allowedTools`，启动日志会提醒这个风险。

## 支持 Codex CLI 吗？

支持。要启用 Codex，在 `agents[]` 里新增或修改一个 `backend: "codex"` 的 agent，并填写 `agents[].codex.workingDir`；再用 `bindings[]` 把 Discord channel 绑定到这个 agent。Codex backend 使用 `codex exec --json` / `codex exec resume`。启动时默认只跑快速 compatibility probe：检查 `codex --version` 与 help 里是否有必需 flag，不发起真实模型 turn；本机未安装 Codex CLI 或 CLI 形态不匹配时会拒绝启动。

Codex CLI 当前没有 native tool whitelist。它的边界来自 `codex.sandbox`、`codex.addDirs`、`--ask-for-approval never`、工作目录和默认不加载用户全局 config / rules。

配置时优先保持安全默认：`sandbox: "read-only"`、`addDirs: []`、`loadUserConfig: false`、`loadRules: false`。只有需要 bot 直接改仓库文件时才改成 `workspace-write`；只有需要访问工作目录外的项目路径时才填写 `addDirs`。更完整的配置示例和取舍见 [`user-guide.md` §Codex backend 配置细节](user-guide.md#codex-backend-配置细节)。

## `claudeCode.permissionLevel` 应该怎么配？

默认保持 `default`。agent-nexus 会显式用 `--permission-mode default` 启动 Claude Code 子进程，并自检 `can_use_tool` 工具权限控制。

也可以配置 `acceptEdits` / `auto` / `bypassPermissions` / `dontAsk` / `plan`，agent-nexus 会把字符串原样传给 Claude Code。非 `default` 模式会跳过工具权限控制 probe，并在启动日志打 warn；如果 Claude Code 实际 `init.permissionMode` 与配置不一致（例如 `auto` 不可用回退到 `default`），agent-nexus 会拒绝启动该 session。

## `/reply-mode all` 会让所有人都能用吗？

不会。`all` 只表示“不必 @bot 也触发”，仍然先检查 `platforms[].auth.allowlist`。

## 数据和密钥放在哪里？

- 配置：`~/.agent-nexus/config.json`
- Discord token：`~/.agent-nexus/secrets/DISCORD_BOT_TOKEN`
- Discord 运行状态：默认 `~/.agent-nexus/state/discord.json`

不要把 token 写进仓库、Issue、PR 或聊天截图。

## 支持 Slack / Feishu / Telegram 吗？

不支持。当前唯一平台是 Discord。

## 长回复怎么显示？

Discord 单条消息有长度限制。agent-nexus 会尽量通过 edit 更新当前回复；超过平台限制时会按切片发送或编辑多条消息。
