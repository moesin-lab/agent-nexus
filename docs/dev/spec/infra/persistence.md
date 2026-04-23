---
title: Spec：Persistence（本地存储）
type: spec
status: active
summary: 本机桌面形态下的存储契约；SQLite 表结构、transcript 文件、secrets 层级、Store 接口
tags: [spec, persistence, sqlite, storage, secrets]
related:
  - dev/adr/0003-deployment-local-desktop
  - dev/architecture/session-model
  - dev/spec/infra/idempotency
  - dev/spec/security/secrets
  - dev/spec/security
contracts:
  - Store
---

# Spec：Persistence（本地存储）

定义本机桌面形态（ADR-0003）下的数据存储契约。所有持久化走 core 提供的存储抽象；platform/agent 不直接触碰存储层。

## 存储根路径

默认：`~/.agent-nexus/`

可通过环境变量 `AGENT_NEXUS_DATA_DIR` 覆盖。启动时创建不存在的目录，权限 `0700`。

## 目录结构

```
~/.agent-nexus/
├── config.toml             # 用户配置（只读）
├── state.db                # SQLite：sessions、idempotency、messages、budget
├── transcripts/
│   └── <sessionKey>/
│       └── <date>.jsonl    # CC 原始输出 transcript（按日切片）
├── logs/
│   └── <date>.jsonl        # 结构化日志
├── secrets/                # 敏感文件（mode 0700）
│   └── .gitkeep            # 说明：用 OS keychain 优先，此目录作为 fallback
└── cache/
    └── attachments/        # 附件缓存（可清空）
```

## SQLite 表结构

### sessions

| 列 | 类型 | 约束 |
|---|---|---|
| `session_id` | TEXT PRIMARY KEY | ulid / uuidv7；单调递增 |
| `session_key` | TEXT NOT NULL | `<platform>:<channelId>:<userId>` |
| `generation` | INTEGER NOT NULL | 同 session_key 下的代数，从 1 起 |
| `state` | TEXT NOT NULL | `Created|Active|Idle|Archived|Errored|Interrupted` |
| `created_at` | TEXT NOT NULL | RFC3339 |
| `last_activity_at` | TEXT NOT NULL | RFC3339 |
| `archived_at` | TEXT | |
| `agent_backend` | TEXT NOT NULL | 当前仅 `"claudecode"` |
| `working_dir` | TEXT NOT NULL | |
| `transcript_path` | TEXT NOT NULL | 相对 `~/.agent-nexus/`，按 session_id 归属 |
| `turns_used` | INTEGER NOT NULL DEFAULT 0 | 一等计量 |
| `tool_calls_used` | INTEGER NOT NULL DEFAULT 0 | 一等计量 |
| `wall_clock_ms` | INTEGER NOT NULL DEFAULT 0 | 一等计量（累计） |
| `tokens_used` | INTEGER NOT NULL DEFAULT 0 | input+output 累计 |
| `cost_used_usd` | REAL | NULL 表示订阅模式未归因 |
| `budget_limit_usd` | REAL | NULL 表示 $ 预算未启用（opt-in） |
| `meta_json` | TEXT | 任意扩展 JSON |

索引：

- `idx_sessions_last_activity (last_activity_at)`
- `idx_sessions_key_generation (session_key, generation DESC)` — 按 SessionKey 查"当前活跃实例"用
- `UNIQUE (session_key, generation)` — 同 key 的 generation 唯一

**不变量**：任一时刻同 `session_key` 下非终态实例（`state ∉ {Archived}`）至多一个。核心插入前校验。

### idempotency

| 列 | 类型 | 约束 |
|---|---|---|
| `session_key` | TEXT | 联合主键 |
| `message_id` | TEXT | 联合主键 |
| `first_seen_at` | TEXT NOT NULL | |
| `status` | TEXT NOT NULL | `processing|processed|failed` |
| `result_json` | TEXT | 处理结果摘要 |
| `expires_at` | TEXT NOT NULL | 用于 TTL 清理 |

主键 `(session_key, message_id)`。索引 `idx_idempotency_expires`。

### messages（可选，用于历史查询）

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | INTEGER PRIMARY KEY AUTOINCREMENT | |
| `session_id` | TEXT NOT NULL | 归属的 session 实例（不是 session_key） |
| `message_id` | TEXT | 平台消息 ID |
| `direction` | TEXT NOT NULL | `inbound|outbound` |
| `content_summary` | TEXT | 脱敏后的摘要 |
| `trace_id` | TEXT | |
| `created_at` | TEXT NOT NULL | |

