---
title: Spec：Platform Adapter 接口
type: spec
status: active
summary: IM 平台适配层接口契约；事件归一化、发送能力、能力声明、Discord 专属映射
tags: [spec, platform-adapter, discord, normalized-event, gateway]
related:
  - dev/spec/message-protocol
  - dev/architecture/overview
  - dev/spec/infra/cost-and-limits
  - dev/spec/security/README
contracts:
  - PlatformAdapter
  - OutboundMessage
  - MessageRef
  - CapabilitySet
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
    start(ctx: Context, handler: EventHandler) -> void
    stop(ctx: Context) -> void

    // 发送
    send(sessionKey, OutboundMessage) -> MessageRef
    edit(messageRef: MessageRef, OutboundMessage) -> void
    delete(messageRef: MessageRef) -> void

    // 可选：反应/表情
    react(messageRef: MessageRef, emoji: string) -> void
}

type EventHandler = fn(NormalizedEvent) -> void
```

### 启动与停止

- `start(ctx, handler)`：建立连接（Discord gateway WebSocket），注册事件分发。每次收到并归一化一个事件后调用 `handler`。
- `stop(ctx)`：关闭连接、释放资源；必须幂等，支持多次调用。

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
| `sessionKey` | 是 | `(platform, channelId, userId)` 构造 |
| `messageId` | 视事件 | 消息类事件必填（Discord message snowflake） |
| `type` | 是 | `message | command | reaction | ...` |
| `text` | 视事件 | 消息正文（已去除 bot mention） |
| `attachments` | 视事件 | 附件列表（URL + meta） |
| `rawPayload` | 是 | 平台原始负载（调试用；不得外泄到日志或 IM） |
| `receivedAt` | 是 | Adapter 收到时间 |

## OutboundMessage

daemon 调用 `send()` 时传入的对象。Adapter 负责映射到平台格式。

```text
OutboundMessage {
    text: string                              // 纯文本（必填，除非是纯组件消息）
    embeds: Embed[]                           // 富卡片（见 CapabilitySet）
    components: Component[]                   // 按钮、选择器等
    replyTo: MessageRef?                      // 可选：作为回复
    ephemeral: bool                           // 可选：仅发起者可见（slash command 上下文）
    traceId: string                           // 贯穿链的 ID
    sessionKey: SessionKey
}
```

Embed / Component 的具体结构单独定义（见本文件附录）。

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
    supportsThreads: bool              // 是否支持 thread 作为 channelId
    supportsEphemeral: bool            // 仅发起者可见
    supportsAttachments: bool
    maxAttachmentsPerMessage: int
    supportsTypingIndicator: bool
}
```

daemon 在发送前检查能力：超出 `maxTextLength` 的文本必须切片；不支持的能力不使用。

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
| Slash command | `NormalizedEvent { type: "command", command: { name, args } }` |
| Button click | `NormalizedEvent { type: "interaction", interaction: { componentId, values } }` |
| Reaction add | `NormalizedEvent { type: "reaction", reaction: { emoji, action: "add" } }` |
| DM vs guild channel | 都映射为 channelId；DM 的 channelId 使用 Discord DM channel ID |
| Thread | thread.id 作为 `sessionKey.channelId` |
| Reply | `NormalizedEvent.replyTo = MessageRef`（指向被回复消息） |
| Mention (bot) | 从 text 中去除 bot mention 后填入 `text` |
| Attachment | `attachments[]`，包含 url、filename、contentType、size |

## Discord Trigger 策略

Discord adapter 提供两档触发模式，决定哪些 `messageCreate` 被归一化投递到 daemon：

| 模式 | 触发条件 |
|---|---|
| `mention`（默认） | 消息文本显式 @ 本机器人（plain `<@id>` 或 nick `<@!id>`） |
| `all` | 任意非 bot、非自身的用户消息 |

**两档共同前置 guard 不变**：

1. `msg.author.bot === true` → 丢弃
2. `msg.author.id === botUserId` → 丢弃（防 bot 标志位被绕；在 `all` 档下变成关键路径，配合 §"Bot 身份自检"防自回环）

**bot 自身 mention 的 strip 行为在两档下一致**：归一化前永远剥掉 `<@botUserId>` / `<@!botUserId>`，保留对其它用户的 mention。

### 切换面板：`/reply-mode` slash command

Adapter 在 `start()` 阶段向 Discord 注册一个全局 slash command：

```text
/reply-mode mode:<mention|all>?
```

- 不带 `mode` 参数：查询当前模式，ephemeral ack
- 带 `mode` 参数：写入新模式（持久化），ephemeral ack 确认

### 授权

`ownerUserIds: string[]` 由 config 提供。slash command handler 检查 `interaction.user.id` 是否在该列表：

- 命中 → 正常处理
- 未命中 → **不 ack**（Discord 会向调用方显示 "interaction failed"），不打印消息、不更改状态、仅打 `discord_reply_mode_unauthorized` info 日志（仅记录 user id，不写 username）

`ownerUserIds` 为空数组 / 缺省 → 没人能切换 → 模式永远等于 state 文件初始值（缺省即默认 `mention`）。这是 feature-locked 的安全默认。

### 运行时状态持久化

Adapter 把 trigger 模式持久化到 `statePath`（由 config 提供）。文件格式：

```json
{
  "replyMode": "mention"
}
```

- `start()` 时：若文件存在且合法 → 用文件值；否则 → 默认 `mention`，**不**预写文件
- `/reply-mode` 切换成功时：写入文件（`writeFile` 覆盖整文件，不需要原子性——单一 writer，状态极小）
- 文件损坏（JSON 解析失败 / 字段非法） → 启动失败抛错，**不**自动修复（避免静默丢失运维操作）

`statePath` 必填且 adapter 不自己选位置——避免 adapter 在文件系统里乱建目录。CLI 默认推荐 `~/.agent-nexus/state/discord.json`，目录权限 `0700` 与 secrets 一致。

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

## 测试契约（合约测试）

Adapter 必须有下列合约测试：

1. 已知 Discord 事件 fixture → 产出符合 spec 的 NormalizedEvent
2. 一个 OutboundMessage → 正确的 Discord API 调用（mock Discord API）
3. 超长文本 → 正确切片
4. 能力声明与实现一致（不声称支持但不实现）
5. 幂等：同一事件 fixture 两次投递行为一致

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
- 具体的 embed / component 结构（附录定义，单独演进）
- 产品层面的用户命令集（见 `docs/product/`）

## 附录：Embed / Component 结构（占位）

首版用最小可用子集。具体字段等首次接入 Discord 的 PR 按需填充本段。

```text
Embed {
    title: string?
    description: string?
    color: int?
    fields: [{ name, value, inline }]?
    footer: { text }?
}

Component {
    type: "button" | "select"
    id: string
    label: string?
    style: string?
    options: ...?
}
```
