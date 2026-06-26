---
title: Spec：Platform Adapter 接口
type: spec
status: active
summary: IM 平台适配层接口契约；事件归一化、发送能力、能力声明、Discord 专属映射
tags: [spec, platform-adapter, discord, normalized-event, gateway]
related:
  - dev/spec/message-protocol
  - dev/spec/command-registry
  - dev/spec/config-routing
  - dev/architecture/overview
  - dev/spec/infra/cost-and-limits
  - dev/spec/security/README
contracts:
  - PlatformAdapter
  - OutboundMessage
  - MessageRef
  - MessageEmbed
  - MessageComponent
  - EventCommandResponse
  - EventModalResponse
  - CapabilitySet
  - CreateThreadInput
  - CreateThreadResult
  - UpdateThreadInput
  - PlatformSettingsSnapshotInput
  - PlatformSettingsSnapshot
  - SettingsSnapshotItem
  - PlatformSettingsActionInput
  - PlatformSettingsActionResult
---

# Spec：Platform Adapter 接口

定义 IM 平台适配层的接口契约。每个 IM 平台（当前仅 Discord）实现此接口并注册到 daemon。

> **package 归属**：`PlatformAdapter` 接口与相关类型（`OutboundMessage` / `MessageRef` / `CapabilitySet`）定义在 `@agent-nexus/protocol` package；**具体平台实现** 住在 `@agent-nexus/platform-<name>` 独立 package（如 `@agent-nexus/platform-discord`）。详见 [`adr/0004-language-runtime.md`](../adr/0004-language-runtime.md) §TS-P7。

## 目标

- 把平台特定事件归一化为 `NormalizedEvent`（定义见 [`message-protocol.md`](message-protocol.md)）
- 把 `OutboundMessage` 发到目标平台
- 声明平台能力（capability），让 daemon 知道哪些富交互可用
- 处理平台特定的连接管理（gateway、webhook、重连）

## 接口

### 生命周期

```text
interface PlatformAdapter {
    // 元信息
    name() -> string                        // 例 "discord"
    capabilities() -> CapabilitySet

    // 生命周期
    start(handler: EventHandler) -> void
    stop() -> void

    // 发送
    send(sessionKey, OutboundMessage) -> MessageRef
    edit(messageRef: MessageRef, OutboundMessage) -> void
    delete(messageRef: MessageRef) -> void

    // 可选：创建平台原生 thread；仅 supportsThreadCreation=true 时由 daemon 调用
    createThread(input: CreateThreadInput) -> CreateThreadResult
    updateThread(input: UpdateThreadInput) -> void

    // 输入指示（仅 supportsTypingIndicator=true 时由 daemon 调用）
    setTyping(sessionKey) -> void       // 开始/续期 typing 指示
    clearTyping(sessionKey) -> void     // 显式清除（turn 结束/interrupt/错误）

    // 可选：platform-owned settings 的只读快照与 owner action
    settingsSnapshot(input: PlatformSettingsSnapshotInput) -> PlatformSettingsSnapshot
    applySettingsAction(input: PlatformSettingsActionInput) -> PlatformSettingsActionResult

    // 可选：反应/表情
    react(messageRef: MessageRef, emoji: string) -> void

    // 可选：thread 与 settings 控制面
    createThread(input: CreateThreadInput) -> CreateThreadResult
    updateThread(input: UpdateThreadInput) -> void
    settingsSnapshot(input: PlatformSettingsSnapshotInput) -> PlatformSettingsSnapshot
    applySettingsAction(input: PlatformSettingsActionInput) -> PlatformSettingsActionResult
}

type EventHandler = fn(NormalizedEvent) -> void
```

`PlatformAdapter.name()` 表示 platform type，不是配置里的 platform instance name。多 bot / 多
platform instance 的稳定实例名由 [`config-routing.md`](config-routing.md) 的 `PlatformConfig.name`
定义；CLI / daemon 在注册 adapter 时把该实例名包进 `RouteContext`。

`settingsSnapshot` 是只读、按调用用户求值的反向读 port，用于 daemon 拼装 `/nexus-settings` 面板。它只能暴露平台 owner 自己持有的设置，例如 Discord adapter 的 reply-mode；daemon-owned session / thread / workingDir / agent binding override 仍由 daemon 自己拼入 snapshot。每个 item 必须带 `owner`、`source`、`durability` 与 `canChange`，其中 `canChange` 使用调用方身份判断，不能把平台 allowlist 逻辑搬到 daemon 里重写。

