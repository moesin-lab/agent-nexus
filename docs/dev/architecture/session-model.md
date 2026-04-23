---
title: 会话模型（Session Model）
type: architecture
status: active
summary: 定义 SessionKey、状态机、幂等、顺序保证、断线/重启恢复与交互原子性
tags: [session, session-model, lifecycle, idempotency, ordering, concurrency]
related:
  - dev/architecture/overview
  - dev/spec/message-protocol
  - dev/spec/persistence
  - dev/spec/cost-and-limits
---

# 会话模型（Session Model）

"会话"（session）是本项目的核心抽象。几乎所有横切能力（幂等、限流、预算、日志串联、错误恢复）都以 session 为单位组织。

## Session Key

一个 session 由**确定性 key** 唯一标识：

```text
SessionKey = (platform, channelId, initiatorUserId)
```

### 字段说明

| 字段 | 含义 | Discord 场景取值 |
|---|---|---|
| `platform` | IM 平台标识 | `"discord"` |
| `channelId` | 会话容器 ID | Discord channel ID 或 thread ID |
| `initiatorUserId` | 发起者 ID | Discord user ID |

### 为什么包含 `initiatorUserId`

即使在同一个 channel，不同用户的对话应是独立 session（不同的工作目录、不同的 CC 历史、不同的预算）。

### Discord thread 的映射

- **常规 channel 消息**：`channelId = channel.id`
- **thread 消息**：`channelId = thread.id`（thread 被视为独立容器）

理由：Discord thread 天然是"独立对话线"，映射成独立 session 最自然，也最契合多会话并发场景。

### 不在 key 里的东西

- **不包含 messageId**：messageId 是消息级概念，不是会话级
- **不包含 timestamp**：session 跨时间持续
- **不包含 agent 后端名**：一个 session 只绑定一个 agent，后端在 session 元数据里记录

## 生命周期

```
   ┌──────────┐
   │ Created  │  新用户发起首条消息，未 spawn agent
   └────┬─────┘
        │  spawn CC CLI 子进程
        ▼
   ┌──────────┐
   │  Active  │  有活跃子进程与最近的交互
   └────┬─────┘
        │  超过 idle timeout（默认 30 分钟）
        ▼
   ┌──────────┐
   │   Idle   │  子进程仍在但暂停计费，新消息可重新激活
   └────┬─────┘
        │  超过 idle-to-archive 阈值（默认 2 小时）
        ▼
   ┌──────────┐
   │ Archived │  子进程已关闭，历史保留；新消息触发新 session
   └──────────┘
```

### 状态转换触发

| 转换 | 触发 |
|---|---|
| Created → Active | 收到首条消息，CC 子进程 spawn 成功 |
| Active → Idle | 距离最近一条消息/事件超过 idle timeout |
| Idle → Active | 收到同 key 的新消息且尚未 Archived |
| Idle → Archived | 超过 idle-to-archive 阈值 |
| Active → Archived | 显式 `/end` 命令、或错误熔断触发（见 spec/cost-and-limits） |

### 显式结束

用户可通过 slash command（具体命令名在 spec/platform-adapter）立即把当前 session 归档。

## 幂等

### 为什么需要

Discord gateway 会重发事件（at-least-once）。同一条用户消息可能被 adapter 收到多次——**不能让 CC CLI 被触发多次**。

### 机制

- 每条入站 `NormalizedEvent` 带唯一 `messageId`（Discord 给的消息 snowflake）
- `core.idempotency` 维护 `(sessionKey, messageId) → processed_at` 的去重表
- adapter 收到事件后 **先查去重表**；命中则直接 ack 并跳过
- 去重表条目 TTL 默认 24 小时（时间窗口在 `spec/message-protocol.md` 调优）

### 存储

- 本机 SQLite 表 `idempotency`（主键 `(sessionKey, messageId)`）
- 内存 LRU 缓存热数据加速

## 顺序保证

### 同 session 内

**严格串行**。原因：CC CLI 是有状态的对话，并发输入会把会话搞乱。

- core 为每个活跃 session 维护一个 FIFO 队列
- 队列头任务完成前，后续事件排队
- 用户在短时间内发多条消息 → 串行处理，前一条完成才处理下一条

### 跨 session

**并发**。不同 session 的任务可以并行（受全局并发上限限制，见 `spec/cost-and-limits.md`）。

### 并发上限

- 全局活跃 CC 子进程数 ≤ 配置值（默认 3，可配置）
- 超过上限时新 session 排队等待

## 断线与重启恢复

### gateway 断连

- Discord gateway WebSocket 断开
- adapter 重连（带 session resume）
- 期间产生的事件 gateway 会重放 → 幂等表过滤重复
- session registry **不受影响**（是本地内存 + 持久化，不依赖 gateway 状态）

### 进程重启

- 启动时从持久化层（SQLite）重建 session registry
- 所有上一轮的 Active/Idle session 状态转为 **Interrupted**（单独状态）
- 收到任何 Interrupted session 的消息 → 提示用户"上次被中断了，是否恢复"
- 恢复策略：spawn 新 CC 子进程但保留历史 transcript

### CC 子进程崩溃

- agent runtime 检测到 exit 且未预期
- 当前 session 状态标为 `Errored`
- 最后一条未完成的输入标记失败
- 用户可见通知 + 允许重试

## 元数据

每个 session 维护：

```text
Session {
    key: SessionKey
    state: Created | Active | Idle | Archived | Errored | Interrupted
    createdAt, lastActivityAt, archivedAt
    agentBackend: "claudecode"
    ccPid: int?
    transcriptFile: path
    counters: {                          // 一等计量（订阅/API 通用）
        turnsUsed: int
        toolCallsUsed: int
        wallClockMs: int
        tokensUsed: int                  // 累计 input+output
        costUsd: float | null            // 订阅模式可能为 null
    }
    budget: {                            // 可选；opt-in $ 预算层
        limitUsd: float | null           // null 表示未启用
    }
    traceId: 当前请求链的 traceId
}
```

元数据落盘规则见 [`../spec/persistence.md`](../spec/persistence.md)。

## 交互原子性

**原子单元**：一次"用户消息 → agent 回复完成"的完整往返。

- 中途 CC CLI 崩溃 → 整体失败，用户收到错误通知
- 中途 Discord 发送失败 → 已生成的回复仍记入 transcript，可重发
- 中途用户发新消息（同 session）→ 排队

## 反模式

- 用 messageId 作为 sessionKey 的一部分（session 跨消息存在）
- 允许同 session 并发处理（会破坏 CC 状态）
- 不做幂等（gateway 重放会坑你）
- 依赖 gateway 连接状态判断 session 是否 alive（分开管理）
- 把预算/限流放在 session 外部全局管（必须归因到 session）
