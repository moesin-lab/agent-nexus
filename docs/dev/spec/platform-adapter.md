---
title: Spec：Platform Adapter 接口
type: spec
status: active
summary: IM 平台适配层接口契约；事件归一化、发送能力、能力声明、Discord 专属映射
tags: [spec, platform-adapter, discord, normalized-event, gateway]
related:
  - dev/spec/message-protocol
  - dev/architecture/overview
  - dev/spec/cost-and-limits
  - dev/spec/security
contracts:
  - PlatformAdapter
  - OutboundMessage
  - MessageRef
  - CapabilitySet
---

# Spec：Platform Adapter 接口

定义 IM 平台适配层的接口契约。每个 IM 平台（当前仅 Discord）实现此接口并注册到 `core`。

## 目标

- 把平台特定事件归一化为 `NormalizedEvent`（定义见 [`message-protocol.md`](message-protocol.md)）
- 把 `OutboundMessage` 发到目标平台
- 声明平台能力（capability），让 core 知道哪些富交互可用
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
- 失败进入指数退避（与 [`cost-and-limits.md`](cost-and-limits.md) 对齐）

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

Core 调用 `send()` 时传入的对象。Adapter 负责映射到平台格式。

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

Adapter 声明自己支持的能力，core 据此降级或拒绝操作。

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

Core 在发送前检查能力：超出 `maxTextLength` 的文本必须切片；不支持的能力不使用。

## MessageRef

`send` 返回的引用对象。用于 `edit`/`delete`/`react`。

```text
MessageRef {
    platform: string
    channelId: string
    messageId: string                 // 平台分配的 ID
    sentAt: timestamp
}
```

MessageRef 由 adapter 构造，core 原样存储，不做解释。

## 事件分发语义

### at-least-once

Discord gateway 会重放事件。Adapter **不**做去重（core 的 idempotency 层做）。Adapter 只保证：

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

下列映射是 Discord adapter 必须实现的，但接口对 core 透明：

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

## 发送映射（core → Discord）

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

- Adapter 自己做幂等（应由 core）
- Adapter 自己打非结构化日志（应用 core.logger）
- Adapter 暴露 Discord SDK 类型给 core
- Adapter 在 `send` 里做复杂的业务逻辑（只做协议翻译）
- Adapter 与 agent 互相引用（违反依赖方向，见 architecture/dependencies）
- 声称 `supportsThreads: true` 但 thread 映射不对

## Out of spec

下列问题不在本 spec 范围：

- 具体的 Discord 凭据管理（见 [`security.md`](security.md)）
- 发送失败时的重试策略（见 [`cost-and-limits.md`](cost-and-limits.md)）
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