`applySettingsAction` 是 owner action port，用于 settings 面板把 platform-owned 写操作派回 adapter。Discord v1 仅支持 `action="discord.replyMode"`；权限、输入校验、状态文件写入与 `/discord-reply-mode` 保持同 owner 语义。daemon 不得直接改 platform 私有状态。

### 启动与停止

- `start(handler)`：建立连接，注册事件分发。每次收到并归一化一个事件后调用 `handler`。
- `stop()`：关闭连接、释放资源；必须幂等，支持多次调用。
- `setTyping(sessionKey)`：单次"现在显示 typing"语义；周期续期由 daemon 按 [`cost-and-limits.md`](infra/cost-and-limits.md) §流式集成数值 的 `typingRefreshMs` 重复调用，adapter **不持有定时器**（周期由 daemon engine 驱动，见 [`adr/0012-claudecode-stream-json-mainline.md`](../adr/0012-claudecode-stream-json-mainline.md) §PR-C 最小集成契约）。
- `clearTyping(sessionKey)`：turn 结束 / interrupt / 错误路径必须调用；幂等（无活跃 typing 时 no-op）。
- `setTyping` / `clearTyping` 仅在 `capabilities().supportsTypingIndicator === true` 时被 daemon 调用；为 false 时 daemon 不得调用（与 §CapabilitySet "不支持的能力不使用"一致）。
- **两者均为 fire-and-forget**：typing 指示是 best-effort，平台 API 失败由 adapter **静默吞掉 + 打 `debug` 日志**，**不向 daemon 抛**——尤其 `clearTyping` 失败不得中断 turn 结束 / interrupt / 错误的收尾路径。

`start` 必须：

- 在连接建立前不向 handler 投递事件
- 重连时通过 session resume 避免丢失事件
- 失败进入指数退避（与 [`cost-and-limits.md`](infra/cost-and-limits.md) 对齐）

## NormalizedEvent

详细字段见 [`message-protocol.md`](message-protocol.md)。这里只列出 adapter 必须填的字段：

| 字段 | 必填 | 说明 |
|---|---|---|
| `eventId` | 是 | 平台事件 ID（Discord interaction id / message id） |
| `platform` | 是 | `"discord"` |
| `sessionKey` | 是 | adapter 层 `PlatformSessionKey(platform, channelId, userId)`；daemon routing 层再注入 `platformName` |
| `messageId` | 视事件 | 消息类事件必填（Discord message snowflake） |
| `type` | 是 | `message | command | reaction | ...` |
| `text` | 视事件 | 消息正文（已去除 bot mention） |
| `attachments` | 视事件 | 附件列表（URL + meta） |
| `rawPayload` | 是 | 平台原始负载（调试用；不得外泄到日志或 IM） |
| `receivedAt` | 是 | Adapter 收到时间 |
| `guildId` | 否 | guild 消息所属 guild；DM 无该字段 |
| `initiatorRoleIds` | 否 | guild 内发起者角色 ID，用于 daemon.auth；DM 缺省或空数组 |
| `threadParentChannelId` | 否 | thread 事件所属父 channel；daemon 可用于 thread 会话继承父频道授权；非 thread 缺省 |

## OutboundMessage

daemon 调用 `send()` 时传入的对象。Adapter 负责映射到平台格式。

```text
OutboundMessage {
    text: string                              // 纯文本；纯组件消息用空字符串
    embeds: MessageEmbed[]?                   // 富卡片（见 CapabilitySet）
    components: MessageComponent[]?           // 按钮、选择器等
    replyTo: MessageRef?                      // 可选：作为回复
    ephemeral: bool?                          // 仅发起者可见（slash command 上下文）
    traceId: string                           // 贯穿链的 ID
    sessionKey: SessionKey
}
```

MessageEmbed 结构见本文件附录；Component 结构见下节 `MessageComponent`。

Platform-native ack/defer/followup/update/rate-limit 编排归 adapter。daemon 不持有 Discord interaction token、Slack ack deadline 或 Telegram callback query 等平台私有状态；daemon 只通过 `OutboundMessage` 表达平台中立的回复意图。Adapter 必须在平台要求的时限内完成 native ack/defer，并把后续 `send` / `edit` / followup 映射到对应平台 API。

