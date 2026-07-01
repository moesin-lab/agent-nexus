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
    eventId: string                          // 平台事件 ID（全局唯一，含时间序）
    platform: string                         // "discord"
    sessionKey: PlatformSessionKey
    messageId: string?                       // 消息类事件必填
    traceId: string                          // adapter 生成或从上下文继承

    // 分类
    type: EventType

    // 内容
    text: string?                            // 去 mention 后的正文
    attachments: Attachment[]?
    replyTo: MessageRef?                     // 若本事件是对某消息的回复
    command: CommandPayload?                 // type == "command" 时
    interaction: InteractionPayload?         // type == "interaction" 时
    reaction: ReactionPayload?               // type == "reaction" 时

    // 原始负载（仅供 adapter 内部调试）
    rawPayload: opaque
    rawContentType: string                   // "discord:message" / "discord:interaction" 等

    // 时间
    receivedAt: timestamp                    // adapter 收到的时间
    platformTimestamp: timestamp?            // 平台时间戳（如 Discord snowflake 解出的时间）
    guildId: string?                         // guild 事件所属 guild；DM 缺省
    initiatorRoleIds: string[]?              // guild 内发起者角色 ID；DM 缺省/空
    threadParentChannelId: string?           // thread 事件所属父 channel；非 thread 缺省

    // 用户信息
    initiator: {
        userId: string
        displayName: string
        isBot: bool
    }
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

## SessionKey

Platform adapter 产出的入站事件只包含平台类型、频道和发起者；配置实例名由 daemon routing 层在
`RouteContext.platformName` 中注入。daemon/agent 侧使用的完整 `SessionKey` 必须包含 `platformName`。

```text
PlatformSessionKey {
    platform: string                // IM 平台标识，例 "discord"
    channelId: string               // 会话容器 ID（Discord channel ID 或 thread ID）
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

**要点**：`(sessionKey, messageId)` TTL 窗口内最多处理一次；**adapter 不做去重**，由 daemon 在 `routing → auth → idempotency → 限流 → 队列` 流程中执行 `checkAndSet`。本 spec 只定义 `NormalizedEvent` 与相关数据结构；幂等的规则、存储、流程、GC、合约测试全部集中在 `idempotency.md`。

## 顺序

- 同 `sessionKey` 串行
- 跨 `sessionKey` 并发
- `eventId` 作为序号；需要严格顺序时按 `platformTimestamp` 回退，再按 `eventId` 字典序

## OutboundMessage

daemon → adapter 的出站消息。见 [`platform-adapter.md`](platform-adapter.md) 的定义。以下是**分片/合并**的协议。

### 文本切片

Discord 单条消息上限 2000 字符。超过时：

1. 按段落（`\n\n`）分割
2. 每段不超过 `CapabilitySet.maxTextLength - 50`（预留标记）
3. 仍超长的段按 `\n` 分；还不行按字符
4. 每段首行加 `[续 N/M]` 标记（可选；在 spec/observability 里的实验开关控制）
5. 各段保持代码块（```) 的边界（不在代码块中间切）

### 代码块

- CC CLI 输出的代码块用 ``` 包围
- 切片不得破坏代码块：要切就切在 ``` 外
- 代码块超长单独发附件（`.txt`）而非截断

### 附件

- 由 adapter 决定走内联（<8MB）还是 CDN（>8MB）
- daemon 产出 `OutboundAttachment { content, filename, contentType }`

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

daemon 默认用 `ui.toolMessages="append"` 展示工具调用轨迹：每个 `tool_call_started` 追加一条独立工具消息，消息正文包含工具名与目标摘要。平台声明 `supportsEmbeds=true` 时，这条独立工具消息可以同时携带一个平台中立的 `MessageEmbed` 工具卡片；`text` 仍必须保留可读 fallback。平台不支持 embed、fallback 文本超过平台单条消息长度、或处于 `compact` 模式时，必须退回纯文本展示。

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

工具 start fallback 文本与工具卡片字段都必须先经过出站脱敏，再按平台限制截断；禁止先截断再脱敏。这样避免长 input 在截断边界打碎 token 后绕过脱敏规则。工具卡片字段截断只影响卡片，不能改变 trace 日志里的结构化 tool 事件。

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

- 字段名 `camelCase`
- 可选字段：缺省即不写（不写 `null` 占位）
- 枚举值：小写字符串（`"message"` / `"command"`）
- 时间：ISO string 而非 Unix epoch
- 未知字段：向前兼容（解析器忽略未知字段，不 fail）

## 合约测试

- 平台事件 fixture → NormalizedEvent 的 JSON 快照比对
- 切片算法：构造 5000 字符文本，分片后拼接 == 原文
- 幂等：同 fixture 两次投递，第二次被 idempotency 层拦下
- 顺序：同 session 的事件即使乱序到达，也按 sequence 串行处理

## 反模式

- 在 NormalizedEvent 里塞 Discord 特定类型（应留在 rawPayload）
- 把 `text` 字段当生日礼物塞 mention / emoji 原文（都要归一化或剥离）
- 切片策略在 adapter 里做（应在 daemon 的公共模块）
- 跨语言序列化用非 UTF-8 或 BOM
- 新增字段时不更新本 spec（代码与 spec 漂移）
