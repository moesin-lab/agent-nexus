---
title: 模块依赖方向
type: architecture
status: active
summary: 定义仓库内模块间允许与禁止的 import 关系；daemon 只依赖 protocol + stdlib，agent-*/platform-* 只依赖 daemon + protocol
tags: [architecture, hub-and-spoke, modules, dependencies]
related:
  - dev/architecture/overview
  - dev/standards/coding
---

# 模块依赖方向

本文件定义仓库内模块间**允许**与**禁止**的 import 关系。违反即拒绝合并。

> **本文按 package 维度讨论 import 关系**——`protocol` / `daemon` / `agent/<name>` / `platform/<name>` / `cli` / `vscode` / `web` 都是 npm package 名（前缀 `@agent-nexus/`，详见 [`adr/0004-language-runtime.md`](../adr/0004-language-runtime.md) §TS-P7）。模块概念名（cmd / core / agent / platform）作为职责分类在 [`overview.md`](overview.md) §模块结构 讨论；本文 §checklist 第 1 条仍用此分类。
>
> 带点的 namespace prefix（`daemon.logger` / `daemon.idempotency`）= `@agent-nexus/daemon` 的 import path 内的横切能力子模块；类型契约（`NormalizedEvent` / `AgentEvent` 等）住 `@agent-nexus/protocol`，import 时直接用类型名（不带 prefix）。
>
> **本项目不使用 "三层结构 / layered architecture" 措辞**，采用 hub-and-spoke 模块模型；旧版"三层"措辞已归档到 [`docs/_deprecated/architecture/three-layer-vocabulary.md`](../../_deprecated/architecture/three-layer-vocabulary.md)。

## 允许方向

```
protocol               # leaf（无依赖）—— 类型 + 接口契约（PlatformAdapter / AgentRuntime / NormalizedEvent...）
daemon          ───>   protocol
agent/<name>    ───>   daemon, protocol
platform/<name> ───>   daemon, protocol
vscode / web    ───>   protocol（仅类型；运行时通过 stdio/WebSocket 接 daemon 进程，不直接 import daemon）
cli             ───>   daemon, platform/*, agent/*, protocol（拼装层）
```

说明：

- **protocol** 是 leaf 包，只导出类型和接口契约，无任何运行时代码依赖。
- **daemon** 是中枢（hub），只依赖 protocol + 语言标准库 + 少量通用基础库（日志库、结构化编码、SQLite 驱动等）；白名单见下文。daemon 不感知具体 platform / agent 实现。
- **agent/<name>** / **platform/<name>** 每个独立 package 只能 import daemon 和 protocol，不能引用其他 agent / platform package，彼此也不互引。
- **vscode / web** 客户端 package 只 import protocol（共享 IPC schema 类型）；运行时通过 stdio / WebSocket 跟 daemon 进程通信，不直接 link daemon 代码。
- **cli** 是唯一"什么都能引用"的模块，负责按配置选择启用哪些 platform-* / agent-* 并启动 daemon。

## 禁止方向（硬性）

| 禁止 | 理由 |
|---|---|
| `daemon` → `agent/*` | daemon 是抽象中枢，不应知道具体实现 |
| `daemon` → `platform/*` | 同上 |
| `agent/<a>` → `agent/<b>` | agent 之间独立，共享逻辑上提到 daemon |
| `platform/<a>` → `platform/<b>` | 同上 |
| `agent/*` → `platform/*` 或反向 | 通过 daemon 传递事件，不直接互引 |
| 任何 package → `cli` | cli 是终端消费者 |
| `vscode` / `web` → `daemon` 或 `platform/*` 或 `agent/*` | UI 客户端只通过 protocol 类型 + IPC 跟 daemon 进程通信，不 link 进程内代码 |

## 为什么这么严

中枢（daemon）一旦反向 import 适配 package 的具体类型，会被适配细节渗透，新增适配器时不得不改 daemon。本项目通过**禁止反向 import** 强制 daemon 稳定。

具体好处：

1. 改动 `platform-discord` 不会影响 `agent-claudecode` 的编译/测试
2. daemon 可以独立测试（不需要启动 Discord）
3. 新增平台只需要实现 protocol 定义的接口，不需要读 daemon 的实现

## daemon 的外部依赖白名单

daemon 允许使用的非标准库（原则：**通用、成熟、无业务耦合**）：

- 日志库
- 结构化编码（JSON/TOML 等）
- SQLite 或等效嵌入式 KV（用于 idempotency、session 持久化）
- OTel client（可选，观测导出）
- UUID 生成

不在白名单里的库要引入 daemon，必须先发 ADR。

## platform / agent 的依赖

`platform-*` / `agent-*` package 可自由引入所需的 SDK 与工具库，但：

- 所有业务接口通过 `@agent-nexus/protocol` 定义的接口契约
- 不把 platform/agent 特有类型从"对外边界"暴露（只在内部使用，边界上转为 protocol 定义的归一化类型）

例：`platform-discord` 内部用 discord.js 的 `Message` 类型随便使，但在**对 daemon 返回**时必须构造 `NormalizedEvent`（类型住 `@agent-nexus/protocol`，import 即用）。

## cli 的职责

cli 拼装、不做业务：

- 读配置
- 创建 daemon 实例（注入日志、存储、限流器等基础设施）
- 注册启用的 `agent-*` / `platform-*` package
- 启动 engine
- 处理 OS 信号（SIGTERM、SIGINT）

cli 里可以写一些 glue 代码，但禁止写业务逻辑。

## 循环依赖

- 任何方向的循环依赖都拒绝
- 用 linter 或 ADR-0004 语言选定的工具（madge / import-linter / 等）检测

## 测试代码的依赖

测试代码遵循同样方向，并额外允许：

- 测试工具库（assert / fixture / mock 生成器）
- 合约测试（contract test）可以引用 daemon 与被测 adapter，组合验证

## 新增模块时的 checklist

开新模块（新 agent、新 platform、或新的 daemon 子模块）前：

- [ ] 这个模块属于哪个角色（cmd / core / agent / platform）？（角色分类见 [`overview.md`](overview.md) §模块结构）
- [ ] 它依赖哪些 package？是否只依赖 `daemon` 与 `protocol`？
- [ ] 是否需要在 daemon 增加新接口？若是，**先改 daemon 发 PR**，再开这个模块
- [ ] 是否需要在 protocol 增加新接口契约？若是，**先改 protocol 发 PR**，再开实现 package
- [ ] 在本文件附录索引登记（若是新 agent/platform）

## 附录：当前 package 清单

| package | 物理路径 | npm name | 状态 |
|---|---|---|---|
| protocol | `packages/protocol/` | `@agent-nexus/protocol` | 规划中（spec 先行） |
| daemon | `packages/daemon/` | `@agent-nexus/daemon` | 规划中 |
| platform-discord | `packages/platform/discord/` | `@agent-nexus/platform-discord` | 规划中 |
| agent-claudecode | `packages/agent/claudecode/` | `@agent-nexus/agent-claudecode` | 规划中 |
| vscode | `packages/vscode/` | `@agent-nexus/vscode` | 规划中 |
| web | `packages/web/` | `@agent-nexus/web` | 规划中 |
| cli | `packages/cli/` | `@agent-nexus/cli` | 规划中 |

（代码目录在 ADR-0004 语言选型完成后建立；详见 [`adr/0004-language-runtime.md`](../adr/0004-language-runtime.md) §TS-P7。）