Discord component / modal 的 ack 约束：

- 不打开 modal 的 component interaction：adapter 必须先 native defer，再调用 `EventHandler`。
- modal submit interaction：adapter 必须先 native defer，再调用 `EventHandler`。
- 打开 modal 的 component interaction：`showModal` 本身是该 interaction 的 native ack，adapter 必须在进入 daemon handler 前完成；adapter 只拥有 native modal 展示字段，最终会改变状态的提交仍由后续 modal submit 归一化为 `NormalizedEvent`，并在 daemon auth 后由对应 owner 处理。

`EventHandler` 可返回 `EventHandlerResult.commandResponse`，仅用于已被 adapter native defer/ack 的 command / component / modal interaction 收尾。Discord adapter 对非 reply-mode slash command、非 modal-opening component 与 modal submit 先发 ephemeral deferred reply；daemon 若返回 `commandResponse.text`，adapter 必须用 `editReply` 展示该 ephemeral 反馈，否则清理 deferred reply。`commandResponse.components` 可携带平台中立的按钮或 select；Discord adapter 映射为 Action Row + Button / String Select。普通消息与 agent 成功输出仍走 `OutboundMessage`。

`EventHandlerResult.modalResponse` 用于 native interaction 要求立即打开 modal 的平台。Adapter 负责把平台中立的 `EventModalResponse` 映射到平台 native modal；不能支持 modal 的 adapter 不得声明 `supportsModals`。

```text
EventCommandResponse {
    text: string
    ephemeral: bool?
    components: MessageComponent[]?
}
```

### MessageComponent / EventModalResponse

`MessageComponent` 是 daemon 给 adapter 的平台中立交互组件描述：

```text
MessageComponent =
  ButtonComponent | SelectComponent

ButtonComponent {
    type: "button"
    componentId: string
    label: string
    style: "primary" | "secondary" | "danger"
    disabled: bool?
}

SelectComponent {
    type: "select"
    componentId: string
    placeholder: string?
    options: [{
        label: string
        value: string
        description: string?
        default: bool?
    }]
    minValues: int?
    maxValues: int?
    disabled: bool?
}

EventModalResponse {
    modalId: string
    title: string
    inputs: [{
        componentId: string
        label: string
        kind: "short_text" | "long_text"
        required: bool?
        placeholder: string?
        value: string?
    }]
}
```

`componentId` / `modalId` 是 agent-nexus 内部的中立 ID。Adapter 映射到平台 native 字段；native token、ack handle、callback query id 等平台私有状态不得进入本契约。

## CapabilitySet

Adapter 声明自己支持的能力，daemon 据此降级或拒绝操作。

```text
CapabilitySet {
    maxTextLength: int                 // 单条消息最大字符数（Discord: 2000）
    supportsEdit: bool
    supportsDelete: bool
    supportsReactions: bool
    supportsEmbeds: bool
    supportsButtons: bool
    supportsSelects: bool?             // 缺省按 false 处理
    supportsModals: bool?              // 缺省按 false 处理
    supportsThreads: bool              // 是否支持 thread 作为 channelId
    supportsThreadCreation: bool?      // 缺省按 false 处理
    supportsEphemeral: bool            // 仅发起者可见；native 实现与 ack/followup 编排归 adapter
    supportsAttachments: bool
    maxAttachmentsPerMessage: int
    supportsTypingIndicator: bool
    supportsSlashCommands: bool        // 是否支持 slash command 注册与 interaction 投递
}
```

daemon 在发送前检查能力：超出 `maxTextLength` 的文本必须切片；不支持的能力不使用。新增 optional capability 字段缺省等同 `false`，用于保持旧 adapter capability literal 可编译；实现声明支持后必须有对应实现和合约测试。

## Thread / Settings 可选 port

`createThread` / `updateThread` 只在 adapter 声明对应能力后由 daemon 调用。

```text
CreateThreadInput {
    parentChannelId: string
    initiatorUserId: string
    title: string
    visibility: "private" | "public"
    autoArchiveDurationMinutes: int?
    initialMessage: string?
    traceId: string
}

CreateThreadResult {
    threadId: string
    parentChannelId: string
    url: string?
}

UpdateThreadInput {
    threadId: string
    title: string?
    traceId: string
}
```

