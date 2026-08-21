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
  - dev/spec/agent-backends/codex-app-server
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
- `claudeCode.permissionLevel` 默认必须为 `default`，agent-nexus 启动 CC 子进程时必须显式传 `--permission-mode <permissionLevel>`，避免继承用户全局 `settings.permissions.defaultMode`。允许值与 CC CLI 对齐：`default` / `acceptEdits` / `auto` / `bypassPermissions` / `dontAsk` / `plan`；非 `default` 只允许用户显式配置，且必须打 warn、跳过 `can_use_tool` probe，并标注为不满足工具隔离强安全承诺。`bypassPermissions` 是 Claude Code backend 的显式 YOLO 模式，语义接近远程等价本机执行，启动时必须有 `claudecode_bypass_permissions_enabled` warn。
- Codex CLI 当前没有执行前工具审批 / allowlist / denylist / control request。Codex backend 只能用 `--sandbox`、`--ask-for-approval never`、`--cd`、`--add-dir`、`--ignore-user-config`、`--ignore-rules` 表达 process-level 边界；当显式配置 `sandbox="danger-full-access"` 时，不再提供文件系统 sandbox 边界。详见 [`codex-cli.md`](../agent-backends/codex-cli.md) 与 ADR-0014。
- Codex app-server 首版固定 `approvalPolicy="never"`，只开放 spec method allowlist；它不是执行前按工具名 allowlist。详见 [`codex-app-server.md`](../agent-backends/codex-app-server.md) 与 ADR-0022。

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
- Codex CLI 使用 `--cd <workingDir>` 绑定工作根；sandboxed 模式下额外可写目录只能来自显式 `codex.addDirs` 并逐个传 `--add-dir`。`danger-full-access` 下 `workingDir` 只是启动根，`addDirs` 不构成访问边界。详见 [`codex-cli.md`](../agent-backends/codex-cli.md)。
- Codex app-server 的 thread cwd 必须等于 canonical `SessionConfig.workingDir`；sandbox/additional roots 只能来自 `codexAppServer` owner 配置。response 中返回的 cwd 或 `codexHome` 与注入值不一致时立即终止 session。
- 如果 CC 配置允许多个 allowed dirs，沿用 CC 的 allowlist（本项目不重复实现）
- **不继承** agent-nexus 进程的 cwd；每 session 显式传子进程 cwd
- `/nexus-working-dir` 与 settings config editor 都允许把 workingDir 设为任意非空绝对路径，不强制包含在 agent 默认 `workingDir` 下。workingDir 是启动位置与 process-level sandbox 输入，不是独立安全边界；真实可读写范围仍由 backend sandbox / `addDirs` / CC 工具强制点与部署层 OS 纵深共同决定。

## 工具隔离强制点

工具隔离的真正强制点不在 CLI flag，而在 **CC 进程内执行前拦截 + OS 纵深**（[ADR-0012 决策点 5](../../adr/0012-claudecode-stream-json-mainline.md)，本节为其 spec 落地）：

1. **进程内执行前强制点（fail-closed）**：CC 2.1.149 实测确认 `--permission-prompt-tool stdio` 会打开 stream-json control permission 通道：工具执行前 stdout 产出 `control_request{subtype:"can_use_tool", request_id, request:{tool_name,input,tool_use_id,...}}`；agent-nexus 必须以 `permissionLevel=default` 启动该路径，并据 `claudeCode.allowedTools` 回写 `control_response`，`allow` 时携带 `request_id` + `updatedInput`，`deny` 时携带 `request_id` + 拒绝原因。deny 样本中 Bash/Edit 写文件副作用未发生且 result 汇总 `permission_denials`；allow 样本中文件实际创建，说明该通道既能阻断也能放行。`--permission-prompt-tool` 不在 `claude --help` 输出中，属于需 compatibility probe 验证的外部契约；启动时若 flag 不被接受、未收到预期 `can_use_tool`、回包无效、或规则解析失败，一律 **fail closed**（禁止启动或禁用全部工具）。非 `default` permissionLevel 可能让 CC 在 stdio prompt 前 allow / deny / classifier 处理，不能要求出现 `can_use_tool`，因此只能作为显式弱化模式；其中 `bypassPermissions` 是显式 YOLO 模式，不能包装成工具隔离。**PreToolUse hook** 保留为 fallback / defense-in-depth：control probe 不通过但实现仍要提供工具隔离时，才可切 hook 主强制点；hook 配置与规则同样必须位于被隔离对象（模型）**不可写的边界外**，启动时校验已加载且规则可解析，失败 fail closed。control probe 与 hook probe 均不通过时，**禁止落地**该工具隔离实现，不允许对外宣称满足工具隔离承诺。
2. **OS 级 defense-in-depth**：最低语义 = 限制工作目录写入范围 + 敏感路径不可读 + 网络能力明确策略（容器 / 沙箱 / 只读挂载 / 网络隔离任一可行手段）。目标平台无法提供任何 OS 级限制时，**必须显式声明"不满足工具隔离强安全承诺"**，不得宣称满足。与 ADR-0003 local-desktop 部署的张力下，弱化形态（信任工作目录 + 只读挂载）须显式标注。
3. 该强制点**保留** §合约测试 §白名单外拒绝 的安全语义，**废弃** observer 架构下"agent-nexus 事后不转发"的实现路径——stream-json 下 agent-nexus 是子进程 stdout 观察者，看到 `tool_use` 时工具已执行完，无法事后拦截。

