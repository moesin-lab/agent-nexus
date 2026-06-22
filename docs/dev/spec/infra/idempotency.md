---
title: Spec：Idempotency（幂等去重）
type: spec
status: active
summary: 同 (sessionKey, messageId) TTL 窗口内最多处理一次；adapter 不做去重；daemon 在 auth 之后 session 入队之前执行 checkAndSet；后台 GC
tags: [spec, idempotency, session]
related:
  - dev/spec/message-protocol
  - dev/spec/security/auth
  - dev/spec/infra/persistence
  - dev/architecture/session-model
  - dev/architecture/overview
contracts:
  - IdempotencyStore
---

# Spec：Idempotency（幂等去重）

定义"同一条 IM 事件只处理一次"的契约。Discord gateway **at-least-once** 语义下，同一 user message 可能被 adapter 收到多次——不能让 CC CLI 被触发多次。

对应模块：`daemon.idempotency`。

## 规则

同一 `(sessionKey, messageId)` 在 TTL 窗口内**最多处理一次**。

- `sessionKey`：见 [`../../architecture/session-model.md`](../../architecture/session-model.md) §SessionKey
- `messageId`：平台给的消息 ID（Discord snowflake）
- TTL：默认 24 小时（配置项在下文）

## 职责划分

- **Adapter** 只负责归一化与投递，**不做去重**
- **Daemon** 在 `Engine.dispatch` 流程中执行 `checkAndSet(sessionKey, messageId)`
- 顺序：**auth → idempotency → 限流/预算 → session 队列**
  - 顺序的安全依据见 [`../security/auth.md` §权限检查位置](../security/auth.md#权限检查位置)（`auth_denied` 不进 idempotency 表，避免上游伪造 messageId 刷表）
  - 数据流见 [`../../architecture/overview.md`](../../architecture/overview.md) §入站数据流

## 流程

```
adapter 归一化 NormalizedEvent
    │
    └─> daemon.Engine.dispatch(event)
           │
           ├─ daemon.auth 权限检查（先；拒绝直接返回，不插入幂等表）
           │
           ├─ daemon.idempotency.checkAndSet(sessionKey, messageId)
           │     ├─ 命中 "processed" → 丢弃事件（已经处理过）
           │     ├─ 命中 "processing" → 跳过（上一次还在进行中）
           │     ├─ 命中 "failed" → 丢弃事件（失败终态已记录）
           │     ├─ 命中 "cancelled" → 丢弃事件（用户已取消 pending item）
           │     └─ 未命中 → 插入 "processing"，继续
           │
           ├─ daemon 限流/预算检查（见 cost-and-limits.md）
           │     ├─ 拒绝 → 删除 "processing" 占位，本次不入队
           │     └─ 通过 → 继续
           │
           ├─ 投递到 session 的 FIFO 队列
           │     ├─ 队列满 → 删除 "processing" 占位，本次不入队
           │     └─ 入队成功 → 继续
           │
           └─ 处理完成 → 更新 status 为 "processed"（或 "failed"）；
              `/nexus-queue clear` 取消 pending 时更新为 "cancelled"
```

## 状态语义

| status | 语义 | 后续重复投递 |
|---|---|---|
| `processing` | 首次投递已通过 auth 和幂等检查，正在排队或运行 | 跳过 |
| `processed` | 已完成处理 | 丢弃 |
| `failed` | 事件已入队但处理失败 | 丢弃 |
| `cancelled` | 事件已入 session 队列，但在开始运行前被取消 | 丢弃 |

取消只作用于 session 队列里尚未开始的 pending item。已经进入 running 的 item 不被队列取消打断，也不得把幂等状态标为 `cancelled`；它必须继续结算为 `processed` 或 `failed`。

`markCancelled` 是状态写入接口，不负责判断队列项是否仍可取消。调用方只有在队列取消返回 `cancelled`（pending item 已移出队列且尚未开始运行）后才能调用；队列返回 `running` 或 `not_found` 时不得调用。

## 存储

- 表：`idempotency`（见 [`persistence.md`](persistence.md) §idempotency）
- 主键：`(session_key, message_id)`
- 字段：`firstSeenAt`, `status: "processing" | "processed" | "failed" | "cancelled"`, `result?`, `expires_at`
- TTL 写入 `expires_at`，后台 GC 清理
- 内存 LRU 缓存热数据加速

状态语义：

- `processing`：事件已通过 auth 和幂等插入，正在等待或执行
- `processed`：处理成功；后续同 `(sessionKey, messageId)` 重放作为 terminal duplicate 丢弃
- `failed`：本次已进入队列但处理失败；后续同 `(sessionKey, messageId)` 重放作为 terminal duplicate 丢弃，用户重试必须产生新的平台 `messageId`
- `cancelled`：pending `message` item 被用户取消；后续同 `(sessionKey, messageId)` 重放作为 terminal duplicate 丢弃

如果 daemon 在插入 `processing` 后、事件被 queue 接受前遇到 transient 拒绝（例如限流/预算拒绝或队列满），必须删除该幂等占位；后续同一平台重放仍可重新尝试入队。事件一旦进入 queue，后续只能转为 `processed` / `failed` / `cancelled` 之一。

幂等键使用路由层的 `session_key`，不使用持久化主键 `session_id`。会话分代与路由关系见 [`session-model.md`](../../architecture/session-model.md)。

`/nexus-queue` 对幂等的影响：

- 编辑 pending `message` item 只修改队列内即将投递给 agent 的 prompt，不改变原平台 `messageId` 或幂等键
- 取消 pending `message` item 时，原 `(sessionKey, messageId)` 标为 `cancelled`，后续重放命中 terminal duplicate
- `Insert next` 创建 synthetic `message` item，不对应平台 `messageId`，因此不写 idempotency store；它只受当前内存 queue 管理

## 接口语义

| 方法 | 语义 |
|---|---|
| `checkAndSet(sessionKey, messageId)` | 未命中时插入 `processing`；命中时返回现有 status |
| `markProcessed(sessionKey, messageId)` | 处理完成后标 `processed` |
| `markFailed(sessionKey, messageId)` | 处理失败后标 `failed` |
| `markCancelled(sessionKey, messageId)` | pending item 被取消、且尚未开始运行时标 `cancelled` |
| `forget(sessionKey, messageId)` | 删除单条幂等记录；用于插入 `processing` 后、queue 接受前的 transient 拒绝回滚，以及测试隔离 |
| `clearAll()` | 清空内存态；用于进程内测试或重载场景，不对应持久化 GC |

## 实现分层

`InMemoryIdempotencyStore` 是进程内 baseline：只保存当前进程的 `(sessionKey, messageId) -> status`，提供 `checkAndSet`、状态标记、`forget` 与 `clearAll`。它不实现 TTL、后台 GC、`failed` 可重试窗口，也不跨进程保留状态。

持久化 Store 必须实现本 spec 的 TTL 与 GC；SQLite 字段见 [`persistence.md`](persistence.md) §idempotency。

## 后台 GC

- 扫描周期：每 5 分钟（可配置 `limits.idempotency.gcIntervalMs`）
- 批量上限：每轮最多 10000 条，避免长事务
- 条件：`expires_at < now()`
- 失败降级：GC 失败不应阻塞业务；记 `warn` 日志继续运行

## 配置

```toml
[limits.idempotency]
ttlSeconds = 86400              # 24 小时
gcIntervalMs = 300000           # 5 分钟
gcBatchSize = 10000
```

## 合约测试

- **首次投递**：全新 (sessionKey, messageId) → 插入 `processing`；业务正常处理后标 `processed`
- **重复投递**：同一 fixture 连发两次 → 第二次返回 "hit"，不转发给 session 队列；CC CLI 只被触发一次
- **auth 拒绝不入表**：`auth_denied` 的事件 → idempotency 表**无该 messageId 记录**（防刷表）
- **入队前拒绝回滚**：限流/预算拒绝或队列满发生在插入 `processing` 之后、queue 接受之前 → 调用 `forget` 删除占位；同 messageId 重放可重新插入 `processing` 并尝试入队
- **pending 取消**：`/nexus-queue clear` 取消 pending item → 标 `cancelled`；同 messageId 重放命中 terminal duplicate，不重新入队
- **失败终态**：第一次处理标 `failed` → 同 messageId 重放命中 terminal duplicate，不重新入队
- **单条 forget**：删除一条 `(sessionKey, messageId)` 记录 → 同 session 其他 messageId 不受影响
- **GC 基线**：插入 10000 条过期条目 → 一轮 GC 清空（在 `gcBatchSize` 之内）
- **GC 失败降级**：mock SQLite 写入错误 → GC 跳过本轮 + 打 warn；业务不中断

## 观测

事件（见 [`observability.md`](observability.md)）：

- `idempotency_hit`：命中去重 → 字段 `sessionKey`, `messageId`, `status`
- `idempotency_insert`：新插入 → 字段 `sessionKey`, `messageId`
- `idempotency_gc_finished`：单轮 GC 完成 → 字段 `scanned`, `deleted`, `durationMs`

## 反模式

- Adapter 自己做去重（重复实现，增加平台间不一致）
- auth 后幂等前插入额外检查把 messageId 作为缓存键（扩大攻击面）
- 去重成功但不落持久化（重启丢失）
- 用 `messageId` 单字段做主键（跨 session 可能冲突；必须联合 sessionKey）
- 不清理过期条目（SQLite 无限增长）

## Out of spec

- 跨平台幂等（未来多平台时发 ADR）
- 基于内容 hash 的语义去重（仅按平台 messageId，简单可靠）
- 分布式场景下的锁协调（本机桌面形态不需要）
