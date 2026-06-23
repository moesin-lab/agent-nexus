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
  - dev/spec/infra/trajectory-observability
  - dev/spec/security/secrets
  - dev/spec/security/README
contracts:
  - Store
---

# Spec：Persistence（本地存储）

定义本机桌面形态（ADR-0003）下的数据存储契约。所有持久化走 daemon 提供的存储抽象；platform/agent 不直接触碰存储层。

## 存储根路径

默认实例根目录（下文写作 `<home>`）：`~/.agent-nexus/`

`<home>` 的选择顺序：

1. CLI 参数 `--home <path>` 或 `--home=<path>`：最高优先级；启动参数解析后写入当前进程的 `AGENT_NEXUS_HOME`
2. 环境变量 `AGENT_NEXUS_HOME`
3. 默认 `~/.agent-nexus/`

`--home` 与 `AGENT_NEXUS_HOME` 表达同一个实例根目录，二者都接受 `~` 展开；空白路径必须 fail-closed。`config.json`、`secrets/`、`state/`、SQLite、transcript 与 log 都从该根目录派生。旧名 `AGENT_NEXUS_DATA_DIR` 不再是本项目契约；loader 不读取它，新文档和示例不得继续使用，旧部署必须迁移到 `AGENT_NEXUS_HOME` 或 `--home`。

启动时创建不存在的目录，权限 `0700`。

## 目录结构

```
<home>/
├── config.json             # 用户配置（mode 0600）
├── state.db                # SQLite：sessions、idempotency、messages、budget
├── state/
│   └── discord-<encodedPlatformName>.json  # Discord reply mode 状态
├── transcripts/
│   └── <sessionKey>/
│       └── <date>.jsonl    # CC 原始输出 transcript（按日切片）
├── trajectory/
│   ├── imports/            # Nexus 管理的外部导入片段
│   └── provider-calls/     # Nexus 管理的 provider-call observation payload
├── logs/
│   └── <date>.jsonl        # 结构化日志
├── secrets/                # 敏感文件（mode 0700）
│   └── .gitkeep            # 说明：用 OS keychain 优先，此目录作为 fallback
└── cache/
    └── attachments/        # 附件缓存（可清空）
```