`autoArchiveDurationMinutes` 是通用 TTL 意图，不定义具体枚举；adapter 若不支持或平台只支持离散值，必须在实现侧拒绝或映射到最近合法值，并记录结构化日志。

Settings port 用于 platform control surface 查询 / 修改平台层设置。它不承载 daemon auth、agent config 或平台 secret。

```text
PlatformSettingsSnapshotInput {
    userId: string
    channelId: string
    threadParentChannelId: string?
}

SettingsSnapshotItem {
    key: string
    label: string
    owner: "platform" | "daemon" | "agent"
    value: string
    source: string
    durability: "durable" | "in-memory" | "derived"
    canChange: bool
}

PlatformSettingsSnapshot {
    items: SettingsSnapshotItem[]
}

PlatformSettingsActionInput extends PlatformSettingsSnapshotInput {
    action: string
    value: string?
}

PlatformSettingsActionResult {
    status: "handled" | "rejected" | "unsupported"
    message: string
}
```

`settingsSnapshot` 必须是只读查询，不产生副作用。`applySettingsAction` 必须幂等：重复提交同一 action/value 要么保持目标状态，要么返回同一个拒绝原因，不得产生重复外部动作。

## MessageRef

`send` 返回的引用对象。用于 `edit`/`delete`/`react`。

```text
MessageRef {
    platform: string
    channelId: string
    messageId: string                 // 主消息 ID（多切片时为最后一条）；单条 compat 保留
    messageIds: string[]              // 全部切片 ID（有序，≥ 1 元素）；单条时 = [messageId]
    sentAt: timestamp
}
```

- 单条发送：`messageId === messageIds[0]`，`messageIds.length === 1`
- 多切片发送：`messageId` 为最后一切片 ID，`messageIds` 按发送顺序列出全部切片 ID
- 使用方对完整长回复做 edit / delete 时，应遍历 `messageIds`

MessageRef 由 adapter 构造，daemon 原样存储，不做解释。

## 事件分发语义

### at-least-once

Discord gateway 会重放事件。Adapter **不**做去重（daemon 的 idempotency 层做）。Adapter 只保证：

- 每个平台事件被解析为 0 或 1 个 `NormalizedEvent`
- 同一平台事件可能被 handler 调用多次（重放场景）
- Handler 内部保证幂等

### 顺序

Adapter 按**平台给的顺序**投递事件。不做重排序。如有乱序风险，通过 `messageId` 的时间戳可恢复顺序。

### 错误处理

- Adapter 自身错误（解析失败、反序列化失败）：打 `error` 日志并丢弃事件（不调用 handler）
- 连接错误：按退避重连，不影响事件分发语义
- Handler 抛出异常：adapter 捕获后打日志，不中止事件循环

## Discord 专属映射

下列映射是 Discord adapter 必须实现的，但接口对 daemon 透明：

| Discord 概念 | 归一化为 |
|---|---|
| Text message | `NormalizedEvent { type: "message" }` |
| Slash command | `NormalizedEvent { type: "command", command: { name, args, registrationScope } }` |
| Button click | `NormalizedEvent { type: "interaction", interaction: { componentId, kind: "button", values: [] } }` |
| String select | `NormalizedEvent { type: "interaction", interaction: { componentId, kind: "select", values } }` |
| Reaction add | `NormalizedEvent { type: "reaction", reaction: { emoji, action: "add" } }` |
| DM vs guild channel | 都映射为 channelId；DM 的 channelId 使用 Discord DM channel ID |
| Thread | thread.id 作为 `sessionKey.channelId`，父 channel id 填入 `threadParentChannelId` |
| Reply | `NormalizedEvent.replyTo = MessageRef`（指向被回复消息） |
| Mention (bot) | 从 text 中去除 bot mention 后填入 `text` |
| Attachment | `attachments[]`，包含 url、filename、contentType、size |

`CommandPayload.registrationScope` 必须使用该 platform instance 的 command registration scope。Discord adapter 不得用 interaction 发生位置推导 scope：global command 在 guild 内触发时仍标为 `global`；配置了 `testGuildId` 的实例才标为对应 guild scope。

### Discord thread 创建

`createThread` 用于 daemon-owned `/nexus-new-thread`。Discord adapter 必须：

