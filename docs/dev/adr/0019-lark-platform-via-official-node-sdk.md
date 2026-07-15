---
title: ADR-0019：飞书平台通过官方 Node SDK 接入
type: adr
status: active
summary: 选择官方 Node SDK 的 Client、WSClient 与 EventDispatcher 直连飞书，lark-cli 仅作为生命周期与错误状态参考
tags: [adr, decision, platform-adapter]
related:
  - dev/adr/0001-im-platform-discord
  - dev/adr/0003-deployment-local-desktop
  - dev/adr/0015-multi-platform-agent-config
  - dev/spec/platform-adapter
  - dev/spec/config-routing
  - dev/spec/infra/observability
  - dev/spec/security/secrets
adr_status: Proposed
adr_number: "0019"
decision_date: 2026-07-12
supersedes: null
superseded_by: null
---

# ADR-0019：飞书平台通过官方 Node SDK 接入

- **状态**：Proposed
- **日期**：2026-07-12
- **决策者**：senticx@foxmail.com
- **相关 ADR**：ADR-0001、ADR-0003、ADR-0015

## 状态变更日志

- 2026-07-10：Proposed，初稿评估 `larksuite/cli` 子进程方案
- 2026-07-12：按设计反馈改选官方 Node SDK；`lark-cli` 降为非运行时参考

## Context

agent-nexus 当前只有 Discord adapter，但实际工作场景需要在飞书私聊中驱动已有 agent。ADR-0001 已把新增企业
IM 平台留给后续 ADR；ADR-0015 已提供命名 platform、agent 与 binding，第二个平台应复用这条中立路由，而不是
新增旁路 daemon。

agent-nexus 仍采用 ADR-0003 的本机桌面部署。飞书接入需要低运维成本的出站连接，不能为了接收事件新增公网
webhook、证书与反向代理。首版还必须维持现有 auth、idempotency、queue 与 SessionKey 边界，平台层只负责协议翻译。

官方 `@larksuiteoapi/node-sdk` 1.70.0 已提供：

- `Client` 直接调用 `im.v1.message.create`；
- `WSClient` + `EventDispatcher` 接收 `im.message.receive_v1` 长连接事件；
- `idle / connecting / connected / reconnecting / failed` 状态快照；
- `onReady / onError / onReconnecting / onReconnected` 回调、handshake timeout 与 `close()`。

SDK 的 `start()` 在内部异步启动连接，并不等待 ready；adapter 必须把 `onReady` / `onError` 包成自己的启动 promise。
官方文档还要求长连接事件处理在 3 秒内完成，否则会触发重推；事件 callback 因而只能完成归一化和 daemon 投递，
不能等待 agent turn 或出站回复。

