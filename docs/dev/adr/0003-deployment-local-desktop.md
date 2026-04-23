---
title: ADR-0003：部署形态——本机桌面
type: adr
status: active
summary: 选择本机桌面形态（单用户单机）作为 MVP 部署模式，与 CC CLI 和 Discord gateway 匹配最佳
tags: [adr, decision, deployment]
related:
  - dev/adr/0001-im-platform-discord
  - dev/adr/0002-agent-backend-claude-code-cli
  - dev/spec/infra/persistence
  - dev/spec/security
adr_status: Accepted
adr_number: "0003"
decision_date: 2026-04-22
supersedes: null
superseded_by: null
---

# ADR-0003：部署形态——本机桌面

- **状态**：Accepted
- **日期**：2026-04-22
- **决策者**：项目发起人
- **相关 ADR**：ADR-0001、ADR-0002

## 状态变更日志

- 2026-04-22：Proposed
- 2026-04-22：Accepted

## Context

部署形态决定架构的根本形状：

- 身份、权限、隔离模型
- 数据存储位置与加密要求
- 可观测性与日志落盘策略
- 运维复杂度（是否要多实例、负载均衡、配置中心）
- 用户安装与升级路径

cc-connect 原生支持多种形态（个人本机、企业服务器），结果多处代码在"单用户本机"与"多租户服务"之间摇摆，配置、权限、日志都留了两套抽象，增加了复杂度。

本项目的使用场景非常明确：**一个用户，在自己的电脑上，通过 Discord 远程驱动本机 CC CLI**。

## Options

### Option A：本机桌面（single-user, local-host）

- **是什么**：用户在自己电脑上运行 agent-nexus 进程，它同时连接 Discord 与本机 CC CLI
- **优点**：
  - 身份边界 = 本机用户，简单清晰
  - 所有数据（session、token、log）都在本地，无合规问题
  - 运维复杂度极低，无需部署多实例
  - 与 ADR-0002（CC CLI）天然契合——CC 也是本机跑
- **缺点**：
  - 用户关电脑 = 服务下线（这符合个人使用预期）
  - 多人无法共用一个实例
  - 无法在公网直接接收 Discord webhook（必须用 gateway 长连接）
- **主要风险**：随便扩展到多租户会打破假设

### Option B：多租户 SaaS

- **是什么**：一套部署服务多个用户，每人一套隔离的 session 与 agent
- **优点**：用户不用自己装、多用户成本摊销
- **缺点**：
  - 必须自建 agent 后端（无法驱动用户本机 CC），等于否定 ADR-0002
  - 合规、数据隔离、账单、配额全部要做
  - 远超 MVP 范围
- **主要风险**：一旦选这条路，项目性质变成 SaaS，不是"接 agent 到 IM"

### Option C：自托管服务器（单用户远端）

- **是什么**：用户把 agent-nexus 部署到自己的 VPS/家用服务器，24/7 运行
- **优点**：不关机、可公网、配置灵活
- **缺点**：
  - CC CLI 要装在服务器上（用户本机体验丢失）
  - 用户要管运维
  - 适合少数极客，不是 MVP 目标用户
- **主要风险**：增加运维复杂度换来的价值不高

## Decision

选 **Option A：本机桌面**。

理由（一句话）：与 MVP 场景（个人用户、遥控本机 CC）高度契合，身份/隔离/数据模型最简单，没有多余的复杂度。

## Consequences

### 正向

- 架构简单：单进程、单用户、单 agent
- 数据隐私好：所有敏感数据留在本地
- 无需公网 IP、无需域名、无需 TLS 证书
- 可观测性简单：直接写本地 JSONL

### 负向

- 关机 = 服务不可用（文档里明确告知用户）
- 多人场景完全不支持（本项目范围之外）
- 不能接收 Discord webhook，必须用 gateway 长连接（增加网络复杂度）

### 需要后续跟进的事

- spec/platform-adapter.md 必须明确使用 Discord gateway 而非 webhook
- spec/persistence.md 必须定义本地存储位置（如 `~/.agent-nexus/`）与备份策略
- spec/security.md 必须定义 token 存储方式（文件还是 OS keychain）
- 用户可见文档（product/）要强调"关机即停机"

## Out of scope

- **不决定**是否提供桌面 GUI（可能是 CLI + tray、可能是纯 CLI，后续 ADR）
- **不决定**自启动机制（launchd / systemd / tray，属于 ops/）
- **不决定**将来是否增加自托管服务器模式（如需则发新 ADR）

## 参考

- 相关 spec（待创建）：`docs/dev/spec/persistence.md`、`docs/dev/spec/security.md`
