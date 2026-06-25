---
title: ADR-0018：Trajectory Observability 读模型与外部观测
type: adr
status: active
summary: 选择 daemon-owned trajectory read model、显式 source adapter 与 opt-in provider capture，不把外部 transcript 回放进模型上下文
tags: [adr, decision, observability, session, security]
related:
  - dev/spec/infra/trajectory-observability
  - dev/architecture/session-model
  - dev/spec/infra/persistence
  - dev/spec/infra/observability
  - dev/spec/security/redaction
adr_status: Accepted
adr_number: "0018"
decision_date: 2026-06-23
supersedes: null
superseded_by: null
---

# ADR-0018：Trajectory Observability 采用 daemon-owned read model 与 opt-in capture

- **状态**：Accepted
- **日期**：2026-06-23
- **决策者**：agent-nexus maintainers
- **相关 ADR**：ADR-0012、ADR-0014、ADR-0016

## 状态变更日志

- 2026-06-23：Accepted

## Context

Agent Nexus 现有会话模型以 daemon-owned RoutingSession 为中心，agent 原生 conversation id 只作为 opaque ref 保存。当前 transcript、usage、log 也已分属不同 owner：transcript 记录 agent event 流，usage 归属 limits/cost 计量，log 归属 observability。

Trajectory Observability 的目标不是再加一份普通日志，而是让 Nexus 能以统一读模型串起四类材料：

- Nexus 自己的 RoutingSession 与 AgentEvent transcript。
- 外部已有 Codex / Claude Code session 的发现、导入、resume 绑定。
- usage / log anchor，用于按 turn、trace、时间定位。
- 可选 provider/request-level observation，用于更细粒度调试。

P1 证据显示外部来源并不统一：

- Codex CLI / App JSONL 里有 `session_meta`、`event_msg`、`response_item`、`turn_context` 等 record 类型，不同 record 内又有 message、tool、usage、reasoning 等 payload。
- Claude Code JSONL 里有 `user`、`assistant`、`attachment`、`queue-operation`、`last-prompt` 等 record 类型，content 可能是字符串或 blocks。
- Claude Code 与 Codex 都有 native resume 能力，但 native id 的含义和可用性由对应 agent package 拥有。
- claude-tap 证明本机代理和 transcript import 都可行，但它是独立观测工具，不是 Nexus 的会话状态 owner；其机制只能作为参考，不能照搬为 Nexus 默认数据路径。

因此需要先决定 trajectory 的 owner、外部 transcript 的边界、provider capture 是否默认开启，以及这些数据是否可进入模型上下文。

决策驱动：

- **会话边界**：RoutingSession 仍由 daemon 拥有，agent native session 不进入 SessionKey。
- **安全边界**：外部 transcript 与 provider payload 可能含密钥、PII、工具结果和 prompt，必须 fail-closed。
- **可验证性**：不同来源的 schema 会漂移，导入必须带 source metadata、confidence 与错误状态。
- **可恢复性**：resume 必须优先保存 opaque native ref，而不是靠回放历史文本模拟恢复。
- **最小实现**：先定义 read model 和 adapters，后续 UI、viewer、proxy 实现都依附它。

## Options

### A. 只依赖现有 logs / transcripts

把所有观测需求折叠到现有 log 与 transcript 文件中，外部 session 只保留路径或文本摘录。

优点：

- 改动最少。
- 不引入新存储表或 adapter 概念。

缺点：

- logs 和 transcripts 的读者、保留策略、安全边界不同，继续混用会破坏现有 SSOT。
- 无法表达外部来源、导入状态、confidence、native resume eligibility。
- provider/request 级观测只能塞进日志，难以施加独立 retention、size limit 与 redaction 策略。

### B. Daemon-owned read model + source adapters + opt-in provider capture

新增 daemon-owned trajectory read model。外部来源通过显式 source adapter 发现和导入，导入结果成为 Nexus 管理的 trajectory segment。provider/request-level capture 作为可选 source，默认关闭，开启后也只写入受限的 observation 记录。

优点：

- 保持 RoutingSession 为会话聚合 owner，agent native id 仍 opaque。
- 外部 schema 漂移被隔离在 source adapter 内。
- 可以给导入、provider observation、Nexus 原生 event 设置不同 confidence、retention 和 redaction 策略。
- resume 绑定可以只保存 native ref，不依赖 transcript 内容回放。

缺点：

- 需要新增 spec、存储、查询接口和合约测试。
- provider capture 的 backend/auth 可行性并不一致，必须有支持矩阵和 fail-closed 行为。

### C. 把外部 transcript 作为模型上下文，provider proxy 默认开启

导入外部 transcript 后直接回放给 agent，尽可能模拟原对话。为了完整观测，默认通过 proxy 捕获 provider 请求和响应。

优点：

- 用户表面上会看到更像“记住过去”的体验。
- provider 观测覆盖率更高。

缺点：

- 外部 transcript 进入 prompt 会扩大 prompt injection 和 secret leakage 面。
- 回放文本不等于 native resume，可能制造虚假上下文和错误归因。
- 默认 proxy 会改变认证、TLS、网络失败形态，风险过高。
- 与现有 session-model 对 opaque native ref 的边界相冲突。

## Decision

选择 **B. Daemon-owned read model + source adapters + opt-in provider capture**。

具体约束：

- Trajectory read model 由 daemon 拥有，字段契约见 [`../spec/infra/trajectory-observability.md`](../spec/infra/trajectory-observability.md)。
- 外部 transcript 可被发现、注册、导入、链接，但导入内容默认不进入模型上下文。
- resume 外部 session 时，daemon 只保存 source metadata、confidence 与 opaque native ref，并把 native ref 交给对应 agent runtime 的 resume 参数。
- provider/request-level observation 默认关闭，必须由 daemon config 显式开启；未知 backend/auth mode 不捕获。
- provider capture 与外部导入都必须经过 redaction、size limit、retention 和 error-state 约束。

## Consequences

正向后果：

- 后续 UI、CLI、debug report 可以从同一 read model 查询 trajectory，而不是拼多个日志文件。
- 外部 session import 与 native resume 分离，避免“导入了文本就等于可恢复”的错误假设。
- provider-call observation 可以渐进支持，不阻塞外部 import/resume 的主路径。

负向后果：

- P3 以后需要先写迁移和 Store 合约测试，再实现 UI 或导入命令。
- provider capture 不能承诺全 backend 全认证模式可用；实现必须把 unsupported 作为正常状态暴露。
- 早期 read model 可能比终端用户期望更偏审计，不直接提供完整 viewer 体验。

需要后续跟进的事：

- 新增 infra spec，定义 config、source adapter、trajectory segment、import state、provider observation 与查询契约。
- 更新 persistence、observability、redaction、session-model 与 config-routing 的链接性契约。
- P3 以 failing contract tests 开始，先覆盖 unsupported / fail-closed / no replay 三类行为。

## Out of scope

- 不定义前端 viewer 交互。
- 不定义 provider proxy 的具体 TLS/CA 注入实现。
- 不改变 Codex / Claude Code agent package 对 native session id 的 owner 边界。
- 不把 transcript import 做成长期记忆或自动 prompt 注入。

## 参考

- P1 证据：`/home/node/.goal/agent-nexus-trajectory-observability/drafts/p1-evidence.md`
- claude-tap public README: <https://github.com/liaohch3/claude-tap>
