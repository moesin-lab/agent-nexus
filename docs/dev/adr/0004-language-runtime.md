---
title: ADR-0004：实现语言与运行时选型
type: adr
status: active
summary: 选定 TypeScript / Node + pnpm workspaces monorepo；TS SDK 生态累积优势 + 跨端类型共享超过 Go 单二进制优势
tags: [adr, decision, language-runtime]
related:
  - dev/spec/platform-adapter
  - dev/spec/agent-runtime
  - dev/spec/message-protocol
  - dev/spec/infra/persistence
adr_status: Accepted
adr_number: "0004"
decision_date: 2026-04-25
supersedes: null
superseded_by: null
---

# ADR-0004：实现语言与运行时选型

- **状态**：Accepted
- **日期**：2026-04-25
- **决策者**：项目 owner
- **相关 ADR**：ADR-0001、ADR-0002、ADR-0003

## 状态变更日志

- 2026-04-22：Proposed（候选方案列出，待 spec 三件套写成后重审）
- 2026-04-22：完成基于 spec 三件套的二次评审，初步倾向 Go（隐含前提：演进面 N 偏小）
- 2026-04-25：完成 codex 异构 argue + 三轮修正（演进面 N、并发负载实证、跨端共享需求、反混合方案）
- 2026-04-25：**Accepted Option A：TypeScript / Node + pnpm workspaces monorepo**
- 2026-04-25：命名澄清（非决策反转）——TS-P7 的 npm package 名由 `@agent-nexus/core` 修订为 `@agent-nexus/daemon`，理由 = 消除与 architecture `core` layer 概念名歧义；package 内含 architecture 的 core + agent + platform 三层，名义范围比 layer 大，应反映"daemon 进程整体"语义
- 2026-04-25：同步修订 architecture/spec 文档中带点的 namespace `core.xxx` → `daemon.xxx`；layer 维度的散文与 ASCII 路径 `core` 保留；monorepo + TS + 5 包结构不变

## Context

前置决策：Discord（ADR-0001）+ Claude Code CLI（ADR-0002）+ 本机桌面（ADR-0003）。本 ADR 决定实现语言与运行时，影响：

- SDK 生态（Discord / Anthropic / OpenAI / Gemini / Slack / Telegram / MCP / 观测评估工具）与集成成本
- 并发模型（长连接、子进程管理、pty）
- 分发形态（单二进制 / runtime 依赖 / 打包器）
- 测试工具链与 eval 生态
- 与 CC CLI 的互操作难度
- **演进面**：新 agent 后端 / 新 IM 平台 / web 前端 / VSCode 插件 / MCP server / 观测评估工具的接入边际成本
- **跨端代码与类型契约共享**：daemon ↔ web ↔ VSCode extension 之间的协议、类型、辅助函数复用

## Options

### Option A：TypeScript / Node ✅ Accepted

- **是什么**：Node LTS 20.x + TypeScript（strict 模式）+ pnpm workspaces monorepo；MVP 走 npm 全局安装路径分发
- **优点**：
  - discord.js 是 Discord SDK 事实标准，文档密度 / 样例量 / 新特性跟进速度均领先
  - Anthropic / OpenAI / Gemini / Mistral 官方 SDK 全部 TS 一等公民
  - MCP 官方 TS SDK 是一等
  - LangFuse / Helicone / Langtrace / Vercel AI SDK 等观测评估生态几乎全 TS-native
  - **VSCode extension API 强制 TS/JS**——TS 单语言下 extension 可直接 `import` `@agent-nexus/daemon` 的公开模块；其他语言必走 thin shell + IPC
  - **跨端代码与类型契约共享**：pnpm workspaces 下 daemon / web / VSCode / CLI 共享 `@agent-nexus/protocol` package（NormalizedEvent / SessionConfig / AgentEvent 单一权威源）
  - 与 CC CLI 同栈，未来可能直接 `import` CC 模块
  - 用户装 CC 时 Node 18+ 已经在本地（CC CLI 强制要求）→ 分发零负担
  - TS strict 模式 + 结构化类型对 Discord 这类深嵌套 payload 的 IDE 反馈体验好
  - fixture / 动态结构化数据工装顺手（CC transcript JSONL 编辑、event 序列 diff、脱敏前后对比）
