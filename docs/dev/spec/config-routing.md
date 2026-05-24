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
  - dev/spec/security/secrets
contracts:
  - AgentNexusConfig
  - PlatformConfig
  - AgentConfig
  - PlatformBinding
  - RoutingTable
---

# Spec：配置与路由契约

定义 agent-nexus 启动配置从"单 Discord bot + 单 agent backend"升级为"命名 platform bot 集合 + 命名 agent 集合 + 显式 binding"后的配置与路由契约。字段权威源在本 spec；平台与 backend 私有字段的细节仍由各 owner spec / package parser 拥有。

## 目标

- 顶层 `platforms[]` 表达一个或多个平台 bot 实例。
- 顶层 `agents[]` 表达一套或多套 agent 配置。
- 每个 platform 实例通过 `bindings[]` 显式绑定到命名 agent。
- 路由按 platform instance identity 与平台侧条件匹配；未匹配和多重匹配都 fail-closed。
- 现有单实例配置不静默半兼容，必须清晰迁移或报错。

## 顶层 schema

```text
AgentNexusConfig {
    platforms: PlatformConfig[]       // 必填，非空
    agents: AgentConfig[]             // 必填，非空
    log: LogConfig?                   // 现有 log 配置，缺省仍为 info
    ui: DaemonConfig?                 // 现有 daemon/ui 配置
}
```

顶层不再使用 `discord`、`agent`、`claudeCode`、`codex` 作为主配置入口。loader 看到这些 legacy 顶层字段时不得悄悄混用；迁移语义见下文。

## PlatformConfig

```text
PlatformConfig {
    name: string                      // 全局唯一，稳定实例名
    type: "discord"                   // P8 锁定的首个类型
    bindings: PlatformBinding[]       // 必填，非空

    // type="discord" owner 字段，由 platform-discord parser 校验
    botUserId: string
    tokenRef: string                  // secret ref 名称，不是 token 值
    statePath?: path
    testGuildId?: string
    allowedUserIds: string[]
}
```

### Platform 字段规则

| 字段 | 规则 |
|---|---|
| `name` | 非空字符串；在 `platforms[]` 内唯一；用于日志、routing table 与 session key partition |
| `type` | P8 只允许 `"discord"`；未知 type 启动失败 |
| `bindings` | 非空数组；每条 binding 由该 platform type 的 owner parser 校验平台侧条件 |
| `tokenRef` | secret ref 名称；loader 只能用它定位 secret 文件 / secret provider，不得接受明文 token |
| `allowedUserIds` | Discord 实例级 allowlist；必填且非空；缺失或空数组按 platform-discord 现有 fail-closed 规则处理 |
| `statePath` | 可选；缺省由 CLI 以 platform `name` 派生稳定路径，避免多 bot 共用同一 state 文件 |

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
| `claudeCode` | `backend="claudecode"` 时必填，且只能由 `@agent-nexus/agent-claudecode` parser 校验 |
| `codex` | `backend="codex"` 时必填，且只能由 `@agent-nexus/agent-codex` parser 校验 |

`AgentConfig` 不继承全局 workingDir / toolWhitelist。需要两套不同工作目录或工具边界时，配置两个不同 `agents[]` 项。

## PlatformBinding

binding 是 platform 实例内的路由规则，引用一个命名 agent，并携带该 platform type 拥有的匹配条件。

```text
PlatformBinding {
    agentName: string                 // 必须引用 agents[].name

    // type="discord" owner 字段，由 platform-discord parser 校验
    channelIds?: string[]             // 至少一个平台条件必须存在
    guildIds?: string[]
    threadIds?: string[]
    allowedUserIds?: string[]
}
```

### Binding 字段规则

| 字段 | 规则 |
|---|---|
| `agentName` | 必填；必须引用存在的 `agents[].name` |
| `channelIds` | Discord channel allow/bind 条件；非空字符串数组；命中 `event.sessionKey.channelId` |
| `guildIds` | Discord guild 条件；仅当 NormalizedEvent 携带 guild identity 后可实现，P9 可先拒绝该字段并给迁移错误 |
| `threadIds` | Discord thread 条件；仅当平台 event 能区分 thread identity 后可实现，P9 可先拒绝该字段并给迁移错误 |
| `allowedUserIds` | binding 级用户条件；与 platform 实例级 allowlist 取交集语义 |

