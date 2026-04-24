---
title: ADR-0002：Agent 后端选型——Claude Code CLI
type: adr
status: active
summary: 选择 Claude Code CLI 作为 agent 后端，通过子进程 + stdio 驱动；直接复用用户现有 CC 能力
tags: [adr, decision, cc-cli, claude-code, agent-runtime]
related:
  - dev/adr/0001-im-platform-discord
  - dev/adr/0003-deployment-local-desktop
  - dev/spec/agent-runtime
adr_status: Accepted
adr_number: "0002"
decision_date: 2026-04-22
supersedes: null
superseded_by: null
---

# ADR-0002：Agent 后端选型——Claude Code CLI

- **状态**：Accepted
- **日期**：2026-04-22
- **决策者**：senticx@foxmail.com
- **相关 ADR**：ADR-0001、ADR-0003

## 状态变更日志

- 2026-04-22：Proposed
- 2026-04-22：Accepted

## Context

agent-nexus 的定位是"把一个 agent 接到 IM"。选 agent 后端决定：

- 我们能给用户什么能力（编码/通用对话/工具使用）
- 如何启动、保持、销毁 agent 进程
- 工具权限边界与安全模型
- 与 IM 消息流的集成方式（stdio / SDK / HTTP）
- 升级节奏（跟随上游还是独立版本）

项目发起人已经在日常使用 Claude Code（CC），希望 IM 里直接驱动的就是同一个 CC 实例——同一套 session、同一套工具集、同一套配置。这是比"随便选一个 agent"更强的约束。

## Options

### Option A：Claude Code CLI（子进程 + stdio）

- **是什么**：本机已安装的 CC CLI，通过子进程 + stdio 驱动
- **优点**：
  - 直接复用 CC 现有的会话、工具、hooks、skills、MCP server
  - 升级跟随官方，无需我们自己维护 agent 代码
  - 本机执行，权限模型清晰（用户本机即边界）
  - 与"本机桌面"形态（ADR-0003）高度一致
- **缺点**：
  - stdio 是黑盒接口，协议不稳定（CC 升级可能改输出格式）
  - 子进程生命周期管理复杂（中断、崩溃恢复）
  - 输出解析脆弱（需要按 CC 输出格式做 parser）
- **主要风险**：CC 输出格式 breaking change 会打断集成

### Option B：Claude API + 自建工具编排

- **是什么**：直接调用 Anthropic API，工具集由我们实现
- **优点**：接口稳定、语义可控、多租户友好
- **缺点**：
  - 失去 CC 现有的全部能力（MCP、hooks、skills、文件编辑 UX）
  - 工具集要我们重写一遍，成本巨大
  - 与用户日常 CC 的 session/记忆不互通
- **主要风险**：为了"稳定接口"放弃 90% 的已有能力，得不偿失

### Option C：Claude Agent SDK / Managed Agents

- **是什么**：Anthropic 官方托管 agent，状态与工具由平台管
- **优点**：开发最省、状态持久化免费、升级自动
- **缺点**：
  - 本机桌面场景下，Managed Agents 的云端执行与"遥控本机"需求不契合
  - 工具集受托管平台限制，不如本机 CC 灵活
- **主要风险**：与 ADR-0003 本机桌面形态天然冲突

## Decision

选 **Option A：Claude Code CLI**。

理由（一句话）：使用场景就是"IM 远程驱动本机的 CC"，CC CLI 是唯一能直接复用用户现有配置与能力的选项；接口黑盒的风险通过 spec 约束 + transcript 回放测试来缓解。

## Consequences

### 正向

- 功能起点很高：用户在 IM 里能做的几乎等于在终端里用 CC 能做的
- 升级无感：CC 升级会自动带来新能力（新工具、新 MCP）
- 与用户本机环境深度整合：文件系统、git、项目配置都现成

### 负向

- CC 输出格式变化时需要快速跟进 adapter（需要 CI 回归）
- 必须维护 CC transcript 的回放测试（保证解析逻辑稳定）
- 无法多租户——一个 CC CLI 对一个用户（这也符合 ADR-0003）

### 需要后续跟进的事

- spec/agent-runtime.md 必须定义：启动参数、输出事件枚举、超时、中断信号
- testing/fixtures.md 必须要求维护 CC transcript fixture 集
- 观察 CC 输出格式变化，必要时发新 ADR 切换协议（例如转用 CC 的 SDK API 而非 CLI stdio）

## Out of scope

- **不决定**CC 的具体版本或安装方式（用户自己装）
- **不决定**是否支持同时接入多个 agent 后端（未来可能发新 ADR 允许 Codex、Gemini 等）
- **不决定**工具权限的具体白名单（属于 spec/security.md）

## 参考

- Claude Code 官方文档：`https://docs.claude.com/en/docs/claude-code/`
- 相关 spec（待创建）：`docs/dev/spec/agent-runtime.md`