- **缺点**：
  - 单线程 event loop——CPU-bound 任务无解；agent-nexus 是 IO-bound 不命中此痛点
  - pty / 子进程 / 信号 idiom 比 Go 标准库繁一档（用 `execa` + `node-pty` 压住）
  - 三个 native 依赖（`node-pty` / `better-sqlite3` / `keytar`），跨平台 prebuilt 是 ongoing 维护成本
  - 类型系统不如 Go 严格——靠 strict 模式 + 边界处显式契约压住
- **主要风险**：Node 主版本切换（N-API ABI 变化）时三个 native 依赖的 prebuilt 跟进可能延迟——锁 LTS 主版本可缓解

### Option B：Go

- **是什么**：Go 1.22+，单二进制，goroutine 并发
- **优点**：
  - 单二进制分发，无 runtime 依赖（在不需要跨端共享时是优势）
  - goroutine + channel 在长连接 / 子进程 stdio 流式处理上 idiom 顺手——但能力优势仅在并发数量 > 1000 或 CPU-bound 多核场景显现
  - `testing` + `testify` + `pprof` 内置工具链稳
  - 标准库 / 纯 Go 库覆盖：`os/exec` + `creack/pty` + `modernc.org/sqlite` + `zalando/go-keyring`
  - macOS 跨架构（amd64 / arm64）交叉编译干净
  - AOT 性能（agent-nexus 不命中此需求）
- **缺点**：
  - **discordgo 维护节奏明显慢于 discord.js**——v0.29.0（2025-05-24）维护活跃但 Discord 新组件 / Components V2 / voice / modal V2 等会滞后，需要自补协议字段
  - **Anthropic / OpenAI / Gemini 都已有官方 Go SDK**（修正二次评审"Anthropic 无官方 Go SDK"的过时表述），但**新特性通常先上 TS / Python，Go 滞后**
  - MCP / LangFuse / Helicone / Langtrace 等观测评估工具在 Go 多为社区维护或缺位
  - **跨端共享不可达**：VSCode extension 强制 TS，web 前端也是 TS——Go daemon 必须走 thin shell + IPC + 跨语言协议化（codegen 或手维护双份契约）
  - 与 CC CLI 只能 stdio 黑盒交互
  - fixture / 动态结构化数据维护比 TS 笨拙（codex argue 已确认）
  - 桌面分发并非"零成本"——macOS notarization + Windows SmartScreen 是 Go/Node 共同的桌面分发成本
  - `modernc.org/sqlite` 有 fragile `modernc.org/libc` 依赖（要求 go.mod 锁精确版本）+ 写入密集场景比 cgo 版 `mattn/go-sqlite3` 慢
  - 类型表达力比 TS 弱一个数量级（联合类型、条件类型、infer、mapped types 缺位）
- **主要风险**：每接入一个新 agent 后端 / IM 平台 / MCP server / 评估工具都要付 SDK 缺位 / 滞后的边际成本——演进面 N 大时累积代价高；且 web / VSCode 强制把 daemon ↔ frontend 协议化为额外固定成本

### Option C：Python

- **是什么**：Python 3.12+，asyncio，pytest
- **优点**：
  - discord.py 成熟
  - Anthropic 官方 SDK 一等公民
  - LLM / eval 生态最强（notebook、pandas、各种 eval 库）
- **缺点**：
  - 本机桌面分发最麻烦（venv / pipx / pyinstaller 各有坑）
  - asyncio 的 pty / 子进程管理心智负担中等
  - 与 CC CLI 混栈（CC 是 Node，我们是 Python）
  - VSCode extension 强制 TS——同样不可达跨端共享
- **主要风险**：分发复杂度让用户装机门槛变高

### Option D：混合（Go + TS）❌ Rejected

混合方案至少有两种形态，均被驳回：

#### Form D-1：core/agent Go + platform/discord TS（cross-process IPC）

驳回理由（来自 codex 异构 argue Task 2）：

