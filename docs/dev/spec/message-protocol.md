---
title: Spec：Message Protocol（归一化消息与事件）
type: spec
status: active
summary: 归一化消息/事件的字段契约、幂等、顺序、切片、流式语义
tags: [spec, message-protocol, normalized-event, idempotency, ordering]
related:
  - dev/spec/platform-adapter
  - dev/spec/config-routing
  - dev/spec/agent-runtime
  - dev/spec/command-registry
  - dev/architecture/session-model
contracts:
  - NormalizedEvent
  - SessionKey
  - Attachment
  - CommandPayload
  - CommandRegistrationScope
  - InteractionPayload
  - ReactionPayload
---

# Spec：Message Protocol（归一化消息与事件）

定义系统内部的**归一化消息格式**与**幂等/顺序/分片语义**。所有 platform adapter 把入站事件翻译成本格式；daemon 与 agent runtime 只看本格式。

> **package 归属**：本 spec 定义的所有类型（`NormalizedEvent` / `SessionKey` / `Attachment` / `CommandPayload` / `InteractionPayload` / `ReactionPayload` 等）住在 `@agent-nexus/protocol` package（leaf 包，无依赖；所有其他 package 共享 import）。详见 [`adr/0004-language-runtime.md`](../adr/0004-language-runtime.md) §TS-P7。

## NormalizedEvent

平台入站事件的归一化形态。Adapter 构造，daemon 消费。

```text
NormalizedEvent {
    // 标识
    eventId: string                          // 平台事件 ID（全局唯一；不承诺可排序）
    platform: string                         // "discord" / "lark"
    sessionKey: PlatformSessionKey
    messageId: string?                       // 消息类事件必填
    idempotencyKey: string?                  // 平台可提供稳定重投键；daemon 缺省回退 messageId
    traceId: string                          // adapter 生成或从上下文继承

    // 分类
    type: EventType

    // 内容
    text: string?                            // 去 mention 后的正文
    attachments: Attachment[]?
    replyTo: MessageRef?                     // 若本事件是对某消息的回复
    responseTarget: MessageRef?              // 本事件产生的普通出站应回复到该消息
    command: CommandPayload?                 // type == "command" 时
    interaction: InteractionPayload?         // type == "interaction" 时
    reaction: ReactionPayload?               // type == "reaction" 时

    // adapter handoff 前构造的脱敏 wire 摘要（仅内存；不得含 secret / token，也不得持久化）
    rawPayload: opaque
    rawContentType: string                   // "discord:message" / "lark-node-sdk:im.message.receive_v1@1.70.0" 等

    // 时间
    receivedAt: timestamp                    // adapter 收到的时间
    platformTimestamp: timestamp?            // 平台时间戳（如 Discord snowflake 解出的时间）
    guildId: string?                         // guild 事件所属 guild；DM 缺省
    initiatorRoleIds: string[]?              // guild 内发起者角色 ID；DM 缺省/空
    threadParentChannelId: string?           // thread 事件所属父 channel；非 thread 缺省
    channelKind: "direct" | "group" | "thread"? // 当前容器形态；用于限制依赖父群的控制动作
    deliveryScope: "session" | "control"?    // 缺省 session；control 只允许显式控制文本
    sessionContainer: SessionContainerRef?   // 平台原生 Session 容器定位引用

    // 用户信息
    initiator: {
        userId: string
        displayName: string
        isBot: bool
    }
}

SessionContainerRef {
    kind: "thread"
    bindingMode: "fixed" | "rebindable"
    parentChannelId: string
    rootMessageId: string?
    url: string?                             // 平台明确给出的精确容器 URL
    parentUrl: string?                       // 精确 URL 缺失时的父容器入口
}

enum EventType {
    message          // 普通消息
    command          // slash command 或前缀命令
    interaction      // 按钮点击 / 选择器 / modal 提交
    reaction         // 表情反应
    typing_start     // 可选：输入中提示
    control          // 控制类（session 结束、重启等）
}
```