### Codex backend 降级边界

Codex backend 当前不满足本节 Claude Code 的执行前工具白名单强制点：

- 用户启用 Codex backend 时，安全承诺降级为 process-level sandbox / approval / workingDir / add-dir / config inheritance 组合；任何 UI 或日志不得宣称"按工具名白名单执行前拦截"。显式 `danger-full-access` 进一步降级为远程等价本机执行，只能依赖身份 allowlist、部署隔离与操作者信任。
- `danger-full-access` 启动时必须有 warn 级日志，便于 operator 和事故复盘识别高权限 session。
- 若未来 Codex CLI 暴露执行前工具审批或 allowlist，必须先更新 `codex-cli.md` 与本 spec，并用 CompatibilityProbe fail-closed 验证。

### Codex app-server 隔离与控制边界

Codex app-server 的结构化 ServerRequest 能拒绝审批，但首版没有完整飞书 approval broker，不能把“能看到请求”表述为已实现按工具白名单：

- 每个 agent conversation generation 必须使用独立、跨 local child 持久的随机 homeId `CODEX_HOME`；SessionKey 只记录创建/rebind 审计，不拥有 home。只允许复制下述认证材料，并由 agent-nexus 生成最小 `config.toml`；不得继承用户 config、rules、MCP、hooks、skills、plugins、features、model 或其它 Codex state。
- 首版认证唯一允许的源材料是 `<sourceCodexHome>/auth.json`；API-key env、其它 credential 文件、源 config 与整个目录复制均不支持。源 home 与文件必须 canonicalize、属于当前 uid、不是 symlink，auth 必须是 regular file、mode 不含 group/world bits、大小 `1..1048576` bytes。实现用 `O_NOFOLLOW` 打开后 `fstat` 再读，避免先 check 后 reopen。
- conversation-private home 位于 CLI 注入的 agent-nexus `persistenceRoot`，root、`homes/` 与随机 128-bit homeId 子目录 mode `0700`，registry、owner metadata、生成的 `config.toml` mode `0600`。managed config 只包含 agent-nexus 明确拥有的最小值（当前固定 `check_for_update_on_startup=false`，防止无人值守 viewer 被 update modal 阻塞）；已有 managed config 内容漂移时用 private temp + fsync + atomic rename 替换，不合并 user config。首次创建时 auth 通过 exclusive temp file `0600` 写入、fsync、rename，再校验目标没有越出 root；允许 Codex 在该副本内原子刷新，但永不写回 source。
- 每次 seed 记录 source auth 内容 SHA-256、size 与 mtime 到 secret metadata（`0600`，日志不输出）。若 app-server 请求 `account/chatgptAuthTokens/refresh`，当前 child fail closed并把 conversation 标为 `auth_stale`。下一次 start 只有在重新安全打开 source 后发现 SHA-256 与 last-seeded digest 不同，才原子替换 durable `auth.json` 并清除 stale；digest 相同则 fail fast，提示 operator 先运行 Codex login，不进入重复 spawn/crash。rotation 只替换 auth，不覆盖 rollout/config/registry。
- normal stop、committed child crash 与 daemon shutdown 只结束 child并保留 durable home。未 commit 的 creating home 由下次 registry reconciliation 删除；committed home 只有在 operator 显式启用 backend retention 后才可按 lastUsedAt GC。GC 通过 private registry 定位单个 conversation home；删除前必须确认没有 live lease，并用打开的 root-relative handle/lstat 复核 threadId/homeId/owner metadata、拒绝 symlink 和越界路径。清理失败产生安全错误与可审计日志，不得静默复用。
- child 环境变量按 allowlist 构造，显式移除 OpenAI endpoint/provider override、Lark/Discord token、数据库凭据、daemon secret 与其它无关敏感变量。隔离目标是避免静默继承，不声称抵御同 uid 恶意进程。
- client request 只允许 initialize、thread start/resume/read、turn start/interrupt、unsubscribe，以及 [`codex-app-server-process.md`](../agent-backends/codex-app-server-process.md) 明列的 sandboxed stable `command/exec` family；禁止 filesystem、login、plugin、remote-control、daemon、experimental `process/*`、background-terminal 及通用 method passthrough。
- ServerRequest 必须按 backend spec 的逐 method exact schema 恰好响应一次。command/file approval decline，MCP elicitation cancel；permissions 没有 deny variant，必须回合法 JSON-RPC error并 interrupt。auth refresh、user-input、dynamic tool、attestation 与 unknown request 按表结束 turn/session，不能伪造空授权或 token。
- `danger-full-access` 与现有 Codex backend 相同，等价远程本机执行能力，必须有 warn 级日志和平台首条安全警告；method allowlist 与 private home 不构成文件系统 sandbox。
- 可选 remote viewer 只能通过 ADR-0023 定义的 per-incarnation capability token 连接 loopback app-server。controller 与 viewer 均拥有完整 app-server client 权限；token 是高权限 secret，必须使用 mode `0600` 文件向 server 提供，并只通过单用途环境变量向 viewer 提供。不得写入 argv、日志、registry、终端快照或平台消息；旧 incarnation token 必须失效。viewer 不扩大 sandbox，但会扩大同一 sandbox 内可发起操作的本机入口，因此默认关闭且失败时回退 stdio 主路径。

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
- **权限模式显式化**：默认启动参数必须包含 `--permission-mode default`，`init.permissionMode` 必须与配置一致；配置非 `default` permissionLevel 时必须原样传 `--permission-mode <value>`，跳过 permission control probe 并打 warn；`bypassPermissions` 必须额外产生 `claudecode_bypass_permissions_enabled` warn，且启动参数不得包含 `--dangerously-skip-permissions` / `--allow-dangerously-skip-permissions`；若 CC 实际回退到其他模式（如 `auto` 不可用回退），必须 fail closed
- **启动时 `Bash` 警告**：配置启用 `Bash` → 启动日志必有 `warn`；首条欢迎消息包含危险标注
- **工作目录正确锁定**：fake CC spawn 时子进程 `cwd` 选项等于 `SessionConfig.workingDir`；argv 中**不**出现 `--cwd`。
- **MCP 默认全禁**：配置未显式列 MCP → CC 启动参数不带任何 MCP 注册
- **Codex native whitelist 不支持**：Codex backend 不得把 Claude Code 的 `allowedTools` 语义翻译成不存在的 Codex allowlist flag
- **Codex app-server private home**：fresh generation 使用不同随机 home；同一 conversation rebind 后按 thread registry 恢复原 home；commit 前 crash 的 creating home被 reconciliation 清理且从未暴露 ref；用户 MCP/skills/plugins/config 未加载；stop/crash 后 committed home 保留且能 resume，只有显式 retention GC 才清理；source/destination symlink、owner/mode/size/越界与返回 home 不匹配时 fail closed
- **认证 rotation**：refresh request 让 Busy turn 恰好一次 error terminal并标记 stale；源 digest 未变化时后续启动 fail fast，变化后只原子替换 auth 并成功恢复同一 thread，rollout/config 不丢失
- **Codex app-server method/ServerRequest allowlist**：禁止方法不能写入 pipe；approval/MCP/unknown request 均在 deadline 内 deny/cancel/error，且被测副作用未发生
- **Codex remote viewer admission**：真实 Codex 对无 token、错误 token、旧 token 返回拒绝，正确 token 才完成 upgrade；listener 只绑定 loopback，token 文件 mode `0600`，argv/日志/snapshot/registry 均不含 token；app-server incarnation 更换后旧 viewer 被停止且旧 token 不再可用
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