- **FFI 路径直接排除**：cgo 嵌 Node / 调 N-API 把构建、生命周期、崩溃边界、内存模型全搅复杂
- **多进程 IPC 与单进程架构定义冲突**：[`docs/dev/architecture/overview.md`](../architecture/overview.md) 写死"单进程：一个 agent-nexus 进程"
- **横切能力协议化代价过高**：core 的 11 项横切能力（日志 / Session / 幂等 / 限流 / 记账 / 预算 / auth / tool-boundary / secrets / redact / persistence）全在 core；TS adapter 每处理一个 Discord 事件都要跨进程请求 traceId / NormalizedEvent 入队 / 幂等 / session / 预算 / redact / message refs——hot path 全部 IPC
- **业务规模不值得**：单用户单机本机部署，引入分布式系统式问题但业务规模不需要
- **结果是 worst-of-both 而非 best-of-both**：Go 和 TS 复杂度叠加，而不是优点叠加

#### Form D-2：Go daemon + TS frontend（web / VSCode）

看似合理（业务-UI 解耦），但被驳回。**Thin shell + remote daemon 本身是合理架构（LSP 路线已证），缺陷不在解耦本身**——驳回理由是：

- **协议契约 source-of-truth 漂移**：`NormalizedEvent` / `SessionConfig` / `AgentEvent` 跨语言只有两条路：手维护双份（必漂移）或 codegen（protobuf / OpenAPI / TypeSpec / smithy 第三套工具链）
- **构建 / 调试 / 部署链路双倍**：`go build` + `pnpm build` + 协议 codegen 三条流水线；跨语言 trace 只能靠 traceId 字符串关联；panic / exception 跨语言无 native 支持
- **VSCode extension 退化为 thin shell + IPC**——TS 全栈下 extension 可直接 `import` `@agent-nexus/daemon` 的公开模块（比 thin shell + IPC 更顺）
- **多平台 Go binary 分发反而比 TS 全栈复杂**：用户装 Go binary（多平台 matrix）+ vsix（+ npm package），TS 全栈下只装 npm + vsix
- **Go 的微优势（性能 / 启动 / 内存）在 agent-nexus 单用户单机场景下不可观测**

**关键洞察**：解耦目标在 TS monorepo + 独立 packages 已可达——`@agent-nexus/protocol`（仅类型 + JSON schema 权威源）+ `@agent-nexus/daemon`（daemon 独立可运行）+ `@agent-nexus/vscode`、`@agent-nexus/web`（独立 UI packages，通过协议跟 daemon 通信，类型 `import` 共享）。物理进程边界（业务-UI 解耦）+ 类型契约共享（同语言 `import`）= 解耦目标全达，**没有跨语言 codegen 税**。

混合 D-2 在 agent-nexus 实际场景下 weakly dominated by TS 全栈：

| 维度 | 混合 D-2 | TS 全栈 monorepo |
|---|---|---|
| 业务-UI 解耦 | ✓ | ✓ |
| 多客户端复用 | ✓ | ✓ |
| 类型契约共享 | 跨语言（手维护或 codegen） | `import`（零 codegen） |
| 协议演进 | 双语言改两次 | 一次 |
| 调试链路 | 跨语言 | 单语言 stack 直通 |
| 分发 | Go binary（多平台 matrix）+ vsix | npm + vsix |
| daemon 性能 / 启动 / 内存 | 微优 | 单用户场景不可观测 |

混合方案吃两边代价没拿两边优势——不是错的方向，是劣解。

## 对比矩阵

