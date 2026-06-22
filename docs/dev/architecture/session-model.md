---
title: 会话模型（Session Model）
type: architecture
status: active
summary: 说明 SessionKey、状态机、幂等、顺序保证、断线/重启恢复与交互原子性如何组合
tags: [session, session-model, lifecycle, idempotency, ordering, concurrency]
related:
  - dev/architecture/overview
  - dev/spec/message-protocol
  - dev/spec/infra/idempotency
  - dev/spec/infra/persistence
  - dev/spec/infra/cost-and-limits
---

# 会话模型（Session Model）

"会话"（session）在本项目里至少有三层含义。本文讨论的是 daemon 拥有的 **RoutingSession**：某个 IM 入口如何绑定到 agent owner、opaque agent conversation ref、队列与审计上下文。它不是 Codex / Claude Code 的原生 conversation，也不是 agent runtime 的子进程句柄。

术语边界：

| 名称 | Owner | 含义 |
|---|---|---|
| `TransportSession` | platform adapter | 平台原生会话/interaction/reply context，例如 Discord channel/thread/interaction token |
| `RoutingSession` | daemon | IM 入口到 agent owner 与 opaque agent conversation ref 的路由状态 |
| `AgentSession` | agent runtime | 当前运行的 agent 后端进程/SDK 句柄 |
| `AgentConversation` | agent package | agent 原生对话上下文，例如 Codex thread、Claude session |

几乎所有横切能力（幂等、限流、预算、日志串联、错误恢复）都以 RoutingSession 为组织单位；agent conversation 的内部生命周期由 agent package 自己解释。

## 标识：SessionKey vs sessionId