- 在指定父 text channel 下创建 explicit private thread（不得依赖 Discord API 默认 type）
- 默认把 `initiatorUserId` 加入 thread
- 可选发送 `initialMessage`，并禁止默认 mention parse
- 如果创建 thread 后 add member 或 initial send 失败，必须尽力删除或归档刚创建的 thread，再把错误抛给 daemon

成功结果返回 `threadId` 与 `parentChannelId`；有 guild 上下文时可返回 Discord channel URL。daemon 负责把 thread metadata 写入 RoutingSession store，并决定后续授权与路由。

`updateThread` 用于 daemon 在首条用户消息确定标题后更新 thread 名称。Adapter 必须把 title 截断到平台允许长度；更新失败向 daemon 抛错，由 daemon best-effort 记录 `thread_update_failed`，不得中断当前 turn。

## Discord Trigger 策略

Discord adapter 提供两档触发模式，决定哪些 `messageCreate` 被归一化投递到 daemon：

| 模式 | 触发条件 |
|---|---|
| `mention`（默认） | 消息文本显式 @ 本机器人（plain `<@id>` 或 nick `<@!id>`） |
| `all` | 任意非 bot、非自身的用户消息 |

**两档共同前置 guard**：

1. `msg.system === true` → 丢弃（pin / join / thread-create 等系统消息）
2. `msg.author.bot === true` → 丢弃
3. `msg.author.id === botUserId` → 丢弃（防 bot 标志位被绕；在 `all` 档下变成关键路径，配合 §"Bot 身份自检"防自回环）
4. legacy user guard 启用时，`msg.author.id ∉ allowedUserIds` → 丢弃（见 §"用户白名单"；多平台 CLI 关闭此 adapter guard，改由 daemon 按 `platforms[].auth.allowlist` 统一鉴权）

**bot 自身 mention 的 strip 行为在两档下一致**：归一化前永远剥掉 `<@botUserId>` / `<@!botUserId>`，保留对其它用户的 mention。

### 用户白名单（legacy `allowedUserIds`）

本节描述 legacy 单 Discord 配置下 adapter 内部 guard 的现状。多平台配置启用后，授权字段迁到
`platforms[].auth.allowlist`，权威语义见 [`security/auth.md`](security/auth.md) 与
[`config-routing.md`](config-routing.md)；router 不得新增 user allowlist 语义。多平台 CLI 会把
`parseInbound(..., allowedUserIds = null)` 传给 Discord adapter，chat 路径不再提前按 userIds
过滤，保证 role / guild / channel 维度能进入 daemon auth gate。

`allowedUserIds: string[]` 由 config 提供，**同时控制两件事**：

| 通路 | 不在 allowedUserIds 里的行为 |
|---|---|
| Inbound chat（`messageCreate` 触发）| `parseInbound` 第 4 道 guard 静默丢弃，仅打 `discord_inbound_unauthorized` info 日志（仅记 user id，不带 username 与 message text） |
| Slash command（`/discord-reply-mode` / `/reply-mode`） | ephemeral ack 一句固定文案含调用方 user id；行为见 §"授权" |

**统一一套权限，不分 admin 与 user**——slash command 与普通对话归一到同一信任边界。

#### fail-closed 默认

- `allowedUserIds = []` 或字段缺省 → **拒绝所有 inbound chat 与 slash command**
- legacy `parseDiscordConfig` **必填**该字段。多平台 CLI 不再读取顶层 `discord.allowedUserIds`，而是用 `platforms[].auth.allowlist.userIds` 作为 slash command 授权列表，并让 daemon auth 统一处理 inbound chat 授权。
- 不允许"漏配 = 放行"——access control 的标准默认就是 fail-closed

理由：之前曾用 `ownerUserIds`（空数组 = "没人能切 mode"）是 fail-closed 的（语义无害——没人切罢了）；但展开到 inbound chat 时，"空 = 放行所有"会让漏配场景静默把 bot 暴露给频道全部用户，反而最危险。统一用 fail-closed 消除此类陷阱。

### 切换面板：Discord reply mode slash command

Reply mode command 纳入 [`command-registry.md`](command-registry.md) 的 `platform:discord:reply-mode`：

```text
/discord-reply-mode mode:<mention|all>?
/reply-mode mode:<mention|all>?     // legacy alias
```

- 不带 `mode` 参数：查询当前模式，ephemeral ack
- 带 `mode` 参数：写入新模式（持久化），ephemeral ack 确认
- `/discord-reply-mode` 是 stable name；`/reply-mode` 是迁移窗口内的 historical compatibility alias

