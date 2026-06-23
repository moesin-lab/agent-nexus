---
title: agent-nexus
type: root
status: active
summary: 把本机编码 agent 接入 Discord 的本机桥，支持 Claude Code CLI 和 Codex CLI 后端
tags: [project, discord, cc-cli, codex]
related:
  - root/AGENTS
  - product/README
  - product/user-guide
  - ops/runbook
  - dev/README
---

# agent-nexus

agent-nexus 是一个本机运行的 IM 桥接服务。它把 Discord 消息路由到你本机的编码 agent，让你可以在 Discord 里驱动 Claude Code CLI 或 Codex CLI 处理本机项目。

当前状态：可用于本机 Discord MVP。Discord 是当前唯一平台，部署、密钥和 agent CLI 登录状态由本机用户维护。

## 特性

- Discord `@mention` 与 slash command 路由到本机 agent。
- 支持 Claude Code CLI 和 Codex CLI 后端。
- 按 `(platformName, platform, channelId, userId)` 复用会话，并支持新建、停止、resume 与 route kill。
- 支持 Discord thread 会话、session 列表、working directory override、settings 面板与 queue 操作。
- 流式回复、typing 指示、工具调用状态与原地 edit。
- 基于 allowlist 的访问控制；Claude Code 后端默认不启用 `Bash`。
- 配置、密钥和运行状态默认放在 `~/.agent-nexus/`，也可用 `--home` 或 `AGENT_NEXUS_HOME` 跑多实例。

## 快速开始

### 前置条件

- Node >= 20
- pnpm >= 10（仓库锁定 `pnpm@10.33.2`）
- 已安装并登录 Claude Code CLI 或 Codex CLI
- 一个 Discord bot token、bot user id、你的 Discord user id
- Discord bot 已加入目标 server，并开启 `MESSAGE CONTENT INTENT`

Discord bot 创建、邀请和权限配置见 [`docs/product/platforms/discord.md`](docs/product/platforms/discord.md)。

### 安装

```bash
pnpm install
pnpm build
pnpm test
```

开发模式直接运行源码：

```bash
pnpm dev
```

构建并安装本地 CLI：

```bash
pnpm pack:cli
npm install -g packages/cli/agent-nexus-cli-*.tgz
agent-nexus
```

首次运行会创建：

- `~/.agent-nexus/config.json`
- `~/.agent-nexus/secrets/DISCORD_BOT_TOKEN`

需要跑 stable / dev 等多个实例时，用 `--home <dir>` 或 `AGENT_NEXUS_HOME=<dir>` 指定实例根目录；`config.json`、`secrets/`、`state/` 都会从这个根目录派生。

填入 Discord token：

```bash
echo -n '<your-discord-bot-token>' > ~/.agent-nexus/secrets/DISCORD_BOT_TOKEN
chmod 600 ~/.agent-nexus/secrets/DISCORD_BOT_TOKEN
```

token 文件权限不是 `0600` 时，agent-nexus 会拒绝启动。

### 最小配置

编辑 `~/.agent-nexus/config.json`。下面示例使用 Claude Code CLI：

```json
{
  "platforms": [
    {
      "name": "discord-main",
      "type": "discord",
      "botUserId": "1234567890123456789",
      "tokenRef": "DISCORD_BOT_TOKEN",
      "auth": {
        "allowlist": {
          "userIds": ["2345678901234567890"]
        }
      }
    }
  ],
  "agents": [
    {
      "name": "claude-prod",
      "backend": "claudecode",
      "claudeCode": {
        "workingDir": "/path/to/your/repo"
      }
    }
  ],
  "bindings": [
    {
      "name": "discord-main-claude-prod",
      "platformName": "discord-main",
      "agentName": "claude-prod",
      "match": {
        "discord": {
          "channelIds": ["3456789012345678901"]
        }
      }
    }
  ]
}
```

Codex backend、字段说明、多实例配置和安全边界见 [`docs/product/user-guide.md`](docs/product/user-guide.md)。

### 启动

配置完成后再次启动：

```bash
agent-nexus
```

开发模式使用：

```bash
pnpm dev
corepack pnpm --filter @agent-nexus/cli dev --home ~/.agent-nexus-dev
```

## 使用

启动成功后，在绑定的 Discord channel 里发送：

```text
@bot 帮我解释这个仓库的入口
```

常用命令：

| 命令 | 用途 |
|---|---|
| `@bot <prompt>` | 向当前绑定的 agent 发送一轮对话 |
| `@bot /new` | 清空当前 route 的会话 |
| `/claudecode-new` / `/codex-new` | 为对应后端开启新会话 |
| `/claudecode-stop` / `/codex-stop` | 停止对应后端当前任务 |
| `/nexus-kill` | 终止当前 Nexus route 并清除 resume 记录 |
| `/nexus-sessions` | 查看并切换可恢复 session |
| `/nexus-new-thread` | 创建 Discord private thread 作为新会话容器 |
| `/nexus-working-dir` | 设置 channel 或下一次 session 的 working directory |
| `/nexus-settings` | 打开当前 route 的 settings 面板 |
| `/nexus-queue` | 查看、重排、编辑或取消 pending prompts |
| `/nexus-reload-config` | 热加载 bindings、auth、UI 与文本前缀配置 |
| `/discord-reply-mode` | 切换 Discord 消息触发模式 |

默认只响应显式 `@bot` 的消息，且调用者必须命中 allowlist。Slash command 会按当前频道绑定的后端动态注册。

## 项目结构

```text
packages/
  cli/                # CLI 入口与配置加载
  daemon/             # 路由、会话与命令分发
  platform/discord/   # Discord adapter
  agent/              # Claude Code / Codex 后端
  protocol/           # 归一化消息协议
docs/
  product/            # 使用者文档
  ops/                # 本机运行与排障
  dev/                # 架构、spec、ADR 与协作规则
```

## 文档

- 使用指南：[`docs/product/user-guide.md`](docs/product/user-guide.md)
- Discord 配置：[`docs/product/platforms/discord.md`](docs/product/platforms/discord.md)
- 运维手册：[`docs/ops/runbook.md`](docs/ops/runbook.md)
- 开发者入口：[`AGENTS.md`](AGENTS.md) 与 [`docs/dev/README.md`](docs/dev/README.md)
- 全部文档导航：[`docs/README.md`](docs/README.md)

## 开发

```bash
pnpm typecheck
pnpm test
pnpm test:watch
pnpm test:e2e:discord
```

本仓库使用 [Conventional Commits](https://www.conventionalcommits.org/)。开发协作规则见 [`AGENTS.md`](AGENTS.md)。

## 许可证

[MIT](LICENSE)。
