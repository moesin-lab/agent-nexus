---
title: ADR-0019：飞书平台通过官方 CLI 接入
type: adr
status: active
summary: 选择 larksuite/cli 作为飞书私聊平台的进程外协议边界，复用其 WebSocket 事件与 IM 命令契约
tags: [adr, decision, platform-adapter]
related:
  - dev/adr/0001-im-platform-discord
  - dev/adr/0003-deployment-local-desktop
  - dev/adr/0015-multi-platform-agent-config
  - dev/spec/platform-adapter
  - dev/spec/config-routing
  - dev/spec/security/secrets
adr_status: Proposed
adr_number: "0019"
decision_date: 2026-07-10
supersedes: null
superseded_by: null
---

# ADR-0019：飞书平台通过官方 CLI 接入

- **状态**：Proposed
- **日期**：2026-07-10
- **决策者**：senticx@foxmail.com
- **相关 ADR**：ADR-0001、ADR-0003、ADR-0015

## 状态变更日志

- 2026-07-10：Proposed

## Context

agent-nexus 当前只有 Discord adapter，但实际工作场景需要在飞书私聊中驱动已有 agent。ADR-0001 已把新增企业 IM 平台留给后续 ADR；ADR-0015 已提供命名 platform、agent 与 binding，第二个平台应复用这条中立路由，而不是新增旁路 daemon。

agent-nexus 仍采用 ADR-0003 的本机桌面部署。飞书接入需要低运维成本的出站连接，不能为了接收事件新增公网 webhook、证书与反向代理。首版还必须维持现有 auth、idempotency、queue 与 SessionKey 边界，平台层只负责协议翻译。

官方 `larksuite/cli` 从 1.0 起提供 bot 身份的 WebSocket 事件消费。`event consume` 用 stdout NDJSON 输出事件，在 stderr 提供固定 ready marker、结构化错误与退出原因，并支持 stdin EOF / SIGTERM 优雅退出；raw API 命令支持从 stdin 接收请求 body，并提供结构化成功与错误 envelope。这些是可由 adapter 监督的稳定子进程契约。

首版目标是单用户、飞书 P2P、纯文本闭环。群聊、卡片、附件与飞书工作资源会扩大授权和数据外泄面，不能与第二个平台 walking skeleton 一起进入。

## Options

### Option A：以官方 `larksuite/cli` 作为进程外协议边界

- **是什么**：platform-lark 直接监督官方 CLI 的事件子进程，并用 CLI IM 命令发送回复。
- **优点**：复用官方 WebSocket、认证 profile、ready marker、结构化输出与错误契约；符合本机桌面部署；上游 CLI 升级与崩溃隔离在 adapter 子进程边界。
- **缺点**：增加外部二进制的安装、版本兼容和子进程生命周期；事件是 CLI 处理后的扁平形状，不是原始 OpenAPI envelope。
- **主要风险**：上游快速迭代导致 wire contract 漂移；用固定兼容版本和合约 fixture 缓解。

### Option B：在 platform-lark 内直接使用官方 Node SDK

- **是什么**：adapter 进程内创建 SDK WebSocket client，并直接调用 IM API。
- **优点**：单进程、类型化 API、无需解析 stdout / stderr；可直接访问原始事件字段，并复用 agent-nexus 现有 secrets 模型。
- **缺点**：需要在 adapter 内管理 SDK client 生命周期与错误归类，并自行定义 ready / stop 的本项目契约。
- **主要风险**：需要直接维护飞书 SDK、token 获取与重连行为的版本兼容。

### Option C：接收飞书 webhook

- **是什么**：daemon 暴露 HTTP endpoint 接收飞书事件，并用 SDK 或 REST 出站回复。
- **优点**：平台常见部署形态，事件由飞书主动投递。
- **缺点**：需要公网入口、TLS、challenge 校验与请求鉴权，改变本机桌面部署边界。
- **主要风险**：为了首个企业 IM adapter 引入新的网络攻击面与 host 运维依赖。

