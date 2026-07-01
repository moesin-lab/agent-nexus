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
- 多实例运行时用 `--home <dir>` 或 `AGENT_NEXUS_HOME=<dir>` 指定实例根目录；配置、密钥与状态文件都会从该目录派生。本仓库约定 dev 使用 `~/.agent-nexus`，stable 使用 `~/.agent-nexus-stable`。
- Discord bot 已开启 `MESSAGE CONTENT INTENT`，并在目标 server / channel 有读写消息权限。

## 手动启动

开发模式：

```bash
pnpm dev
corepack pnpm --filter @agent-nexus/cli dev
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

## Stable 自动更新

stable 实例由 host LaunchAgent 拉起容器内 watchdog：`~/.agent-nexus-stable/bin/keepalive-stable.sh run`。本仓库维护脚本源位于 `scripts/ops/agent-nexus-stable/`；安装到 stable home 后，watchdog 重启才会加载新脚本。

自动更新启用后，watchdog 会定时检查 `origin/main`：

- 专属源码 checkout：`~/.agent-nexus-stable/source/agent-nexus`
- 构建产物 release：`~/.agent-nexus-stable/releases/<hash>`
- 当前运行 release：`~/.agent-nexus-stable/current`
- 自动更新状态：`~/.agent-nexus-stable/state/auto-update/`

关键状态文件：

| 路径 | 用途 |
|---|---|
| `stable_hash` | 最近通过健康检查和 promote 窗口的稳定版本 |
| `pending_candidate_hash` | 已切到 current、等待健康检查或 promote 的候选版本 |
| `bad_hashes.tsv` | 已知错误版本，包含 hash、时间、分类和原因 |
| `last_error.log` | 最近一次自动更新错误 |
| `restart-requested` | 区分自动更新主动重启和普通崩溃 |

更新流程：

1. `git fetch origin main` 解析远端 hash。
2. 如果 hash 已在 `bad_hashes.tsv`，跳过。
3. 在专属 release worktree 中执行 `pnpm install --frozen-lockfile` 与 `pnpm build`。
4. 构建成功后，只有当 child 无子进程且 stdout/stderr 静默超过 idle 窗口，才切换 `current` 并 SIGTERM child。
5. 候选启动后必须在新 stdout 中出现 `engine_started` 与 `discord_ready`；通过后再等 promote 窗口，才写入 `stable_hash`。
6. 候选失败时切回 `stable_hash` 指向的 release；回退不重新 build。

健康检查依赖 `engine_started` 与 `discord_ready` 两条 info 级日志继续写入 stdout。不要把 stable 的 log level 调到 `warn` 以上，也不要把 pino 输出改到非 stdout sink；否则候选会 readiness timeout，并进入临时 cooldown。

默认配置可用环境变量调整：

| 变量 | 默认值 | 说明 |
|---|---:|---|
| `AGENT_NEXUS_STABLE_AUTO_UPDATE_ENABLED` | `1` | 是否启用自动更新 |
| `AGENT_NEXUS_STABLE_AUTO_UPDATE_INTERVAL_SECONDS` | `600` | 检查间隔 |
| `AGENT_NEXUS_STABLE_AUTO_UPDATE_IDLE_SECONDS` | `300` | 重启前静默窗口 |
| `AGENT_NEXUS_STABLE_AUTO_UPDATE_PROMOTE_SECONDS` | `180` | 候选晋升为 stable 前的存活窗口 |
| `AGENT_NEXUS_STABLE_AUTO_UPDATE_RELEASE_KEEP_COUNT` | `3` | 除 stable / pending / current 外保留的旧 release 数 |
| `AGENT_NEXUS_STABLE_AUTO_UPDATE_LOG_MAX_BYTES` | `10485760` | 单个 stable 日志文件超过该大小时保留尾部内容 |
| `AGENT_NEXUS_STABLE_AUTO_UPDATE_READINESS_COOLDOWN_SECONDS` | `3600` | readiness timeout 后临时跳过同一 hash 的时间 |
| `AGENT_NEXUS_STABLE_AUTO_UPDATE_BUILD_BAD_THRESHOLD` | `2` | 同一 hash 连续 build 失败达到该次数才写入 `bad_hashes.tsv` |

手动检查一次更新：

```bash
~/.agent-nexus-stable/bin/keepalive-stable.sh update-once
```

注意：首次安装新脚本后，不要从正在由 stable child 托管的 agent 会话里直接重启 watchdog；重启会中断该会话。应在会话结束后运行 `~/.agent-nexus-stable/bin/keepalive-stable.sh restart`，或由 host LaunchAgent 后续重启加载。

## 备份与清理

- 备份 `~/.agent-nexus/config.json` 时不要把 token 一起提交到仓库。
- 轮换 token 时，在 Discord Developer Portal 重新生成 token，覆盖 `DISCORD_BOT_TOKEN`，再重启进程。
- 删除对应 platform 的 `~/.agent-nexus/state/discord-<encodedPlatformName>.json` 会让 reply mode 回到默认 `mention`。