#### 注册作用域：global vs per-guild

由 config `platforms[].testGuildId`（可选 string）决定：

| `testGuildId` | 注册作用域 | 生效延迟 | 适用场景 |
|---|---|---|---|
| 缺省 / 空 | **全局**（global）——所有 bot 加入的 guild 可见 | 不适合快速本地迭代 | 生产形态 |
| 非空 | **限定 guild**——只在该 guild 可见 | **瞬时**（重启后立刻可见） | 开发 / 单 guild 测试 |

Bot 不在 `testGuildId` 对应 guild 时：注册失败 → `discord_slash_command_register_failed` error 日志（不阻断启动），其它消息通路不受影响。

> **为什么暴露这个开关**：global slash command 的传播 / 客户端可见性不适合本地快速迭代。per-guild 是 Discord bot 开发的标准 dev workflow。生产部署应**不**配 `testGuildId`，跑 global。

### 授权

Reply mode slash command handler 复用上节 `allowedUserIds` 列表（**不再有独立的 `ownerUserIds`**）。检查 `interaction.user.id` 是否在该列表：

- 命中 → 正常处理
- 未命中 → **ephemeral ack 含调用方自己的 user id**（如 `Permission denied. Your User ID is \`<id>\`; ask the bot operator to add it.`），不更改状态、打 `discord_reply_mode_unauthorized` info 日志（仅记录 user id，不写 username）

`allowedUserIds` 为空数组 / 缺省 → 没人能 use slash command（也没人能 inbound chat）。这是 feature-locked 的安全默认（见上节 fail-closed 段）。

> **为什么 slash command 用 ack 而不是静默丢**：实战发现合法 owner 漏配 `allowedUserIds` 时被自己的 bot 静默拒（Discord 显示 "interaction failed"），看起来像 bot 坏了，UX 极差。攻击面"踩死"的收益≈0——Discord 协议本身就暴露 user id，告诉调用方"被拒"不给攻击者新信息；ack 里回显调用方自己的 id 让误配的合法 owner 一眼能修。inbound chat 路径仍然静默丢弃——chat 路径下回显"被拒"会刷屏并暴露 bot 存在给随意打字的用户，且不像 slash command 那样有"等 ack"的协议预期。

### 运行时状态持久化

Adapter 把 trigger 模式持久化到 `statePath`（由 config 提供）。文件格式：

```json
{
  "replyMode": "mention"
}
```

- `start()` 时：若文件存在且合法 → 用文件值；否则 → 默认 `mention`，**不**预写文件
- reply mode slash command 切换成功时：写入文件（`writeFile` 覆盖整文件，不需要原子性——单一 writer，状态极小）
- 文件损坏（JSON 解析失败 / 字段非法） → 启动失败抛错，**不**自动修复（避免静默丢失运维操作）

