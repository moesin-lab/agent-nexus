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
  - dev/adr/0012-claudecode-stream-json-mainline
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
- **`--allowed-tools` / `--permission-mode` 是配置意图声明，不是安全边界**：ADR-0012 决策点 5.1 实测（CC 2.1.148）在 `--print` 非交互 stream-json 主路径下二者不强制工具边界；工具隔离的强制点见 §工具隔离强制点

## 启用危险工具的要求

用户配置启用 `Bash` 或等效时：

- 启动日志里打 `warn` 提醒
- 在 IM 首条欢迎消息里显式标注
- 支持 per-session 关闭（slash command）

## 工作目录

- `SessionConfig.workingDir` 限定 CC 的默认工作目录
- 传递方式：CC CLI 没有 `--cwd` flag；`workingDir` 通过子进程 `cwd` 选项传给 `claude` 进程。详见 [`claude-code-cli.md`](../agent-backends/claude-code-cli.md) §启动命令模板 / §Flag 参考矩阵。
- 如果 CC 配置允许多个 allowed dirs，沿用 CC 的 allowlist（本项目不重复实现）
- **不继承** agent-nexus 进程的 cwd；每 session 显式传子进程 cwd

## 工具隔离强制点

工具隔离的真正强制点不在 CLI flag，而在 **CC 进程内执行前拦截 + OS 纵深**（[ADR-0012 决策点 5](../../adr/0012-claudecode-stream-json-mainline.md)，本节为其 spec 落地）：

1. **进程内执行前强制点（fail-closed）**：必须有一个已验证可在工具执行前 deny 的 CC 进程内强制点。候选两条——stream-json control protocol `can_use_tool`（agent-nexus 作 control 对端据 `toolWhitelist` allow/deny）或 PreToolUse hook（实测已验证可 deny）。**control 还是 hook 作主强制**由实现前 [ADR-0012 §工具隔离实现前置验证门槛](../../adr/0012-claudecode-stream-json-mainline.md) 坐实（坐实 `can_use_tool` 触发方式 → control 优先；不可行 → hook），本 spec 不预设。无论哪条：其配置必须位于被隔离对象（模型）**不可写的边界外**，启动校验已加载；缺失 / 加载失败 / 规则解析失败一律 **fail closed**（禁止启动或禁用全部工具）。
2. **OS 级 defense-in-depth**：最低语义 = 限制工作目录写入范围 + 敏感路径不可读 + 网络能力明确策略（容器 / 沙箱 / 只读挂载 / 网络隔离任一可行手段）。目标平台无法提供任何 OS 级限制时，**必须显式声明"不满足工具隔离强安全承诺"**，不得宣称满足。与 ADR-0003 local-desktop 部署的张力下，弱化形态（信任工作目录 + 只读挂载）须显式标注。
3. 该强制点**保留** §合约测试 §白名单外拒绝 的安全语义，**废弃** observer 架构下"agent-nexus 事后不转发"的实现路径——stream-json 下 agent-nexus 是子进程 stdout 观察者，看到 `tool_use` 时工具已执行完，无法事后拦截。

## 核心威胁关联

Discord 账号被盗 → 远程等价本机操作（见 `security.md` §"核心威胁"）。降低此威胁代价依赖 **执行前强制点 + OS 纵深**（见 §工具隔离强制点），不再依赖实测已失效的 CLI flag：

- 白名单语义（白名单外工具不得执行）由 §工具隔离强制点 的进程内执行前强制点落地
- OS 级 defense-in-depth 作兜底，进程内强制点随 CC 被攻破或配置篡改而失效时仍有硬边界
- **只读工具集**（`Read / Grep / Glob`）可作比 §规则 默认集（含 `Edit / Write`）更保守的起点；启用 `Edit / Write` 应触发 per-session 警告
- 写操作二次确认（per-session / per-tool）仍为 future 项（MVP 未实现）
- `Bash` 与 MCP shell 类启用时**强制**显示在欢迎消息

## 合约测试

- **白名单外拒绝（执行前）**：CC 尝试调用未在 `toolWhitelist` 的工具 → 进程内执行前强制点在工具**执行前** deny；**最低断言 = 工具副作用未发生（执行前被拦）**。具体可观测信号（如 `permission_denials` / `tool_result.isError`）随 [ADR-0012 §工具隔离实现前置验证门槛](../../adr/0012-claudecode-stream-json-mainline.md) 坐实的强制点（control / hook）形态确定，由该强制点 owner 记入 spec——本 spec 不预钉字段
- **强制点缺失 fail-closed**：强制点配置缺失 / 加载失败 → 启动失败或全部工具禁用，**不**退化放行
- **启动时 `Bash` 警告**：配置启用 `Bash` → 启动日志必有 `warn`；首条欢迎消息包含危险标注
- **工作目录正确锁定**：fake CC spawn 时子进程 `cwd` 选项等于 `SessionConfig.workingDir`；argv 中**不**出现 `--cwd`。
- **MCP 默认全禁**：配置未显式列 MCP → CC 启动参数不带任何 MCP 注册

## 反模式

- 为了方便让 `Bash` 在默认白名单里
- 把 `--allowed-tools` / `--permission-mode` 当安全边界（决策点 5.1 实测不强制）
- 只配进程内强制点不叠 OS 纵深却宣称满足强安全承诺
- 把强制点配置放在模型可写路径（可被 prompt injection 篡改）
- 多 session 共用一套 `workingDir`（无法做 per-session 隔离）
- 用户侧通过 IM 命令即时改 `toolWhitelist`（必须改配置重启）

## Out of spec

- 具体工具的功能实现（属 CC CLI 自身）
- MCP server 的协议细节（独立 spec，MVP 不涉及）
- per-tool 动态审批 UI（属 future）