| 维度 | TypeScript/Node | Go | Python |
|---|---|---|---|
| Discord SDK | ★★★（事实标准） | ★★ | ★★★ |
| Anthropic SDK | ★★★（官方 TS） | ★★（官方 Go 已有但滞后） | ★★★（官方） |
| OpenAI SDK | ★★★ | ★★ | ★★★ |
| Gemini SDK | ★★★ | ★★ | ★★★ |
| Slack / Telegram SDK | ★★★ | ★★ | ★★★ |
| MCP SDK | ★★★（官方一等） | ★（社区） | ★★★（官方） |
| 观测 / 评估生态 | ★★★（LangFuse / Helicone / Langtrace 一等） | ★ | ★★ |
| **跨端代码与类型共享** | **★★★（monorepo `import`）** | ★（必走跨语言 codegen） | ★（同 Go） |
| **VSCode extension 集成** | **★★★（直接 `import` `@agent-nexus/daemon` 公开模块）** | ★（thin shell + IPC） | ★（同 Go） |
| 与 CC CLI 互操作 | ★★★（同栈） | ★★（stdio） | ★★（stdio） |
| 本机桌面分发 | ★★★（CC 已带 Node + npm path） | ★★★（单二进制；多平台 matrix） | ★（最麻烦） |
| 并发 / 长连接（agent-nexus 实际负载） | ★★★（IO-bound + 量级 10 是 event loop sweet spot） | ★★★（idiom 顺，但能力优势不显现） | ★★（asyncio） |
| 子进程 / pty / 信号心智 | ★★（需 native deps，用 `execa` 压住） | ★★★ | ★★ |
| LLM / eval 生态 | ★★★ | ★ | ★★★ |
| TDD 工具链 | ★★★（vitest） | ★★★（testing） | ★★★（pytest） |
| fixture / 动态数据工装 | ★★★ | ★★ | ★★★ |
| 类型表达力 | ★★★（联合 / 条件 / mapped / template literal） | ★★ | ★ |

## 评审历史（含修正声明）

### 第一轮（2026-04-22 Initial）

候选 A/B/C 列出，未决；待 spec 三件套写成后重审。

### 第二轮（2026-04-22 Post-spec review）

基于三大契约（platform-adapter / agent-runtime / message-protocol）+ 横切四件套反观语言适配性，初步倾向 Go。关键论据：

1. 本项目不直接调 Anthropic API（CC CLI 在中间），TS / Python 的官方 SDK 优势对本项目"几乎无效"
2. TS / Python 都需要 native 依赖三件套（pty / sqlite / keychain），跨平台 prebuilt 是大坑
3. Go 的子进程 / 并发 / 单二进制优势在 spec 下被放大
4. Discord SDK 差距缩小到不致命

**隐含前提（已在第三 / 四轮被纠正）**：演进面 N 偏小 + 不做跨端 UI。论据 #1 仅对 N 小成立；论据 #3 在 web / VSCode 演进下被稀释。

### 第三轮（2026-04-25 Codex argue + 演进面 N）

跑完 codex 异构 argue（OpenAI gpt-5 系列）独立反方分析（按本 ADR §"评审条件" #3 要求）。argue 报告含四个任务，关键发现：

- **Anthropic / OpenAI / Gemini 都已有官方 Go SDK**（不是第二轮说的"无 SDK"）——但新特性通常先上 TS / Python，Go 滞后
- discordgo 仍维护活跃（v0.29.0 / 2025-05-24），但 release 节奏明显慢于 Discord 变化——Discord 新组件 / voice / modal V2 等需要自补
- macOS notarization + Windows SmartScreen 是 Go / Node 共同的桌面分发成本（Go 单二进制不等于"分发零成本"）
- `modernc.org/sqlite` 有 fragile `modernc.org/libc` 依赖
- Go 在 fixture / 动态结构化数据维护上有节奏税（CC transcript JSONL 编辑、event 序列 diff、脱敏前后对比）
- 混合 D-1（core/adapter 跨进程 IPC）被详尽驳回（hot-path IPC + 横切协议化 + 单进程违规）
- codex 独立推荐：Option B (Go)（基于 N 偏小的隐含前提，与第二轮一致）

项目 owner 显式纠正：**演进面 N 大**（多 agent 后端 / 多 IM / MCP / 观测评估工具是长期目标）。

**TS SDK 累积优势分析**：

| 扩展面 | TS 接入成本 | Go 接入成本 |
|---|---|---|
| 新 agent 后端 | `pnpm add @<vendor>/sdk`，import 即用 | 官方 Go SDK 通常滞后；新特性需自补 HTTP / SSE 解析 |
| 新 IM 平台 | discord.js / @slack/bolt / telegraf 一等 | 多为社区维护，节奏慢，文档密度低 |
| MCP server | 官方 TS SDK 一等 | 社区维护，跟进慢 |
| 观测 / 评估 | LangFuse / Helicone / Langtrace TS-native | 多数无官方 Go binding |