Discord P9 的最小实现必须支持 `channelIds` 与 `allowedUserIds`。若配置了 P9 尚未实现的条件字段，loader 必须 fail-closed，错误消息包含字段路径。

### 空条件禁止

每条 binding 至少包含一个平台侧匹配条件。禁止用"无条件 catch-all binding"伪装默认 agent；需要全频道开放时必须显式列出 channel 或由后续 ADR/spec 定义可审计的 allow-all 语法。

## Owner 校验边界

CLI loader 的职责：

1. 校验顶层结构、`name` 唯一性、`type` / `backend` 枚举、binding 引用存在。
2. 按 `platform.type` 调用对应 platform parser 校验平台字段与 binding 条件。
3. 按 `agent.backend` 调用对应 agent parser 校验 backend 私有字段。
4. 组装 platform adapter、agent runtime 与 routing table。

CLI loader 不得：

- 解释 `claudeCode` / `codex` 的业务字段。
- 解释 Discord token 明文值。
- 在未知字段或未知条件上静默忽略。
- 为未命中 binding 的事件选择默认 agent。

## RoutingTable

CLI 在启动时从已解析配置生成 routing table：

```text
RoutingTable {
    entries: RoutingEntry[]
}

RoutingEntry {
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
    channelIds?: string[]
    allowedUserIds?: string[]
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
3. `channelIds` 存在时，`event.sessionKey.channelId` 必须在列表内。
4. `allowedUserIds` 存在时，`event.sessionKey.initiatorUserId` 必须在列表内。
5. 匹配结果数量为 1 时，返回该 `agentName`。
6. 匹配结果数量为 0 时，拒绝 dispatch，打结构化日志 `route_not_found`。
7. 匹配结果数量大于 1 时，拒绝 dispatch，打结构化日志 `route_ambiguous`。

拒绝 dispatch 不得调用任何 agent runtime，也不得创建 session。

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

`SessionKey.platform` 当前只有平台类型字符串（如 `"discord"`）。多 platform 实例后，同一类型的不同 bot 可能拥有相同 channel/user ID，必须纳入 platform instance identity。

P10 起 `SessionKey` 或等价 routing/session context 必须包含 `platformName`。序列化 session key 至少区分：

```text
platformName + platformType + channelId + initiatorUserId
```

在该迁移完成前，CLI 必须拒绝同时启动两个同 type platform 实例，错误消息说明当前 session 隔离尚未完成。

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

P9 必须选择以下之一，不得静默半兼容：

1. **显式迁移**：loader 识别 legacy 形态，输出完整新结构到用户确认的路径；迁移结果中 platform `name` 与 agent `name` 使用稳定默认值，例如 `discord-main`、`claude-main`、`codex-main`。
2. **清晰错误**：loader 拒绝 legacy 形态，错误消息说明需要改为 `platforms[]` / `agents[]`，并给出最小字段路径清单。

无论选择哪一种，loader 都不得在内存里把 legacy 配置偷偷当新配置启动；否则运维无法审计实际路由。

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
| binding 引用不存在 agent | loadConfig | `ConfigError`，含 binding 字段路径 |
| binding 条件为空 | owner parser | `ConfigError`，含 binding 字段路径 |
| binding 条件非法 | owner parser | `ConfigError`，含 binding 字段路径 |
| route 未命中 | dispatch | `route_not_found` 日志；不调用 agent |
| route 多重命中 | dispatch | `route_ambiguous` 日志；不调用 agent |

## 合约测试

P9/P10 实现必须覆盖：

1. `platforms[]` / `agents[]` 缺失、空数组、重复 name、未知 type/backend。
2. binding 引用不存在 agent。
3. Discord binding `channelIds` / `allowedUserIds` 非空字符串数组校验。
4. legacy config 被显式迁移或清晰拒绝。
5. routing 0 命中、1 命中、多命中三分支。
6. 两个 Discord platform 实例的同 channel/user 不共享 session key。
7. secret 示例与日志不包含 token 明文。

## 反模式

- 配置未命中 binding 时回落到某个默认 agent。
- 多个 binding 命中时按数组顺序选择第一个。
- CLI 直接解析 backend 私有字段。
- Discord parser 静默忽略未知 binding 条件。
- 多个 platform 实例共用不含 platform name 的 session key。
- 示例配置把 token 写成明文字段。
