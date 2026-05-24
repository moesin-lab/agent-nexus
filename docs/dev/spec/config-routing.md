---
title: Spec：配置与路由契约
type: spec
status: active
summary: platforms[] / agents[] / bindings 的配置 schema、owner 校验边界、路由匹配语义与迁移规则
tags: [spec, config, routing, platform, agent]
related:
  - dev/adr/0015-multi-platform-agent-config
  - dev/spec/platform-adapter
  - dev/spec/agent-runtime
  - dev/spec/message-flow
  - dev/spec/security/auth
  - dev/spec/security/secrets
contracts:
  - AgentNexusConfig
  - PlatformConfig
  - AgentConfig
  - PlatformAuthConfig
  - PlatformBinding
  - RoutingTable
---

# Spec：配置与路由契约

定义 agent-nexus 启动配置从"单 Discord bot + 单 agent backend"升级为"命名 platform bot 集合 + 命名 agent 集合 + 显式 binding"后的配置与路由契约。字段权威源在本 spec；平台与 backend 私有字段的细节仍由各 owner spec / package parser 拥有。

## 目标

- 顶层 `platforms[]` 表达一个或多个平台 bot 实例。
- 顶层 `agents[]` 表达一套或多套 agent 配置。
- 顶层 `bindings[]` 表达 platform 到 agent 的显式路由关系。
- 路由按 platform instance identity 与平台侧条件匹配；未匹配和多重匹配都 fail-closed。
- 现有单实例配置不静默半兼容，必须清晰迁移或报错。

## 顶层 schema

```text
AgentNexusConfig {
    platforms: PlatformConfig[]       // 必填，非空
    agents: AgentConfig[]             // 必填，非空
    bindings: PlatformBinding[]       // 必填，非空
    log: LogConfig?                   // 现有 log 配置，缺省仍为 info
    ui: DaemonConfig?                 // 现有 daemon/ui 配置
}
```

顶层不再使用 `discord`、`agent`、`claudeCode`、`codex` 作为主配置入口。loader 看到这些 legacy 顶层字段时必须按 §Legacy 配置迁移 报错，不得悄悄混用。

## PlatformConfig

```text
PlatformConfig {
    name: string                      // 全局唯一，稳定实例名
    type: "discord"                   // 当前支持的首个类型
    auth: PlatformAuthConfig          // 必填；由 daemon.auth owner parser 校验

    // type="discord" owner 字段，由 platform-discord parser 校验
    botUserId: string
    tokenRef: string                  // secret ref 名称，不是 token 值
    statePath?: path
    testGuildId?: string
    publicChannelMode?: "disabled" | "thread" | "public"
}
```

### Platform 字段规则

| 字段 | 规则 |
|---|---|
| `name` | 非空字符串；在 `platforms[]` 内唯一；用于日志、routing table 与 session key partition |
| `type` | 当前只允许 `"discord"`；未知 type 启动失败 |
| `auth` | 实例级授权配置；必填；字段语义见 §PlatformAuthConfig |
| `tokenRef` | secret ref 名称；loader 只能用它定位 secret 文件 / secret provider，不得接受明文 token |
| `statePath` | 可选；缺省由 CLI 以 platform `name` 派生稳定路径，避免多 bot 共用同一 state 文件 |
| `publicChannelMode` | Discord 公开 channel 策略；缺省 `thread`；字段语义见 [`security/auth.md`](security/auth.md) |

## PlatformAuthConfig

多 platform instance 后，授权配置从 legacy `config.security.allowlist` 迁到每个 `PlatformConfig.auth`。
同一进程内多个 bot 可以拥有不同 allowlist。auth 由 `daemon.auth` 拥有；router 不读取 user/role/guild
授权字段。

```text
PlatformAuthConfig {
    allowlist: AllowlistConfig        // 必填；见 security/auth.md
}
```

`AllowlistConfig` 字段继续以 [`security/auth.md`](security/auth.md) 为权威源：
`userIds`、`roleIds`、`allowedGuildIds`、`allowedChannelIds`、`allowDM`、`requireMentionOrSlash`。
loader 必须调用 daemon.auth owner parser 校验这些字段，不能由 platform parser 或 routing
matcher 自行解释。

## AgentConfig

```text
AgentConfig {
    name: string                      // 全局唯一，稳定 agent 名
    backend: "claudecode" | "codex"

    // backend="claudecode" owner 字段，由 agent-claudecode parser 校验
    claudeCode?: ClaudeCodeConfig

    // backend="codex" owner 字段，由 agent-codex parser 校验
    codex?: CodexConfig
}
```

### Agent 字段规则

| 字段 | 规则 |
|---|---|
| `name` | 非空字符串；在 `agents[]` 内唯一；binding 只能通过此名称引用 |
| `backend` | 必填；未知 backend 启动失败 |
| `claudeCode` | `backend="claudecode"` 时必填；`backend="codex"` 时必须缺省；字段内容只能由 `@agent-nexus/agent-claudecode` parser 校验 |
| `codex` | `backend="codex"` 时必填；`backend="claudecode"` 时必须缺省；字段内容只能由 `@agent-nexus/agent-codex` parser 校验 |