官方接收消息文档建议用 `message_id` 去重，但成熟生产实现曾记录同一 P2P 文本重投时 `message_id` 变化的案例
（[openclaw#46778](https://github.com/openclaw/openclaw/issues/46778)），并最终采用稳定精确重投身份修复
（[openclaw@9ed9d38](https://github.com/openclaw/openclaw/commit/9ed9d389e05dcdc9b164e9e8d548aa076b23d672)）。
本决策因此保留原始平台 `messageId`，同时允许 adapter 派生独立 `idempotencyKey`；字段与存储契约由
[`message-protocol.md`](../spec/message-protocol.md) 和 [`idempotency.md`](../spec/infra/idempotency.md) 单点定义。

`larksuite/cli` 对 ready、running、reconnecting、stopping、failed 等状态和结构化错误做了可借鉴的产品化表达，
但把 CLI 二进制、profile、stdout/stderr wire contract 引入运行时会增加安装、版本、子进程与第二套凭据边界。
它只作为状态机、错误分类和测试视角参考，不是 dependency、transport 或 protocol boundary。

首版目标仍是单用户、飞书 P2P、纯文本闭环。群聊、卡片、附件与飞书工作资源会扩大授权和数据外泄面，不能与
第二个平台 walking skeleton 一起进入。

## Options

### Option A：直接使用官方 Node SDK 的低层 Client / WSClient

- **是什么**：platform-lark 在进程内组合 `Client`、`WSClient` 与 `EventDispatcher`，自行映射到 `PlatformAdapter`。
- **优点**：官方类型与原始事件直接可用；无需外部二进制、profile 或 stdio 协议；与仓库 TypeScript runtime 一致；
  凭据复用 agent-nexus 现有 secrets owner。
- **缺点**：adapter 必须包装 SDK 异步 ready、终态失败、快速 ACK 与日志脱敏；SDK 升级仍需 fixture 合约。
- **主要风险**：SDK 的 lifecycle API 与 event type 随版本变化；以固定版本、port wrapper 和真实 fixture 缓解。

### Option B：使用官方 Node SDK 的高层 Channel 模块

- **是什么**：直接使用 SDK 推荐的 `createLarkChannel`，复用消息归一化、安全策略、outbound、streaming 与媒体能力。
- **优点**：对 conversational bot 开箱即用，后续富消息能力完整。
- **缺点**：Channel 自带 normalization、safety、streaming 与发送策略，会与 agent-nexus 已有 auth、redaction、
  idempotency、queue 和 `PlatformAdapter` owner 重叠。
- **主要风险**：同一事实出现两个 owner，后续难以证明授权、去重和 partial-send 只执行一次。

### Option C：以官方 `larksuite/cli` 作为进程外协议边界

- **是什么**：监督 CLI event consumer 子进程，并通过 CLI 命令发送回复。
- **优点**：ready / error / stop 状态清晰，凭据可由命名 profile 托管。
- **缺点**：增加外部安装、精确版本、子进程、stdio wire、profile 与进程环境隔离；消息发送还有固定 spawn 成本。
- **主要风险**：CLI 状态与 agent-nexus adapter 状态成为双层运行时，排障和升级面扩大。

### Option D：接收飞书 webhook

- **是什么**：daemon 暴露 HTTP endpoint 接收飞书事件，并用 SDK 出站回复。
- **优点**：平台常见部署形态。
- **缺点**：需要公网入口、TLS、challenge 校验与请求鉴权，改变本机桌面部署边界。
- **主要风险**：为了首个企业 IM adapter 引入新的网络攻击面与 host 运维依赖。

## Decision

选 **Option A：直接使用官方 Node SDK 的低层 Client / WSClient**。

决定性理由：在不引入外部 CLI 运行时的前提下复用官方长连接、token 与消息 API，同时保持 auth、idempotency、
queue、redaction 和 streaming 的唯一 owner 仍在 agent-nexus。`lark-cli` 的状态划分可作为设计输入，但不进入依赖图。

## Consequences

### 正向

- 飞书入站继续走出站 WebSocket，不改变 ADR-0003 的本机部署形态。
- platform-lark 与现有 TypeScript packages 使用同一 runtime，不增加可执行文件和子进程监督边界。
- adapter 直接接收 SDK typed event；事件归一化与敏感字段边界由
  [`platform-adapter.md`](../spec/platform-adapter.md) 单点定义，不再经过 CLI 扁平化。
- app secret 继续由 agent-nexus secrets owner 加载，不新增外部 profile provider。
- lark-cli 的 ready/reconnect/stop/error 状态仍可作为状态机设计输入。

### 负向

- platform-lark 增加精确依赖 `@larksuiteoapi/node-sdk@1.70.0`，后续升级会增加 lifecycle 与 wire 兼容成本；
  具体兼容契约由 [`platform-adapter.md`](../spec/platform-adapter.md) 定义。
- app secret 会在 platform-lark 进程内存中提供给官方 SDK，必须遵守现有 redaction 与 secret 生命周期。
- SDK `start()` 不等待 ready，adapter 必须额外包装启动与终态恢复；具体状态和超时由
  [`platform-adapter.md`](../spec/platform-adapter.md) 定义。
- SDK 内建 reconnect 可能按服务端配置耗尽，需要 agent-nexus 补充外层恢复边界。
- EventDispatcher callback 受平台 ACK 窗口约束，不能同步等待业务 turn。
- SDK 没有公开 replay cursor；重连窗口仍不承诺无损，重推重复由 daemon idempotency 过滤。

### 需要后续跟进的事

- 配置字段与校验由 [`config-routing.md`](../spec/config-routing.md) 单点定义；adapter lifecycle、wire 与验证契约由
  [`platform-adapter.md`](../spec/platform-adapter.md) 单点定义。
- 凭据与日志边界分别见 [`secrets.md`](../spec/security/secrets.md) 和
  [`observability.md`](../spec/infra/observability.md)。
- 若 SDK low-level lifecycle API 被移除，再比较低层 SDK wrapper 与高层 Channel；不静默切换 owner。

## Out of scope

- 不引入 `lark-cli` binary、profile、stdio protocol 或自动安装流程。
- 不采用 SDK Channel 模块拥有 auth、idempotency、streaming 或 redaction。
- 不新增飞书群聊、卡片、附件、reaction、typing、thread 或 native command 注册。
- 不让 agent 调用飞书文档、日历、任务等工作 API。
- 不自动创建飞书应用或自动申请 scope。
- 不取代 ADR-0001；Discord 继续是已有完整能力平台。

## Amendments

无。

## 参考

- 相关 issue：[#181](https://github.com/moesin-lab/agent-nexus/issues/181)
- 外部参考：[官方 Node SDK 1.70.0 README](https://github.com/larksuite/node-sdk/blob/95dbd3e949ab18491e6dbf3fe7da202ed3fce3bb/README.md)
- 外部参考：[WSClient lifecycle 实现](https://github.com/larksuite/node-sdk/blob/95dbd3e949ab18491e6dbf3fe7da202ed3fce3bb/ws-client/index.ts)
- 外部参考：[WSClient state types](https://github.com/larksuite/node-sdk/blob/95dbd3e949ab18491e6dbf3fe7da202ed3fce3bb/ws-client/types.ts)
- 外部参考：[消息事件类型](https://github.com/larksuite/node-sdk/blob/95dbd3e949ab18491e6dbf3fe7da202ed3fce3bb/code-gen/events-template.ts)
- 设计参考：[lark-cli event 状态与错误契约](https://github.com/larksuite/cli/blob/main/skills/lark-event/SKILL.md)
