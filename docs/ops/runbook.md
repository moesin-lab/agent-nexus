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
- 多实例运行时用 `--home <dir>` 或 `AGENT_NEXUS_HOME=<dir>` 指定实例根目录；配置、密钥与状态文件都会从该目录派生。
- Discord bot 已开启 `MESSAGE CONTENT INTENT`，并在目标 server / channel 有读写消息权限。

## 手动启动

开发模式：

```bash
pnpm dev
corepack pnpm --filter @agent-nexus/cli dev --home ~/.agent-nexus-dev
```

构建并安装本地 npm bin 后运行：

```bash
pnpm build
pnpm pack:cli
npm install -g packages/cli/agent-nexus-cli-*.tgz
agent-nexus
agent-nexus --home ~/.agent-nexus-stable
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
| `<home>/config.json` | 主配置 | `0600` |
| `<home>/secrets/DISCORD_BOT_TOKEN` | Discord bot token | `0600` |
| `<home>/state/discord-<encodedPlatformName>.json` | Discord reply mode 状态 | 目录 `0700` |

首次运行会创建前两个文件的模板 / 空文件，但不会替你填真实 bot id、allowlist、working directory 或 token。

默认 `<home>` 是 `~/.agent-nexus`。`config.json` 可手动编辑，也可从 `/nexus-settings` 写入；热生效字段可通过 `/nexus-reload-config` 或 settings 保存后的自动 reload 生效，其余字段仍需重启进程。`daemon.commandRegistry.*` 控制 slash command 注册、alias 与 `@bot /new` 文本前缀；`state/discord-<encodedPlatformName>.json` 由 `/discord-reply-mode` 或 legacy `/reply-mode` 写入，通常不手动改。例如 `platforms[].name="discord-main"` 时默认文件是 `<home>/state/discord-discord-main.json`。

## 常见故障

| 现象 | 检查 |
|---|---|
| 启动提示配置模板已创建 | 编辑 `~/.agent-nexus/config.json`，至少填 `platforms[].botUserId`、`platforms[].auth.allowlist.userIds` 或 `roleIds`、`agents[].claudeCode.workingDir` / `agents[].codex.workingDir`，并给 `bindings[].match.discord.channelIds` 填目标频道 |
| 启动提示 token 文件已创建 / token 为空 | 写入 `~/.agent-nexus/secrets/DISCORD_BOT_TOKEN` 并保持 `0600` |
| 启动报 token 权限 | `chmod 600 ~/.agent-nexus/secrets/DISCORD_BOT_TOKEN` |
| `cc_compat_probe_failed` | 先跑 `claude --version`；确认 Claude Code 已登录，且当前版本支持长驻 `stream-json` 与工具权限检查 |
| `agent_compat_probe_failed` 且 `agentBackend=codex` | 先跑 `codex --version`；确认 Codex CLI 已登录；再跑 `scripts/verify-codex-agent.sh` 看 resume、错误或中断验证失败原因 |
| Discord 里无响应 | 确认 `platforms[].auth.allowlist` 包含发送者 user id 或 role；确认当前频道命中某条 `bindings[].match.discord.channelIds`；默认模式下确认消息显式 @bot |
| `/discord-reply-mode` / `/reply-mode` 不出现 | 开发时配置 `platforms[].testGuildId`，避免全局 slash command 缓存延迟；确认 bot 邀请包含 `applications.commands` scope；确认 `daemon.commandRegistry.registration.enabled=true`；legacy `/reply-mode` 还要求 `daemon.commandRegistry.aliases.legacy.replyMode=true` |
| `/codex-new` / `/claudecode-new` 不出现 | 确认对应 backend 的 agent 已配置，且当前 platform 至少有一条 binding 指向该 agent；裸 `/new` 只在同一注册 scope 只有一种 agent owner 且 `daemon.commandRegistry.aliases.singleAgent.enabled=true` 时出现 |
| 同一个 Discord application 下其它工具注册的 slash command 消失 | agent-nexus 会用期望全集覆盖当前 application 在该 scope 下的命令；不要和其它工具共享同一个 bot application 的 slash command scope |
| bot 回复自己或循环 | 检查 `platforms[].botUserId` 是否等于实际 bot user id；启动日志中不应出现 `discord_bot_user_id_mismatch` |

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
- 删除对应 platform 的 `~/.agent-nexus/state/discord-<encodedPlatformName>.json` 会让 reply mode 回到默认 `mention`。