RoutingSession 有两层标识：**路由 key**（SessionKey）和**持久化主键**（sessionId）。字段契约与存储约束分别见 [`message-protocol.md`](../spec/message-protocol.md#sessionkey) 与 [`persistence.md`](../spec/infra/persistence.md#sessions)；本节只说明二者如何协作。

### SessionKey（路由层）

字段定义见 [`../spec/message-protocol.md` §SessionKey](../spec/message-protocol.md#sessionkey)。本节只讲它在架构里的角色：

- **入站事件路由**：给定入站 `NormalizedEvent`，由 SessionKey 定位**当前活跃**的 RoutingSession 实例
- **串行队列键**：同 SessionKey 的事件串行；跨 SessionKey 并发
- **幂等键的一部分**：见 [`../spec/infra/idempotency.md`](../spec/infra/idempotency.md)
- **非唯一性**：跨时间允许同 key 多 generation 共存——入站路由必须先按 SessionKey 找当前活跃实例（字段定义与跨时间唯一性陈述见 [`../spec/message-protocol.md` §SessionKey](../spec/message-protocol.md#sessionkey)）

### sessionId（持久化层）

**用途**：

- 持久化主键：`sessions` 表的 `PRIMARY KEY(sessionId)`，允许同 SessionKey 有历史行
- 跨 session 的审计：transcript 文件、usage_events、messages 都按 sessionId 归属，不按 SessionKey（否则 archive 后历史会被新实例覆盖/误读）
- `generation` 只辅助同一 SessionKey 下的历史实例排序；唯一性由 sessionId 保证

SessionKey 维度上的查询索引与唯一约束见 [`persistence.md`](../spec/infra/persistence.md#sessions)。

### Discord thread 的映射

- **常规 channel 消息**：`channelId = channel.id`
- **thread 消息**：`channelId = thread.id`（thread 被视为独立容器）

该映射让 thread 作为独立会话容器参与同一套路由、队列与持久化组合。

Daemon-owned `/nexus-new-thread` 是当前内存态 MVP：daemon 在当前 Discord channel 下创建 private thread，默认把调用者加入 thread，并在独立的内存 thread registry 里记录 `threadId -> parentChannelId / ownerUserId / renameOnFirstPrompt`。这份 registry 是 channel topology 元数据，不随 `/new`、`/nexus-kill` 或 `/nexus-sessions` rebind 复制到其它 SessionKey。用户在该 thread 中发送第一条消息时才启动 agent；`session_started` 后再写入 opaque agent conversation ref。只有创建时未传标题、仍使用默认占位标题的 managed thread，才会 best-effort 把 Discord thread 名称改为第一条用户消息生成的标题；已有标题不会被覆盖。已注册的 managed thread 内消息只允许创建者继续，并用父 channel 执行 binding route 与 channel allowlist 判定。

Discord 上原生存在、但不是 `/nexus-new-thread` 创建或 registry 已丢失的 thread，只通过 `threadParentChannelId` 继承父 channel 的 route/auth；daemon 不会把首个发言者提升为 owner，也不会自动把该 thread 改名。进程重启会丢失内存 thread registry，因此 managed thread 会降级为 native thread fallback：仍可继承父频道 route/auth，但不再保留 owner-only 约束、自动改名能力或 session switcher 列表。

### 不在 SessionKey 里的东西

- **不包含 messageId**：messageId 是消息级概念，不是会话级
- **不包含 timestamp**：SessionKey 本身跨时间持续（多个 generation 共享同一 key）
- **不包含 agent 后端名**：一个 RoutingSession 只绑定一个 agent owner，后端在 session 元数据里记录
- **不包含 agent conversation id**：Codex thread id / Claude session id 作为 opaque agent conversation ref 存在 RoutingSession 元数据里，不进入 SessionKey

## 生命周期

状态机（含错误路径与重启路径，状态字段契约见 [`persistence.md`](../spec/infra/persistence.md#sessions)）：

```
                ┌──────────┐
                │ Created  │  SessionKey 首次出现，未 spawn agent
                └────┬─────┘
                     │  spawn agent 子进程（成功）
                     │  spawn 失败 ─────────────────────────┐
                     ▼                                      │
           ┌──────────────────┐                             │
           │      Active      │  有活跃 agent 子进程         │
           │ ◄──────┐         │                             │
           └───┬────┴─────┬───┘                             │
      idle timeout       │                                 │
               │   ┌──────┼─────── 用户 /resume              │
               ▼   │      │                                 │
           ┌──────────┐   │  ┌─────────────────────────┐    │
           │   Idle   │   │  │       Errored           │◄───┘
           └────┬─────┘   │  │  熔断 / agent 崩溃 / 超时│
                │         └──┤                         │
                │            └──────┬──────────────────┘
                │            冷却 / /resume / /end
                │                   │
    idle-to-archive / /end          │
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
           spawn 新 agent   └──► Archived
                │
                ▼
              Active
```

### 状态转换触发

| From → To | 触发 |
|---|---|
| Created → Active | 收到首条消息，agent 子进程 spawn 成功 |
| Created → Errored | spawn 失败 |
| Active → Idle | 距离最近一条消息/事件超过 `limits.session.idleTimeoutMs`（默认 30 分钟，见 [`../spec/infra/cost-and-limits.md` §Session 生命周期 timeout](../spec/infra/cost-and-limits.md#session-生命周期-timeout)） |
| Idle → Active | 收到同 SessionKey 的新消息且本 generation 未 Archived |
| Idle → Archived | 超过 `limits.session.idleToArchiveMs`（默认 2 小时） |
| Active → Archived | 显式 `/end` 命令 |
| Active → Errored | 熔断触发（见 `cost-and-limits.md`）/ agent 崩溃 / wallclock_timeout |
| Errored → Active | 用户 `/resume` 且在冷却期内或冷却期结束后的第一条新消息（见 `cost-and-limits.md` §熔断） |
| Errored → Archived | 用户 `/end`，或冷却期后仍无新消息达到归档阈值 |
| Active/Idle → Interrupted | **进程重启**：所有非终态 session 转入 Interrupted |
| Interrupted → Active | 用户 `/resume` → spawn 新 agent 子进程（复用 transcript）|
| Interrupted → Archived | 用户 `/end`，或超过 `limits.session.interruptedToArchiveMs`（默认 24 小时） |

**终态**：`Archived`。终态 session 不再接受任何操作；同 SessionKey 的新消息会触发 `generation + 1` 的新 Created 实例。

### 显式结束 / 恢复命令

用户可通过 slash command（命令名在 `platform-adapter.md` 定义）控制状态：

- `/end` → Active/Idle/Errored/Interrupted → Archived
- `/resume` → Errored/Interrupted → Active（会尝试 spawn 新 agent）
- 用户在新 channel 发消息 → 创建新 SessionKey 的 Created

Agent-owned `/new`、`/stop`、`/steer` 等 command 不直接改写本状态机；daemon 只把它们按 command registry 路由给 agent package。若 agent command 结果要求更新 opaque agent conversation ref，daemon 只保存该 opaque ref，不解释 agent conversation 语义。Daemon-owned `/nexus-kill` 是 RoutingSession 级控制：清除当前 route 与 opaque ref，并释放当前 runtime handle。

### 可恢复 AgentConversation 绑定

RoutingSession 持有的 opaque agent conversation ref 与 live `AgentSession` handle 分离：
前者是跨 turn / 跨进程恢复用的绑定，字段契约与更新语义见 [`persistence.md` §sessions](../spec/infra/persistence.md#sessions)；
后者只是当前进程里的 runtime 句柄，接口契约见 [`agent-runtime.md`](../spec/agent-runtime.md#agentsession-与-session-的区分)。

当同一 SessionKey 没有可复用的 live handle 但仍有 opaque ref 时，daemon 启动新的 `AgentSession`，并把该 ref 放进 `SessionConfig.resumeFromAgentSessionId`。

用户把已有 resumable session 绑定到新的 SessionKey 时，daemon 迁移 opaque ref 和下一次 spawn 所需的一次性 override；平台 thread 拓扑仍归原 channel，不随 rebind 复制。

当前实现还未落地本文件描述的 SQLite lifecycle registry。内存态 MVP 支持 daemon-owned `/nexus-sessions`：按当前 platform instance + platform + user 列出最近可恢复的 opaque agent conversation ref，下拉项用该 session 的第一条用户消息生成标题；通过 Discord select 选择后，把当前 SessionKey 绑定到所选 `agentSessionId`；下一条消息使用 `SessionConfig.resumeFromAgentSessionId` 恢复。rebind 迁移 opaque ref、标题与下一次 spawn override，不复制 thread registry 或其它 channel topology 元数据。`/nexus-new-thread` 创建的 thread 占位在 agent session 启动前不出现在该列表里。

workingDir 解析分三层：一次性 session override > channel workingDir default > agent config default。`/nexus-working-dir path:<absolute-path>` 默认设置当前 channel/thread 的 channel default；thread 若未设置自己的 default，则继承父 channel 的 default。`/nexus-working-dir ... scope:session` 才在当前原始 SessionKey（channel 或 thread + user）上保存一次性 `nextSession.workingDir`，仅在下一次真正 `startSession` 时消费。thread 继承父频道 binding 只影响 route/auth 与 channel default 读取，不会把 session override 写到父频道 key。所有 workingDir 设置都必须位于当前 binding 目标 agent 的默认 `workingDir` 之内。状态变更进入同 SessionKey 的 daemon queue：空闲时可立即完成；若当前 turn 正在运行，则先返回 queued ack，待排到队头后再写入并发送最终结果。由于 SessionKey 包含 platformName、platform、channelId 与 initiatorUserId，channel-scope workingDir 对同频道不同用户不提供全序保证。

`/nexus-settings` 可设置当前 channel/thread 的 agent binding override。override 的路由契约由 [`config-routing.md`](../spec/config-routing.md#运行时-channel-agent-override) 拥有；本模型只依赖其组合结果：切换 agent owner 会清除触发者当前原始 SessionKey 上的 RoutingSession 映射与 opaque agent conversation ref，下一条消息按新 agent owner 启动或恢复。该列表、thread registry、channel default、agent binding override、一次性 override 与 daemon queue 都随进程重启丢失，不替代 Interrupted / Archived 的持久状态机。

## 幂等

### 为什么需要

Discord gateway 会重发事件（at-least-once）。同一条用户消息可能被 adapter 收到多次；去重能力由 daemon 在入队前提供。

详细规则、存储、流程与合约测试见独立 spec：[`idempotency.md`](../spec/infra/idempotency.md)。

### 在本 session 模型中的角色（要点）

- 每条入站 `NormalizedEvent` 带平台消息 ID
- **Adapter 只负责归一化与投递，不做去重**；由 daemon 在 dispatch 阶段（auth 检查之后、session 入队之前）执行 `checkAndSet(sessionKey, messageId)`
- 去重键、TTL、存储和 GC 规则见 [`idempotency.md`](../spec/infra/idempotency.md)

## 顺序保证

### 同 session 内

**严格串行**。agent 后端是有状态对话，同 session 并发输入会破坏上下文顺序。

- daemon 为每个活跃 SessionKey 维护一个内存 FIFO 队列；key 是 `platformName + platform + channelId + initiatorUserId`
- 队列覆盖 message、`dispatchMode: "queued"` 的 agent command，以及会影响 turn-visible state 的 daemon state command（当前为 workingDir mutation）
- 队列头任务完成前，后续任务排队；用户在短时间内发多条消息 → 串行处理，前一条完成才处理下一条
- `/nexus-queue` 管理当前 SessionKey 的 queue：面板展示 running / pending / recent 计数；用户可选择 pending item 后上移、下移、取消或编辑 message prompt，也可插入一条 next prompt；`next` 中断当前 running turn 并让下一条 pending item 继续执行；`clear` 取消所有 pending，不取消 running
- `/nexus-kill` 不进入队列；它立即停止当前 runtime handle，取消当前 SessionKey 的 pending items，并删除当前 RoutingSession 映射

### 跨 session

**并发**。不同 SessionKey 的任务可以并行。当前内存队列只做 per-key pending depth 限制；全局并发上限见 `spec/cost-and-limits.md` 的目标约束，不由 queue v1 强制。

### Daemon queue v1

队列是 daemon 内存态协作结构，不是持久 session lifecycle registry。队列 key 与 RoutingSession key 一致：`platformName + platform + channelId + initiatorUserId`。这意味着同一频道内不同用户各有自己的 queue；channel-level workingDir 这类共享状态只在同一 key 内有顺序保证，跨用户不提供全序。

队列 item 类型：

- `message`：用户消息或 `/nexus-queue` 插入的 next prompt；pending 状态下可编辑 prompt、上移、下移、取消
- `agent-command`：`dispatchMode: "queued"` 的 agent command；pending 状态下可上移、下移、取消，但不支持编辑
- `daemon-state-command`：会影响 turn-visible state 的 daemon 命令，当前为 workingDir mutation；pending 状态下可上移、下移、取消，但不支持编辑

状态集合：

- `queued`：等待执行；`/nexus-queue` 只管理这一类 pending item
- `running`：正在执行；不能重排、编辑或 clear；可通过 `/nexus-queue action:next` 中断当前 turn 后继续 pending，也可通过 `/nexus-kill` 或 agent stop 类命令影响
- `completed` / `failed` / `cancelled`：终态；只进入 recent 计数，不再接受操作

管理操作：

- `status`：返回当前 key 的 running、pending、recent 计数，并附带 pending item select
- `clear`：取消当前 key 的全部 pending item；message item 的幂等状态进入 `cancelled`
- `select`：选择一个 pending item 后显示 `Up` / `Down` / `Edit` / `Cancel`
- `Edit`：只对 `message` item 开放，修改即将传给 agent 的 prompt；不改变原 Discord message
- `Insert next`：通过 modal 新增一个 synthetic `message` item，插到当前 running 之后、已有 pending 之前；该 item 没有平台 `messageId`，因此不参与入站 messageId 幂等
- `next`：daemon-owned queue 控制；对当前 active `AgentSession` 调用 `interrupt()`，不删除 RoutingSession 映射，不清空 pending items；当前 running item 收到 terminal 后由 queue 调度下一条 pending

### 并发上限

- 全局活跃 agent 子进程数受 limits spec 约束
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
- 用户 `/resume` → spawn 新 agent 子进程，复用当前 session 实例，保留历史 transcript
- 用户 `/end` 或超过 `limits.session.interruptedToArchiveMs`（默认 24 小时）→ Archived，同 SessionKey 下次消息会创建新 generation 的新 Created

### agent 子进程崩溃

- agent runtime 检测到 exit 且未预期
- 当前 session 状态标为 `Errored`
- 最后一条未完成的输入标记失败
- 用户可见通知 + 允许重试

## 元数据

session 元数据字段、状态枚举、索引、不变量与落盘规则见 [`persistence.md`](../spec/infra/persistence.md#sessions)。本架构文档只依赖这些契约来描述 session registry、队列、agent runtime 与 transcript 的组合关系。

## 交互原子性

**原子单元**：一次"用户消息 → agent 回复完成"的完整往返。

- 中途 agent 子进程崩溃 → 整体失败，用户收到错误通知
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