`<encodedPlatformName>` 是对 `platforms[].name` 执行 `encodeURIComponent` 后的结果，只作为单个文件名片段使用；CLI 不得把未编码的 platform name 拼成路径段。显式配置 `platforms[].statePath` 时，字段语义与重复路径校验见 [`config-routing.md`](../config-routing.md#platformconfig)。

## SQLite 表结构

### sessions

| 列 | 类型 | 约束 |
|---|---|---|
| `session_id` | TEXT PRIMARY KEY | ulid / uuidv7；单调递增 |
| `session_key` | TEXT NOT NULL | `<platformName>:<platform>:<channelId>:<userId>` |
| `generation` | INTEGER NOT NULL | 同 session_key 下的代数，从 1 起 |
| `state` | TEXT NOT NULL | `Created|Active|Idle|Archived|Errored|Interrupted` |
| `created_at` | TEXT NOT NULL | RFC3339 |
| `last_activity_at` | TEXT NOT NULL | RFC3339 |
| `archived_at` | TEXT | |
| `agent_backend` | TEXT NOT NULL | `"claudecode"` \| `"codex"` |
| `agent_conversation_ref` | TEXT | opaque agent conversation ref；回传给 `SessionConfig.resumeFromAgentSessionId` |
| `working_dir` | TEXT NOT NULL | |
| `next_session_json` | TEXT | 一次性 next-session override；消费后置 NULL |
| `transcript_path` | TEXT NOT NULL | 相对 `<home>/`，按 session_id 归属 |
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

字段更新语义：

- `agent_conversation_ref` 对 daemon 是 opaque token，来源与 runtime 契约见 [`agent-runtime.md` §Agent command envelope](../agent-runtime.md#agent-command-envelope) / [`agent-runtime.md` §事件 payload 字段](../agent-runtime.md#事件-payload-字段)。
  普通 metadata upsert 不携带该字段表示保留旧值；只有 runtime 给出新 ref 时覆盖，显式清除时置 NULL。
- `next_session_json` 表示下一次 spawn 前的一次性 override，例如 pending `workingDir`。
  普通 metadata upsert 不携带该字段表示保留旧值；消费后置 NULL；将现有 resumable session 绑定到新 SessionKey 时，它随 `agent_conversation_ref` 一起迁移。

### idempotency

| 列 | 类型 | 约束 |
|---|---|---|
| `session_key` | TEXT | 联合主键 |
| `message_id` | TEXT | 联合主键 |
| `first_seen_at` | TEXT NOT NULL | |
| `status` | TEXT NOT NULL | `processing|processed|failed|cancelled` |
| `result_json` | TEXT | 处理结果摘要 |
| `expires_at` | TEXT NOT NULL | 用于 TTL 清理 |

主键 `(session_key, message_id)`。索引 `idx_idempotency_expires`。

状态语义由 [`idempotency.md`](idempotency.md) 拥有；本表只承载落盘枚举。`processed` / `failed` / `cancelled` 都是 terminal duplicate 状态，后续同 `(session_key, message_id)` 重放不重新入队。

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
| `completeness` | TEXT NOT NULL | `complete` / `partial` / `missing`；语义见 [`cost-and-limits.md` §`UsageRecord.completeness` 语义](cost-and-limits.md#usagerecordcompleteness-语义) |
| `model` | TEXT | |
| `recorded_at` | TEXT NOT NULL | |

用于使用量审计与复盘。表名从 `budget_events` 改为 `usage_events`（原表名暗示以 $ 为主轴，已不准确）。

**聚合约束**：所有美元 counter / `$` 预算 snapshot 的聚合**只能基于** `completeness = 'complete' AND cost_usd > 0` 的记录（语义见 [`cost-and-limits.md` §`UsageRecord.completeness` 语义](cost-and-limits.md#usagerecordcompleteness-语义) 消费方硬不变量）。直接 `SUM(cost_usd)` 是反模式。

### external_session_imports

| 列 | 类型 | 说明 |
|---|---|---|
| `import_id` | TEXT PRIMARY KEY | ulid / uuidv7 |
| `source_adapter` | TEXT NOT NULL | `codex-cli-jsonl` / `codex-app-jsonl` / `claude-code-jsonl` 等 |
| `source_session_id` | TEXT NOT NULL | 外部来源内的 session id |
| `source_path_hash` | TEXT NOT NULL | 外部路径 hash；不保存未脱敏绝对路径 |
| `native_session_ref` | TEXT | 可交给 agent runtime 的 opaque resume ref |
| `linked_session_id` | TEXT | 绑定到 Nexus RoutingSession 后填写 |
| `state` | TEXT NOT NULL | `discovered|registered|imported|linked|rejected|failed|retired` |
| `confidence` | TEXT NOT NULL | `high|medium|low|unknown` |
| `metadata_json` | TEXT NOT NULL | source metadata、摘要、unsupported reasons；必须脱敏 |
| `error_json` | TEXT | `{code,message,retryable}` |
| `discovered_at` | TEXT NOT NULL | RFC3339 |
| `imported_at` | TEXT | RFC3339 |
| `linked_at` | TEXT | RFC3339 |

索引：

- `idx_external_session_imports_source (source_adapter, source_session_id)`
- `idx_external_session_imports_linked_session (linked_session_id)`
- `idx_external_session_imports_state (state, discovered_at DESC)`

字段语义和状态机见 [`trajectory-observability.md`](trajectory-observability.md#导入状态)。

### trajectory_segments

| 列 | 类型 | 说明 |
|---|---|---|
| `segment_id` | TEXT PRIMARY KEY | ulid / uuidv7 |
| `session_id` | TEXT | Nexus session id；未链接外部导入时可为空 |
| `import_id` | TEXT | 外部导入来源 |
| `provider_observation_id` | TEXT | provider-call observation 来源 |
| `source` | TEXT NOT NULL | `nexus-agent-event|external-import|provider-call` |
| `kind` | TEXT NOT NULL | `user-message|agent-message|reasoning|tool-call|tool-result|usage|provider-request|provider-response|state-change|unknown` |
| `trace_id` | TEXT | |
| `turn_sequence` | INTEGER | |
| `sequence` | INTEGER NOT NULL | 同 session 或 import 内的稳定顺序 |
| `ts` | TEXT NOT NULL | RFC3339 |
| `summary` | TEXT NOT NULL | 脱敏摘要 |
| `content_ref` | TEXT | 指向 `<home>/trajectory/imports/` 或 transcript 内受管内容 |
| `usage_event_id` | TEXT | 关联 usage_events；存储 `usage_events.id` 的字符串投影，对齐 trajectory read model 的 `usageEventId` opaque id |
| `log_anchor_json` | TEXT | `{logFile,byteOffset,event}`；路径必须相对 `<home>` |
| `confidence` | TEXT NOT NULL | `high|medium|low|unknown` |
| `redaction_state` | TEXT NOT NULL | `redacted|metadata-only|dropped` |
| `metadata_json` | TEXT NOT NULL | 扩展 metadata；必须脱敏 |

索引：

- `idx_trajectory_segments_session (session_id, ts, sequence)`
- `idx_trajectory_segments_import (import_id, ts, sequence)`
- `idx_trajectory_segments_source_kind (source, kind)`

`content_ref` 不得指向外部原始 transcript 路径。查询契约见 [`trajectory-observability.md`](trajectory-observability.md#查询契约)。

### provider_call_observations

| 列 | 类型 | 说明 |
|---|---|---|
| `observation_id` | TEXT PRIMARY KEY | ulid / uuidv7 |
| `session_id` | TEXT | 可为空，表示无法可靠对齐到 Nexus session |
| `trace_id` | TEXT | |
| `backend` | TEXT NOT NULL | agent backend |
| `capture_mode` | TEXT NOT NULL | `reverse-proxy|forward-proxy|transcript-only` |
| `request_started_at` | TEXT NOT NULL | RFC3339 |
| `response_finished_at` | TEXT | RFC3339 |
| `provider_host` | TEXT | |
| `model` | TEXT | |
| `request_summary` | TEXT NOT NULL | 脱敏摘要 |
| `response_summary` | TEXT | 脱敏摘要 |
| `request_body_ref` | TEXT | 受管 redacted payload |
| `response_body_ref` | TEXT | 受管 redacted payload |
| `stream_frames_ref` | TEXT | 仅 `storeRawStreams=true` 时允许 |
| `request_bytes` | INTEGER NOT NULL | 原始大小计数 |
| `response_bytes` | INTEGER | 原始大小计数 |
| `redaction_state` | TEXT NOT NULL | `redacted|metadata-only|dropped` |
| `alignment_json` | TEXT NOT NULL | `{confidence,turnSequence,agentEventSequence,reasons}` |
| `error_code` | TEXT | |
| `metadata_json` | TEXT NOT NULL | 必须脱敏 |

索引：

- `idx_provider_call_observations_session (session_id, request_started_at)`
- `idx_provider_call_observations_backend (backend, request_started_at)`

payload 文件只能写入 `<home>/trajectory/provider-calls/`。provider-call 字段语义见 [`trajectory-observability.md`](trajectory-observability.md#provider-call-observation)。

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
3. **文件 fallback**：`<home>/secrets/<name>`，mode `0600`

前一级可用则不读下一级。启动时在日志里记录**来源**（来源本身，不含值）。

### 禁止

- 写入 SQLite
- 写入 transcript
- 写入 log
- 出现在 IM 消息里

详见 [`security.md`](../security/README.md)。

## 存储接口（daemon）

```text
interface Store {
    // sessions
    getSession(key) -> Session?
    upsertSession(session: Session) -> void
    listSessions(filter) -> Session[]

    // idempotency
    checkAndSet(key, messageId) -> IdempotencyState
    markProcessed(key, messageId, result) -> void
    markFailed(key, messageId) -> void
    markCancelled(key, messageId) -> void
    forget(key, messageId) -> void              // 插入 processing 后未实际入队时回滚幂等占位
    gc(now) -> int                           // 返回删除条数

    // messages（可选）
    appendMessage(record) -> void

    // usage / budget
    recordUsageEvent(event) -> void
    getSessionCounters(key) -> SessionCounters      // turns, toolCalls, wallClockMs, tokens, costUsd（costUsd 仅累加 completeness=complete && cost_usd>0；见 usage_events §聚合约束）
    getSessionBudget(key) -> BudgetSnapshot?        // null 当 $ 预算未启用

    // trajectory
    upsertExternalSessionImport(record) -> void
    appendTrajectorySegment(segment) -> void
    recordProviderCallObservation(observation) -> void
    pruneProviderCallObservations(before) -> int
    queryTrajectory(query) -> TrajectoryPage
}
```

## 并发

- SQLite 使用 WAL 模式（`PRAGMA journal_mode=WAL`）
- 所有写入走单一后台 goroutine/task（语言定后落实）
- 读可以并发

## 迁移

- 首版 schema 由 `@agent-nexus/daemon` 包内 `migrations/` 子目录管理
- 每次 schema 变更 +1 migration
- 启动时检查 schema version，自动跑 pending migrations
- 禁止手工改 schema

## 备份

MVP 不内置备份功能。用户可自行备份 `<home>/state.db` 与 `transcripts/`。

未来若加备份/导出，发独立 ADR。

## 数据留存

- `idempotency`：TTL 24h，后台 GC
- `messages`、`usage_events`：默认 90 天，用户可配置
- `transcripts`：默认永久，用户可配置轮转
- `external_session_imports`、`trajectory_segments`：默认 90 天，用户可配置；已链接到 active session 的记录不得早于 session 归档清理
- `provider_call_observations` 与 `<home>/trajectory/provider-calls/` payload：默认 30 天，用户可配置
- `logs`：默认 30 天

## 反模式

- 绕过 Store 接口直接 SQL（失去测试与迁移保护）
- 把大 JSON 塞进 `meta_json` 代替建表
- 在 SQLite 里存密钥或 token
- 把 transcript 读回来给 CC 当输入做"记忆恢复"（MVP 不做；设计复杂）
- 把 logs 和 transcripts 混在一起（二者读者/用途不同）
