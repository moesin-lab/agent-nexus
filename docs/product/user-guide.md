---
title: 用户指南
type: product
status: active
summary: 本机安装、配置、启动、Discord 使用与常见操作的用户侧指南
tags: [product, user-guide]
related:
  - product/README
  - product/platforms/discord
  - product/faq
---

# 用户指南

本指南面向本机运行 agent-nexus 的使用者。Discord bot 的申请、邀请和 portal 权限见 [`platforms/discord.md`](platforms/discord.md)。

## 前置条件

- Node >= 20
- pnpm >= 10（仓库 `packageManager` 锁定版本为 `pnpm@10.33.2`）
- 本机已安装并登录 Claude Code CLI，`claude --version` 能运行
- 一个 Discord bot token、bot user id、你的 Discord user id
- bot 已加入测试 server，并开启 `MESSAGE CONTENT INTENT`

## 安装与构建

在仓库根目录执行：

```bash
pnpm install
pnpm build
pnpm pack:cli
npm install -g packages/cli/agent-nexus-cli-*.tgz
```

开发时也可以直接用 `pnpm dev` 跑源码。

## 配置文件

首次运行 `agent-nexus` 会自动创建配置脚手架：

- `~/.agent-nexus/` 和 `~/.agent-nexus/secrets/`，权限为 `0700`
- `~/.agent-nexus/config.json` 模板，权限为 `0600`
- `~/.agent-nexus/secrets/DISCORD_BOT_TOKEN` 空文件，权限为 `0600`

后续启动会自动把模板中新增但本地缺失的字段补回 `config.json`；已有配置值不会被覆盖。必填字段如果没有真实默认值，只会补占位值并继续提示你填写。

编辑 `~/.agent-nexus/config.json`：

```json
{
  "discord": {
    "botUserId": "1234567890123456789",
    "allowedUserIds": ["2345678901234567890"]
  },
  "claudeCode": {
    "workingDir": "/path/to/your/repo",
    "bin": "claude",
    "permissionLevel": "default",
    "allowedTools": ["Read", "Grep", "Glob", "Edit", "Write"]
  },
  "ui": {
    "toolMessages": "append"
  },
  "log": {
    "level": "info"
  }
}
```

```bash
chmod 600 ~/.agent-nexus/config.json
```

字段说明：

| 字段 | 必填 | 说明 |
|---|---|---|
| `discord.botUserId` | 是 | Discord bot user id |
| `discord.allowedUserIds` | 是 | 允许使用 bot 的用户 id 列表；缺失或空数组会启动失败 |
| `discord.testGuildId` | 否 | 开发时把 `/reply-mode` 限定注册到一个 guild，避免全局 slash command 缓存延迟 |
| `claudeCode.workingDir` | 是 | Claude Code 默认工作目录 |
| `claudeCode.bin` | 否 | Claude Code CLI 路径；默认 `claude` |
| `claudeCode.permissionLevel` | 否 | 默认 `default`；允许 `default` / `acceptEdits` / `auto` / `bypassPermissions` / `dontAsk` / `plan`，会原样传给 `--permission-mode`。只有 `default` 自检工具权限控制；其他模式会跳过该 probe 并打 warn |
| `claudeCode.allowedTools` | 否 | 默认 `Read/Grep/Glob/Edit/Write`；启用 `Bash` 需要显式加入 |
| `ui.toolMessages` | 否 | 默认 `append`；工具调用追加为独立消息并在结果到达时编辑该工具消息。设为 `compact` 可回到旧式紧凑显示 |
| `log.level` | 否 | `trace` / `debug` / `info` / `warn` / `error` / `fatal`，默认 `info` |

写 Discord token：

```bash
echo -n '<your-discord-bot-token>' > ~/.agent-nexus/secrets/DISCORD_BOT_TOKEN
chmod 600 ~/.agent-nexus/secrets/DISCORD_BOT_TOKEN
```

token 文件权限不是 `0600` 时会拒绝启动。

## 启动

开发模式：

```bash
pnpm dev
```

安装后运行：

```bash
agent-nexus
```

启动会先跑 Claude Code 兼容性 probe，包括版本、一次性 JSON 输出、长驻 `stream-json` 和工具权限检查。通过后会连接 Discord，日志里应出现 `discord_ready` 和 `engine_started`。

## 在 Discord 里使用

默认触发模式是 `mention`：

```text
@bot ping
@bot 请读一下 README，概括当前项目怎么运行
```

会话按 `(channelId, userId)` 隔离。同一个用户在同一个频道里继续 `@bot` 会复用活跃 Claude Code session。

重置会话：

```text
@bot /new
@bot /new 从这个问题重新开始
```

切换触发模式：

```text
/reply-mode mode:mention
/reply-mode mode:all
```

`all` 模式只影响消息触发条件，不绕过 `allowedUserIds`。不在 allowlist 里的用户仍不能驱动 bot。

## 工具与安全

- 默认工具集是 `Read` / `Grep` / `Glob` / `Edit` / `Write`。
- `Bash` 默认禁用；加入 `allowedTools` 后启动会打 warn。
- 白名单外工具应在执行前被拒绝；机制细节见 [`../dev/spec/security/tool-boundary.md`](../dev/spec/security/tool-boundary.md)。
- agent-nexus 是本机进程。它能访问的文件和网络能力取决于本机运行环境与 Claude Code 工作目录。

## 停止

前台运行时按 `Ctrl-C`。进程收到 `SIGINT` / `SIGTERM` 后会调用 engine stop 并断开 Discord。

长期运行、日志保留和排障步骤见 [`../ops/runbook.md`](../ops/runbook.md)。
