---
title: 会话模型（Session Model）
type: architecture
status: active
summary: 定义 SessionKey、状态机、幂等、顺序保证、断线/重启恢复与交互原子性
tags: [session, session-model, lifecycle, idempotency, ordering, concurrency]
related:
  - dev/architecture/overview
  - dev/spec/message-protocol
  - dev/spec/infra/idempotency
  - dev/spec/infra/persistence
  - dev/spec/infra/cost-and-limits
---

# 会话模型（Session Model）

"会话"（session）是本项目的核心抽象。几乎所有横切能力（幂等、限流、预算、日志串联、错误恢复）都以 session 为单位组织。

## 标识：SessionKey vs sessionId

会话有两层标识：**路由 key**（SessionKey，不唯一跨时间）和**持久化主键**（sessionId，唯一跨时间）。二者职责不同。

### SessionKey（路由层）

```text
SessionKey = (platform, channelId, initiatorUserId)
```

| 字段 | 含义 | Discord 场景取值 |
|---|---|---|
| `platform` | IM 平台标识 | `"discord"` |
| `channelId` | 会话容器 ID | Discord channel ID 或 thread ID |
| `initiatorUserId` | 发起者 ID | Discord user ID |

**用途**：

- 入站事件路由：给定入站 `NormalizedEvent`，由 SessionKey 定位**当前活跃**的 session 实例
- 串行队列键：同 SessionKey 的事件串行；跨 SessionKey 并发
- 幂等键的一部分：见 [`../spec/idempotency.md`](../spec/infra/idempotency.md)

**非唯一性**：同一 SessionKey 可以随时间对应**多个**已归档 + 一个活跃的 session 实例（新用户 `/end` 后再次对话就是新实例）。

### sessionId（持久化层）

```text
sessionId = <ulid | uuidv7>     // 单调递增、全局唯一
generation = 1, 2, 3, ...       // 同 SessionKey 下的代数，archive 后新建 +1
```

**用途**：

- 持久化主键：`sessions` 表的 `PRIMARY KEY(sessionId)`，允许同 SessionKey 有历史行
- 跨 session 的审计：transcript 文件、usage_events、messages 都按 sessionId 归属，不按 SessionKey（否则 archive 后历史会被新实例覆盖/误读）
- 一个 `generation` 仅作人类可读的序号辅助，真正唯一性由 sessionId 保证

**在 SessionKey 维度上的查询**：SQLite 上加索引 `idx_sessions_key_generation (sessionKey_str, generation DESC)` 即可 O(log n) 取"当前活跃实例"。

### Discord thread 的映射

- **常规 channel 消息**：`channelId = channel.id`
- **thread 消息**：`channelId = thread.id`（thread 被视为独立容器）

理由：Discord thread 天然是"独立对话线"，映射成独立 session 最自然，也最契合多会话并发场景。

### 不在 SessionKey 里的东西

- **不包含 messageId**：messageId 是消息级概念，不是会话级
- **不包含 timestamp**：SessionKey 本身跨时间持续（多个 generation 共享同一 key）
- **不包含 agent 后端名**：一个 session 只绑定一个 agent，后端在 session 元数据里记录

## 生命周期

状态机（含错误路径与重启路径）：

```
                ┌──────────┐
                │ Created  │  SessionKey 首次出现，未 spawn agent
                └────┬─────┘
                     │  spawn CC CLI 子进程（成功）
                     │  spawn 失败 ─────────────────────────┐
                     ▼                                      │
           ┌──────────────────┐                             │
           │      Active      │  有活跃 CC 子进程            │
           │ ◄──────┐         │                             │
           └───┬────┴─────┬───┘                             │
      idle timeout (30m)  │                                 │
               │   ┌──────┼─────── 用户 /resume              │
               ▼   │      │                                 │
           ┌──────────┐   │  ┌─────────────────────────┐    │
           │   Idle   │   │  │       Errored           │◄───┘
           └────┬─────┘   │  │  熔断 / CC 崩溃 / 超时  │
                │         └──┤                         │
                │            └──────┬──────────────────┘
                │            冷却 / /resume / /end
                │                   │
    idle-to-archive (2h) / /end     │
                │                   │
                ▼                   ▼
           ┌──────────────────────────┐
           │        Archived          │  子进程已关闭；同 SessionKey
           │   (终态，generation+1     │  新消息触发新 generation 的
           │    的新实例才能再开)      │  Created
           └──────────────────────────┘

     进程重启时，原 Active/Idle 都转为：
           ┌──────────────────┐
           │   Interrupted    │  特殊状态，只能手动恢复
           └────┬──────┬──────┘
         /resume     /end
                │          │
           spawn 新 CC      └──► Archived
                │
                ▼
              Active
```

### 状态转换触发

