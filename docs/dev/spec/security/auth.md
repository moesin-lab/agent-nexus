---
title: Spec：Auth（身份与授权）
type: spec
status: active
summary: Discord 身份四元组 allowlist、会话绑定、公开 channel 默认转私域；权限检查位置与流程
tags: [spec, security, auth, allowlist]
related:
  - dev/spec/security/README
  - dev/spec/config-routing
  - dev/spec/infra/idempotency
  - dev/spec/security/tool-boundary
  - dev/architecture/overview
contracts:
  - AllowlistConfig
  - AuthDecision
---

# Spec：Auth（身份与授权）

定义 Discord 身份到 agent-nexus 的权限映射。与 `security.md`（威胁模型 + 安全索引）、`tool-boundary.md`（能做什么）、`redaction.md`（出口脱敏）、`secrets.md`（密钥）一起构成 security 分区。

对应模块：`daemon.auth`。

## Allowlist

权限判断基于**四元组** `(guildId, channelId, userId, roleIds)`，不是只看 `userId`。

legacy 单实例配置项为 `config.security.allowlist`。多平台多 Agent 配置启用后，allowlist 按
platform instance 下沉到 `platforms[].auth.allowlist`，字段语义不变；配置形态见
[`config-routing.md`](../config-routing.md) §PlatformAuthConfig。

| 字段 | 类型 | 说明 |
|---|---|---|
| `userIds` | string[] | 允许的 Discord user id |
| `roleIds` | string[] | 允许的 Discord role id（guild 内） |
| `allowedGuildIds` | string[] | 允许的 guild id（空列表 = 不限制 guild） |
| `allowedChannelIds` | string[] | 允许的 channel / thread id（可选；留空则 guild 内任意 channel） |
| `allowDM` | bool | 是否允许 Discord DM 触发（默认 `true`） |
| `requireMentionOrSlash` | bool | 是否要求消息 @ bot 或走 slash command 才触发（默认 `true`；仅 DM 自动豁免） |

**约束**：

- **fail-closed**：启动时至少需要一个 ID 列表非空；所有 ID 列表都缺省或为空时拒绝启动。
- 空的 `roleIds` / `allowedChannelIds` / `allowedGuildIds` 表示该维度不额外收窄；空的 `userIds` 只有在 `roleIds` 非空时才可用于角色授权。
- DM 事件没有 guild / role 上下文；即使 `allowDM=true`，DM 也必须命中 `userIds`。只靠 `roleIds` / `allowedGuildIds` / `allowedChannelIds` 的配置不得放行 DM。
- 启动时验证格式，有错立即失败。

## 权限检查位置

- 在 `daemon.auth` 模块。legacy 单实例流程中位于 `daemon.Engine.dispatch` 最前；多 platform instance 流程中位于 `daemon.router` 之后、idempotency 之前（见 [`../message-flow.md`](../message-flow.md)）
- `daemon.router` 只做 platform instance + binding 到 agent 的选择，不是授权层；未命中 / 多重命中时不进入 auth
- 唯一路由命中后，用命中的 `platforms[].auth.allowlist` 做 auth；auth 通过后，再执行 idempotency checkAndSet，再限流/预算（见 [`idempotency.md`](../infra/idempotency.md) §流程）
- 拒绝时：打 `auth_denied` 日志（字段含 `guildId` / `channelId` / `userId` / `reason`）+ 可选 DM 通知

runtime 执行的 allowlist 维度：

- `userIds` 与 `roleIds` 是身份 allowlist；任一命中即可通过身份检查。
- `allowedGuildIds` 非空时，guild 消息必须来自其中一个 guild；DM 不走 guild 匹配。
- `allowedChannelIds` 非空时，消息 channel/thread 必须命中。
- `allowDM=false` 时，缺少 `guildId` 的 DM 事件拒绝；`allowDM=true` 时，DM 仍必须命中 `userIds`，role 授权不适用于 DM。
- `requireMentionOrSlash` 由 Discord adapter 的 trigger 策略控制，不由 router 判断。

## 会话绑定

一个 session 绑定 **一个** initiator user。其他用户发到同 channel 的消息 → **一律丢弃**，不进入 agent context、不记入 session transcript、不触发任何动作。

MVP 不提供 `shared_channel_mode`。安全依据见 [`README.md` §威胁模型](README.md#威胁模型)（非发起者文本是 prompt injection 入口）；如果未来确有需要，必须：

- 先发独立 ADR 评审
- 非发起者内容必须打 `untrusted` 标，且默认不拼接进 agent prompt
- 明确记录这份上下文的来源和信任级别

## 公开 channel 默认转私域

为缓解核心威胁（见 `security.md` §"核心威胁"）与旁观泄露，默认行为：

- legacy 单实例配置项为 `config.platform.discord.publicChannelMode`；多平台配置项为
  `platforms[].publicChannelMode`
- 取值 `disabled | thread | public`，默认 `thread`
  - `disabled`：公开 channel 触发 → 直接拒绝并提示"请到 DM 或私有 thread"
  - `thread`：公开 channel 触发 → 创建 private thread（或 ephemeral ACK + thread）继续对话
  - `public`：允许在公开 channel 持续对话（不推荐，仅为调试 / 演示用）
- `ephemeral` 发送能力仅对 slash command 的 interaction response 有效，不适用于持续对话

## 合约测试

- **Allowlist 拒绝**：不在四元组白名单内的事件 → `auth_denied`，不进入 idempotency 表
- **四元组组合**：分别构造 userId 缺失、guildId 不在 allow、channelId 不在 allow、DM 但 allowDM=false 等场景 → 均拒绝
- **publicChannelMode=thread**：公开 channel 触发 → 创建 thread 后在 thread 内继续；原 channel 仅 ephemeral ACK
- **`shared_channel_mode` 不存在**：配置里出现该字段 → 启动失败

## 反模式

- 默认 open allowlist（fail-open）
- 只看 `userId` 而忽略 `guildId / channelId`
- 允许用户在 IM 里通过命令修改 allowlist（太危险，用户修配置文件重启）
- 把 `auth_denied` 事件写进 idempotency 表（上游攻击者可刷表）

## Out of spec

- 多因素认证（与本机桌面形态不匹配）
- OAuth 级权限细分（MVP 用 allowlist 够）
- `auth_denied` 的 DM 通知模板（产品层）
