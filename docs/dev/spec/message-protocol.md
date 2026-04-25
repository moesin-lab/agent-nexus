---
title: Spec：Message Protocol（归一化消息与事件）
type: spec
status: active
summary: 归一化消息/事件的字段契约、幂等、顺序、切片、流式语义
tags: [spec, message-protocol, normalized-event, idempotency, ordering]
related:
  - dev/spec/platform-adapter
  - dev/spec/agent-runtime
  - dev/architecture/session-model
contracts:
  - NormalizedEvent
  - SessionKey
  - Attachment
  - CommandPayload
  - InteractionPayload
  - ReactionPayload
---

# Spec：Message Protocol（归一化消息与事件）

定义系统内部的**归一化消息格式**与**幂等/顺序/分片语义**。所有 platform adapter 把入站事件翻译成本格式；daemon 与 agent runtime 只看本格式。

> **package 归属**：本 spec 定义的所有类型（`NormalizedEvent` / `SessionKey` / `Attachment` / `CommandPayload` / `InteractionPayload` / `ReactionPayload` 等）住在 `@agent-nexus/protocol` package（leaf 包，无依赖；所有其他 package 共享 import）。详见 [`adr/0004-language-runtime.md`](../adr/0004-language-runtime.md) §TS-P7。

## NormalizedEvent

平台入站事件的归一化形态。Adapter 构造，core 消费。

```text
NormalizedEvent {
    // 标识
    eventId: string                          // 平台事件 ID（全局唯一，含时间序）
    platform: string                         // "discord"
    sessionKey: SessionKey
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

见 [`../architecture/session-model.md`](../architecture/session-model.md)。

```text
SessionKey {
    platform: string
    channelId: string
    initiatorUserId: string
}
```

在日志与持久化中序列化为字符串：`<platform>:<channelId>:<userId>`。

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
    name: string                  // 例 "reset" / "end" / "budget"
    args: map[string]value        // 键值；slash command 的 options
    rawText: string?              // 整条命令原文（调试）
}

InteractionPayload {
    componentId: string
    kind: "button" | "select" | "modal_submit"
    values: string[]              // select 的选中项 / modal 字段
}

ReactionPayload {
    emoji: string
    action: "add" | "remove"
    targetMessageId: string
}
```

## 幂等

见独立 spec：[`idempotency.md`](infra/idempotency.md)。

**要点**：`(sessionKey, messageId)` TTL 窗口内最多处理一次；**adapter 不做去重**，由 core 在 `auth → idempotency → 限流 → 队列` 流程中执行 `checkAndSet`。本 spec 只定义 `NormalizedEvent` 与相关数据结构；幂等的规则、存储、流程、GC、合约测试全部集中在 `idempotency.md`。

## 顺序

- 同 `sessionKey` 串行
- 跨 `sessionKey` 并发
- `eventId` 作为序号；需要严格顺序时按 `platformTimestamp` 回退，再按 `eventId` 字典序

## OutboundMessage

core → adapter 的出站消息。见 [`platform-adapter.md`](platform-adapter.md) 的定义。以下是**分片/合并**的协议。

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
- Core 产出 `OutboundAttachment { content, filename, contentType }`

## 流式语义

### 逐步更新 vs 单次发送

Agent 输出是流式的（`text_delta`）。适配到 IM 的策略：

**模式 A：末次完整发送**（MVP 默认）
- 缓冲 `text_delta`，直到 `text_final` 才整段发送
- 优点：简单、消息数少
- 缺点：用户等待时间长、无实时反馈

**模式 B：分步编辑**
- 首个 delta 时 `send`（占位消息）
- 后续 delta 节流（每 1s 或每 200 字符）`edit`
- `text_final` 时最后一次 `edit`
- 优点：实时反馈
- 缺点：消息数不变但编辑次数多；Discord 对 edit 也有 rate limit

MVP 优先实现模式 A，模式 B 作为后续增强（在独立 ADR 中评审）。

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
- 切片策略在 adapter 里做（应在 core 的公共模块）
- 跨语言序列化用非 UTF-8 或 BOM
- 新增字段时不更新本 spec（代码与 spec 漂移）