`statePath` 必填且 adapter 不自己选位置——避免 adapter 在文件系统里乱建目录。多 platform instance 配置下，CLI 必须传入实例级路径；默认路径与编码规则由 [`persistence.md`](infra/persistence.md#目录结构) 定义，避免多个 Discord bot 共用 reply-mode 状态。目录权限 `0700` 与 secrets 一致。

> **范围说明**：本 PR 把 state 限定到 platform-discord 私有；如果未来其它 platform 也需要持久化运行时状态，再独立 ADR 抽 daemon 级 state 抽象。当前不预先发明。

### Bot 身份自检（ready 回调）

Adapter 在 `client.on('ready')` 比较 `client.user?.id` 与 config 的 `botUserId`：

- 一致 → `discord_ready` info 日志
- 不一致 → `discord_bot_user_id_mismatch` warn 日志，同时给出 config 值与实际登录值，**不 throw**（允许 dev 临时同 token 跑多配置）

为什么这一条与 trigger 策略放在同一节：在 `replyMode: 'all'` 档下，自我过滤 guard（`msg.author.id === botUserId`）从"纵深防御"升级为"防自回环关键路径"——一旦 ID 漂移且 bot 标志位被绕，`all` 模式会让 bot 把自己的回复当输入再次触发自己。ready 自检让运维在启动那一刻就发现 ID 漂移。

## 发送映射（daemon → Discord）

| OutboundMessage 字段 | Discord |
|---|---|
| `text` | message content |
| `embeds` | Discord embed |
| `components` | Discord 组件（Action Row / Button / Select） |
| `replyTo` | message_reference |
| `ephemeral` | Interaction response flags |
| 超过 2000 字符 | 切片成多条（切片策略见 message-protocol） |

Discord adapter 声明 `supportsEmbeds=true` 时，必须把 `OutboundMessage.embeds` 映射到 Discord rich embed。capability 翻转与 `send` / `edit` 实现必须同 PR 原子落地，禁止先声明支持但静默丢弃 embed。

`send` / `edit` 的 embed 语义：

- 单片消息：`text` 映射为 `content`，`embeds` 原样映射为 Discord `embeds`。
- 多片消息：调用方应优先避免为切片消息附 embed；adapter 若收到多片 text + embeds，只能把 embeds 挂在第一片，后续片保持纯 content。
- `embeds` 字段缺省：不改变平台既有 embed 状态（edit 场景）。
- `embeds: []`：显式清空该消息上的 embed。

所有 outbound embed 文本字段必须由 daemon 在调用 adapter 前完成出站脱敏；adapter 只做平台协议映射，不重新解析 tool input 或执行业务脱敏。

### Thread 创建错误语义

```text
CreateThreadResult {
    threadId: string
    parentChannelId: string
    url?: string
    setupWarnings?: [{ code: "initial_message_failed" }]
}
```

`createThread(input)` 创建 thread 后的 setup 分三段处理：

- `threads.create` 失败：直接返回失败，未产生 thread。
- `members.add(initiatorUserId)` 失败：thread 对发起者不可用；adapter 可 best-effort 删除或归档已创建 thread，然后返回失败。
- `initialMessage` 发送失败：不得删除或归档已创建 thread；adapter 记录包含 `traceId` / `threadId` / 原始错误的结构化错误日志，并返回带 `setupWarnings[{ code: "initial_message_failed" }]` 的 `CreateThreadResult`，让上层后续消息仍可在已创建 thread 内继续或恢复。

## 测试契约（合约测试）

Adapter 必须有下列合约测试：

1. 已知 Discord 事件 fixture → 产出符合 spec 的 NormalizedEvent
2. 一个 OutboundMessage → 正确的 Discord API 调用（mock Discord API）
3. 超长文本 → 正确切片
4. 能力声明与实现一致（不声称支持但不实现）
5. 幂等：同一事件 fixture 两次投递行为一致
6. `clearTyping` 幂等：未 `setTyping` 直接 `clearTyping` → no-op 不抛

> daemon 侧消费契约（`supportsTypingIndicator=false` 时不得调用 typing primitive、按 `typingRefreshMs` 周期续期、turn 结束/interrupt/错误时 `clearTyping`）由 daemon engine 落地与测试（ADR-0012 §PR-C 最小集成契约），不在 adapter 合约——本表只覆盖 adapter 自身实现行为。

## 反模式

- Adapter 自己做幂等（应由 daemon）
- Adapter 自己打非结构化日志（应用 daemon.logger）
- Adapter 暴露 Discord SDK 类型给 daemon
- Adapter 在 `send` 里做复杂的业务逻辑（只做协议翻译）
- Adapter 与 agent 互相引用（违反依赖方向，见 architecture/dependencies）
- 声称 `supportsThreads: true` 但 thread 映射不对

## Out of spec

下列问题不在本 spec 范围：

- 具体的 Discord 凭据管理（见 [`security.md`](security/README.md)）
- 发送失败时的重试策略（见 [`cost-and-limits.md`](infra/cost-and-limits.md)）
- 具体的平台 native embed / component 映射细节（由各 adapter 实现拥有）
- 产品层面的用户命令集（见 `docs/product/`）

## 附录：MessageEmbed 结构

首版用最小可用子集。Component 字段权威源见 §MessageComponent / EventModalResponse。

```text
MessageEmbed {
    title: string?
    description: string?
    color: int?
    fields: [{ name, value, inline }]?
    footer: { text }?
}
```

Discord 限制：一个 Action Row 最多 5 个 button，或 1 个 select；string select 最多 25 个 option；interactive component 的 `custom_id` 最长 100 字符。Adapter 必须在收到 component interaction 后按平台时限 native ack/defer，再把 normalized interaction 投递 daemon。
