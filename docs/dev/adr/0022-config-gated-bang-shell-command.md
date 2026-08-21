---
title: ADR-0022：用显式配置开放感叹号 Shell 指令
type: adr
status: active
summary: 将消息前缀 ! 作为 daemon-owned 的任意 Shell 执行入口，默认关闭并明确其远程等价本机执行风险
tags: [adr, decision, security, shell, command]
related:
  - dev/adr/0003-deployment-local-desktop
  - dev/spec/config-routing
  - dev/spec/message-flow
  - dev/spec/security/auth
  - dev/spec/security/tool-boundary
adr_status: Proposed
adr_number: "0022"
decision_date: 2026-07-27
supersedes: null
superseded_by: null
---

# ADR-0022：用显式配置开放感叹号 Shell 指令

- **状态**：Proposed
- **日期**：2026-07-27
- **决策者**：项目 owner
- **相关 ADR**：ADR-0003、ADR-0012、ADR-0014

## 状态变更日志

- 2026-07-27：Proposed

## Context

agent-nexus 的用户有时需要在当前项目目录直接运行短命令，而不希望先让 agent 解释并调用工具。聊天消息前缀
`!` 是常见的直接执行约定，但它会把已授权 IM 身份提升为远程 Shell 操作者，风险高于普通 prompt。

现有 Claude Code `Bash` 工具受 backend permission control 约束，Codex 受 sandbox 约束；直接 `!` 指令不经过
任一 agent backend，因此不能借用这些工具边界，也不能被描述成 sandboxed agent 工具。其实际权限等同于
agent-nexus 进程的 OS 用户。

平台 allowlist 已经是消息进入 daemon 的身份门禁。项目 owner 明确选择不再增加独立 Shell 用户白名单，因为
同一实例中的 agent 与配置编辑入口可以修改配置文件；额外列表会增加一种不能形成独立安全边界的配置表象。

直接命令仍需遵守既有 routing、auth、幂等、session 串行队列、workingDir 和出站脱敏路径。固定超时与输出上限
用于限制误操作的资源占用，但不构成文件系统、网络或子进程权限隔离。

## Options

### Option A：显式配置开启 daemon-owned 的完整 Shell

- **是什么**：默认关闭；开启后，已通过平台 allowlist 的消息以 `!` 开头时由 daemon 在当前 workingDir 用
  `/bin/sh -lc` 执行。
- **优点**：支持管道、重定向和环境展开；复用跨平台 adapter 的路由、队列、脱敏与回复能力。
- **缺点**：允许任意本机命令；不受 agent backend 的工具白名单或 sandbox 保护。
- **主要风险**：IM 账号失陷、prompt/配置被恶意修改或误输入都可能造成主机级破坏。

### Option B：只允许无 Shell 语法的程序与参数

- **是什么**：解析首个 token 为程序，其余为参数，禁止管道、重定向和 Shell 展开。
- **优点**：减少 Shell 语法注入面，子进程边界更直接。
- **缺点**：不符合用户对“终端指令”的完整预期；自行实现可靠 quoting 仍容易产生歧义。
- **主要风险**：用户可能误以为命令与本地终端等价，实际行为不同。

### Option C：把 `!` 转成 agent prompt

- **是什么**：要求 agent backend 决定是否调用 Bash 等工具，不提供 daemon 直执行。
- **优点**：继续复用 backend 工具审批和 sandbox。
- **缺点**：不是直接执行，增加模型延迟和不确定性；无法保证命令原样运行。
- **主要风险**：UI 看似直接命令，实际受模型解释影响，容易误导。

## Decision

选择 Option A：以默认关闭、配置显式开启的 daemon-owned 完整 Shell 执行 `!` 指令。

## Consequences

### 正向

- Discord 与飞书共享同一条直接命令语义，不在 adapter 重复实现。
- 命令按 session 队列串行，workingDir 与当前会话一致，输出继续经过脱敏和平台发送边界。
- 缺省配置不扩大攻击面；不开启时 `!` 保持普通 prompt 兼容行为。

### 负向

- 开启后，所有通过当前 platform allowlist 的用户都获得 agent-nexus OS 用户权限下的任意 Shell 能力。
- 该入口绕过 Claude Code 工具白名单和 Codex sandbox，不能提供 agent 工具隔离承诺。
- 30 秒超时与 32 KiB 输出上限只能限制单次资源占用，不能阻止命令启动持久后台进程或访问网络与敏感文件。

### 需要后续跟进的事

- 若出现多人共享部署需求，必须重新评估独立 owner 身份、部署隔离或 OS sandbox，而不是只叠加可修改的配置列表。
- 若需要长任务，应设计可审计的 job 模型；不提高本入口的固定超时和输出上限。

## Out of scope

- 不提供聊天命令或 settings 按钮来开启、关闭此能力。
- 不增加命令 allowlist、二次确认、交互式 TTY、后台任务管理或 stdin。
- 不声称该入口继承 agent backend 的 permission control、sandbox 或 allowed tools。
- 不改变 platform allowlist 的身份语义。

## Amendments

- 无。

## 参考

- 相关 spec：[`../spec/security/tool-boundary.md`](../spec/security/tool-boundary.md)
- 相关 spec：[`../spec/config-routing.md`](../spec/config-routing.md)
- 相关 spec：[`../spec/message-flow.md`](../spec/message-flow.md)