每次新接入 TS 节省 10–30% 时间；累积到 N 大场景，超过 Go 在 daemon 进程实现上的一次性心智优势。

### 第四轮（2026-04-25 跨端需求 + 实际负载实证 + 反混合）

项目 owner 进一步显式声明：**未来计划做 web 前端 + VSCode 插件**。两个新事实加入决策：

#### a）跨端代码与类型契约共享

- VSCode extension API 强制 TS / JS；web 前端事实标准 TS
- TS monorepo 下 daemon / web / VSCode / CLI 共享 `@agent-nexus/protocol` package，零 codegen 税
- 非 TS 路径必须付出跨语言协议化成本（手维护双份契约或引入 protobuf / OpenAPI / TypeSpec）

#### b）实际并发负载实证

| Workload | 量级 | 性质 |
|---|---|---|
| Discord gateway WebSocket | 1 条 | IO |
| 同时活跃 session | 1-5（峰值十几） | IO + 子进程 |
| 同 sessionKey 处理 | 串行（不是并行） | spec/message-protocol §顺序硬约束 |
| CC CLI 子进程 stdout | 每 session 一个，行解析 | IO |
| SQLite 操作 | 单用户 | IO |

**IO-bound + 低并发（量级 10）+ 单用户——Node event loop 的设计中心**。Go goroutine 的并发优势在 > 1000 并发或 CPU-bound 多核场景才显现，agent-nexus 全不命中。第二轮"Go ★★★ vs TS ★★"评分修正为"两者均 ★★★"——Go 的并发优势是 idiom 风格优势，在本项目实际负载下不可观测。

#### c）反驳混合方案 D-2

详见 §Options §Option D 的 D-2 驳回——核心论点：解耦目标在 TS monorepo 已可达，混合是劣解。

#### 第四轮综合判断

剔除被纠正论据后，Go 剩余真实优势：

- 单二进制分发：在不做 web/VSCode 时真实，跨端演进下被稀释
- 子进程 / 信号 idiom 顺手：真实但权重小（TS 用 `execa` 可压住）
- 工程化简单（gofmt / Go 1 兼容承诺）：与 N 大演进面无关
- AOT 性能：agent-nexus 不命中需求

Go 相对优势权重明显下降；TS（SDK 累积 + 跨端共享 + 类型表达力）权重明显上升。**最终推荐：Option A (TypeScript / Node)**。

## Decision

**Accepted Option A：TypeScript / Node + pnpm workspaces monorepo**。

驱动因素：

1. 演进面 N 大（多 agent 后端 / 多 IM / MCP / 观测评估工具长期目标）→ TS SDK 一等公民生态累积优势
2. web + VSCode 跨端 UI 是长期目标 → `@agent-nexus/protocol` 单一权威源，零 codegen 税
3. IO-bound + 低并发（量级 10）负载——Node event loop sweet spot；Go 并发优势在本项目不显现
4. 解耦目标在 TS monorepo + 独立 packages 已可达，无需跨语言混合
5. 用户机器 Node 18+ 已被 CC CLI 满足，分发门槛已消化
6. 与 CC CLI 同栈，未来可能直接 `import` CC 模块

## Consequences

