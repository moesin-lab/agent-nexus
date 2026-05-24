---
title: Spec：Tool Boundary（工具与工作目录边界）
type: spec
status: active
summary: agent backend 的工具白名单、默认集、危险工具启用流程、工作目录与 sandbox 约束
tags: [spec, security, tool-boundary, cc-cli, codex]
related:
  - dev/spec/security/README
  - dev/spec/security/auth
  - dev/spec/agent-backends/claude-code-cli
  - dev/spec/agent-backends/codex-cli
  - dev/spec/agent-runtime
  - dev/adr/0012-claudecode-stream-json-mainline
  - dev/adr/0014-agent-backend-codex-cli
contracts:
  - ToolWhitelistConfig
  - CodexSandboxConfig
---

# Spec：Tool Boundary（工具与工作目录边界）

定义 agent backend 可以**做什么**的硬边界。`auth.md` 决定**谁**能触发；本 spec 决定**能做哪些操作**。两者正交。

对应模块：`@agent-nexus/agent-claudecode` 的 permission control 实现。通用 daemon 不解释 Claude Code 的工具白名单语义。

## 规则

- Claude Code CLI 可用工具集由 `claudeCode.allowedTools` 控制；这是 `@agent-nexus/agent-claudecode` 的 backend 专属配置，不属于通用 `AgentRuntime` / `SessionConfig`。
- 白名单来自配置：`claudeCode.allowedTools`
- 默认集（MVP 建议）：`Read, Grep, Glob, Edit, Write`
- **默认禁用**：`Bash`、任何 shell 执行类工具
- MCP server：单独配置 `config.security.mcpServers`，默认全禁
- **`--allowed-tools` / `--permission-mode` 是配置意图声明，不是安全边界**：ADR-0012 决策点 5.1 实测（CC 2.1.148 / 2.1.149）二者不单独强制工具边界；工具隔离的强制点见 §工具隔离强制点
- `claudeCode.permissionLevel` 默认必须为 `default`，agent-nexus 启动 CC 子进程时必须显式传 `--permission-mode <permissionLevel>`，避免继承用户全局 `settings.permissions.defaultMode`。允许值与 CC CLI 对齐：`default` / `acceptEdits` / `auto` / `bypassPermissions` / `dontAsk` / `plan`；非 `default` 只允许用户显式配置，且必须打 warn、跳过 `can_use_tool` probe，并标注为不满足工具隔离强安全承诺
- Codex CLI 当前没有执行前工具审批 / allowlist / denylist / control request。Codex backend 只能用 `--sandbox`、`--ask-for-approval never`、`--cd`、`--add-dir`、`--ignore-user-config`、`--ignore-rules` 表达 process-level 边界；详见 [`codex-cli.md`](../agent-backends/codex-cli.md)。

## 启用危险工具的要求

用户配置启用 `Bash` 或等效时：

- 启动日志里打 `warn` 提醒
- 在 IM 首条欢迎消息里显式标注
- 支持 per-session 关闭（slash command）

启用 `Edit` / `Write`（默认集已含，但相对只读集是写权限升级）时：

- 启动日志里打 `warn` 提醒（与 §核心威胁关联 "启用 Edit/Write 应触发 per-session 警告"对齐）

## 工作目录

- `SessionConfig.workingDir` 限定 CC 的默认工作目录
- 传递方式：CC CLI 没有 `--cwd` flag；`workingDir` 通过子进程 `cwd` 选项传给 `claude` 进程。详见 [`claude-code-cli.md`](../agent-backends/claude-code-cli.md) §启动命令模板 / §Flag 参考矩阵。
- Codex CLI 使用 `--cd <workingDir>` 绑定工作根；额外可写目录只能来自显式 `codex.addDirs` 并逐个传 `--add-dir`。详见 [`codex-cli.md`](../agent-backends/codex-cli.md)。
- 如果 CC 配置允许多个 allowed dirs，沿用 CC 的 allowlist（本项目不重复实现）
- **不继承** agent-nexus 进程的 cwd；每 session 显式传子进程 cwd

## 工具隔离强制点

工具隔离的真正强制点不在 CLI flag，而在 **CC 进程内执行前拦截 + OS 纵深**（[ADR-0012 决策点 5](../../adr/0012-claudecode-stream-json-mainline.md)，本节为其 spec 落地）：

1. **进程内执行前强制点（fail-closed）**：CC 2.1.149 实测确认 `--permission-prompt-tool stdio` 会打开 stream-json control permission 通道：工具执行前 stdout 产出 `control_request{subtype:"can_use_tool", request_id, request:{tool_name,input,tool_use_id,...}}`；agent-nexus 必须以 `permissionLevel=default` 启动该路径，并据 `claudeCode.allowedTools` 回写 `control_response`，`allow` 时携带 `request_id` + `updatedInput`，`deny` 时携带 `request_id` + 拒绝原因。deny 样本中 Bash/Edit 写文件副作用未发生且 result 汇总 `permission_denials`；allow 样本中文件实际创建，说明该通道既能阻断也能放行。`--permission-prompt-tool` 不在 `claude --help` 输出中，属于需 compatibility probe 验证的外部契约；启动时若 flag 不被接受、未收到预期 `can_use_tool`、回包无效、或规则解析失败，一律 **fail closed**（禁止启动或禁用全部工具）。非 `default` permissionLevel 可能让 CC 在 stdio prompt 前 allow / deny / classifier 处理，不能要求出现 `can_use_tool`，因此只能作为显式弱化模式。**PreToolUse hook** 保留为 fallback / defense-in-depth：control probe 不通过但实现仍要提供工具隔离时，才可切 hook 主强制点；hook 配置与规则同样必须位于被隔离对象（模型）**不可写的边界外**，启动时校验已加载且规则可解析，失败 fail closed。control probe 与 hook probe 均不通过时，**禁止落地**该工具隔离实现，不允许对外宣称满足工具隔离承诺。
2. **OS 级 defense-in-depth**：最低语义 = 限制工作目录写入范围 + 敏感路径不可读 + 网络能力明确策略（容器 / 沙箱 / 只读挂载 / 网络隔离任一可行手段）。目标平台无法提供任何 OS 级限制时，**必须显式声明"不满足工具隔离强安全承诺"**，不得宣称满足。与 ADR-0003 local-desktop 部署的张力下，弱化形态（信任工作目录 + 只读挂载）须显式标注。
3. 该强制点**保留** §合约测试 §白名单外拒绝 的安全语义，**废弃** observer 架构下"agent-nexus 事后不转发"的实现路径——stream-json 下 agent-nexus 是子进程 stdout 观察者，看到 `tool_use` 时工具已执行完，无法事后拦截。

