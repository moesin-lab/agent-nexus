---
title: 会话模型（Session Model）
type: architecture
status: active
summary: 说明 SessionKey、状态机、幂等、顺序保证、断线/重启恢复与交互原子性如何组合
tags: [session, session-model, lifecycle, idempotency, ordering, concurrency]
related:
  - dev/architecture/overview
  - dev/spec/platform-adapter
  - dev/spec/message-protocol
  - dev/spec/infra/idempotency
  - dev/spec/infra/persistence
  - dev/spec/infra/cost-and-limits
  - dev/spec/infra/trajectory-observability
---

# 会话模型（Session Model）

"会话"（session）在本项目里至少有三层含义。本文讨论的是 daemon 拥有的 **RoutingSession**：某个 IM 入口如何绑定到 agent owner、opaque agent conversation ref、队列与审计上下文。它不是 Codex / Claude Code 的原生 conversation，也不是 agent runtime 的子进程句柄。

术语边界：

| 名称 | Owner | 含义 |
|---|---|---|
| `TransportSession` | platform adapter | 平台原生连接、会话容器与 reply context |
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

### 平台会话容器

平台原生字段到 `PlatformSessionKey` 的映射由 [`platform-adapter.md`](../spec/platform-adapter.md) 统一定义。本模型只依赖两个组合不变量：adapter 把平台会话容器映射为稳定的 `channelId`，并把消息发起者映射为稳定的 `initiatorUserId`。

支持原生子会话容器的平台把子容器作为独立 SessionKey 参与路由、队列与持久化；父子拓扑只用于 route、auth 与 channel default 继承，不改变 SessionKey 身份。Daemon-owned `/nexus-new-thread` 通过 adapter capability 创建子容器，并把 managed topology metadata 与 RoutingSession 分开保存：rebind 不复制拓扑，首条用户消息才启动 agent，`session_started` 后才写入 opaque agent conversation ref。

daemon-created 容器在 agent session 启动前的占位 topology metadata 仍不跨进程恢复。已经形成 RoutingSession 的容器定位引用随 session 记录持久化；丢失未绑定占位后，子容器只能依赖 adapter 提供的父容器 context 做 fallback，daemon 不再保留 owner-only、自动命名或 session switcher 占位等 managed 行为。

