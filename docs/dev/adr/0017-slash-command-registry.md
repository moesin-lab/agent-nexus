---
title: Slash command registry 统一声明与注册
type: adr
status: active
summary: 选择统一 descriptor、daemon planner、显式 reverse map 和远端成功后激活的 slash command 架构
tags: [adr, decision, dispatch, platform-adapter, agent-runtime]
related:
  - dev/spec/command-registry
  - dev/spec/message-protocol
  - dev/spec/platform-adapter
  - dev/spec/agent-runtime
adr_status: Proposed
adr_number: "0017"
decision_date: 2026-05-24
supersedes: null
superseded_by: null
---

# ADR-0017：Slash command registry 统一声明与注册

- **状态**：Proposed
- **日期**：2026-05-24
- **决策者**：agent-nexus maintainers
- **相关 ADR**：ADR-0001、ADR-0014、ADR-0015

## 状态变更日志

- 2026-05-24：Proposed

## Context

当前 Discord adapter 自己注册和处理 `/reply-mode`，daemon 另有 text prefix `/new`。这两个路径都可用，但它们把命令事实分散在 platform、daemon 和文档中：没有统一 descriptor、没有统一命名策略，也没有可以证明 remote registration 与本地 dispatch map 一致的激活点。

项目已经有多 platform instance、多 agent binding 和 Codex / Claude Code 两个 agent backend。命令空间如果继续增长，裸名冲突会变成真实风险：`/new` 可能是单 agent 的便捷入口，也可能与历史 platform command 或 daemon command 冲突。

Discord command 注册本身又有 scope 与远端状态问题。当前逐条 create/upsert 的实现对一个 command 足够；当一个 scope 内存在 stable name、legacy alias、single-agent alias 时，partial success 会让用户看见远端 command，但 daemon 本地不一定有一致的 dispatch map。

因此需要把 slash command 抽成独立 registry 契约：owner package 声明命令，daemon 统一规划命名和 reverse map，platform adapter 只负责 native payload 映射与远端提交。

## Options

### Option A：继续由 platform adapter 各自注册命令

- **是什么**：Discord adapter 继续定义 `/reply-mode`，后续 command 由对应实现就近注册和处理。
- **优点**：改动小；现有 `/reply-mode` 不需要迁移；platform SDK 映射最直接。
- **缺点**：agent command 会被迫了解 platform naming 或由 CLI glue 拼装；daemon 无法统一检测裸名、prefix、legacy alias 冲突。
- **主要风险**：不同 command 的注册成功状态与 daemon dispatch 状态无统一事务边界，partial registration 后难以 fail-closed。

### Option B：统一 descriptor + daemon planner + explicit reverse map

- **是什么**：agent / platform / daemon package 暴露 platform-neutral descriptor，daemon 按统一 name policy 为每个 registration scope 生成 plan 和 reverse map，platform adapter 负责 native payload 映射与提交。
- **优点**：command taxonomy、prefix、alias 和 legacy policy 有单一执行点；dispatch 不依赖字符串拆分；远端注册成功后才激活本地 map。
- **缺点**：需要新增 protocol/daemon seam；现有 `/reply-mode` 和 `/new` 都要迁移到 registry；P3-P5 的测试面更宽。
- **主要风险**：如果 planner 把 binding scope、agent owner 和 platform registration scope 混为一谈，会出现命令可见但 route 不匹配的边界错误。

### Option C：引入用户可配置 command DSL

- **是什么**：把 command name、alias、handler 绑定开放到配置文件，让用户自定义命令表。
- **优点**：灵活；可以用配置解决不同团队的命名偏好。
- **缺点**：把命名冲突、安全边界和 handler routing 暴露给用户，显著扩大配置 schema 与错误面。
- **主要风险**：用户配置可绕开 historical reserved bare name 与 owner prefix policy，导致迁移和安全审计不可控。

## Decision

选择 Option B：使用统一 `CommandDescriptor`、daemon-owned `CommandNamePolicy` / registration planner / active reverse map，并规定只有远端注册成功后才能激活对应 scope 的 reverse map。

## Consequences

### 正向

- `agent`、`platform`、`daemon` command 的 owner 边界可统一验证。
- Stable name、single-agent alias、legacy bare name 的冲突检测有单一实现点。
- Dispatch 只查 explicit reverse map，不从平台 command name 字符串推导 owner 或 handler。
- `/reply-mode` 可以兼容迁移为 stable `/discord-reply-mode` + legacy `/reply-mode`。
- 远端注册失败或 partial success 时，本地 active map 不切换，command dispatch fail-closed。

### 负向

- 需要先补 protocol/daemon scaffold 和失败测试，不能直接在 Discord adapter 上加第二个命令。
- Platform adapter 需要新增 command registration port 或等价 seam。
- Agent package 要新增 descriptor export，但仍不能 import platform naming utility。
- Global/guild registration scope 与 routing binding 是两套概念，review 时需要专门检查二者没有被混用。

### 需要后续跟进的事

- P3 先落 failing tests：canonical id uniqueness、reserved prefix collision、historical reserved bare name、alias removal、reverse-map miss。
- P4 实现 daemon planner 与 active map 后，必须覆盖 remote registration failure 保留旧 map。
- P5 迁移 Discord `/reply-mode`，同时注册 `/discord-reply-mode` 和 `/reply-mode`。

## Out of scope

- 不决定新增第二个 IM platform。
- 不决定用户自定义 command DSL。
- 不决定 Discord 之外平台的 native payload 细节。
- 不决定让 backend 自身 TTY slash commands 直接透传到 IM。
- 不改变 `platforms[]` / `agents[]` / `bindings[]` 的路由模型，除 command registration 所需的读取外不扩展 routing schema。

## Amendments

- 无

## 参考

- 相关 spec：[`../spec/command-registry.md`](../spec/command-registry.md)
- 相关 spec：[`../spec/message-protocol.md`](../spec/message-protocol.md)
- 相关 spec：[`../spec/platform-adapter.md`](../spec/platform-adapter.md)
- 相关 spec：[`../spec/agent-runtime.md`](../spec/agent-runtime.md)