`messageId` 始终保留平台消息 ID 语义，供 reply / reaction / queue 展示与审计使用，不得改写为内容 hash。
`idempotencyKey` 是可选的精确重投身份：仅当平台在重投同一逻辑消息时可能更换 `messageId`，且 adapter 能从
稳定 wire 字段确定性派生时设置。adapter 只负责派生字段，不查询状态、不决定是否丢弃；daemon 使用
`event.idempotencyKey ?? event.messageId` 作为有效幂等键。该字段必须是非空、带版本前缀的不透明字符串，
不得直接拼接消息正文或其它敏感原文。

`replyTo` 描述入站消息与历史消息的关系；`responseTarget` 描述本次处理产生的普通出站应该回复到哪里，两者不得
互相代替。Daemon 必须把 `responseTarget` 透传为事件派生 `OutboundMessage.replyTo`，包括 queue-full、文本命令
反馈和 agent 输出。Adapter 不得用进程内 `threadId -> latestMessageId` 缓存重建该意图。当前只有 Lark 话题消息
设置 `responseTarget`；P2P 与没有原生 reply transport 的事件缺省。

`deliveryScope` 缺省为 `session`。`control` 事件只能进入当前平台明确列入的文本控制面；其它普通文本与
未知 `/...` 均静默丢弃，不得进入幂等、队列、SessionStore 或 agent。该字段表达 platform adapter 已知的原生容器
角色，不由 daemon 根据 platform 字符串猜测。

`sessionContainer` 是路由与恢复所需的平台中立定位引用，不改变 SessionKey 身份。`bindingMode="fixed"` 表示容器与
当前 RoutingSession 一一对应：不得在容器内通过 `/new` 产生新 generation，也不得把其它 session rebind 到该
容器。`url` 只能保存平台明确提供的精确 URL；不能从 ID 猜测。缺少 `url` 时保留 `parentUrl` 和稳定 ID
作为降级定位信息。

## SessionKey

Platform adapter 产出的入站事件只包含平台类型、频道和发起者；配置实例名由 daemon routing 层在
`RouteContext.platformName` 中注入。daemon/agent 侧使用的完整 `SessionKey` 必须包含 `platformName`。

```text
PlatformSessionKey {
    platform: string                // IM 平台标识，例 "discord" / "lark"
    channelId: string               // 原生容器 ID（Discord channel/thread、Lark P2P chat_id 或话题 thread_id）
    initiatorUserId: string         // 发起者 ID
}

SessionKey {
    platformName: string            // 配置实例名，例 "discord-main"
    platform: string
    channelId: string
    initiatorUserId: string
}
```

完整 `SessionKey` 序列化（日志、持久化、session/idempotency key）：
`<platformName>:<platform>:<channelId>:<initiatorUserId>`。`PlatformSessionKey` 只能用于 adapter
入站归一化，不得作为 daemon session/idempotency 存储 key。

**SessionKey 不唯一跨时间**——同一 SessionKey 可以随时间对应多个已归档 + 一个活跃的 session 实例。会话本体的持久化主键是 `sessionId`，不是 SessionKey。SessionKey 与 sessionId 的关系、生命周期、Discord thread 映射等组合语义见 [`../architecture/session-model.md`](../architecture/session-model.md)。

## Attachment

```text
Attachment {
    url: string                   // 平台下载地址（预签名 URL）
    filename: string
    contentType: string?          // MIME（尽可能识别）
    sizeBytes: int?
    width, height: int?           // 图片/视频
    platformId: string?           // 平台附件 ID
}
```

## MessageRef

见 [`platform-adapter.md`](platform-adapter.md)。

## CommandPayload / InteractionPayload / ReactionPayload

