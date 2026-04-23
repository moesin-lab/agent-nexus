---
title: ADR-0004：实现语言与运行时选型
type: adr
status: active
summary: 实现语言选型（TS/Go/Python）；基于三大 spec 二次评审后倾向 Go，待用户最终决策
tags: [adr, decision, language-runtime]
related:
  - dev/spec/platform-adapter
  - dev/spec/agent-runtime
  - dev/spec/message-protocol
  - dev/spec/infra/persistence
adr_status: Proposed
adr_number: "0004"
decision_date: null
supersedes: null
superseded_by: null
---

# ADR-0004：实现语言与运行时选型

- **状态**：Proposed
- **日期**：2026-04-22
- **决策者**：待定
- **相关 ADR**：ADR-0001、ADR-0002、ADR-0003

## 状态变更日志

- 2026-04-22：Proposed（候选方案列出，尚未决策；将在 spec 核心三件套写成后重新评审）

## Context

前置决策：Discord（ADR-0001）+ Claude Code CLI（ADR-0002）+ 本机桌面（ADR-0003）。现需确定实现语言与运行时。该决定影响：

- SDK 生态（Discord / Anthropic）与集成成本
- 并发模型（长连接、子进程管理、pty）
- 分发形态（单二进制 / 需要 runtime / 需要打包器）
- 测试工具链与 eval 生态
- 与 CC CLI 的互操作难度

本 ADR 在"三大契约 spec 写成后"再评审，届时能基于具体接口形态判断哪门语言更贴合。

## Options

### Option A：TypeScript / Node

- **是什么**：Node LTS + TypeScript，开发用 tsx/vitest，打包用 tsup/bun build 或直接跑源码
- **优点**：
  - discord.js 是 Discord SDK 事实标准
  - Anthropic 官方 SDK 是 TS 一等公民
  - 与 CC CLI 同栈，未来可能直接 import CC 模块
  - 用户装 CC 时 Node runtime 已经在本地 → 分发零负担
  - LLM / eval 生态（promptfoo 等）TS 覆盖良好
- **缺点**：
  - 并发模型是 async/event loop，pty 与子进程管理需要额外心智
  - 类型系统不如 Go/Rust 严格
- **主要风险**：Node runtime 版本碎片化（用户装的 CC 用什么 Node？要兼容吗？）

### Option B：Go

- **是什么**：Go 1.22+，单二进制，goroutine 并发
- **优点**：
  - 单二进制分发，无 runtime 依赖
  - goroutine + channel 做长连接/子进程非常顺
  - 与 cc-connect 同栈，经验可迁移
  - `testing` + `testify` 测试生态稳
- **缺点**：
  - Discord SDK（discordgo）不如 discord.js 齐
  - Anthropic 无官方 Go SDK，需要自己包 HTTP
  - 与 CC CLI 只能 stdio 黑盒交互
  - LLM/eval 生态最弱
- **主要风险**：Discord 高级特性（button/modal）SDK 支持跟不上时自己补

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
- **主要风险**：分发复杂度让用户装机门槛变高

## 对比矩阵

| 维度 | TypeScript/Node | Go | Python |
|---|---|---|---|
| Discord SDK | ★★★（事实标准） | ★★ | ★★★ |
| Anthropic SDK | ★★★（官方 TS） | ★（要自包） | ★★★（官方） |
| 与 CC CLI 互操作 | ★★★（同栈） | ★★（stdio） | ★★（stdio） |
| 本机桌面分发 | ★★★（CC 已带 Node） | ★★★（单二进制） | ★（最麻烦） |
| 并发/长连接 | ★★（event loop） | ★★★（goroutine） | ★★（asyncio） |
| LLM/eval 生态 | ★★ | ★ | ★★★ |
| TDD 工具链 | ★★★（vitest） | ★★★（testing） | ★★★（pytest） |
| 与 cc-connect 经验迁移 | — | ★★★ | — |

## 基于三大 spec 的二次评审（2026-04-22）

三大契约已写成（`spec/platform-adapter.md` / `spec/agent-runtime.md` / `spec/message-protocol.md`）+ 横切四件套。回头看对语言选型的影响：

### 重要更正

**本项目不直接调用 Anthropic API。** ADR-0002 选定 CC CLI 作为 agent 后端，意味着所有 LLM 调用发生在 CC 内部；我们只读 CC 输出的 `usage` 事件做记账。原本列为 TS / Python 一大优势的"官方 Anthropic SDK 一等公民"，**对本项目几乎无效**。