`AgentConfig` 不继承全局 workingDir 或 backend 私有安全字段。需要两套不同工作目录或 Claude Code `allowedTools` 边界时，配置两个不同 `agents[]` 项。
inactive backend 配置块必须拒绝，不能作为"未知但忽略"字段保留，避免陈旧私有配置影响审计。

## PlatformBinding

binding 是顶层路由关系实体，连接一个命名 platform 实例与一个命名 agent，并携带该 platform type 拥有的匹配条件。

```text
PlatformBinding {
    name: string                      // 全局唯一，稳定 binding 名
    platformName: string              // 必须引用 platforms[].name
    agentName: string                 // 必须引用 agents[].name
    match: PlatformMatchSpec          // 由 platform type 判定 owner 字段
}

PlatformMatchSpec {
    // platformName 指向 type="discord" 时必填，由 platform-discord parser 校验
    discord: DiscordMatchSpec
}

DiscordMatchSpec {
    channelIds: string[]              // 非空；命中 event.sessionKey.channelId
}
```

### Binding 字段规则

| 字段 | 规则 |
|---|---|
| `name` | 非空字符串；在 `bindings[]` 内唯一；用于日志、routing table 与错误定位 |
| `platformName` | 必填；必须引用存在的 `platforms[].name` |
| `agentName` | 必填；必须引用存在的 `agents[].name` |
| `match.discord.channelIds` | Discord channel allow/bind 条件；非空字符串数组；命中 `event.sessionKey.channelId` |

Discord 当前最小 binding 条件只支持 `channelIds`。用户、角色、guild、DM、公开 channel 策略全部属于
`PlatformAuthConfig` / `daemon.auth`，不属于 routing matcher。若配置了未知 binding 条件字段，loader 必须
fail-closed，错误消息包含字段路径。

### 空条件禁止

每条 Discord binding 必须显式列出至少一个 `match.discord.channelIds`。禁止用"无条件 catch-all binding"伪装默认 agent；需要全频道开放时必须显式列出 channel 或由后续 ADR/spec 定义可审计的 allow-all 语法。

### 暂不支持的条件

`guildIds` / 独立 `threadIds` 路由条件暂不进入当前 schema：当前 `NormalizedEvent` / `SessionKey` 没有独立
guild identity，且 thread 已折叠为 `sessionKey.channelId`。若后续要按 guild 或 thread 类型路由，必须先扩展
`message-protocol.md` 的身份字段并同步 persistence / idempotency 契约。

## Owner 校验边界

CLI loader 的职责：

1. 校验顶层结构、`name` 唯一性、`type` / `backend` 枚举、binding 引用存在。
2. 按 `platform.type` 调用对应 platform parser 校验 platform 字段与 binding match 条件。
3. 调用 daemon.auth parser 校验每个 `platforms[].auth`。
4. 按 `agents[].backend` 调用对应 agent parser 校验 backend 私有字段。
5. 组装 platform adapter、agent runtime 与 routing table。

CLI loader 不得：

- 解释 `claudeCode` / `codex` 的业务字段。
- 解释 Discord token 明文值。
- 用 routing matcher 解释 user/role/guild/DM 授权字段。
- 在未知字段或未知条件上静默忽略。
- 为未命中 binding 的事件选择默认 agent。

## RoutingTable

CLI 在启动时从已解析配置生成 routing table：

```text
RoutingTable {
    entries: RoutingEntry[]
}

RoutingEntry {
    bindingName: string
    platformName: string
    platformType: string
    agentName: string
    match: PlatformMatchSpec
}

PlatformMatchSpec {
    // discriminated by platformType
    discord?: DiscordMatchSpec
}

DiscordMatchSpec {
    channelIds: string[]
}
```

routing entry 不携带 backend 私有配置；它只引用已经构造好的 agent runtime。

## 路由匹配语义

入站 `NormalizedEvent` 本身只表达平台归一化事件；platform instance identity 由 CLI / daemon 在注册
platform adapter 时包一层 `RouteContext` 注入。这样 `PlatformAdapter` 仍保持按 platform type
输出标准事件，路由层负责知道"这条事件来自哪个配置里的 bot 实例"。

```text
RouteContext {
    platformName: string
    platformType: string
    event: NormalizedEvent
}
```

`RouteContext.platformName` 来自 `PlatformConfig.name`，不是 Discord 的 `botUserId`。
`botUserId` 仍只用于 Discord 身份自检；配置、日志、routing table 与 session partition
使用稳定 `platformName`。

匹配步骤：

1. 只考虑 `entry.platformName == context.platformName` 的 routing entries。
2. 按 `platformType` 调用 platform owner 的 match 函数。
3. `event.sessionKey.channelId` 必须在 `channelIds` 内。
4. 匹配结果数量为 1 时，返回该 `agentName`。
5. 匹配结果数量为 0 时，拒绝 dispatch，打结构化日志 `route_not_found`。
6. 匹配结果数量大于 1 时，拒绝 dispatch，打结构化日志 `route_ambiguous`。