## Decision

选 **Option A：以官方 `larksuite/cli` 作为进程外协议边界**。

决定性理由：接受外部凭据托管与断线丢失窗口，换取复用官方已经为 agent 子进程定义的 ready、事件和错误契约，不在 adapter 内自有 token 刷新与重连状态机。

## Consequences

### 正向

- 飞书入站继续走出站 WebSocket，不改变 ADR-0003 的本机部署形态。
- adapter 只消费稳定 NDJSON / error envelope，daemon 继续只接触 `NormalizedEvent` 与 `PlatformAdapter`。
- bot app 凭据由官方 CLI 的命名 profile 托管，不进入 agent-nexus config、argv、日志或 transcript；其存储介质与权限约束由 secrets spec 核实并记录。
- 第二个平台会反向验证现有 platform seam，并移除 daemon/CLI 对 Discord 单实现的硬编码。

### 负向

- 运行环境必须单独安装兼容的 `lark-cli`，并在启动前完成 app profile 初始化与最小 bot scope 配置。
- platform-lark 必须监督 ready marker、stdout NDJSON、stderr error envelope、异常退出与优雅停止。
- CLI 已预处理消息内容；adapter 不能假设它等同飞书原始事件，版本升级必须重跑 fixture 合约。
- `lark-cli` profile 是 agent-nexus secrets provider 之外的运行态依赖，启动自检与错误信息必须明确区分两者。
- 官方 CLI 保留 `event_id`，但没有公开事件 resume / replay cursor 契约；首版不承诺子进程断线窗口无损，重连期间可能丢失事件。
- 消息正文跨进程传递时不得进入 argv / process list；下游 spec 必须选择 stdin 等非 argv 数据通道。
- 每次出站回复需要启动短生命周期 CLI 子进程，增加固定延迟与进程调度开销。

### 需要后续跟进的事

- 修订 `security/secrets.md` 的存储与启动自检模型，显式容纳由平台外部 CLI profile 托管凭据的形态。
- 修订 `platform-adapter.md` 的重连语义：只有上游支持 resume 时才承诺断线无损；不支持时必须记录可观测的丢失窗口。
- 修订 `platform-adapter.md` 的 `rawPayload` 语义，区分平台原始 envelope 与上游 adapter dependency 预处理后的 wire payload。
- 首版固定到经 fixture 验证的兼容版本，具体版本号由 spec / 实现记录；fixture 必须钉住 `event_id`、消息字段与成功/错误 envelope，升级前先更新并验证。
- 若上游移除稳定 ready / NDJSON / error contract，重新比较 Option A 与 Option B，不做静默兼容。
- 群聊或工作资源能力需要重新 surface 授权、会话与数据可见性边界后再立项。

## Out of scope

- 不决定具体配置字段、argv、事件字段映射与能力声明；这些属于 spec。
- 不新增飞书群聊、卡片、附件、reaction、typing、thread 或命令注册。
- 不让 agent 调用飞书文档、日历、任务等工作 API。
- 不自动安装、自动升级或自动创建飞书应用。
- 不取代 ADR-0001；Discord 继续是已有完整能力平台。

## Amendments

无。

## 参考

- 相关 issue：[#181](https://github.com/moesin-lab/agent-nexus/issues/181)
- 外部参考：[larksuite/cli README](https://github.com/larksuite/cli/blob/main/README.md)
- 外部参考：[lark-event 子进程契约](https://github.com/larksuite/cli/blob/main/skills/lark-event/SKILL.md)
- 外部参考：[飞书消息事件扁平输出字段](https://github.com/larksuite/cli/blob/main/events/im/message_receive.go)
- 外部参考：[lark-cli raw API 实现](https://github.com/larksuite/cli/blob/main/cmd/api/api.go)
- 外部参考：[lark-im 消息发送契约](https://github.com/larksuite/cli/blob/main/skills/lark-im/references/lark-im-messages-send.md)
