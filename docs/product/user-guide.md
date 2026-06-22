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

默认实例根目录是 `~/.agent-nexus`。需要同时运行 stable / dev 等多个实例时，用 `agent-nexus --home <dir>` 或 `AGENT_NEXUS_HOME=<dir>` 指定实例根目录；配置、密钥与状态文件都会从该目录派生。

后续启动会自动把模板中新增但本地缺失的字段补回 `config.json`；已有配置值不会被覆盖。必填字段如果没有真实默认值，只会补占位值并继续提示你填写。

编辑 `~/.agent-nexus/config.json`：

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
  "daemon": {
    "commandRegistry": {
      "registration": {
        "enabled": true,
        "applyTimeoutMs": 30000,
        "retry": {
          "maxAttempts": 3,
          "backoffMs": 1000
        }
      },
      "aliases": {
        "singleAgent": {
          "enabled": true
        },
        "legacy": {
          "replyMode": true
        }
      },
      "textPrefixes": {
        "newSession": true
      }
    }
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
| `platforms[].name` | 是 | platform bot 实例稳定名称；binding 用它引用该 bot |
| `platforms[].type` | 是 | 当前支持 `discord` |
| `platforms[].botUserId` | 是 | Discord bot user id |
| `platforms[].tokenRef` | 是 | token secret 文件名；默认读取 `~/.agent-nexus/secrets/DISCORD_BOT_TOKEN` |
| `platforms[].auth.allowlist.userIds` / `roleIds` | 是 | 允许使用 bot 的用户或角色；至少有一个 ID 维度非空 |
| `platforms[].auth.allowlist.allowedGuildIds` | 否 | 限定可用 server/guild；`[]` 表示不按 guild 收窄 |
| `platforms[].auth.allowlist.allowedChannelIds` | 否 | 限定可用 channel/thread；`[]` 表示不按 channel 收窄 |
| `platforms[].auth.allowlist.allowDM` | 否 | 默认 `true`；DM 仍必须命中 `userIds` |
| `platforms[].testGuildId` | 否 | 开发时把 slash command 限定注册到一个 guild，避免全局 slash command 缓存延迟 |
| `agents[].name` | 是 | agent 配置稳定名称；binding 用它引用该 agent |
| `agents[].backend` | 是 | `claudecode` 或 `codex` |
| `agents[].claudeCode.workingDir` | backend 为 `claudecode` 时是 | Claude Code 默认工作目录 |
| `agents[].claudeCode.bin` | 否 | Claude Code CLI 路径；默认 `claude` |
| `agents[].claudeCode.permissionLevel` | 否 | 默认 `default`；允许 `default` / `acceptEdits` / `auto` / `bypassPermissions` / `dontAsk` / `plan` |
| `agents[].claudeCode.allowedTools` | 否 | 默认 `Read/Grep/Glob/Edit/Write`；启用 `Bash` 需要显式加入 |
| `agents[].codex.workingDir` | backend 为 `codex` 时是 | Codex 默认工作目录，传给 `--cd` |
| `agents[].codex.bin` | 否 | Codex CLI 路径；默认 `codex` |
| `agents[].codex.model` | 否 | 传给 Codex CLI 的 `--model` |
| `agents[].codex.sandbox` | 否 | 默认 `read-only`；可设为 `workspace-write` |
| `agents[].codex.addDirs` | 否 | 默认 `[]`；逐个传给 `--add-dir` |
| `agents[].codex.loadUserConfig` / `loadRules` | 否 | 默认 `false`，启动时传 `--ignore-user-config` / `--ignore-rules` |
| `bindings[].platformName` | 是 | 引用 `platforms[].name` |
| `bindings[].agentName` | 是 | 引用 `agents[].name` |
| `bindings[].match.discord.channelIds` | 是 | 该 binding 匹配的 Discord channel/thread id 列表 |
| `daemon.commandRegistry.registration.enabled` | 否 | 默认 `true`；设为 `false` 时不 apply 远端 slash command 注册计划，本地 command dispatch 保持 fail-closed |
| `daemon.commandRegistry.registration.applyTimeoutMs` | 否 | 默认 `30000`；注册计划 apply 超时毫秒数 |
| `daemon.commandRegistry.registration.retry.maxAttempts` / `backoffMs` | 否 | 默认 `3` / `1000`；启动时注册计划 apply 的重试策略 |
| `daemon.commandRegistry.aliases.singleAgent.enabled` | 否 | 默认 `true`；控制裸 `/new` / `/stop` single-agent slash alias，不影响 `/codex-new` / `/codex-stop` / `/claudecode-new` / `/claudecode-stop` |
| `daemon.commandRegistry.aliases.legacy.replyMode` | 否 | 默认 `true`；控制 legacy `/reply-mode` 是否注册，不影响 `/discord-reply-mode` |
| `daemon.commandRegistry.textPrefixes.newSession` | 否 | 默认 `true`；控制 `@bot /new` 文本前缀，不影响 slash command |
| `ui.toolMessages` | 否 | 默认 `append`；工具调用追加为独立消息并在结果到达时编辑该工具消息。设为 `compact` 可回到旧式紧凑显示 |
| `log.level` | 否 | `trace` / `debug` / `info` / `warn` / `error` / `fatal`，默认 `info` |

### Codex backend 配置细节

启用 Codex CLI backend 时，最小配置通常是：

```json
{
  "name": "codex-dev",
  "backend": "codex",
  "codex": {
    "workingDir": "/path/to/your/repo",
    "bin": "codex",
    "sandbox": "read-only",
    "addDirs": [],
    "loadUserConfig": false,
    "loadRules": false
  }
}
```

如果你希望 bot 能修改 `workingDir` 里的项目文件，把 `sandbox` 改成 `workspace-write`：

```json
{
  "name": "codex-dev",
  "backend": "codex",
  "codex": {
    "workingDir": "/path/to/your/repo",
    "sandbox": "workspace-write",
    "addDirs": [],
    "loadUserConfig": false,
    "loadRules": false
  }
}
```

`sandbox` 决定 Codex CLI 的文件访问模式：

| 值 | 适用场景 | 行为 |
|---|---|---|
| `read-only` | 让 bot 只读代码、解释问题、做 review | 默认值；Codex 不能写项目文件 |
| `workspace-write` | 让 bot 直接改 `workingDir` 下的仓库文件 | Codex 可以在工作目录内创建、修改、删除文件 |

`addDirs` 用来额外开放工作目录之外的路径。默认保持 `[]`。只有当 Codex backend 必须访问另一个目录时才配置，例如主项目在 `/workspace/app`，但还需要读共享 SDK `/workspace/shared-sdk`：

```json
{
  "name": "codex-dev",
  "backend": "codex",
  "codex": {
    "workingDir": "/workspace/app",
    "sandbox": "workspace-write",
    "addDirs": ["/workspace/shared-sdk"]
  }
}
```

不要把 home、密钥目录、浏览器 profile、SSH/GPG 目录这类宽泛或敏感路径放进 `addDirs`。`addDirs` 是显式扩大 Codex CLI 可见范围的配置，应尽量只填具体项目目录。

`loadUserConfig` 控制是否加载本机全局 Codex 配置：

| 值 | 行为 | 建议 |
|---|---|---|
| `false` | 默认；启动时传 `--ignore-user-config` | 推荐。bot 行为只受 agent-nexus 配置控制 |
| `true` | 允许 Codex CLI 继承你的全局 Codex config | 只在你明确需要复用全局模型、provider 或其他 Codex CLI 设置时打开 |

`loadRules` 控制是否加载 Codex rules：

| 值 | 行为 | 建议 |
|---|---|---|
| `false` | 默认；启动时传 `--ignore-rules` | 推荐。避免仓库外或用户级 rules 改变 bot 行为 |
| `true` | 允许 Codex CLI 读取 rules | 只在你确认这些 rules 适合 Discord bot 场景时打开 |

常见组合：

| 目标 | 推荐配置 |
|---|---|
| 只让 bot 解释代码 / review | `sandbox: "read-only"`，`addDirs: []`，`loadUserConfig: false`，`loadRules: false` |
| 让 bot 修改当前仓库 | `sandbox: "workspace-write"`，`addDirs: []`，`loadUserConfig: false`，`loadRules: false` |
| 多仓库联动 | `workspace-write` 加上最小必要的 `addDirs` |
| 复用个人 Codex CLI 行为 | 只在理解影响后把 `loadUserConfig` 或 `loadRules` 改为 `true` |

Codex backend 固定使用非交互 `codex exec --json` / `resume`，并固定传 `--ask-for-approval never`。因此需要人工确认的操作不会弹出审批窗口；应通过 `sandbox`、`workingDir`、`addDirs` 和默认不加载用户配置 / rules 来控制边界。

启动时默认只跑快速 Codex compatibility probe：检查 `codex --version` 与 help 中的必需 flag，不发起真实模型 turn。这样 Discord bot 启动不会先等待多轮 `codex exec --json`。如果要做完整 Codex backend 验证，使用仓库里的 `scripts/verify-codex-agent.sh`。

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

会话按命名 platform bot、平台类型、channel/thread 和 user 隔离。同一个用户在同一个频道里继续 `@bot` 会复用 daemon RoutingSession；具体 agent conversation 如何延续由绑定的 agent package 处理。

重置会话：

```text
@bot /new
@bot /new 从这个问题重新开始
/claudecode-new  # 路由给 Claude Code agent package
/codex-new       # 路由给 Codex agent package
```

`/claudecode-new` 和 `/codex-new` 是 agent slash command 的稳定名称，按当前频道 binding 路由到对应 backend。每个 `-new` 命令只在对应 backend 已配置且在该 Discord 注册 scope 有 binding 时注册；只启用一个 backend 时只会看到对应的那一个。`/new` 只有在同一个 Discord 注册 scope 里只有一种 agent owner 且 `daemon.commandRegistry.aliases.singleAgent.enabled=true` 时才会作为 slash command alias 出现；多 backend 共用同一个 scope 时不会注册裸 `/new`，避免歧义。`@bot /new <prompt>` 是文本前缀形式，可以在重置后立即带 prompt 开新一轮；可用 `daemon.commandRegistry.textPrefixes.newSession=false` 禁用。

中断和终止：

```text
/claudecode-stop  # 路由给 Claude Code agent package
/codex-stop       # 路由给 Codex agent package
/stop             # 单 agent scope 下的便捷 alias
/nexus-kill       # daemon 直接终止当前 RoutingSession
/nexus-sessions   # 列出可恢复 session，并用下拉菜单切换
/nexus-new-thread # 在当前 Discord channel 下创建新的私有 thread 会话
/nexus-working-dir path:/workspace/app
/nexus-working-dir path:/workspace/app scope:session
/nexus-settings   # 打开当前 channel/thread 的交互式 settings 面板
/nexus-queue      # 打开当前会话队列面板；可移动、编辑、取消 pending、插入 next prompt，或让下一条接管
```

`new` / `stop` 是 agent command，daemon 只完成鉴权、reverse-map、binding route 和 envelope 转发；重置、停止、排队或拒绝等具体语义由对应 agent package/runtime 决定。`/nexus-kill` 是 daemon command，会终止当前 RoutingSession，并清掉后续 resume 需要的 opaque agent conversation ref。`/nexus-sessions` 是内存态 session switcher：Discord 会显示仅调用方可见的下拉菜单，每项用该 session 的第一条用户消息做标题；选择某一项后当前 channel/user 会绑定到对应 agent conversation，下一条消息按该 conversation resume；进程重启后列表会丢失。`/nexus-new-thread` 会在当前 channel 下创建 private thread，默认把调用者加入；thread 中第一条用户消息启动一个新的 agent session；只有创建时未传标题、仍使用默认占位标题时，才会自动把 thread 名改成第一条消息生成的标题，不迁移父 channel 的当前会话。`/nexus-working-dir` 默认设置当前 channel/thread 的工作目录默认值；thread 未设置时继承父 channel 的默认值。传 `scope:session` 时才为当前 channel/thread + user 的下一次新 agent session 设置一次性 override。路径必须在当前 binding 目标 agent 的默认 `workingDir` 内。如果当前 session 正在运行，workingDir 变更会排到当前 turn 后面，不会影响当前进程。`/nexus-settings` 是统一入口：展示并修改当前 reply-mode、effective workingDir、channel agent binding、session resume 和 new-thread 操作；每次操作返回新的 ephemeral 快照。settings 里的 workingDir 直接用 modal 输入路径；agent binding 是当前进程内的 channel override，重启后回到配置文件 binding。`/nexus-queue` 打开当前 channel/thread + user 的 daemon queue 面板：用下拉选择 pending item，再用按钮上移、下移、编辑 message prompt 或取消；`Run next` / `action:next` 会中断当前 running turn，让下一条 pending item 接着执行；`Insert next` 会用 modal 插入一条排在当前 running 后面的 prompt；`action:clear` 只取消 pending items，不中断 running turn。

当前除 `/discord-reply-mode` / `/reply-mode` / `/nexus-sessions` / `/nexus-new-thread` / `/nexus-working-dir` / `/nexus-settings` / `/nexus-queue` 外，agent / daemon slash command 的成功 ack 会作为普通频道消息发送；如果 command registry 尚未激活、当前频道没有匹配 binding，或调用方未通过 allowlist，Discord 会显示一条仅调用方可见的 ephemeral 反馈。排障时看 daemon 日志中的 `command_*` / `auth_denied` / `command_registration_*` / `thread_create_failed` 事件。

### 管理排队中的消息

当你连续发了多条消息，而第一条还在执行时，后续消息会留在当前 channel/thread + user 的 queue 里。使用 `/nexus-queue` 打开面板：

- 面板顶部显示当前 running item、pending 数量和最近 completed / failed / cancelled 计数
- 用下拉菜单选择一条 pending item
- `Up` / `Down` 调整它在 pending 列表里的顺序
- `Edit` 修改 pending message prompt；这只改变即将发送给 agent 的文本，不会编辑 Discord 原消息
- `Cancel` 取消选中的 pending item
- `Insert next` 插入一条新的 prompt，排在当前 running 后面、已有 pending 前面
- `Run next` 中断当前 running turn，让下一条 pending item 接着执行
- `action:clear` 一次性取消全部 pending item

running item 不能被 `/nexus-queue` 编辑或重排；要保留 pending 并尽快进入下一条，用 `/nexus-queue action:next`。要直接停止当前 agent 输出，用 agent 的 `/stop`；要清掉当前 RoutingSession 和 pending，用 daemon 的 `/nexus-kill`。

切换触发模式：

```text
/discord-reply-mode mode:mention
/discord-reply-mode mode:all
/reply-mode mode:mention
/reply-mode mode:all
```

`/discord-reply-mode` 是稳定名称；`/reply-mode` 是迁移期 legacy alias，可用 `daemon.commandRegistry.aliases.legacy.replyMode=false` 停止注册。

`all` 模式只影响消息触发条件，不绕过 `allowedUserIds`。不在 allowlist 里的用户仍不能驱动 bot。

重载配置：

```text
/nexus-reload-config
```

`/nexus-reload-config` 是 daemon command，重新加载 `config.json` 并热应用 `bindings[]`、`platforms[].auth`、`ui.toolMessages` 和 `daemon.commandRegistry.textPrefixes`；解析或校验失败时保留当前生效配置，错误以 ephemeral 反馈返回调用方。`platforms[]` 其余字段、`agents[]`、`log` 等变更仍需重启进程生效，reload 成功反馈会带提示。完整语义见 [`config-routing.md` §配置热重载](../dev/spec/config-routing.md#配置热重载)。

## 工具与安全

- 默认工具集是 `Read` / `Grep` / `Glob` / `Edit` / `Write`。
- `Bash` 默认禁用；加入 `allowedTools` 后启动会打 warn。
- 白名单外工具应在执行前被拒绝；机制细节见 [`../dev/spec/security/tool-boundary.md`](../dev/spec/security/tool-boundary.md)。
- agent-nexus 是本机进程。它能访问的文件和网络能力取决于本机运行环境与 Claude Code 工作目录。

## 停止

会话内 agent command 用 `/stop`、`/codex-stop` 或 `/claudecode-stop`；要直接终止当前 Nexus route 用 `/nexus-kill`。

前台运行时按 `Ctrl-C`。进程收到 `SIGINT` / `SIGTERM` 后会调用 engine stop 并断开 Discord。

长期运行、日志保留和排障步骤见 [`../ops/runbook.md`](../ops/runbook.md)。