### 三大 spec 暴露的真实技术需求

| 需求 | 来源 | Go | TS/Node | Python |
|---|---|---|---|---|
| Discord gateway 长连接 + REST | platform-adapter §"启动与停止" | discordgo 够用 | discord.js 事实标准 | discord.py |
| CC CLI 子进程 + stdio/pty 管理 | agent-runtime §"CC CLI 专属说明" | `os/exec` + `creack/pty`，无 native 编译 | 需 `node-pty` native 依赖 | `ptyprocess` |
| 信号与中断（SIGINT/SIGKILL） | agent-runtime §"中断" | 标准库，顺 | 需额外库 | 标准库 |
| JSONL 流解析（CC 输出） | agent-runtime §"输出解析" | `bufio.Scanner`，零依赖 | readline + JSON.parse | `json` 标准库 |
| SQLite（idempotency / session / budget） | persistence §"SQLite 表结构" | `modernc.org/sqlite` 纯 Go，交叉编译零痛 | `better-sqlite3` native 编译 | 标准库 `sqlite3` |
| OS Keychain | security §"密钥存储" | `zalando/go-keyring` 跨平台 | `keytar` native 编译 | `keyring` |
| 结构化 JSON 日志 | observability §"输出" | `log/slog` 标准库 | pino | structlog |
| 退避 + jitter + 并发队列 | cost-and-limits §"退避 + Jitter" | goroutine + channel 天生契合 | async/await | asyncio |
| 本机桌面多平台分发 | ADR-0003 | 单二进制多平台交叉编译 | **3 个 native 依赖（pty/sqlite/keychain）的跨平台 prebuilt 是大坑** | pipx / pyinstaller 多坑 |

### 关键翻盘点

1. **Anthropic SDK 优势蒸发**：第一轮推荐 TS 的主要论据之一失效
2. **Native 依赖拖累 TS 分发**：pty + SQLite + keychain 三个 native 依赖让"用户已有 Node"优势打折
3. **Go 的子进程/并发/单二进制优势在这套 spec 下被放大**
4. **Discord SDK 差距缩小**：我们用到的功能（消息、slash、button、thread）discordgo 都支持，缺口不致命
5. **Python 分发劣势明显且无弥补优势**

### 二次评审倾向

**Go 的相对权重从第一轮的次优上升到与 TS 并列最优，甚至略占优势**。最关键的是"本机桌面多平台分发"这一项——Go 几乎没有痛点，TS 和 Python 都有明显短板。

### 剩余风险

- 若 Discord 推出新的交互特性（例：新的 modal 类型）而 discordgo 跟进慢，需要我们自补
- 若未来接入直接 Anthropic API 的 agent 后端（而非 CC CLI），TS/Python 的 SDK 优势又会回来——但那是另一个 ADR 的事

## Decision

**待用户决策**。建议基于二次评审的倾向：**Go**。

推进本 ADR 到 `Accepted` 需要用户最终确认。在确认前，此状态保持 `Proposed`。

## Consequences（预判）

若选 TS/Node：与 CC 同栈红利最大，但要处理 pty/子进程的 event loop 心智负担。

若选 Go：并发模型最优、分发最轻，但要自包 Anthropic SDK 并跟进 Discord SDK 缺口。

若选 Python：eval 体验最好，但分发复杂度可能劝退用户。

## Out of scope

- **不决定**具体框架（等语言定后在 spec 补充）
- **不决定**打包方式（等 ops/ 阶段）
- **不决定**最低 runtime 版本（等语言定后）

## 评审条件

本 ADR 推进到 Accepted 需要：

1. spec 三大契约（platform-adapter / agent-runtime / message-protocol）已写成
2. 三大契约里的具体字段与交互已让各语言的优劣暴露
3. 评审时跑一次 codex review，要求独立列出"如果是你，选哪个，为什么"

## 参考

- 对比背景对话：plan 文件 `/home/node/.claude/plans/cc-connect-agent-im-cc-connect-1-2-modular-llama.md`
- discord.js：`https://discord.js.org/`
- discordgo：`https://github.com/bwmarrin/discordgo`
- discord.py：`https://discordpy.readthedocs.io/`
- Anthropic SDK 目录：`https://docs.claude.com/en/api/client-sdks`
