---
title: ADR-0024：把原生 Agent Session 物化为平台 Session 容器
type: adr
status: active
summary: 选择由已鉴权控制命令触发 profile session 扫描，并用持久 saga 幂等创建固定平台容器
tags: [adr, decision, session, persistence, lark, codex]
related:
  - dev/adr/0021-lark-thread-as-session-container
  - dev/architecture/session-model
  - dev/spec/agent-runtime
  - dev/spec/platform-adapter
  - dev/spec/infra/persistence
adr_status: Proposed
adr_number: "0024"
decision_date: 2026-08-21
supersedes: null
superseded_by: null
---

# ADR-0024：把原生 Agent Session 物化为平台 Session 容器

- **状态**：Proposed
- **日期**：2026-08-21
- **决策者**：senticx@foxmail.com
- **相关 ADR**：ADR-0014、ADR-0021、ADR-0022

## 状态变更日志

- 2026-08-21：Proposed

## Context

RoutingSession 持久化只能恢复已经被 agent-nexus 见过并绑定到平台容器的 opaque agent conversation ref。
同一个 Codex profile 中还可能存在由 Codex CLI、编辑器或其他受支持入口创建的 durable thread；这些 thread
具备原生 resume identity，却没有可从飞书返回的固定话题入口。

直接把原生 thread 绑定到话题外的 P2P 或群主时间线会重新引入隐式 Session，并违反 ADR-0021 的“一话题一
Session、话题外只做控制面”。恢复流程必须为每个原生 thread 建立一个新话题，用最后一个已完成 turn 的回复
提供可见上下文，并把新话题固定到原 opaque ref。

扫描 profile、创建飞书话题与写 SQLite 跨越三个故障域，不能由一个数据库事务覆盖。若远端创建成功、本地写入
失败后直接重试，会产生重复话题；若启动时自动扫描，daemon 又没有本次操作明确的用户、父群和授权上下文。

profile 也是 agent-owned 边界。daemon 不应解释 Codex rollout 文件或把同一 backend owner 下不同命名 agent 的
session 混在一起；具体 backend 必须提供只读 catalog，CLI 把它和同一 agent 的有效 profile 配置一起组装。

## Options

### Option A：继续只列出原生 Session，由用户手工建话题并选择绑定

- **是什么**：控制面显示 native ref，用户新建话题后再执行一次绑定命令。
- **优点**：不需要跨系统创建资源；远端失败模型简单。
- **缺点**：步骤多且容易绑错；无法自动把最后回复带到新话题。
- **主要风险**：同一 native ref 被重复绑定，或用户在错误话题继续会话。

### Option B：已鉴权控制命令触发扫描，并以持久 saga 物化固定容器

- **是什么**：当前 route 的 agent catalog 扫描 profile；daemon 为新候选持久化 operation，使用稳定幂等键创建
  平台容器，再原子保存 native ref、原 workingDir、fixed container 和 agent identity。
- **优点**：用户只需执行一次控制命令；恢复后的飞书心智与普通话题 Session 一致；可审计每个故障阶段。
- **缺点**：需要新增 catalog、平台幂等创建和 materialization 状态；无法获得跨 SQLite 与平台 API 的强事务。
- **主要风险**：远端请求结果不明确时留下孤儿容器；平台幂等语义失效时不能安全自动重试。

### Option C：daemon 启动时自动扫描并批量创建容器

- **是什么**：每次启动后扫描全部 profile，并为未见过的 session 立即创建话题。
- **优点**：无需用户执行控制命令。
- **缺点**：启动时缺少明确 owner 与 parent target；多 binding 时目标不唯一；重启会产生突发消息。
- **主要风险**：把历史回复发送到错误群或错误用户可见的容器，形成数据泄露。

## Decision

选择 **Option B：由已鉴权控制命令触发 profile 扫描，并以持久 saga 幂等物化固定平台容器**。

## Consequences

### 正向

- 原生 Codex thread 获得稳定、可点击、可继续输入的飞书话题入口。
- 扫描始终绑定当前 route 的精确 `agentName + agentOwner + profileId`，不会只按 backend owner 串绑；fixed
  container 也持久化该 opaque profile identity，恢复时 profile 不一致或缺少所需 catalog 必须 fail closed。
- 新建 operation 前先检查当前 platform/user/agent/profile 下是否已有 fixed container 绑定同一 native ref；普通话题
  首轮产生的 Codex thread 与 materializer 创建的 thread 共用这一唯一性边界，不能物化出第二个话题。该 reservation
  不包含控制面父容器：不同父群并发扫描时首个 operation 固定目标父群，其余调用复用同一结果，不创建第二个话题。
- 旧数据缺少 `profileId` 时不能直接 resume；只有 catalog 在当前 profile 确实返回同一 native ref，才在精确 agent
  identity 下回填 profile 并计为 existing，避免跨 profile 误续接。
- `planned → ambiguous(in-flight) → container_created → linked` 在远端 dispatch 前先封住重放窗口；本地绑定失败后从
  已创建容器继续，不重复调用远端创建。
- 最后回复只作为平台 seed，不进入下一轮模型输入，也不以原文落入 SQLite 或日志。

### 负向

- 平台创建结果为 ambiguous 时首版必须停止自动重试，可能留下无法自动认领的孤儿话题。
- catalog 扫描和逐 session read 会增加一次控制命令的延迟，并受 backend profile schema/version gate 约束。
- Lark 应用需要读取话题群信息并在话题群发送消息的权限。

### 需要后续跟进的事

- 若平台提供可按 idempotency key 查询创建结果的稳定 API，再增加 ambiguous reconciliation。
- 若需要启动时只做无副作用的 catalog 索引，可另行定义缓存与过期策略；不得在启动阶段发平台消息。

## Out of scope

- 不决定跨用户共享一个 Session。
- 不恢复 subagent、ephemeral、无 completed reply 或越过 agent workingDir 边界的 session。
- 不把 profile 历史回复导入模型 prompt、trajectory 正文或通用消息历史。
- 不保证跨 SQLite 与外部平台 API 的 exactly-once 事务；dispatch 已开始但结果未 checkpoint 的 operation 不自动重放。

## Amendments

## 参考

- 相关 issue：[#198](https://github.com/moesin-lab/agent-nexus/issues/198)
- 话题容器决策：[`0021-lark-thread-as-session-container.md`](0021-lark-thread-as-session-container.md)
- Session 组合模型：[`../architecture/session-model.md`](../architecture/session-model.md)
- Agent catalog 契约：[`../spec/agent-runtime.md`](../spec/agent-runtime.md)
- 平台创建契约：[`../spec/platform-adapter.md`](../spec/platform-adapter.md)
- 存储契约：[`../spec/infra/persistence.md`](../spec/infra/persistence.md)