```text
CommandPayload {
    name: string                  // 平台可见 command name，例 "codex-new" / "reply-mode"
    args: map[string]value        // 键值；slash command 的 options
    rawText: string?              // 整条命令原文（调试）
    registrationScope: CommandRegistrationScope
}

CommandRegistrationScope {
    kind: "global" | "guild"
    guildId: string?              // kind == "guild" 时必填
}

InteractionPayload {
    componentId: string
    kind: "button" | "select" | "modal_submit"
    values: string[]              // select 的选中项 / modal text input 值
}

ReactionPayload {
    emoji: string
    action: "add" | "remove"
    targetMessageId: string
}
```

`CommandPayload.name` 不承载 canonical id。daemon 必须按 [`command-registry.md`](command-registry.md) 的 active reverse map 从平台可见 name 解析到 canonical command；不得从 `name` 字符串拆 owner 或 handler。

`/nexus-settings` 的组件 `componentId` 使用 `nexus:settings:<action>` 命名空间，daemon 按 action 表驱动分发。`/nexus-queue` 的组件 `componentId` 使用 `nexus:queue:<action>` 命名空间；item 级 button 可在 componentId 末尾携带 pending item id，目标 SessionKey 仍从 interaction 的 channel/user 上下文推导。v1 不把 channel id / SessionKey 等长上下文编码进 `componentId`。workingDir 与 queue prompt 的直接编辑使用 modal submit；workingDir 路径校验与 `/nexus-working-dir` 共用 root-jail 规则。modal submit 的 `values` 以 `<componentId>=<value>` 表示 text input 值。

`/nexus-queue` 当前保留的 action id：

- `nexus:queue:select`
- `nexus:queue:insert` / `nexus:queue:insert-modal`
- `nexus:queue:edit:<itemId>` / `nexus:queue:edit-modal:<itemId>`
- `nexus:queue:up:<itemId>`
- `nexus:queue:down:<itemId>`
- `nexus:queue:cancel:<itemId>`

`itemId` 是 daemon 内存队列里的 pending item id，只在当前进程内有效；不能作为持久引用或跨 channel/user 的授权依据。

### Payload 互斥约束

`NormalizedEvent.type` 与 payload 字段必须互斥：

| `type` | 必须有 | 不得有 |
|---|---|---|
| `message` | `text`（可为空字符串）或 `attachments` | `command` / `interaction` / `reaction` |
| `command` | `command` | `text` / `attachments` / `interaction` / `reaction` |
| `interaction` | `interaction` | `text` / `attachments` / `command` / `reaction` |
| `reaction` | `reaction` | `text` / `attachments` / `command` / `interaction` |
| `typing_start` / `control` | 无专属 payload | `text` / `attachments` / `command` / `interaction` / `reaction` |

`InteractionPayload` 只使用平台中立字段名。平台私有字段（如 native custom id、callback
data、interaction token）留在 `rawPayload`，不得升入通用 payload。

## 幂等

见独立 spec：[`idempotency.md`](infra/idempotency.md)。

**要点**：`(sessionKey, event.idempotencyKey ?? event.messageId)` TTL 窗口内最多处理一次；**adapter 不做去重**，由 daemon 在 `routing → auth → idempotency → 限流 → 队列` 流程中执行 `checkAndSet`。本 spec 只定义 `NormalizedEvent` 与相关数据结构；幂等的规则、存储、流程、GC、合约测试全部集中在 `idempotency.md`。

## 顺序

- 同 `sessionKey` 串行
- 跨 `sessionKey` 并发
- 单次连接内按 adapter 调用 handler 的先后顺序入队
- `eventId` 只表示平台事件身份，不作为消息幂等键或排序键；`platformTimestamp` 可用于展示，但不能重排已经接收的事件
- 断线重连后的跨连接全序不属于本协议保证；平台无 replay cursor 时还可能存在事件缺口

## OutboundMessage

daemon → adapter 的出站消息。见 [`platform-adapter.md`](platform-adapter.md) 的定义。以下是**分片/合并**的协议。

