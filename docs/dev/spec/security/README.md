---
title: Spec：Security（索引与威胁模型）
type: spec
status: active
summary: 安全分区总索引 + 威胁模型 + 跨分区综合缓解（prompt injection）+ 启动自检清单
tags: [spec, security]
related:
  - dev/spec/infra/errors
  - dev/spec/security/auth
  - dev/spec/security/tool-boundary
  - dev/spec/security/secrets
  - dev/spec/security/redaction
  - dev/spec/infra/idempotency
  - dev/spec/infra/persistence
  - dev/spec/infra/observability
  - dev/standards/errors
---

# Spec：Security（索引与威胁模型）

本项目安全模型基于 ADR-0003（本机桌面）：**唯一可信主体是本机用户**。agent-nexus 代表本机用户行事；Discord 那头的"用户"只是远程遥控者，需要通过 allowlist 与权限边界约束。

本文件是**安全分区的索引**与**威胁模型顶层伞**。具体子分区：

| 主题 | Spec | 对应模块 |
|---|---|---|
| 谁能触发 agent | [`auth.md`](auth.md) | `daemon.auth` |
| 能做什么操作 | [`tool-boundary.md`](tool-boundary.md) | `daemon.toolguard` |
| 密钥怎么放 | [`secrets.md`](secrets.md) | `daemon.secrets` |
| 出口脱敏 | [`redaction.md`](redaction.md) | `daemon.redact` |
| 去重防重放 | [`idempotency.md`](../infra/idempotency.md) | `daemon.idempotency` |

## 威胁模型

### 核心威胁（Discord 账号 ≈ 远程本机 shell）

**allowlisted 用户的 Discord 账号被他人控制**是本项目最核心的威胁。被盗账号**不只**是"能发消息"——它在我们的架构下等价于**远程读写本机代码、触发工具、消耗订阅配额**。

这不是"可以防御的风险之一"，而是**基本假设**：allowlist 是身份映射，不是强认证；Discord 的登录状态不等于本机用户的在场。

**缓解（默认行为，分布在各子 spec）**：

- MVP 默认不在公开 channel 持续对话；触发 bot 后自动转私有 thread 或 DM（[`auth.md`](auth.md) §"公开 channel 默认转私域"）
- 默认工具集只读，`Edit / Write` 默认启用但敏感操作可二次确认，`Bash` 默认禁用（[`tool-boundary.md`](tool-boundary.md)）
- 不在公开 channel 回显敏感内容（[`redaction.md`](redaction.md)）

### 其他威胁

1. **未授权 Discord 用户（边界穿越）**：bot 被邀请到非预期 guild，或用户在错误 channel 触发；allowlist 必须基于 `(guildId, channelId, userId, roleIds)` 四元组（[`auth.md`](auth.md)）
2. **CC CLI 越权**：CC 能读写本机文件、执行工具；必须限制工作目录与工具集（[`tool-boundary.md`](tool-boundary.md)）
3. **Prompt injection**：用户消息中嵌入"忽略上面的指令"等试图改变 agent 行为的内容；**非发起者投毒尤其危险**（见本文 §Prompt Injection 综合缓解）
4. **附件投毒**：恶意上传的文件（超大、压缩炸弹、带 injection 文本的文档、SSRF 链路的 URL）
5. **密钥泄露**：通过日志、IM 输出、transcript 意外回显 token / API key（[`secrets.md`](secrets.md) + [`redaction.md`](redaction.md)）
6. **IM 事件重放** / **请求刷表**：Discord gateway at-least-once；攻击者用伪造 messageId 刷幂等表（[`idempotency.md`](../infra/idempotency.md)）

### 不在范围

- 物理访问本机（本机被攻破意味着已经失守）
- OS 层面的恶意进程（由 OS 安全机制负责）
- Anthropic / Discord 官方服务的安全（信任链上游）

## Prompt Injection 综合缓解（跨分区）

完全防御不现实（LLM 本质就是听用户说）。缓解策略由多个子 spec 合力提供：

| 缓解 | 生效 spec |
|---|---|
| 工具白名单是硬边界：哪怕 LLM 被说服，也只能调白名单内的工具 | [`tool-boundary.md`](tool-boundary.md) |
| 工作目录限制：文件操作限在 `workingDir` | [`tool-boundary.md`](tool-boundary.md) |
| `shared_channel_mode` 不存在：非发起者内容根本不进 context | [`auth.md`](auth.md) |
| shell 默认禁用：绕过白名单的破坏面有限 | [`tool-boundary.md`](tool-boundary.md) |
| 回显脱敏：LLM 想让 bot "复读密钥"过不了 redactor | [`redaction.md`](redaction.md) |
| 审计 transcript：所有工具调用有 `tool_call_finished` 事件，事后可查 | [`observability.md`](../infra/observability.md) |

**未来（输入层 policy guard）**：MVP 只做输出层 redactor；输入侧的 policy guard 待实现阶段积累数据后再设计，见 [`redaction.md`](redaction.md) §"两层视角"。

## 审计与追溯

- 所有 `auth_denied`、`tool_call_finished`、`session_state_changed`、`idempotency_hit` 事件落日志（字段见对应 spec）
- 保留期：至少 30 天（与 logs 滚动一致）

## 启动自检（跨分区 fail-closed 清单）

进程启动时必须通过的检查：

1. **密钥**：所有必需密钥能加载，来源一致（[`secrets.md`](secrets.md) §启动自检）
2. **工作目录**：`workingDir` 存在且可读写
3. **Allowlist**：至少一个字段非空；格式合法（[`auth.md`](auth.md) §Allowlist §约束）
4. **SQLite schema version**：兼容（[`persistence.md`](../infra/persistence.md) §迁移）
5. **Hook / Redactor 基线测试**：内置的 red-team fixture 通过（[`redaction.md`](redaction.md) §合约测试）
6. **CC CLI probe**：CompatibilityProbe 通过（[`claude-code-cli-contract.md`](../agent-backends/claude-code-cli.md) §兼容性自检）

任何一项失败 → 退出码非零 + 清晰错误消息（不包含密钥值）。

## Out of spec

- 加密存储 SQLite 文件（本机 `0600` 权限够用）
- 多因素认证（与本机桌面形态不匹配）
- 审计报表生成（ops 阶段或独立 ADR）
- 具体子 spec 的细节——见各子 spec 的 Out of spec 段