### Codex backend 降级边界

Codex backend 当前不满足本节 Claude Code 的执行前工具白名单强制点：

- 用户启用 Codex backend 时，安全承诺降级为 process-level sandbox / approval / workingDir / add-dir / config inheritance 组合；任何 UI 或日志不得宣称"按工具名白名单执行前拦截"。
- 若未来 Codex CLI 暴露执行前工具审批或 allowlist，必须先更新 `codex-cli.md` 与本 spec，并用 CompatibilityProbe fail-closed 验证。

## 核心威胁关联

Discord 账号被盗 → 远程等价本机操作（见 `security.md` §"核心威胁"）。降低此威胁代价依赖 **执行前强制点 + OS 纵深**（见 §工具隔离强制点），不再依赖实测已失效的 CLI flag：

- 白名单语义（白名单外工具不得执行）由 §工具隔离强制点 的进程内执行前强制点落地
- OS 级 defense-in-depth 作兜底，进程内强制点随 CC 被攻破或配置篡改而失效时仍有硬边界
- **只读工具集**（`Read / Grep / Glob`）可作比 §规则 默认集（含 `Edit / Write`）更保守的起点；启用 `Edit / Write` 应触发 per-session 警告
- 写操作二次确认（per-session / per-tool）仍为 future 项（MVP 未实现）
- `Bash` 与 MCP shell 类启用时**强制**显示在欢迎消息

## 合约测试

- **白名单外拒绝（执行前）**：CC 尝试调用未在 `claudeCode.allowedTools` 的工具 → `can_use_tool` control 强制点在工具**执行前** deny；**最低断言 = 工具副作用未发生（执行前被拦）**。具体可观测信号（stdout 格式 / denial 汇总结构）由 [`claude-code-cli.md`](../agent-backends/claude-code-cli.md) 拥有。测试不得只断言有 denial 文本，必须同时验证副作用未发生。若实现切到 PreToolUse hook fallback，同一最低断言仍成立
- **强制点缺失 fail-closed**：control 主强制点缺失 / 加载失败 → 启动失败或切到已验证 hook fallback；control 与 hook fallback 均不可用 → **禁止落地**工具隔离实现，**不**退化放行
- **control 回包放行**：白名单内工具触发 `can_use_tool` → agent-nexus 回 `control_response allow + updatedInput` 后工具可执行；用于证明强制点不是单向 deny stub
- **权限模式显式化**：默认启动参数必须包含 `--permission-mode default`，`init.permissionMode` 必须与配置一致；配置非 `default` permissionLevel 时必须原样传 `--permission-mode <value>`，跳过 permission control probe 并打 warn；若 CC 实际回退到其他模式（如 `auto` 不可用回退），必须 fail closed
- **启动时 `Bash` 警告**：配置启用 `Bash` → 启动日志必有 `warn`；首条欢迎消息包含危险标注
- **工作目录正确锁定**：fake CC spawn 时子进程 `cwd` 选项等于 `SessionConfig.workingDir`；argv 中**不**出现 `--cwd`。
- **MCP 默认全禁**：配置未显式列 MCP → CC 启动参数不带任何 MCP 注册
- **Codex native whitelist 不支持**：Codex backend 不得把 Claude Code 的 `allowedTools` 语义翻译成不存在的 Codex allowlist flag
- **OS 级 defense-in-depth 不在自动合约测试范围**：§工具隔离强制点 第 2 点的 OS 隔离（工作目录写入范围 / 敏感路径不可读 / 网络策略）依赖部署环境，由**部署层配置 + 上线前审计 checklist** 验证，不作单测覆盖；spec 不把它当"无需验证"，而是验证责任在部署/审计而非进程内单测

## 反模式

- 为了方便让 `Bash` 在默认白名单里
- 让子进程隐式继承用户全局 permission mode，或把非 `default` permissionLevel 作为默认权限级别
- 把 `--allowed-tools` / `--permission-mode` 当安全边界（决策点 5.1 实测不强制）
- 漏传 `--permission-prompt-tool stdio` 却期待 stdout 出现 `can_use_tool`
- 只配进程内强制点不叠 OS 纵深却宣称满足强安全承诺
- 把强制点配置放在模型可写路径（可被 prompt injection 篡改）
- 多 session 共用一套 `workingDir`（无法做 per-session 隔离）
- 用户侧通过 IM 命令即时改 `claudeCode.allowedTools`（必须改配置重启）

## Out of spec

- 具体工具的功能实现（属 CC CLI 自身）
- MCP server 的协议细节（独立 spec，MVP 不涉及）
- per-tool 动态审批 UI（属 future）