事件处理产生的 `OutboundMessage.replyTo` 必须继承 `NormalizedEvent.responseTarget`。同一次 event 的多次
`send()` 可以指向同一个 target；adapter 自己负责把多片或多条回复映射到平台允许的 reply API。

### 文本切片

Adapter 按 `CapabilitySet.maxTextLength` 执行平台单条消息预算。切片必须满足：

- 每片不超过平台声明的 UTF-16 code unit 预算
- 按发送顺序拼接所有 slice 后等于原文，不截断、不添加续传标记
- 正常平台预算下不在 surrogate pair 中间切分；grapheme cluster 是否保持完整由平台专属契约定义

切片由 adapter 在平台发送边界执行并按顺序聚合 `MessageRef.messageIds`；daemon 只传完整
`OutboundMessage`，不得复制平台长度、message id 聚合或 partial-send 语义。段落、代码块、附件 fallback 与
中途失败重试若存在，必须由具体 adapter 专属段定义，不能从本通用协议推断。

## 流式语义

### 逐步更新 vs 单次发送

Agent 输出是流式的（`text_delta`）。适配到 IM 的策略：

**模式 A：末次完整发送**
- 缓冲 `text_delta`，直到 `text_final` 才整段发送
- 优点：简单、消息数少
- 缺点：用户等待时间长、无实时反馈

**模式 B：分步编辑**（Discord MVP 主路径）
- 首个 delta 时 `send`（占位消息）
- 后续 delta 按 [`infra/cost-and-limits.md`](infra/cost-and-limits.md) §流式集成数值 节流 `edit`
- `text_final` 时最后一次 `edit`
- 优点：实时反馈
- 缺点：消息数不变但编辑次数多；Discord 对 edit 也有 rate limit

ADR-0012 已把模式 B 纳入 stream-json 主路径；daemon 在 `supportsEdit=true` 时走分步编辑，不支持 edit 的平台降级到模式 A。节流数值由 [`infra/cost-and-limits.md`](infra/cost-and-limits.md) 拥有。

### 工具消息展示

daemon 默认用 `ui.toolMessages="append"` 展示工具调用轨迹：每个 `tool_call_started` 追加一条独立工具消息，消息包含工具名与目标摘要。平台声明 `supportsEmbeds=true` 且 fallback 文本未超过平台单条消息长度时，daemon 必须发送平台中立的 `MessageEmbed` 工具卡片，并让消息正文为空，避免平台同时渲染正文 fallback 与 embed 造成重复展示。平台不支持 embed、fallback 文本超过平台单条消息长度、或处于 `compact` 模式时，必须退回纯文本展示。

同一 turn 内，daemon 对平台的用户可见输出（status、tool start、assistant 正文、final reply）必须按 AgentEvent 到达顺序串行执行：前一条 `send` / `edit` 完成前，不得启动后一条用户可见输出。否则慢平台请求会造成工具消息与 assistant 正文在 IM 侧错位。

`status` 是非终端工作状态：支持 edit 的平台应复用同一条工作消息连续更新，后续 assistant 正文、工具消息或终端错误到达时清除该临时状态；不支持 edit 的平台可降级为追加状态消息。

在 `append` 模式下，`tool_call_started` 是 assistant 消息分段边界：如果 tool 前已经发送或缓冲了 assistant 文本，daemon 必须先固定该段文本，再发送 tool start；tool 之后到达的 `text_delta` / `text_final` 必须创建新的 assistant 消息，不得回头编辑 tool 前的消息。用户可见顺序应保持为 `assistant before tool` → `tool start` → `assistant after tool`。

工具卡片只表达 start 事件，不承载 result。若同一个 append 工具消息后续被 edit，未显式传空 `embeds` 时沿用平台原有 embed 保留语义；需要清空时必须显式传 `embeds: []`。

