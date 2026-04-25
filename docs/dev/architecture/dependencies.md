---
title: 模块依赖方向
type: architecture
status: active
summary: 定义仓库内模块间允许与禁止的 import 关系；core 只依赖 stdlib，agent/platform 只依赖 core
tags: [architecture, layering, dependencies]
related:
  - dev/architecture/overview
  - dev/standards/coding
---

# 模块依赖方向

本文件定义仓库内模块间**允许**与**禁止**的 import 关系。违反即拒绝合并。

> **命名 disambiguation**：下文 `cmd/` / `core/` / `agent/` / `platform/` 是**架构分层维度**的路径名，不是 npm package 名。ADR-0004 monorepo 布局下四层全部住在 `@agent-nexus/daemon` package 内按职责子目录平铺（详见 [`overview.md`](overview.md) §三层结构）；带点的 namespace prefix（如 `daemon.NormalizedEvent`）= `@agent-nexus/daemon` 的 import path。

## 允许方向

```
cmd/        ──┬──> core/
              ├──> agent/*
              ├──> platform/*
              └──> config/（如有）

agent/*     ────> core/             （且仅 core/）
platform/*  ────> core/             （且仅 core/）
core/       ────> stdlib + 少量白名单通用库
```

说明：

- **core** 是中枢，只依赖语言标准库与少量通用基础库（日志库、结构化编码、SQLite 驱动等）。白名单见下文。
- **agent/** 每个子包只能引用 core，不能引用其他 agent，也不能引用任何 platform。
- **platform/** 对称：只能引用 core。
- **cmd/** 是唯一"什么都能引用"的层，负责拼装。

## 禁止方向（硬性）

| 禁止 | 理由 |
|---|---|
| `core/` → `agent/*` | core 是抽象，不应知道具体实现 |
| `core/` → `platform/*` | 同上 |
| `agent/<a>` → `agent/<b>` | agent 之间独立，共享逻辑上提到 core |
| `platform/<a>` → `platform/<b>` | 同上 |
| `agent/*` → `platform/*` 或反向 | 通过 core 传递事件，不直接互引 |
| 任何模块 → `cmd/` | cmd 是终端消费者 |

## 为什么这么严

中枢层（如本项目的 `core`）一旦反向 import 适配层的具体类型，会被适配层细节渗透，新增适配器时不得不改中枢。本项目通过**禁止反向 import** 强制 core 稳定。

具体好处：

1. 改动 platform/discord 不会影响 agent/claudecode 的编译/测试
2. core 可以独立测试（不需要启动 Discord）
3. 新增平台只需要实现 core 的接口，不需要读 core 的实现

## core 的外部依赖白名单

core 允许使用的非标准库（原则：**通用、成熟、无业务耦合**）：

- 日志库（具体选型随 ADR 0004 后定）
- 结构化编码（JSON/TOML 等）
- SQLite 或等效嵌入式 KV（用于 idempotency、session 持久化）
- OTel client（可选，观测导出）
- UUID 生成

不在白名单里的库要引入 core，必须先发 ADR。

## platform / agent 的依赖

platform/agent 可自由引入所需的 SDK 与工具库，但：

- 所有业务接口通过 core 提供的抽象类型
- 不把 platform/agent 特有类型从"对外边界"暴露（只在内部使用，边界上转为 core 定义的归一化类型）

例：`platform/discord` 内部用 discord.js/discordgo 的 `Message` 类型随便使，但在**对 core 返回**时必须构造 `daemon.NormalizedEvent`。

## cmd/ 的职责

cmd 拼装、不做业务：

- 读配置
- 创建 core 实例（注入日志、存储、限流器等基础设施）
- 注册启用的 agent 后端与 platform 适配器
- 启动 engine
- 处理 OS 信号（SIGTERM、SIGINT）

cmd 里可以写一些 glue 代码，但禁止写业务逻辑。

## 循环依赖

- 任何方向的循环依赖都拒绝
- 用 linter 或 ADR 0004 语言选定的工具（go mod graph、madge、import-linter）检测

## 测试代码的依赖

测试代码遵循同样方向，并额外允许：

- 测试工具库（assert / fixture / mock 生成器）
- 合约测试（contract test）可以引用 core 与被测 adapter，组合验证

## 新增模块时的 checklist

开新模块（新 agent、新 platform、或新的 core 子模块）前：

- [ ] 这个模块属于哪一层？
- [ ] 它依赖哪些上层？是否只依赖 core？
- [ ] 是否需要在 core 增加新接口？若是，**先改 core 发 PR**，再开这个模块
- [ ] 在本文件附录索引登记（若是新 agent/platform）

## 附录：当前模块清单

| 模块 | 路径 | 状态 |
|---|---|---|
| core | `core/` | 规划中（spec 先行） |
| agent/claudecode | `agent/claudecode/` | 规划中 |
| platform/discord | `platform/discord/` | 规划中 |
| cmd/agent-nexus | `cmd/agent-nexus/` | 规划中 |

（代码目录在 ADR 0004 语言选型完成后建立。）