拒绝 dispatch 不得调用任何 agent runtime，也不得创建 session。
用户未授权不得表现为 `route_not_found`；唯一路由命中后，auth 层再按 `platforms[].auth.allowlist`
做四元组检查，拒绝时打 `auth_denied`。

唯一命中后，路由结果至少包含：

```text
RouteDecision {
    platformName: string
    agentName: string
    event: NormalizedEvent
}
```

后续 auth、idempotency、session 队列与出站发送必须沿用同一个 `platformName`，确保回复回到触发事件的
platform adapter 实例。

## Session 隔离

Adapter 产出的 `PlatformSessionKey.platform` 只有平台类型字符串（如 `"discord"`）。多 platform 实例后，同一类型的不同 bot 可能拥有相同 channel/user ID，daemon 必须在 route decision 后注入 platform instance identity。

daemon/agent 侧完整 `SessionKey` 必须包含 `platformName`。序列化 session key 区分：

```text
platformName + platformType + channelId + initiatorUserId
```

迁移完成后，CLI 可以同时启动多个同 type platform 实例；session store、idempotency 与 persistence
不得使用旧 3 段 key。

## Legacy 配置迁移

现有单实例配置形态：

```text
{
    agent: { backend },
    discord: { ... },
    claudeCode?: { ... },
    codex?: { ... }
}
```

迁移策略为 **清晰错误**：loader 拒绝 legacy 形态，错误消息说明需要改为 `platforms[]` / `agents[]`，
并给出最小字段路径清单。可在用户文档中提供人工迁移示例或后续迁移命令，但 loader 不做自动迁移，也不得在内存里把 legacy 配置偷偷当新配置启动。

## Secret 规则

- platform 配置只接受 `tokenRef`，不接受 token 明文。
- 示例配置不得包含真实 token 值。
- secret ref 的解析与文件权限继续遵守 [`security/secrets.md`](security/secrets.md)。
- 多个 platform 实例可引用不同 tokenRef；引用同一 tokenRef 允许，但日志只打印 ref 名称，不打印 token 内容。

## 错误分类

| 条件 | 错误时机 | 要求 |
|---|---|---|
| `platforms[]` 缺失或空 | loadConfig | `ConfigError`，含字段路径 |
| `agents[]` 缺失或空 | loadConfig | `ConfigError`，含字段路径 |
| platform / agent name 重复 | loadConfig | `ConfigError`，列出重复 name |
| 未知 platform type / backend | loadConfig | `ConfigError`，列出允许值 |
| platform auth 缺失或非法 | loadConfig | `ConfigError`，含 `platforms[i].auth` 字段路径 |
| agent owner 字段缺失或 inactive backend 块存在 | loadConfig | `ConfigError`，含 `agents[i].claudeCode` / `agents[i].codex` 字段路径 |
| binding name 重复 | loadConfig | `ConfigError`，列出重复 name |
| binding 引用不存在 platform / agent | loadConfig | `ConfigError`，含 binding 字段路径 |
| binding 条件为空 | owner parser | `ConfigError`，含 binding 字段路径 |
| binding 条件非法 | owner parser | `ConfigError`，含 binding 字段路径 |
| route 未命中 | dispatch | `route_not_found` 日志；不调用 agent |
| route 多重命中 | dispatch | `route_ambiguous` 日志；不调用 agent |

## 合约测试

loader / router 合约测试必须覆盖：

1. `platforms[]` / `agents[]` 缺失、空数组、重复 name、未知 type/backend。
2. `platforms[].auth.allowlist` 缺失、ID 列表全空、非法字段走 `ConfigError`，且字段路径清楚。
3. binding 引用不存在 platform / agent。
4. agent owner 字段缺失、inactive backend 块存在。
5. Discord binding `match.discord.channelIds` 非空字符串数组校验。
6. legacy config 被清晰拒绝。
7. routing 0 命中、1 命中、多命中三分支；未授权用户走 `auth_denied` 而不是 `route_not_found`。
8. 两个同 type platform 实例在 session 隔离迁移完成后可被解析；statePath 由 platform name 派生，互不复用。
9. secret 示例与日志不包含 token 明文。

session 隔离合约测试必须覆盖：

1. 两个 Discord platform 实例的同 channel/user 不共享 session key。
2. route decision 后续 auth、idempotency、session 队列与出站发送沿用同一个 `platformName`。

## 反模式

- 配置未命中 binding 时回落到某个默认 agent。
- 多个 binding 命中时按数组顺序选择第一个。
- CLI 直接解析 backend 私有字段。
- router 用 userId / roleId / guildId 做授权判断。
- Discord parser 静默忽略未知 binding 条件。
- 多个 platform 实例共用不含 platform name 的 session key。
- 示例配置把 token 写成明文字段。