- daemon 进程实现里的子进程 / pty / 信号 / 长连接重连 / FIFO 队列要用成熟库压住心智：`execa` + `node-pty` + `p-queue` + discord.js 自带 ws 重连
- 三个 native 依赖（`node-pty` / `better-sqlite3` / `keytar`）需明确锁定 Node LTS 主版本（建议 20.x），走 `node-gyp-build` prebuilt fallback；CI 验证多平台 prebuilt 可用
- monorepo 切分锁定（见 §"采纳后的执行补丁清单" TS-P7）：`@agent-nexus/protocol`（仅类型 + JSON schema 权威源）/ `@agent-nexus/daemon`（daemon 进程实现，包内含 architecture 的 core + agent + platform 三层）/ `@agent-nexus/vscode`（extension）/ `@agent-nexus/web`（web frontend）/ `@agent-nexus/cli`（CLI 入口）
- MVP 选 npm 全局安装路径分发（用户机器已有 Node）；单二进制打包延后到 ops/ 阶段评审（`@yao-pkg/pkg` / `bun build --compile`）
- core 横切能力（auth / 幂等 / 限流 / 记账 / 预算 / redact）正确性需要细致测试覆盖（vitest + 合约测试）
- TS strict 模式 + 边界处显式契约（NormalizedEvent / AgentEvent / OutboundMessage 在 `@agent-nexus/protocol` 定义）作为类型严格性补偿
- discordgo"自补协议字段"累积成本消除——直接 npm install 拿 discord.js 最新版
- 多 agent 后端接入边际成本消除——`pnpm add @anthropic-ai/sdk` / `openai` / `@google/genai` 直接 import

## 采纳后的执行补丁清单（TS 7 项）

| 补丁 | 内容 |
|---|---|
| **TS-P1** | 锁定 Node LTS 主版本（建议 20.x）；`package.json#engines` 显式声明 `"node": ">=20 <21"` |
| **TS-P2** | Native 依赖明确策略：`node-pty` + `better-sqlite3` + `keytar` 全部走 `node-gyp-build` prebuilt fallback；明确 N-API 版本兼容矩阵；CI 验证多平台 prebuilt 可用 |
| **TS-P3** | 分发形态：MVP 走 npm 全局安装路径（用户机器已有 Node）；单二进制打包延后到 ops/ 阶段评审 |
| **TS-P4** | 并发模型在 spec 里明确：长连接由 `discord.js` 内置 ws；session 串行队列用 `p-queue`（每个 sessionKey 一个队列）；子进程管理用 `execa` + `node-pty` |
| **TS-P5** | 构建工具链：vitest（test）+ tsx（dev）+ tsup 或 swc（dist）；TypeScript strict 模式 + `noUncheckedIndexedAccess` |
| **TS-P6** | 混合方案 D-1 / D-2 显式驳回（见 §Options §Option D）——保留为决策溯源记录，避免后续 reopen |
| **TS-P7** | **monorepo 结构**：pnpm workspaces，packages 切分如下，`@agent-nexus/protocol` 是类型契约单一权威源；其他 package 通过 `import` 共享。`tsconfig.references` 锁定依赖方向，禁止反向 import |

```
packages/
├── protocol/          # 仅类型 + JSON schema；NormalizedEvent / AgentEvent / SessionConfig / OutboundMessage 等
├── daemon/            # daemon 进程实现；包内职责子目录平铺（架构上对应 core + agent + platform 三层）；可独立 npm 启动
├── vscode/            # VSCode extension：import @agent-nexus/protocol，stdio 跟 daemon 通信
├── web/               # web frontend：import @agent-nexus/protocol，WebSocket 跟 daemon 通信
└── cli/               # CLI 入口：直接 spawn daemon
```

> **命名 disambiguation**：本仓库中 `core` 一词专指 architecture 三层结构里的中枢层（见 [`docs/dev/architecture/overview.md`](../architecture/overview.md)）；package 名一律不再使用 `core`。文档里带点的 namespace prefix（`daemon.logger` / `daemon.idempotency` 等）= `@agent-nexus/daemon` 的 import path。

## 剩余风险

- Node 主版本切换（N-API ABI 变化）时三个 native 依赖的 prebuilt 跟进可能延迟——锁 LTS + 监控 prebuilt 发布
- daemon 进程实现里的子进程 / pty / 重连 / FIFO 队列等代码心智成本比 Go 高一档——靠 `execa` / `node-pty` / `p-queue` 等成熟库压住
- 单二进制分发不如 Go 干净——MVP 接受 npm 安装路径
- 类型系统不如 Go / Rust 严格——靠 strict 模式 + 边界处显式契约（`@agent-nexus/protocol` package）压住
- Bun / Deno 等替代 runtime 在未来可能消解部分 native 依赖痛点。当前不引入的具体事实依据 + ops/ 阶段重审的检查清单见 §"未来重审 Bun 的 checklist（ops/ 阶段）"