工具目标摘要由 agent backend 归一化为 `tool_call_started.payload.inputSummary`，daemon 只负责展示，不重新解析 backend 原始 input。Claude Code backend 的摘要规则：

- `Bash`：展示 `command`，且用户可见消息必须使用 fenced `bash` 代码块。
- `Read` / `Edit` / `Write`：优先展示目标文件路径（如 `file_path`）。
- `Grep` / `Glob`：优先展示搜索 pattern。
- 其他工具：优先展示常见目标字段（如 `path` / `target_file` / `query`），否则展示截断后的 input 摘要。

工具 result 内容默认不进入用户消息。文件内容、diff、搜索命中、Bash stdout/stderr 等富展示需另行定义代码块、行号剥离、脱敏和消息位置策略后再启用。

工具 start 的纯文本回退内容、用于长度判定的 fallback 文本，以及工具卡片字段都必须先经过出站脱敏，再按平台限制截断；禁止先截断再脱敏。这样避免长 input 在截断边界打碎 token 后绕过脱敏规则。工具卡片字段截断只影响卡片，不能改变 trace 日志里的结构化 tool 事件。

`ui.toolMessages="compact"` 用于低噪声模式：工具状态合并进当前回复消息，后续 final reply 可覆盖这条状态消息。该模式不保证保留完整用户可见工具轨迹；结构化日志仍按 observability 事件记录。`compact` 模式本期不挂工具卡片，避免临时状态消息被 final reply 编辑覆盖时产生 stale embed。

## 控制语义

`type: control` 的事件用于系统级操作，不是用户消息：

- `session_end`：用户触发结束
- `session_reset`：用户触发重置
- `budget_report`：触发预算查询
- `internal_shutdown`：进程优雅退出

命令名由 `CommandPayload.name` 承载。

## 时间

- 所有时间使用 UTC + RFC3339 毫秒（`2026-04-22T10:30:00.123Z`）
- 不做时区本地化（产品文档层面再做）
- `platformTimestamp` 如果平台未给出则不填

## JSON 序列化约定

归一化结构需要落盘或跨进程时用 JSON：

- `rawPayload` 必须省略；它只允许承载 adapter → daemon 进程内 handoff 所需的脱敏诊断字段，
  `rawContentType` 可以保留

- 字段名 `camelCase`
- 可选字段：缺省即不写（不写 `null` 占位）
- 枚举值：小写字符串（`"message"` / `"command"`）
- 时间：ISO string 而非 Unix epoch
- 未知字段：向前兼容（解析器忽略未知字段，不 fail）

## 合约测试

- 平台事件 fixture → NormalizedEvent 的 JSON 快照比对
- 带 `responseTarget` 的事件 → queue-full、文本命令反馈与 agent 输出均携带相同 `OutboundMessage.replyTo`
- `deliveryScope="control"` 的普通文本与未知 `/...` 静默终止，不占用幂等、队列或 SessionStore
- `bindingMode="fixed"` 的容器保留定位引用，并拒绝 `/new` 分代和 session rebind
- 切片算法：构造超过平台预算的文本，每片不超预算且按顺序拼接后等于原文
- 幂等：同 fixture 两次投递，第二次被 idempotency 层拦下
- 顺序：同 session 按 adapter 调用 handler 的到达顺序串行处理，不按 eventId 或平台时间戳重排

## 反模式

- 在 NormalizedEvent 里塞平台 SDK / CLI 特定类型（应留在 rawPayload）
- 把 secret、token 或无需跨层消费的完整 wire object 塞进 rawPayload
- 用 adapter 隐式缓存猜测 response target，或把入站 `replyTo` 当成出站目标
- 把 `text` 字段当生日礼物塞 mention / emoji 原文（都要归一化或剥离）
- daemon 复制具体平台的长度、message id 聚合或 partial-send 语义（应由 adapter 负责）
- 跨语言序列化用非 UTF-8 或 BOM
- 新增字段时不更新本 spec（代码与 spec 漂移）