平台可把原生容器标记为 fixed session container。该容器的稳定路由 key 与一个 RoutingSession 一一对应，并在首次接受
dispatch 时固定到当时的 `agentName + agentOwner`：配置热重载不得把它切换到同 owner 的另一实例或不同 backend。运行时句柄重建
仍 resume 原 opaque ref，但 `/new`、kill 归档或 session rebind 不能在同一容器下产生新 generation。定位引用与
RoutingSession metadata 关联，列表恢复时引导用户回到原容器，不把对话迁移到控制面。字段契约见
[`message-protocol.md`](../spec/message-protocol.md#normalizedevent)。

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
| Interrupted → Active | 用户 `/resume`，或 fixed session container 收到下一条有效消息 → spawn 新 agent 子进程（复用 opaque agent conversation ref）|
| Interrupted → Archived | 用户 `/end`，或超过 `limits.session.interruptedToArchiveMs`（默认 24 小时） |

**终态**：`Archived`。终态 session 不再接受任何操作；同 SessionKey 的新消息会触发 `generation + 1` 的新 Created 实例。

### 显式结束 / 恢复命令

用户可通过当前平台可用的命令控制状态；命令 owner 与注册规则见 [`command-registry.md`](../spec/command-registry.md)：

- `/end` → Active/Idle/Errored/Interrupted → Archived
- `/resume` → Errored/Interrupted → Active（会尝试 spawn 新 agent）
- 用户在新的平台会话容器发消息 → 创建新 SessionKey 的 Created

Agent-owned `/new`、`/stop`、`/steer` 等 command 不直接改写本状态机；daemon 只把它们按 command registry 路由给 agent package。若 agent command 结果要求更新 opaque agent conversation ref，daemon 只保存该 opaque ref，不解释 agent conversation 语义。Agent-owned `/new` 会解除当前 SessionKey 的活跃绑定，但保留旧 opaque ref 作为 `/nexus-sessions` 可恢复历史；下一条消息用同一 SessionKey 开新 generation。Daemon-owned `/nexus-kill` 是 RoutingSession 级控制：停止当前 runtime handle、取消 pending items，并让当前 RoutingSession 离开活跃对话区；旧 opaque ref 仍作为 `/nexus-sessions` 可恢复历史保留，直到 registry 容量淘汰。

### 可恢复 AgentConversation 绑定

RoutingSession 持有的 opaque agent conversation ref 与 live `AgentSession` handle 分离：
前者是跨 turn / 跨进程恢复用的绑定，字段契约与更新语义见 [`persistence.md` §sessions](../spec/infra/persistence.md#sessions)；
后者只是当前进程里的 runtime 句柄，接口契约见 [`agent-runtime.md`](../spec/agent-runtime.md#agentsession-与-session-的区分)。

当同一 SessionKey 没有可复用的 live handle 但仍有 opaque ref 时，daemon 启动新的 `AgentSession`，并把该 ref 放进 `SessionConfig.resumeFromAgentSessionId`。

用户把已有 resumable session 绑定到新的 SessionKey 时，daemon 迁移 opaque ref、该 session 实际 workingDir 和下一次 spawn 所需的一次性 override；平台原生会话拓扑仍归原容器，不随 rebind 复制。

### Trajectory read model

Trajectory read model 不改变本状态机。它以 RoutingSession / sessionId 为主要 anchor，另行记录外部 session 导入、native resume 绑定、AgentEvent transcript anchor、usage/log anchor 与可选 provider-call observation。

外部 session resume 的架构边界与本节一致：daemon 保存 opaque native ref 并交给 agent runtime resume；外部 transcript 内容不因导入而进入模型上下文。字段、状态和查询契约见 [`trajectory-observability.md`](../spec/infra/trajectory-observability.md)。
外部 import 记录当前没有可验证的 source profile identity，因此不能绑定到声明 profile-scoped 的 backend；此类恢复
应改走同一 backend profile catalog，直到 importer 能提供并验证 opaque profile identity。

当前实现把 RoutingSession registry 持久化到 `<home>/state.db`。daemon-owned `/nexus-sessions` 按当前 platform instance + platform + user 及更新时间倒序列出最近可恢复、且与当前 agent owner/profile 兼容的 opaque agent conversation ref，包括同一 SessionKey 下被 `/new`、`/nexus-kill`、agent binding 切换或 session rebind 挤出活跃区的历史项。展示标题取自该 session 的第一条用户消息。profile-scoped backend 把 opaque profile identity 与每条 RoutingSession 一并落盘；缺失或不匹配的历史不进入列表，也不能由 interaction rebind。可 rebind 容器通过平台交互组件把当前 SessionKey 绑定到所选 `agentSessionId`，下一条消息使用 `SessionConfig.resumeFromAgentSessionId` 恢复；rebind 迁移 opaque ref、agent owner、profile identity、标题、实际 workingDir 与下一次 spawn override，不复制平台原生会话拓扑元数据。fixed session container 的定位引用、首次固定的 agent identity 与 opaque profile identity 一并落盘；列表展示原容器 URL/定位 ID，用户回原容器发送下一条消息时只有同一 profile 才能以原 opaque ref 启动新的 runtime handle，不执行 rebind。不兼容当前 agent owner/profile 的历史不会显示，过期 interaction 也不能跨 backend/profile 重绑。daemon-created 容器占位在 agent session 启动前不进入可恢复列表。
普通消息命中当前 rebindable SessionKey 时也执行同一 profile gate：缺失或不匹配的旧 ref 先归档，再在当前 profile
创建新 Session；fixed 容器则直接 fail closed，不能把旧 ref 交给 runtime。

话题外已鉴权 `/nexus-sessions` 还可触发当前 route 精确命名 agent 的 profile catalog。尚未物化的 native session
按 [ADR-0024](../adr/0024-materialize-native-sessions-as-platform-containers.md) 新建固定容器：最后一个 completed
turn 的回复只作为平台根消息，随后在单一 SQLite 事务中保存 opaque ref、原 workingDir、固定容器与 agent identity。
用户在新容器的下一条消息才启动 runtime，并把原 opaque ref 放入 `resumeFromAgentSessionId`；seed 不作为新的
`AgentInput`。扫描失败或 ambiguous 创建不会生成可恢复 RoutingSession。
若普通 fixed topic 已经绑定同一 native ref，扫描把它计为 existing，不创建 materialization operation 或第二个容器。
materialization identity 不含控制面父容器；同一用户从不同父容器并发扫描时，首个 durable reservation 决定话题目标。
缺少 profile identity 的 legacy fixed topic 在 catalog 从当前 profile 返回同一 native ref 后才允许回填并恢复；在此之前
直接收到的 topic 消息必须 fail closed。

registry 的容量上限是软上限：当前实例通常最多保留 `100` 条 session 记录；超过上限时只淘汰非活跃历史中 `lastTurnAt` 最早的记录，并同步删除对应持久记录，不为凑上限中断仍活跃的 runtime handle。若活跃记录本身超过上限，记录数可暂时超出；某条记录转为非活跃历史时立即再次执行淘汰。

workingDir 解析顺序是：一次性 session override > 当前 RoutingSession 上次实际 workingDir > channel workingDir default > agent config default。恢复同一 session 时保持它实际启动过的目录；channel default 与 agent default 只在该 session 尚无实际目录时参与解析。`/nexus-working-dir path:<absolute-path>` 默认设置当前 channel/thread 的 channel default；thread 若未设置自己的 default，则继承父 channel 的 default。`/nexus-working-dir ... scope:session` 才在当前原始 SessionKey（channel 或 thread + user）上保存一次性 `nextSession.workingDir`，仅在下一次真正 `startSession` 时消费。thread 继承父频道 binding 只影响 route/auth 与 channel default 读取，不会把 session override 写到父频道 key。workingDir 设置必须是非空绝对路径；不要求位于当前 binding 目标 agent 的默认 `workingDir` 之内。状态变更进入同 SessionKey 的 daemon queue：空闲时可立即完成；若当前 turn 正在运行，则先返回 queued ack，待排到队头后再写入并发送最终结果。由于 SessionKey 包含 platformName、platform、channelId 与 initiatorUserId，channel-scope workingDir 对同频道不同用户不提供全序保证。

`/nexus-settings` 可设置当前 channel/thread 的 agent binding override。override 的路由契约由 [`config-routing.md`](../spec/config-routing.md#运行时-channel-agent-override) 拥有；本模型只依赖其组合结果：切换 agent owner 会解除触发者当前原始 SessionKey 上的活跃绑定，把旧 opaque agent conversation ref 留在 `/nexus-sessions` 历史中，并让下一条消息按新 agent owner 启动或恢复。session 列表、一次性 next-session override 与已绑定容器定位引用会持久化；未绑定的 managed topology 占位、channel default、agent binding override 与 daemon queue 仍随进程重启丢失。

## 幂等

### 为什么需要

平台连接可能重发事件。同一条用户消息可能被 adapter 收到多次；去重能力由 daemon 在入队前提供。没有 replay
cursor 的平台还可能在断线窗口丢失事件，幂等只能消除重复，不能补回缺失。

详细规则、存储、流程与合约测试见独立 spec：[`idempotency.md`](../spec/infra/idempotency.md)。

### 在本 session 模型中的角色（要点）

- 每条 message `NormalizedEvent` 带平台消息 ID；平台重投可能更换消息 ID 时可额外带稳定 `idempotencyKey`
- **Adapter 只负责归一化、稳定键派生与投递，不做去重决策**；由 daemon 在 dispatch 阶段（auth 检查之后、session 入队之前）执行 `checkAndSet(sessionKey, event.idempotencyKey ?? event.messageId)`
- 去重键、TTL、存储和 GC 规则见 [`idempotency.md`](../spec/infra/idempotency.md)

## 顺序保证

### 同 session 内

**严格串行**。agent 后端是有状态对话，同 session 并发输入会破坏上下文顺序。

- daemon 为每个活跃 SessionKey 维护一个内存 FIFO 队列；key 是 `platformName + platform + channelId + initiatorUserId`
- 队列覆盖 message、`dispatchMode: "queued"` 的 agent command，以及会影响 turn-visible state 的 daemon state command（当前为 workingDir mutation）
- 队列头任务完成前，后续任务排队；用户在短时间内发多条消息 → 串行处理，前一条完成才处理下一条
- `/nexus-queue` 管理当前 SessionKey 的 queue：面板展示 running / pending / recent 计数；用户可选择 pending item 后上移、下移、取消或编辑 message prompt，也可插入一条 next prompt；`next` 中断当前 running turn 并让下一条 pending item 继续执行；`clear` 取消所有 pending，不取消 running
- `/nexus-kill` 不进入队列；它立即停止当前 runtime handle，取消当前 SessionKey 的 pending items，并解除当前 RoutingSession 的活跃绑定；旧 opaque ref 仍可从 `/nexus-sessions` 恢复

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
- `Edit`：只对 `message` item 开放，修改即将传给 agent 的 prompt；不改变原平台消息
- `Insert next`：通过 modal 新增一个 synthetic `message` item，插到当前 running 之后、已有 pending 之前；该 item 没有平台 `messageId`，因此不参与入站 messageId 幂等
- `next`：daemon-owned queue 控制；对当前 active `AgentSession` 调用 `interrupt()`，不删除 RoutingSession 映射，不清空 pending items；当前 running item 收到 terminal 后由 queue 调度下一条 pending

### 并发上限

- 全局活跃 agent 子进程数受 limits spec 约束
- 超过上限时新 session 排队等待

## 断线与重启恢复

### platform 连接断开

- transport 的重连、resume、replay cursor 与可能丢失窗口由 [`platform-adapter.md`](../spec/platform-adapter.md) 的平台专属契约定义
- daemon 只对 adapter 重新投递的事件执行幂等，不从连接状态推断消息是否已交付
- session registry **不受影响**：内存索引与 SQLite 记录都独立于 platform transport connection

### 进程重启

- CLI 在启动任何 platform 连接前从 SQLite 重建 current/history session registry，并把上一进程的非终态记录写为 **Interrupted**。
- runtime handle、in-flight turn 与 daemon queue 不落盘，也不会在启动时自动 replay。
- 正常 shutdown 在关闭 Session registry/state DB 前等待已接受的 profile materialization 到达 durable checkpoint；
  停机开始后拒绝新的扫描。hard crash 仍按 ADR-0024 的 ambiguous 语义恢复，不自动重放远端创建。
- fixed session container 保持同一个 sessionId/generation；用户回到原话题发送下一条有效消息时，daemon 先校验
  当前精确 agent/profile identity，再启动新的 runtime handle，并把已保存的 opaque ref 作为
  `resumeFromAgentSessionId`；profile 已变化或当前 runtime 不提供原 profile catalog 时 fail closed。
- rebindable 容器的历史继续通过 `/nexus-sessions` 选择后恢复。
- 完整的 Idle/Interrupted 超时归档与交互式确认门仍按本状态机演进；当前 registry persistence 不从 SQLite 自行 replay 用户输入。

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
- 中途平台发送失败 → 已生成的回复仍记入 transcript，可重发
- 中途用户发新消息（同 session）→ 排队

## 反模式

- 用 messageId 作为 sessionKey 的一部分（session 跨消息存在）
- 用 SessionKey 作为持久化主键（Archived 后同 key 新实例会覆盖/冲突；必须用 sessionId）
- 把 `Interrupted` 当 transient 状态不落盘（重启丢失）
- 允许同 session 并发处理（会破坏 CC 状态）
- 不做幂等（平台重投会导致重复处理）
- 依赖 transport 连接状态判断 session 是否 alive（分开管理）
- 把预算/限流放在 session 外部全局管（必须归因到 session）
