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
  - 顺序的安全依据见 [`../security/README.md`](../security/README.md)
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
           │     ├─ 命中 "failed" 且在可重试窗口内 → 重试（标回 "processing"）
           │     └─ 未命中 → 插入 "processing"，继续
           │
           ├─ daemon 限流/预算检查（见 cost-and-limits.md）
           │
           ├─ 投递到 session 的 FIFO 队列
           │
           └─ 处理完成 → 更新 status 为 "processed"（或 "failed"）
```

## 存储

- 表：`idempotency`（见 [`persistence.md`](persistence.md) §idempotency）
- 主键：`(session_key, message_id)`
- 字段：`firstSeenAt`, `status: "processing" | "processed" | "failed"`, `result?`, `expires_at`
- TTL 写入 `expires_at`，后台 GC 清理
- 内存 LRU 缓存热数据加速

幂等键使用路由层的 `session_key`，不使用持久化主键 `session_id`。会话分代与路由关系见 [`session-model.md`](../../architecture/session-model.md)。

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
retryWindowAfterFailedMs = 30000  # "failed" 到允许重试的时间
```

## 合约测试

- **首次投递**：全新 (sessionKey, messageId) → 插入 `processing`；业务正常处理后标 `processed`
- **重复投递**：同一 fixture 连发两次 → 第二次返回 "hit"，不转发给 session 队列；CC CLI 只被触发一次
- **auth 拒绝不入表**：`auth_denied` 的事件 → idempotency 表**无该 messageId 记录**（防刷表）
- **failed 重试**：第一次处理标 `failed` → 超过 `retryWindowAfterFailedMs` 后再投递相同 fixture → 正常处理
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
