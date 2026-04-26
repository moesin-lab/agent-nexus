---
title: agent-nexus
type: root
status: active
summary: 把本机 Claude Code CLI 接入 IM 平台的桥；MVP 目标 Discord + 本机桌面形态
tags: [project, discord, cc-cli]
related:
  - root/AGENTS
  - dev/adr/0001-im-platform-discord
  - dev/adr/0002-agent-backend-claude-code-cli
  - dev/adr/0003-deployment-local-desktop
---

# agent-nexus

把本机 Claude Code CLI 接入 IM 平台的桥。首个目标平台：Discord。

## 定位

agent-nexus 让你在 IM（当前：Discord）里直接和本机 Claude Code 对话，用 IM 作为"远程遥控器"驱动本机的编码 agent；同时把观测、权限、成本控制做成一等公民。

这是一个参考 [cc-connect](https://github.com/chenhg5/cc-connect) 但刻意规避其已知教训的重新实现：**文档先行、契约先行、测试先行**。

## 当前阶段

**文档与规范骨架阶段**。尚无任何代码、无可运行产物。本阶段目标是把架构、决策、接口契约、开发流程、测试策略、编码规范全部落盘，让后续实现者（人或 agent）拿着文档就能开工。

## 已锁定的前置决策

| 维度 | 决策 | ADR |
|---|---|---|
| IM 平台（MVP） | Discord | [0001](docs/dev/adr/0001-im-platform-discord.md) |
| Agent 后端 | Claude Code CLI | [0002](docs/dev/adr/0002-agent-backend-claude-code-cli.md) |
| 部署形态 | 本机桌面 | [0003](docs/dev/adr/0003-deployment-local-desktop.md) |
| 实现语言 | 待评审 | [0004](docs/dev/adr/0004-language-runtime.md) |

## 文档入口

- **开发者**：先读 [`AGENTS.md`](AGENTS.md) 和 [`docs/dev/README.md`](docs/dev/README.md)。
- **使用者**：[`docs/product/README.md`](docs/product/README.md)（MVP 产出后填写）。
- **所有文档导航**：[`docs/README.md`](docs/README.md)。

## 协作

本仓库使用 Conventional Commits。任何代码或接口改动之前必须先有 ADR 或 spec 落盘。详细规则见 [`AGENTS.md`](AGENTS.md)。

## 许可证

[MIT](LICENSE)。
