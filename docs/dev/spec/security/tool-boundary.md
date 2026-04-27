---
title: Spec：Tool Boundary（工具与工作目录边界）
type: spec
status: active
summary: CC CLI 工具白名单、默认集、危险工具启用流程、工作目录约束
tags: [spec, security, tool-boundary, cc-cli]
related:
  - dev/spec/security/README
  - dev/spec/security/auth
  - dev/spec/agent-backends/claude-code-cli
  - dev/spec/agent-runtime
contracts:
  - ToolWhitelistConfig
---

# Spec：Tool Boundary（工具与工作目录边界）

定义 CC CLI 可以**做什么**的硬边界。`auth.md` 决定**谁**能触发；本 spec 决定**能做哪些操作**。两者正交。

对应模块：`daemon.toolguard`（伞标题，具体实现可能分 tool-whitelist / workdir-guard 两部分）。

## 规则

- CC CLI 可用工具集由 `SessionConfig.toolWhitelist` 控制（见 [`agent-runtime.md`](../agent-runtime.md) §SessionConfig）
- 白名单来自配置：`config.security.toolWhitelist`
- 默认集（MVP 建议）：`Read, Grep, Glob, Edit, Write`
- **默认禁用**：`Bash`、任何 shell 执行类工具
- MCP server：单独配置 `config.security.mcpServers`，默认全禁

## 启用危险工具的要求

用户配置启用 `Bash` 或等效时：

- 启动日志里打 `warn` 提醒
- 在 IM 首条欢迎消息里显式标注
- 支持 per-session 关闭（slash command）

## 工作目录

- `SessionConfig.workingDir` 限定 CC 的默认工作目录
- 传递方式：CC CLI 2.1.x 起没有 `--cwd` flag，daemon 通过 OS 子进程 cwd 选项（execa `{ cwd }` / `child_process.spawn({ cwd })`）锁定子进程工作目录；详见 [`claude-code-cli-contract.md`](../agent-backends/claude-code-cli.md) §"启动命令模板" 工作目录条目
- 如果 CC 配置允许多个 allowed dirs，沿用 CC 的 allowlist（本项目不重复实现）
- **不继承** agent-nexus 进程的 cwd；每 session 显式传子进程 cwd

## 核心威胁关联

Discord 账号被盗 → 远程等价本机操作（见 `security.md` §"核心威胁"）。工具边界是降低此威胁代价的主要机制：

- MVP 默认**只读工具集**（`Read / Grep / Glob`）可作更保守起点；启用 `Edit / Write` 应触发 per-session 警告
- 写操作可配置二次确认（per-session 或 per-tool）——MVP 未实现，作为 future 项
- `Bash` 与 MCP shell 类启用时**强制**显示在欢迎消息

## 合约测试

- **白名单外拒绝**：CC 尝试调用未在白名单的工具 → `agent` 错误，不转发工具调用请求，不发送结果
- **启动时 `Bash` 警告**：配置启用 `Bash` → 启动日志必有 `warn`；首条欢迎消息包含危险标注
- **工作目录正确锁定**：fake CC spawn 后子进程 cwd 选项等于 `SessionConfig.workingDir`；argv 中**不**出现 `--cwd`（CC CLI 不识别该 flag）
- **MCP 默认全禁**：配置未显式列 MCP → CC 启动参数不带任何 MCP 注册

## 反模式

- 为了方便让 `Bash` 在默认白名单里
- 不传 `--allowed-tools` 依赖 CC 默认集（安全边界隐式）
- 多 session 共用一套 `workingDir`（无法做 per-session 隔离）
- 用户侧通过 IM 命令即时改 `toolWhitelist`（必须改配置重启）

## Out of spec

- 具体工具的功能实现（属 CC CLI 自身）
- MCP server 的协议细节（独立 spec，MVP 不涉及）
- per-tool 动态审批 UI（属 future）
