---
title: Spec：Security（权限、脱敏、密钥）
type: spec
status: active
summary: 威胁模型、身份 allowlist、工具白名单、密钥层级、Redactor 脱敏规则与 prompt injection 缓解
tags: [spec, security, auth, allowlist, redaction, secrets]
related:
  - dev/adr/0003-deployment-local-desktop
  - dev/spec/persistence
  - dev/spec/observability
  - dev/standards/errors
contracts:
  - Redactor
---

# Spec：Security（权限、脱敏、密钥）

本项目安全模型基于 ADR-0003（本机桌面）：**唯一可信主体是本机用户**。agent-nexus 代表本机用户行事；Discord 那头的"用户"只是远程遥控者，需要通过 allowlist 与权限边界约束。

## 威胁模型

### 核心威胁（Discord 账号 ≈ 远程本机 shell）

**allowlisted 用户的 Discord 账号被他人控制**是本项目最核心的威胁。被盗账号**不只**是"能发消息"——它在我们的架构下等价于**远程读写本机代码、触发工具、消耗订阅配额**。

这不是"可以防御的风险之一"，而是**基本假设**：allowlist 是身份映射，不是强认证；Discord 的登录状态不等于本机用户的在场。

**缓解（默认行为）**：

- MVP 默认不在公开 channel 持续对话；触发 bot 后自动转私有 thread 或 DM
- 默认工具集只读（`Read / Grep / Glob`），`Edit / Write` 默认禁用；用户需显式开启
- 写操作可配置二次确认（per-session 或 per-tool）
- 危险工具（`Bash`、MCP shell 类）启用时在首条欢迎消息显式标注
- 不在公开 channel 回显敏感内容（见 `redaction` + `publicChannelMode`）

### 其他威胁

1. **未授权 Discord 用户（边界穿越）**：bot 被邀请到非预期 guild，或用户在错误 channel 触发；allowlist 必须基于 `(guildId, channelId, userId, roleIds)` 四元组，不是只看 user
2. **CC CLI 越权**：CC 能读写本机文件、执行工具；必须限制工作目录与工具集
3. **Prompt injection**：用户消息中嵌入"忽略上面的指令"等试图改变 agent 行为的内容；**非发起者投毒尤其危险**，见下文砍掉 `shared_channel_mode` 的理由
4. **附件投毒**：恶意上传的文件（超大、压缩炸弹、带 injection 文本的文档、SSRF 链路的 URL）
5. **密钥泄露**：通过日志、IM 输出、transcript 意外回显 token / API key

### 不在范围

- 物理访问本机（本机被攻破意味着已经失守）
- OS 层面的恶意进程（由 OS 安全机制负责）
- Anthropic/Discord 官方服务的安全（信任链上游）

## 身份与授权

### Allowlist

权限判断基于**四元组** `(guildId, channelId, userId, roleIds)`，不是只看 `userId`。

配置项 `config.security.allowlist`：

| 字段 | 类型 | 说明 |
|---|---|---|
| `userIds` | string[] | 允许的 Discord user id |
| `roleIds` | string[] | 允许的 Discord role id（guild 内） |
| `allowedGuildIds` | string[] | 允许的 guild id（空列表 = 拒绝所有 guild） |
| `allowedChannelIds` | string[] | 允许的 channel / thread id（可选；留空则 guild 内任意 channel） |
| `allowDM` | bool | 是否允许 Discord DM 触发（默认 `true`） |
| `requireMentionOrSlash` | bool | 是否要求消息 @ bot 或走 slash command 才触发（默认 `true`；仅 DM 自动豁免） |

**约束**：

- **fail-closed**：任一字段空列表 = 拒绝所有（`userIds=[]` 和 `allowedGuildIds=[]` 都会让 bot 拒绝一切 guild 消息；DM 受 `allowDM` 控制）
- 启动时验证格式与至少一个字段非空，有错立即失败

### 权限检查位置

- 在 `core.auth` 模块，位于 `core.Engine.dispatch` **最前**（见 `architecture/overview.md` 数据流）
- 先过 auth，再执行 idempotency checkAndSet，再限流/预算（见 `spec/message-protocol.md` §幂等流程）
- 拒绝时：打 `auth_denied` 日志（字段含 guildId / channelId / userId / reason）+ 可选 DM 通知

### 会话绑定

一个 session 绑定 **一个** initiator user。其他用户发到同 channel 的消息 → **一律丢弃**，不进入 agent context、不记入 session transcript、不触发任何动作。

**MVP 不提供 `shared_channel_mode`**：曾考虑过"非发起者消息可作为 agent 可见 context"，但被识别为明显的 prompt injection 入口——攻击者无需触发 agent，只要把恶意文本塞进共享 channel，下一次 allowlisted 用户触发时就会中招。如果未来确有需要，必须：

- 先发独立 ADR 评审
- 非发起者内容必须打 `untrusted` 标，且默认不拼接进 agent prompt
- 明确记录这份上下文的来源和信任级别

### 公开 channel 默认转私域

为缓解核心威胁（账号被盗）与旁观泄露，默认行为：

