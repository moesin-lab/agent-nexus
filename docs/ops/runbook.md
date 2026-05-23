---
title: 运维手册
type: ops
status: active
summary: 本机运行 agent-nexus 的启动、停止、日志、状态、升级与排障步骤
tags: [ops, runbook]
related:
  - dev/architecture/overview
  - dev/spec/infra/observability
  - dev/spec/infra/persistence
  - dev/spec/infra/cost-and-limits
  - dev/spec/security/README
---

# 运维手册

本手册面向在本机长期运行 agent-nexus 的操作者。使用者入口见 [`../product/user-guide.md`](../product/user-guide.md)；内部契约见 [`../dev/`](../dev/)。

## 启动前检查

- `node --version` 为 20 或更高版本。
- `pnpm --version` 可运行。
- `claude --version` 可运行。
- 首次运行会自动创建 `~/.agent-nexus/config.json` 与 `~/.agent-nexus/secrets/DISCORD_BOT_TOKEN`；后续启动会把模板新增但本地缺失的配置字段补回 `config.json`。编辑后确认两者权限为 `0600`。
- Discord bot 已开启 `MESSAGE CONTENT INTENT`，并在目标 server / channel 有读写消息权限。

## 手动启动

开发模式：

```bash
pnpm dev
```

构建并安装本地 npm bin 后运行：

```bash
pnpm build
pnpm pack:cli
npm install -g packages/cli/agent-nexus-cli-*.tgz
agent-nexus
```

启动成功的关键信号：

- `secret_loaded`
- `cc_cli_version`
- `discord_ready`
- `engine_started`

## 停止

前台运行时按 `Ctrl-C`。进程收到 `SIGINT` / `SIGTERM` 后会尝试停止 engine、断开 Discord gateway，并退出。

## 配置与状态文件

| 路径 | 用途 | 权限 |
|---|---|---|
| `~/.agent-nexus/config.json` | 主配置 | `0600` |
| `~/.agent-nexus/secrets/DISCORD_BOT_TOKEN` | Discord bot token | `0600` |
| `~/.agent-nexus/state/discord.json` | Discord reply mode 状态 | 目录 `0700` |

首次运行会创建前两个文件的模板 / 空文件，但不会替你填真实 bot id、allowlist、working directory 或 token。

`config.json` 变更后需要重启进程。`discord.json` 由 `/reply-mode` 写入，通常不手动改。

## 常见故障

| 现象 | 检查 |
|---|---|
| 启动提示配置模板已创建 | 编辑 `~/.agent-nexus/config.json`，至少填 `discord.botUserId`、`discord.allowedUserIds`、`claudeCode.workingDir` |
| 启动提示 token 文件已创建 / token 为空 | 写入 `~/.agent-nexus/secrets/DISCORD_BOT_TOKEN` 并保持 `0600` |
| 启动报 token 权限 | `chmod 600 ~/.agent-nexus/secrets/DISCORD_BOT_TOKEN` |
| `cc_compat_probe_failed` | 先跑 `claude --version`；确认 Claude Code 已登录，且当前版本支持长驻 `stream-json` 与工具权限检查 |
| Discord 里无响应 | 确认 `allowedUserIds` 包含发送者 user id；默认模式下确认消息显式 @bot |
| `/reply-mode` 不出现 | 开发时配置 `discord.testGuildId`，避免全局 slash command 缓存延迟 |
| bot 回复自己或循环 | 检查 `discord.botUserId` 是否等于实际 bot user id；启动日志中不应出现 `discord_bot_user_id_mismatch` |

## 升级

```bash
git pull --ff-only
pnpm install
pnpm build
pnpm test
pnpm pack:cli
npm install -g packages/cli/agent-nexus-cli-*.tgz
```

升级后重启进程。若升级涉及配置字段，按 `README.md` 与 [`../product/user-guide.md`](../product/user-guide.md) 更新 `~/.agent-nexus/config.json`。

## 备份与清理

- 备份 `~/.agent-nexus/config.json` 时不要把 token 一起提交到仓库。
- 轮换 token 时，在 Discord Developer Portal 重新生成 token，覆盖 `DISCORD_BOT_TOKEN`，再重启进程。
- 删除 `~/.agent-nexus/state/discord.json` 会让 reply mode 回到默认 `mention`。