## 未来重审 Bun 的 checklist（ops/ 阶段）

ops/ 阶段评审单二进制分发 / runtime 替代时，以下事实点与触发条件决定 Bun 是否可采纳。

### 当前不引入 Bun 的事实依据（来自 codex 异构 argue, 2026-04-25）

- Bun 1.x 已 production-credible（Claude Code / Midjourney 在用），但 `child_process` 兼容仅 **84.56%** / Node-API **~95%**——CC CLI 子进程 + `node-pty` 链路正好命中此脆弱区
- 三个 native deps（`node-pty` / `better-sqlite3` / `keytar`）与 Bun 兼容均为 known unknown，其中 `node-pty` 命中核心热路径，是最高风险项
- `bun build --compile` 要求 native addon 路径静态可分析，对 `better-sqlite3` / `keytar` / `node-pty` 的 `bindings` + `prebuild-install` 模式不友好；**Windows arm64 未进入 `--compile` target**
- `bun:sqlite` 不是 `better-sqlite3` 的 drop-in 替代——切换属于 F1 级 runtime 架构变更（API + 事务/pragma/backup 行为重测）
- `bun build` 作 bundler 不输出 `.d.ts`，仍需 `tsc`；agent-nexus 5 packages 规模下速度优势不构成决策级收益
- 引入 Bun 增加用户机器运行时矩阵——Node 已被 CC CLI 满足是 Option A 核心论据之一，不应被新 runtime 摊薄

### Reopen 触发条件（任一关键项达成 → ops/ 阶段开新 ADR 重审）

- [ ] `node-pty` 在 Bun 上有官方或权威社区的兼容背书 / 可参考 production case
- [ ] Bun 官方 `child_process` 兼容率提升到 95%+ 区间
- [ ] `bun build --compile` 对 `bindings` / `prebuild-install` 路径的处理进入 stable
- [ ] Windows arm64 进入 `bun build --compile` 官方 target
- [ ] `bun:sqlite` 提供 `better-sqlite3` 风格的 API 兼容层（避免 F1 改写代价）
- [ ] `keytar` 替代方案（Bun secrets API 或第三方库）有稳定生产案例

### 数据来源

- codex argue prompt（gitignored）：`.tasks/bun-toolchain-argue.scratch.md`
- Bun 官方：[Node 兼容矩阵](https://bun.sh/docs/runtime/nodejs-compat) / [Bundler executables](https://bun.sh/docs/bundler/executables) / [bun:sqlite](https://bun.sh/docs/api/sqlite)

## Out of scope

- **不决定**具体框架版本（discord.js / vitest / TypeScript 等的具体版本号在实现首 PR 内敲定）
- **不决定**打包方式细节（等 ops/ 阶段；MVP 走 npm 全局安装）
- **不决定**最低 runtime 版本号（建议 Node 20.x LTS，首 PR 内敲定）
- **不决定**monorepo 工具具体选型（pnpm workspaces 是当前推荐；Turborepo / Nx 等增强工具按实际需要再评估）

## 评审条件（已满足）

本 ADR 推进到 Accepted 已满足：

1. ✅ spec 三大契约（platform-adapter / agent-runtime / message-protocol）已写成
2. ✅ 三大契约里的具体字段与交互让各语言的优劣暴露
3. ✅ 跑过 codex 异构 review（OpenAI gpt-5 系列），独立反方分析报告 + 推荐已记录在 §"评审历史" 第三轮
4. ✅ 实际负载与跨端演进面在第四轮被显式纠正

## 参考

- 决策对话：2026-04-25
- codex 异构 argue prompt（gitignored）：`.tasks/adr-0004-argue.scratch.md`
- discord.js：https://discord.js.org/
- discordgo：https://github.com/bwmarrin/discordgo
- discord.py：https://discordpy.readthedocs.io/
- Anthropic SDK 目录：https://docs.claude.com/en/api/client-sdks
- Anthropic Go SDK：https://github.com/anthropics/anthropic-sdk-go
- MCP SDK 列表：https://modelcontextprotocol.io/
- pnpm workspaces：https://pnpm.io/workspaces
