---
title: 架构总览（旧版"三层结构"措辞归档）
type: architecture
status: deprecated
summary: 归档 2026-04-25 之前 architecture/overview.md 使用的"三层结构 (layered architecture)"措辞与相关 ASCII 图；已被 hub-and-spoke 模块模型取代
tags: [architecture, deprecated, layered-architecture, vocabulary]
related:
  - dev/architecture/overview
  - dev/architecture/dependencies
deprecation_date: 2026-04-25
superseded_by: dev/architecture/overview
---

# 架构总览（旧版"三层结构"措辞归档）

> **Deprecated**：本文件归档了 **2026-04-25 之前** `docs/dev/architecture/overview.md` 使用的"**三层结构 (layered architecture)**"措辞与相关 ASCII 图。
>
> 新版架构概念语言采用 **hub-and-spoke（中枢辐射）模块模型**，详见 [`docs/dev/architecture/overview.md`](../../dev/architecture/overview.md) §模块结构。
>
> **废止理由**：架构 layered architecture 措辞误导——暗示线性堆叠 + 自上而下依赖，但 agent-nexus 实际依赖关系是**中枢辐射**（core 是 hub，agent / platform 是平行 spokes，cmd 是 wiring 同时依赖三者）。权威开源对标 LSP / DAP / MCP / Theia / Continue.dev **全部使用** client/server/adapter/extension/binary 等**角色名 / 部署形态名**，**没有一个**用 "layer / 三层" 描述自己的模块组织。
>
> 本文件保留作历史快照，**不作为现行决策依据**。

---

## 旧版 §三层结构 章节（已废止措辞）

参考 cc-connect 的三层划分，但**依赖方向更严**（见 [`dependencies.md`](../../dev/architecture/dependencies.md)）：

```
┌──────────────────────────────────────────────────┐
│                       cmd/                       │  入口：CLI、daemon、配置加载
├──────────────────────────────────────────────────┤
│                       core/                      │  引擎、接口定义、session、幂等、限流、脱敏、观测
├───────────────────────┬──────────────────────────┤
│       agent/          │        platform/         │
│   └── claudecode/     │    └── discord/          │
│                       │                          │
│   （实现 core 定义的   │   （实现 core 定义的      │
│    AgentRuntime 接口）  │    PlatformAdapter 接口）│
└───────────────────────┴──────────────────────────┘
```

### 旧版 §职责划分

- **`core/`**：引擎 + 接口 + 横切能力。是**中枢**，只依赖语言标准库与少量通用工具。
- **`agent/<name>/`**：具体 agent 后端实现。当前只有 `claudecode`。每个实现通过注册表接入 core。
- **`platform/<name>/`**：具体 IM 平台实现。当前只有 `discord`。每个实现通过注册表接入 core。
- **`cmd/`**：可执行入口，拼装 core + 启用的 agent + 启用的 platform，加载配置。

### 旧版 §"比 cc-connect 更严的约束" 第 1 条（已废止措辞）

1. **所有跨层交互必须走 `docs/dev/spec/` 定义的接口。** 新增能力先改 spec，再改代码。

> 新版改写为："**所有跨模块交互必须走 spec/ 定义的接口。**"

---

## 为什么不只改字面而归档

按 [`docs/dev/process/docs-read.md` §路径分层与放行/拦截规则](../../dev/process/docs-read.md#路径分层与放行拦截规则) 的归档约定，被废止的概念性内容物化到本路径，是为了：

1. **路径本身就是"别当事实"的信号**——`_deprecated/` 让读者一眼知道这是历史快照
2. **保留审计追溯链**——未来 reviewer 看到 PR / commit 引用旧措辞时，能查到具体废止理由与上下文
3. **避免 git blame 误读**——纯字面 sed 替换会丢失"为什么废止"的语义，归档保留 rationale

新版架构概念语言（hub-and-spoke）的具体表述见现行 [`docs/dev/architecture/overview.md`](../../dev/architecture/overview.md)。
