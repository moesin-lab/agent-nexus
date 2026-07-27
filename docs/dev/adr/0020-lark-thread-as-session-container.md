---
title: ADR-0020：飞书话题作为独立 session 容器
type: adr
status: active
summary: 选择飞书话题群的 thread 作为独立 SessionKey，私聊保留为兼容与 onboarding 入口
tags: [adr, decision, platform-adapter, lark, session]
related:
  - dev/adr/0019-lark-platform-via-official-node-sdk
  - dev/architecture/session-model
  - dev/spec/platform-adapter
  - dev/spec/message-protocol
adr_status: Proposed
adr_number: "0020"
decision_date: 2026-07-26
supersedes: null
superseded_by: null
---

# ADR-0020：飞书话题作为独立 session 容器

- **状态**：Proposed
- **日期**：2026-07-26
- **决策者**：senticx@foxmail.com
- **相关 ADR**：ADR-0015、ADR-0017、ADR-0019

## 状态变更日志

- 2026-07-26：Proposed

## Context

ADR-0019 的 walking skeleton 把飞书 P2P `chat_id` 映射为 SessionKey。这个入口可以完成单轮与连续对话，
但同一用户与机器人只有一个稳定 P2P 容器；用户要同时推进多个长期任务时，只能反复执行 `/new`，无法从飞书
界面看出不同 session 的边界。

飞书机器人不支持注册 Discord 式 native slash command。普通文本 `/new` 可以重置当前 route，却不能替代
可见、可命名、可回到历史上下文的原生容器。飞书话题群已经提供用户可理解的并行上下文：每个话题有稳定
`thread_id`，群本身有稳定 `chat_id`。

现有 Session Model 已规定平台原生子容器形成独立 SessionKey，父容器只用于 route、auth 与 channel default
继承。飞书 adapter 应复用这个中立模型，不在 daemon 增加飞书专属 session registry，也不把话题标题或消息正文
拼进 SessionKey。

话题内回复还有独立 transport 约束：飞书发送新消息 API 只接受 `chat_id`，不能直接把 `thread_id` 当收件人。
Adapter 必须回复话题中的消息并要求 `reply_in_thread=true`，否则 agent 输出会落回群主时间线。

## Options

### Option A：继续只用 P2P，以 `/new` 划分 session

- **是什么**：保持 `chat_id` 唯一容器，用户需要新上下文时发送文本 `/new`。
- **优点**：不新增群消息权限；不改变入站和发送映射。
- **缺点**：同一时刻只能保留一个可见上下文；历史 session 在飞书 UI 中没有独立入口。
- **主要风险**：用户误以为不同任务仍是独立上下文，实际不断覆盖同一 route。

### Option B：私有话题群作为 session hub，每个话题一个 SessionKey

- **是什么**：P2P 保留兼容；话题群的 `thread_id` 成为 `channelId`，父 `chat_id` 用于 route 与 auth 继承。
- **优点**：session 边界与飞书 UI 一致；多个话题可以并行；复用现有 child-container 模型。
- **缺点**：需要群消息事件权限；发送必须携带原入站消息的 response target。
- **主要风险**：若错误使用 `chat_id` 发送，回复会脱离话题；若群平铺消息也进入 agent，会重新产生共享 session。

### Option C：每个 session 创建一个独立群

- **是什么**：每次新 session 都新建私有群，群 `chat_id` 直接作为 SessionKey。
- **优点**：发送仍可使用普通 create API；群级权限边界直观。
- **缺点**：产生大量群聊；邀请、归档与命名生命周期都需要 agent-nexus 管理。
- **主要风险**：把 session 生命周期扩大成群资源生命周期，增加权限与清理成本。

## Decision

选择 **Option B：私有话题群作为 session hub，每个话题一个 SessionKey**。

P2P 继续作为 onboarding、配置排障和向后兼容入口。话题群只接受带非空 `thread_id` 的用户纯文本；群主时间线
消息不进入 agent。入站消息自身作为 response target，daemon 将该意图透传给 adapter，Lark adapter 使用 reply API
并设置 `reply_in_thread=true`。

飞书原生 slash command 能力仍声明为不支持。普通文本 `/new` 继续重置当前话题 session；其余 registry 已知但
本平台不能执行的控制命令返回稳定的 unavailable 反馈，不得作为普通 prompt 发送给 agent。

## Consequences

### 正向

- 一个飞书话题对应一个可见、稳定、可并行的 RoutingSession。
- 话题 route 与 allowlist 复用父群配置，不需要把动态 `thread_id` 逐个写进 binding。
- queue、幂等与 agent conversation ref 自然按 `thread_id` 隔离。
- P2P 配置与已有用户路径保持兼容。

### 负向

- 应用必须订阅并获准接收群内消息；权限与版本发布成为真实 E2E 的前置条件。
- `NormalizedEvent` 需要显式 response target，daemon 的所有事件派生出站路径都要保持该字段。
- Lark adapter 同时维护 create 与 reply 两种发送调用，并分别覆盖重试、切片和 partial-send。
- 话题参与者共享同一原生内容，但当前 SessionKey 仍包含发起用户；多人共享一个 agent session 不在本决策内。

### 需要后续跟进的事

- 若后续需要由 agent-nexus 自动建群或创建话题，另行决定资源生命周期与新增权限。

## Out of scope

- 不自动创建飞书应用、群聊或话题。
- 不支持群主时间线作为共享 session。
- 不支持多用户共同驱动同一个 RoutingSession。
- 不引入飞书卡片、按钮、附件、reaction、typing indicator 或 native slash command。
- 不把所有 command descriptor 改造成通用文本 command transport。

## Amendments

无。

## 参考

- 相关 issue：[#185](https://github.com/moesin-lab/agent-nexus/issues/185)
- 相关决策：[`0019-lark-platform-via-official-node-sdk.md`](0019-lark-platform-via-official-node-sdk.md)
- 组合模型：[`../architecture/session-model.md`](../architecture/session-model.md)
- 接口契约：[`../spec/platform-adapter.md`](../spec/platform-adapter.md)
