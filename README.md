---
title: agent-nexus
type: root
status: active
summary: 把本机 Claude Code CLI 接入 Discord 的本机桥；MVP 已支持长驻 stream-json、工具可见性与流式 edit
tags: [project, discord, cc-cli]
related:
  - root/AGENTS
  - dev/adr/0001-im-platform-discord
  - dev/adr/0002-agent-backend-claude-code-cli
  - dev/adr/0003-deployment-local-desktop
  - dev/adr/0004-language-runtime
---

# agent-nexus

把本机 Claude Code CLI 接入 IM 平台的桥。首个目标平台：Discord。

## 定位

agent-nexus 让你在 IM（当前：Discord）里直接和本机 Claude Code 对话，用 IM 作为"远程遥控器"驱动本机的编码 agent；同时把观测、权限、成本控制做成一等公民。

这是一个参考 [cc-connect](https://github.com/chenhg5/cc-connect) 但刻意规避其已知教训的重新实现：**文档先行、契约先行、测试先行**。

## 当前能力

**Discord + 本机 Claude Code CLI MVP** 已可端到端运行：

- Discord `@mention` → daemon `Engine` → 长驻 Claude Code `stream-json` 子进程 → Discord 回复。
- 同一 `(channelId, userId)` 复用活跃 session；`/new` 文本前缀或 agent slash command 可重置该会话。
- IM 侧可看到工具调用状态、流式文本、typing 指示与原地 edit。
- 白名单外工具会在执行前被拒绝；机制见 [`docs/dev/spec/security/tool-boundary.md`](docs/dev/spec/security/tool-boundary.md)。`Bash` 不在默认允许集。

仍处在本机桌面形态：Discord 是当前唯一平台，部署与密钥由本机用户维护。

## 已锁定的前置决策

| 维度 | 决策 | ADR |
|---|---|---|
| IM 平台（MVP） | Discord | [0001](docs/dev/adr/0001-im-platform-discord.md) |
| Agent 后端 | Claude Code CLI（默认）/ Codex CLI（显式配置） | [0002](docs/dev/adr/0002-agent-backend-claude-code-cli.md), [0014](docs/dev/adr/0014-agent-backend-codex-cli.md) |
| 部署形态 | 本机桌面 | [0003](docs/dev/adr/0003-deployment-local-desktop.md) |
| 实现语言 | TypeScript / Node + pnpm monorepo | [0004](docs/dev/adr/0004-language-runtime.md) |

## 快速开始

### 1. 前置依赖

- Node ≥ 20、pnpm ≥ 10（`packageManager` 已锁 `pnpm@10.33.2`）
- 本机已装 Claude Code CLI（`claude --version` 能跑）；如不在 `PATH` 里，配置项 `agents[].claudeCode.bin` 给绝对路径
- 如要启用 Codex backend，本机还需安装并登录 Codex CLI（`codex --version` 能跑）；如不在 `PATH` 里，配置项 `agents[].codex.bin` 给绝对路径
- Discord bot：在 [Discord Developer Portal](https://discord.com/developers/applications) 建 application + bot，记下 bot user ID 和 token；intents 至少打开 `MESSAGE CONTENT INTENT`

### 2. 安装与构建

```bash
pnpm install
pnpm build         # tsc --build；CLI 入口会额外 bundle 成 npm bin
pnpm pack:cli      # 产物 packages/cli/agent-nexus-cli-*.tgz
pnpm test          # vitest 全量
pnpm typecheck     # 仅 tsc --build；不生成 npm bin bundle
```

### 3. 配置

首次运行会自动创建配置脚手架：

- `~/.agent-nexus/` 和 `~/.agent-nexus/secrets/`，权限为 0700
- `~/.agent-nexus/config.json` 模板，权限为 0600
- `~/.agent-nexus/secrets/DISCORD_BOT_TOKEN` 空文件，权限为 0600

之后每次启动都会检查 `config.json`，把模板中新增但本地缺失的字段自动补齐到文件中；已有字段不会被覆盖。没有安全默认值的必填字段只会补占位值，仍需手动填写。

编辑 `~/.agent-nexus/config.json`（至少填 `platforms[].botUserId`、`platforms[].auth.allowlist.userIds` 或 `roleIds`、`agents[].claudeCode.workingDir`，并给 binding 填 channel id）：

```json
{
  "platforms": [
    {
      "name": "discord-main",
      "type": "discord",
      "botUserId": "1234567890123456789",
      "tokenRef": "DISCORD_BOT_TOKEN",
      "publicChannelMode": "thread",
      "auth": {
        "allowlist": {
          "userIds": ["2345678901234567890"],
          "roleIds": [],
          "allowedGuildIds": [],
          "allowedChannelIds": [],
          "allowDM": true,
          "requireMentionOrSlash": true
        }
      }
    }
  ],
  "agents": [
    {
      "name": "claude-prod",
      "backend": "claudecode",
      "claudeCode": {
        "workingDir": "/path/to/your/repo",
        "bin": "claude",
        "permissionLevel": "default",
        "allowedTools": ["Read", "Grep", "Glob", "Edit", "Write"]
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
  ],
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

- `platforms[].botUserId`（必填）：bot 的 Discord user ID
- `platforms[].auth.allowlist.userIds` / `roleIds`（必填其一）：允许使用 bot 的 Discord user 或 role ID
- `platforms[].auth.allowlist.allowedGuildIds` / `allowedChannelIds`（可选）：进一步收窄允许的 guild / channel；空数组表示不按该维度收窄
- `platforms[].testGuildId`（可选）：把 slash command 限定注册到某个测试 guild，开发时更快生效
- `agents[].backend`（必填）：选择 `claudecode` 或 `codex`
- `agents[].claudeCode.workingDir`（`backend=claudecode` 时必填）：CC 默认工作目录，per-session 可覆盖
- `agents[].claudeCode.bin`（可选，默认 `claude`）：CC CLI 可执行路径
- `agents[].claudeCode.permissionLevel`（可选，默认 `default`）：原样传给 Claude Code 子进程的 `--permission-mode`，允许 `default` / `acceptEdits` / `auto` / `bypassPermissions` / `dontAsk` / `plan`
- `agents[].claudeCode.allowedTools`（可选）：默认 `Read/Grep/Glob/Edit/Write`。**`Bash` 不在默认集**——启用须显式列出，启动会打 warn（参见 [`docs/dev/spec/security/tool-boundary.md`](docs/dev/spec/security/tool-boundary.md)）
- `agents[].codex.workingDir`（`backend=codex` 时必填）：Codex 默认工作目录，传给 `--cd`
- `bindings[].platformName` / `agentName`（必填）：把命名 platform bot 绑定到命名 agent
- `bindings[].match.discord.channelIds`（必填）：该 binding 匹配的 Discord channel/thread id 列表
- `codex.bin`（可选，默认 `codex`）：Codex CLI 可执行路径
- `codex.model`（可选）：传给 Codex CLI 的 `--model`
- `codex.sandbox`（可选，默认 `read-only`）：允许 `read-only` / `workspace-write`
- `codex.addDirs`（可选，默认 `[]`）：逐个传给 `--add-dir`
- `codex.loadUserConfig` / `codex.loadRules`（可选，默认 `false`）：默认传 `--ignore-user-config` / `--ignore-rules`，避免继承未审计的本机 Codex 配置或 rules
- `ui.toolMessages`（可选，默认 `append`）：`append` 会把每个工具调用作为单独消息追加，并在结果到达时编辑该工具消息补结果摘要；`compact` 回到旧式紧凑显示，只把工具状态揉进当前回复消息
- `log.level`（可选，默认 `info`）：`trace|debug|info|warn|error|fatal`

写 Discord bot token 到 `~/.agent-nexus/secrets/DISCORD_BOT_TOKEN`（**权限必须 0600**，否则启动拒绝）：

```bash
echo -n '<your-discord-bot-token>' > ~/.agent-nexus/secrets/DISCORD_BOT_TOKEN
chmod 600 ~/.agent-nexus/secrets/DISCORD_BOT_TOKEN
```

### 4. 运行

开发模式（`tsx` 热加载源码）：

```bash
pnpm dev
```

构建后跑（生产模式）：

```bash
pnpm build
pnpm pack:cli
npm install -g packages/cli/agent-nexus-cli-*.tgz
agent-nexus
```

启动会先跑 CC CLI 兼容性 probe（版本、`--print` JSON、长驻 `stream-json`、工具权限检查），失败直接 `exit 1`；通过后连 Discord，看到 `discord_ready` / `engine_started` 日志即可在频道里 `@bot ping`。

### 5. 使用

- `@bot <prompt>`：发起一轮 CC 对话；同 `(channelId, userId)` 后续消息复用活跃 session
- `@bot /new`：清当前 (channel, user) 的内存 session，回复 `[new session ready]`
- `@bot /new <prompt>`：清 + 立即用 `<prompt>` 起新一轮
- `/claudecode-new` / `/codex-new`：按绑定到当前频道的 agent owner 清当前会话，回复 `[new session ready]`；只有对应 backend 已配置且在该 Discord 注册 scope 有 binding 时才会出现
- `/new`：仅在同一个 Discord 注册 scope 里只有一种 agent owner 时作为便捷 alias 出现
- `/discord-reply-mode mode:<mention|all>`：在 allowlist 内切换 Discord 消息触发模式
- `/reply-mode mode:<mention|all>`：legacy alias；迁移期内等价于 `/discord-reply-mode`

约束：

- 默认只响应**显式 @ 本机器人**的消息；切到 `all` 后仍只响应 `allowedUserIds` 内用户
- 只剥本 bot 的 mention，其他 `@<user>` 保留给 CC 看到原文
- threads、附件、按钮、reaction、delete 暂未支持；长回复会按切片发送 / edit

## 文档入口

- **开发者**：先读 [`AGENTS.md`](AGENTS.md) 和 [`docs/dev/README.md`](docs/dev/README.md)
- **使用者**：[`docs/product/README.md`](docs/product/README.md)
- **运维者**：[`docs/ops/runbook.md`](docs/ops/runbook.md)
- **所有文档导航**：[`docs/README.md`](docs/README.md)

## 协作

本仓库使用 Conventional Commits。任何代码或接口改动之前必须先有 ADR 或 spec 落盘。详细规则见 [`AGENTS.md`](AGENTS.md)。

## 许可证

[MIT](LICENSE)。