索引 `(session_id, created_at)`。

### usage_events

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | INTEGER PRIMARY KEY | |
| `session_id` | TEXT NOT NULL | 按 sessionId 归属（不按 session_key；avoid archive 后冲突） |
| `trace_id` | TEXT NOT NULL | |
| `turn_sequence` | INTEGER | 本 session 的 turn 序号 |
| `tool_calls_this_turn` | INTEGER | 本 turn 的工具调用数 |
| `wall_clock_ms` | INTEGER | 本 turn 墙钟时长 |
| `input_tokens` | INTEGER | |
| `output_tokens` | INTEGER | |
| `cache_read_tokens` | INTEGER | |
| `cache_write_tokens` | INTEGER | |
| `cost_usd` | REAL | NULL 允许（订阅模式） |
| `model` | TEXT | |
| `recorded_at` | TEXT NOT NULL | |

用于使用量审计与复盘。表名从 `budget_events` 改为 `usage_events`（原表名暗示以 $ 为主轴，已不准确）。

## Transcript 文件

### 位置

`transcripts/<sessionId>/<YYYY-MM-DD>.jsonl`

按 `sessionId` 归档而非 `sessionKey`：同一 SessionKey 可能有多代 session，按 sessionId 隔离避免旧实例 transcript 被新实例覆盖/误读。

### 格式

每行一个 JSON：

```json
{
  "sequence": 1234,
  "traceId": "t_xxx",
  "ts": "2026-04-22T10:00:00.123Z",
  "direction": "agent_event",
  "event": { /* AgentEvent 的 JSON */ }
}
```

### 旋转

- 按自然日切片：`<date>.jsonl`
- 单文件超过 100 MB 时追加 `.1` / `.2` 后缀
- 压缩策略等 ops/ 阶段定义

## 秘密 / 密钥

### 优先顺序

1. **OS keychain**：macOS `Keychain`、Linux `secret-service`、Windows `Credential Manager`
2. **环境变量**：例 `DISCORD_BOT_TOKEN`、`ANTHROPIC_API_KEY`
3. **文件 fallback**：`~/.agent-nexus/secrets/<name>`，mode `0600`

前一级可用则不读下一级。启动时在日志里记录**来源**（来源本身，不含值）。

### 禁止

- 写入 SQLite
- 写入 transcript
- 写入 log
- 出现在 IM 消息里

详见 [`security.md`](../security/README.md)。

## 存储接口（core）

```text
interface Store {
    // sessions
    getSession(key) -> Session?
    upsertSession(session: Session) -> void
    listSessions(filter) -> Session[]

    // idempotency
    checkAndSet(key, messageId) -> IdempotencyState
    markProcessed(key, messageId, result) -> void
    markFailed(key, messageId, errorKind) -> void
    gc(now) -> int                           // 返回删除条数

    // messages（可选）
    appendMessage(record) -> void

    // usage / budget
    recordUsageEvent(event) -> void
    getSessionCounters(key) -> SessionCounters      // turns, toolCalls, wallClockMs, tokens, costUsd
    getSessionBudget(key) -> BudgetSnapshot?        // null 当 $ 预算未启用
}
```

## 并发

- SQLite 使用 WAL 模式（`PRAGMA journal_mode=WAL`）
- 所有写入走单一后台 goroutine/task（语言定后落实）
- 读可以并发

## 迁移

- 首版 schema 由 `core/migrations/` 管理
- 每次 schema 变更 +1 migration
- 启动时检查 schema version，自动跑 pending migrations
- 禁止手工改 schema

## 备份

MVP 不内置备份功能。用户可自行备份 `~/.agent-nexus/state.db` 与 `transcripts/`。

未来若加备份/导出，发独立 ADR。

## 数据留存

- `idempotency`：TTL 24h，后台 GC
- `messages`、`usage_events`：默认 90 天，用户可配置
- `transcripts`：默认永久，用户可配置轮转
- `logs`：默认 30 天

## 反模式

- 绕过 Store 接口直接 SQL（失去测试与迁移保护）
- 把大 JSON 塞进 `meta_json` 代替建表
- 在 SQLite 里存密钥或 token
- 把 transcript 读回来给 CC 当输入做"记忆恢复"（MVP 不做；设计复杂）
- 把 logs 和 transcripts 混在一起（二者读者/用途不同）