| From → To | 触发 |
|---|---|
| Created → Active | 收到首条消息，CC 子进程 spawn 成功 |
| Created → Errored | spawn 失败 |
| Active → Idle | 距离最近一条消息/事件超过 `idle_timeout`（默认 30m） |
| Idle → Active | 收到同 SessionKey 的新消息且本 generation 未 Archived |
| Idle → Archived | 超过 `idle_to_archive` 阈值（默认 2h） |
| Active → Archived | 显式 `/end` 命令 |
| Active → Errored | 熔断触发（见 `cost-and-limits.md`）/ CC 崩溃 / wallclock_timeout |
| Errored → Active | 用户 `/resume` 且在冷却期内或冷却期结束后的第一条新消息（见 `cost-and-limits.md` §熔断） |
| Errored → Archived | 用户 `/end`，或冷却期后仍无新消息达到归档阈值 |
| Active/Idle → Interrupted | **进程重启**：所有非终态 session 转入 Interrupted |
| Interrupted → Active | 用户 `/resume` → spawn 新 CC 子进程（复用 transcript）|
| Interrupted → Archived | 用户 `/end`，或 `interrupted_to_archive` 阈值（默认 24h） |

**终态**：`Archived`。终态 session 不再接受任何操作；同 SessionKey 的新消息会触发 `generation + 1` 的新 Created 实例。

### 显式结束 / 恢复命令

用户可通过 slash command（命令名在 `platform-adapter.md` 定义）控制状态：

- `/end` → Active/Idle/Errored/Interrupted → Archived
- `/resume` → Errored/Interrupted → Active（会尝试 spawn 新 CC）
- 用户在新 channel 发消息 → 创建新 SessionKey 的 Created

## 幂等

### 为什么需要

Discord gateway 会重发事件（at-least-once）。同一条用户消息可能被 adapter 收到多次——**不能让 CC CLI 被触发多次**。

详细规则、存储、流程与合约测试见独立 spec：[`../spec/idempotency.md`](../spec/infra/idempotency.md)。

### 在本 session 模型中的角色（要点）

- 每条入站 `NormalizedEvent` 带唯一 `messageId`（Discord 给的消息 snowflake）
- **Adapter 只负责归一化与投递，不做去重**；由 core 在 dispatch 阶段（auth 检查之后、session 入队之前）执行 `checkAndSet(sessionKey, messageId)`
- 去重表条目 TTL 默认 24 小时
- 本机 SQLite 表 `idempotency`（主键 `(sessionKey, messageId)`），内存 LRU 缓存热数据

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
- 所有上一轮的 Active/Idle session 状态转为 **Interrupted**（写回 DB）
- 收到任何 Interrupted session 所属 SessionKey 的消息 → 先发提示"上次被中断了，是否恢复"（通过 ephemeral ACK + 按钮，按 `platform-adapter.md` 能力决定）
- 用户 `/resume` → spawn 新 CC 子进程，**复用同一 sessionId**（generation 不变），保留历史 transcript
- 用户 `/end` 或达到 `interrupted_to_archive` 阈值 → Archived，同 SessionKey 下次消息会创建新 generation 的新 Created

### CC 子进程崩溃

- agent runtime 检测到 exit 且未预期
- 当前 session 状态标为 `Errored`
- 最后一条未完成的输入标记失败
- 用户可见通知 + 允许重试

## 元数据

每个 session 实例维护（以 `sessionId` 为持久化主键）：

```text
Session {
    // 标识
    sessionId: string                    // ulid/uuidv7，持久化主键
    key: SessionKey                      // (platform, channelId, initiatorUserId)
    generation: int                      // 同 key 下的代数，从 1 起

    // 生命周期
    state: Created | Active | Idle | Archived | Errored | Interrupted
    createdAt, lastActivityAt, archivedAt: timestamp

    // 运行时句柄
    agentBackend: "claudecode"
    ccPid: int?                          // 仅 Active/Idle/Errored 中可能有

    // 产物与上下文
    transcriptFile: path                 // 按 sessionId 归属（见 persistence.md）
    traceId: string                      // 当前请求链

    // 计量（一等；订阅/API 通用）
    counters: {
        turnsUsed: int
        toolCallsUsed: int
        wallClockMs: int
        tokensUsed: int                  // 累计 input+output
        costUsd: float | null            // 订阅模式可能为 null
    }

    // 可选 opt-in 机制
    budget: {
        limitUsd: float | null           // null 表示 $ 预算未启用
    }
}
```

**结构分组对应未来可能的 aggregate 拆分**（见 Codex review 方向 D-B）：目前仍是单结构体，为实现阶段保留"Identity / Lifecycle / Runtime / Counters / Budget"的语义分段，便于后续抽象。本轮不动抽象。

元数据落盘规则见 [`../spec/persistence.md`](../spec/infra/persistence.md)。

## 交互原子性

**原子单元**：一次"用户消息 → agent 回复完成"的完整往返。

- 中途 CC CLI 崩溃 → 整体失败，用户收到错误通知
- 中途 Discord 发送失败 → 已生成的回复仍记入 transcript，可重发
- 中途用户发新消息（同 session）→ 排队

## 反模式

- 用 messageId 作为 sessionKey 的一部分（session 跨消息存在）
- 用 SessionKey 作为持久化主键（Archived 后同 key 新实例会覆盖/冲突；必须用 sessionId）
- 把 `Interrupted` 当 transient 状态不落盘（重启丢失）
- 允许同 session 并发处理（会破坏 CC 状态）
- 不做幂等（gateway 重放会坑你）
- 依赖 gateway 连接状态判断 session 是否 alive（分开管理）
- 把预算/限流放在 session 外部全局管（必须归因到 session）