- `config.platform.discord.publicChannelMode`，取值 `disabled | thread | public`，默认 `thread`
  - `disabled`：公开 channel 触发 → 直接拒绝并提示"请到 DM 或私有 thread"
  - `thread`：公开 channel 触发 → 创建 private thread（或 ephemeral ACK + thread）继续对话
  - `public`：允许在公开 channel 持续对话（不推荐，仅为调试 / 演示用）
- `ephemeral` 发送能力仅对 slash command 的 interaction response 有效，不适用于持续对话

## 工具白名单

### 规则

- CC CLI 可用工具集由 `SessionConfig.toolWhitelist` 控制
- 白名单来自配置：`config.security.toolWhitelist`
- 默认集（MVP 建议）：`Read, Grep, Glob, Edit, Write`
- **默认禁用**：`Bash`、任何 shell 执行类工具
- MCP server：单独配置 `config.security.mcpServers`，默认全禁

### 启用危险工具的要求

用户配置启用 `Bash` 或等效时：

- 启动日志里打 `warn` 提醒
- 在 IM 首条欢迎消息里显式标注
- 支持 per-session 关闭（slash command）

### 工作目录

- `SessionConfig.workingDir` 限定 CC 的默认工作目录
- 如果 CC 配置允许多个 allowed dirs，沿用 CC 的 allowlist（本项目不重复实现）

## 密钥管理

### 存储层级（优先顺序）

1. OS keychain（推荐）
2. 环境变量
3. 文件 `~/.agent-nexus/secrets/<name>`，权限 `0600`

### 约定

- 所有密钥名带明确前缀：`ANTHROPIC_API_KEY`, `DISCORD_BOT_TOKEN`
- 启动时加载，内存保留最短必要时间
- **绝不**写入：
  - SQLite（任何表、任何字段）
  - 任何日志文件
  - Transcript
  - IM 消息
  - 错误栈（栈里出现时拦截并替换为 `<redacted>`）

### 轮换

- Bot token 轮换：重启进程即生效
- 旧 token 应被用户在平台侧作废，本程序不主动做

## 脱敏层（Redactor）

`core.redact` 是输出到 IM 与日志前的最后一道过滤。

### 必过滤项

| 模式 | 替换为 |
|---|---|
| 绝对路径（`/Users/*/...`、`/home/*/...`、`C:\\Users\\*`） | `~/...`（保留相对部分） |
| 已知密钥前缀（`sk-ant-...`, `MTk...`（Discord token 特征）等） | `<redacted:secret>` |
| 含敏感字样的 env：形如 `*_KEY=...`, `*_TOKEN=...`, `*_SECRET=...` | `*_KEY=<redacted>` |
| 邮箱 | `<redacted:email>`（可配置） |
| IPv4/IPv6 地址（可配置） | `<redacted:ip>` |

### 配置

- `config.security.redaction.<key> = true|false` 控制各项开关
- 默认全开

### 实现要点

- **在最后一跳过滤**：日志 sink 的 formatter 里、adapter.send 的 OutboundMessage 包装里
- 测试有 red-team 用例：构造含各种敏感内容的输入，断言输出里没有原文
- 性能影响可接受（字符串扫描；用预编译正则）

## Prompt Injection 缓解

完全防御不现实（LLM 本质就是听用户说）。缓解策略：

1. **工具白名单是硬边界**：哪怕 LLM 被说服，也只能调白名单内的工具
2. **工作目录限制**：文件操作限在 `workingDir`
3. **shell 默认禁用**：绕过白名单的破坏面有限
4. **回显脱敏**：LLM 想让 bot "复读密钥" 也过不了 redactor
5. **审计 transcript**：所有工具调用有 `tool_call_finished` 事件，事后可查

## 审计与追溯

- 所有 `auth_denied`、`tool_call_finished`、`session_state_changed` 事件落日志
- 权限事件追加 `userId`、`sessionKey` 字段便于追溯
- 保留期：至少 30 天（与 logs 滚动一致）

## 启动自检

进程启动时必须通过的检查（fail-closed）：

1. 所有必需密钥能加载（否则退出并提示来源）
2. 工作目录存在且可读写
3. allowlist 非空（否则退出）
4. SQLite schema version 是否兼容

任何一项失败 → 退出码非零 + 清晰错误消息。

## 合约测试

- **Redactor 基线测试**：10+ 种典型敏感 pattern，断言脱敏后的输出不含原文
- **Allowlist 拒绝测试**：unknown user 的事件 → `auth_denied`
- **工具白名单测试**：CC 尝试调用非白名单工具 → `agent` 错误，不发送
- **启动自检测试**：缺密钥、缺目录等 fixture → 启动失败
- **日志红队**：构造含密钥的错误栈 → 日志里无原文

## 反模式

- 默认 open allowlist（fail-open）
- Token 写进 config.toml
- 脱敏只在部分出口做（必须全出口）
- 用 `if debug { log.debug(token) }`——debug 模式下也禁止
- 允许用户在 IM 里通过命令修改 allowlist（太危险，用户修配置文件重启）
- 为了方便让 Bash 在默认白名单里

## Out of spec

- 加密存储 SQLite 文件（本机 `0600` 权限够用）
- 多因素认证（与本机桌面形态不匹配）
- 审计报表生成（ops 阶段或独立 ADR）
